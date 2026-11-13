// Test messages: the dashboard's "Send test" buttons and /test post a sample
// of a message that would otherwise only appear after a real event (someone
// joining, a level-up, a birthday, a log entry), so staff can check how it
// looks and that the bot can post where it should, without waiting.
//
// Every test:
//   - uses what's saved (the dashboard asks to save first);
//   - uses the person testing as the member, so variables fill in for real;
//   - starts with a small "Test sent by @someone" line, so nobody mistakes it
//     for the real thing;
//   - pings nobody (callers send it with no allowed mentions);
//   - goes where the real message would (the channel, or the tester's DMs).
//
// The builders here are plain functions shared by the bot (/test) and the
// dashboard, which have different ways of sending. Each returns a list of
// { channelId, payload } or { dm: true, payload }, or throws TestUnavailable
// with a reason the caller explains ("noChannel" when nothing is set up yet).
//
// createTestLimiter keeps people from turning the buttons into a spam cannon:
// one test every TEST_COOLDOWN_MS per person, and TESTS_PER_MINUTE per server.

import { readFileSync } from "node:fs";
import { activeRules, AutomodRule, AUTOMOD_RULES, normalizeAutomod } from "../automod/config.js";
import { countMentions, findBannedWord, findBlockedLink, findInvites, isMostlyCaps, textRuleDetail } from "../automod/rules.js";
import { birthdaySettings } from "../birthdays/birthdays.js";
import { buildStarboardPost, normalizeStarboard } from "../community/starboard.js";
import { welcomePayload } from "../community/welcome.js";
import { fillVariables } from "../dashboard/public/variables.js";
import { buildFeedPost } from "../feeds/feeds.js";
import { translate } from "../i18n/i18n.js";
import { Announce, normalizeLeveling } from "../leveling/config.js";
import { fillLevelMessage } from "../leveling/leveling.js";
import { LOG_ROUTES, LogRoute, ROUTE_DEFAULTS, ROUTE_PARENTS, routedChannelId } from "../logs/logRoutes.js";
import { SERVER_LOG_SETTINGS } from "../logs/serverLog.js";
import { MOD_LOG_SETTINGS } from "../moderation/modLog.js";
import { Setting } from "../settings/guildSettings.js";
import { bumpReminderPayload, normalizeAutomation } from "../channels/automation.js";
import { milestoneFor, milestonePayload, normalizeMilestones } from "../community/milestones.js";
import { TICKET_LOG_SETTINGS } from "../tickets/ticketLog.js";
import { createRateLimiter } from "../utils/rateLimits.js";

// The values are sent by the dashboard, so never rename one.
export const TestKind = Object.freeze({
  WELCOME: "welcome",
  LEAVE: "leave",
  WELCOME_DM: "welcomeDm",
  LEVEL_UP: "levelUp",
  BIRTHDAY: "birthday",
  STARBOARD: "starboard",
  LOGS: "logs",
  FEED: "feed",
  SCHEDULED: "scheduled",
  BUMP: "bump",
  MILESTONE: "milestone",
});
export const TEST_KINDS = Object.values(TestKind);

export const TEST_COOLDOWN_MS = 5_000;
export const TESTS_PER_MINUTE = 12;
// A log test posts once per log channel; past this many channels the rest are skipped.
export const MAX_LOG_TEST_CHANNELS = 20;
// The level shown in a test level-up message.
export const TEST_LEVEL = 5;
// The longest text /test automod and the dashboard's tester take.
export const MAX_AUTOMOD_TEST_LENGTH = 2000;

// Why a test can't be sent. The reasons double as translation keys
// ("testReason_<reason>") in the bot's and the dashboard's languages.
export const TestReason = Object.freeze({
  NO_CHANNEL: "noChannel", // the feature has no channel yet
  NO_DM: "noDm", // no welcome DM is set up
  LEVELING_OFF: "levelingOff",
  LEVEL_UP_OFF: "levelUpOff", // level-ups aren't announced
  LEVEL_UP_HERE: "levelUpHere", // they're announced where the member chats: use /test level-up there
  NO_LOGS: "noLogs", // no log channel at all
  NOT_FOUND: "notFound", // the feed or scheduled message is gone
  BUMP_OFF: "bumpOff", // bump reminders are off
  MILESTONES_OFF: "milestonesOff", // member milestones are off
});

export class TestUnavailable extends Error {
  name = "TestUnavailable";
  constructor(reason) {
    super(`Test unavailable: ${reason}`);
    this.reason = reason;
  }
}

// One test per person every TEST_COOLDOWN_MS, and TESTS_PER_MINUTE per server.
// take() returns 0 and counts the test, or how many ms to wait (counting nothing).
export function createTestLimiter({ now = Date.now } = {}) {
  const perPerson = createRateLimiter({ limit: 1, windowMs: TEST_COOLDOWN_MS, now });
  const perServer = createRateLimiter({ limit: TESTS_PER_MINUTE, windowMs: 60_000, now });
  return {
    take(guildId, userId) {
      const personKey = `${guildId}:${userId}`;
      const wait = Math.max(perPerson.waitTime(personKey), perServer.waitTime(guildId));
      if (wait > 0) {
        return wait;
      }
      perPerson.take(personKey);
      perServer.take(guildId);
      return 0;
    },
  };
}

// Something that looks enough like a discord.js GuildMember for the message
// builders, made from the dashboard's view of a person.
export function memberLike({ id, username, globalName = null, nick = null, avatarUrl = null }) {
  const name = nick ?? globalName ?? username ?? "";
  return {
    id,
    displayName: name,
    user: { id, username, globalName, displayAvatarURL: () => avatarUrl },
    displayAvatarURL: () => avatarUrl,
  };
}

// The "Test sent by @someone" line, as Discord's small grey text.
export const testLabel = (language, actorId) => `-# 🧪 ${translate(language, "testLabel", { user: `<@${actorId}>` })}`;

// The payload with the test line on top. The message's own text is cut so the
// whole stays within Discord's 2,000 characters.
export function withTestLabel(payload, label) {
  const own = payload.content ? String(payload.content) : "";
  const room = 2000 - label.length - 1;
  const content = own ? `${label}\n${own.length > room ? `${own.slice(0, room - 1)}…` : own}` : label;
  return { ...payload, content, allowedMentions: { parse: [] } };
}

// --- Welcome, leave and welcome DM ------------------------------------------------

const WELCOME_KINDS = {
  [TestKind.WELCOME]: { kind: "welcome", channel: Setting.WELCOME_CHANNEL },
  [TestKind.LEAVE]: { kind: "leave", channel: Setting.LEAVE_CHANNEL },
  [TestKind.WELCOME_DM]: { kind: "dm", channel: null },
};

function welcomeTest({ guildSettings, guild, member, forcedLanguage }, testKind) {
  const { kind, channel } = WELCOME_KINDS[testKind];
  const channelId = channel ? guildSettings.get(guild.id, channel) : null;
  if (channel && !channelId) {
    throw new TestUnavailable(TestReason.NO_CHANNEL);
  }
  const payload = welcomePayload(guildSettings, guild, member, kind, forcedLanguage);
  if (!payload) {
    throw new TestUnavailable(TestReason.NO_DM);
  }
  const message = { content: payload.content, ...(payload.embeds.length > 0 ? { embeds: payload.embeds } : {}) };
  return [channel ? { channelId, payload: message } : { dm: true, payload: message }];
}

// --- Level-up -------------------------------------------------------------------

// `hereChannelId` is where /test was used; the dashboard has none, so a server
// that announces level-ups where the member chats is pointed to /test.
function levelUpTest({ guildSettings, guild, member, language, hereChannelId }) {
  const config = normalizeLeveling(guildSettings.get(guild.id, Setting.LEVELING));
  if (!config.enabled) {
    throw new TestUnavailable(TestReason.LEVELING_OFF);
  }
  if (config.announce === Announce.OFF) {
    throw new TestUnavailable(TestReason.LEVEL_UP_OFF);
  }
  const content = fillLevelMessage(config.message ?? translate(language, "levelUpDefault"), { member, level: TEST_LEVEL, guild });
  if (config.announce === Announce.DM) {
    return [{ dm: true, payload: { content } }];
  }
  const channelId = config.announce === Announce.CHANNEL ? config.announceChannelId : hereChannelId;
  if (!channelId) {
    throw new TestUnavailable(config.announce === Announce.CHANNEL ? TestReason.NO_CHANNEL : TestReason.LEVEL_UP_HERE);
  }
  return [{ channelId, payload: { content } }];
}

// --- Birthday -------------------------------------------------------------------

function birthdayTest({ guildSettings, guild, member, language }) {
  const config = birthdaySettings(guildSettings, guild.id);
  if (!config?.channelId) {
    throw new TestUnavailable(TestReason.NO_CHANNEL);
  }
  const template = config.message ?? translate(language, "birthdayDefaultMessage");
  const content = fillVariables(template, "birthday", { user: `<@${member.id}>`, server: guild.name ?? "" }).slice(0, 2000);
  return [{ channelId: config.channelId, payload: { content } }];
}

// --- Starboard ------------------------------------------------------------------

// A starboard post for a made-up message by the tester, with as many stars as it takes.
function starboardTest({ guildSettings, guild, member, language, now }) {
  const board = normalizeStarboard(guildSettings.get(guild.id, Setting.STARBOARD));
  if (!board) {
    throw new TestUnavailable(TestReason.NO_CHANNEL);
  }
  const message = {
    author: member.user,
    member,
    content: translate(language, "testStarboardSample"),
    createdTimestamp: now(),
    channelId: board.channelId,
    url: `https://discord.com/channels/${guild.id}/${board.channelId}`,
  };
  const post = buildStarboardPost(message, { stars: board.threshold, emoji: board.emoji, language });
  const payload = {
    content: post.content,
    embeds: post.embeds.map((embed) => embed.toJSON?.() ?? embed),
    components: post.components.map((row) => row.toJSON?.() ?? row),
  };
  return [{ channelId: board.channelId, payload }];
}

// --- Feeds and scheduled messages (dashboard only) --------------------------------

// The feed's message for a made-up post. The role is shown but not pinged.
function feedTest({ language, feed }) {
  if (!feed) {
    throw new TestUnavailable(TestReason.NOT_FOUND);
  }
  const item = {
    title: translate(language, "testFeedTitle"),
    link: /^https:\/\//.test(feed.url ?? "") ? feed.url : "",
    author: feed.name,
    game: translate(language, "testFeedGame"),
  };
  const { content } = buildFeedPost(feed, item, language);
  return [{ channelId: feed.channelId, payload: { content } }];
}

function scheduledTest({ scheduled }) {
  if (!scheduled) {
    throw new TestUnavailable(TestReason.NOT_FOUND);
  }
  return [{ channelId: scheduled.channelId, payload: { content: scheduled.content } }];
}

// --- Bump reminder ----------------------------------------------------------------

// The reminder where it would go: its own channel, else where /test was used.
function bumpTest({ guildSettings, guild, language, hereChannelId }) {
  const { bump } = normalizeAutomation(guildSettings.get(guild.id, Setting.CHANNEL_AUTOMATION));
  if (!bump) {
    throw new TestUnavailable(TestReason.BUMP_OFF);
  }
  const channelId = bump.channelId ?? hereChannelId;
  if (!channelId) {
    throw new TestUnavailable(TestReason.NO_CHANNEL);
  }
  return [{ channelId, payload: { content: bumpReminderPayload(bump, language).content } }];
}

// --- Member milestone -------------------------------------------------------------

// The next milestone's post, with the tester as the member who reached it.
function milestoneTest({ guildSettings, guild, member, language }) {
  const config = normalizeMilestones(guildSettings.get(guild.id, Setting.MILESTONES));
  if (!config) {
    throw new TestUnavailable(TestReason.MILESTONES_OFF);
  }
  const milestone = milestoneFor(guild.memberCount ?? 0, config.every) + config.every;
  return [{ channelId: config.channelId, payload: milestonePayload(config, { member, guild, milestone, language }) }];
}

// --- Logs -----------------------------------------------------------------------

// The groups only gather the routes under them; nothing is logged as a group.
const LEAF_ROUTES = LOG_ROUTES.filter((route) => !Object.values(ROUTE_PARENTS).includes(route));
// What each part of the logs falls back to, as the loggers do (actionLog.js,
// modLog.js, serverLog.js, ticketLog.js).
const SECTION_SETTINGS = {
  logs: [Setting.LOGS_CHANNEL],
  modLog: MOD_LOG_SETTINGS,
  serverLog: SERVER_LOG_SETTINGS,
  ticketLog: TICKET_LOG_SETTINGS,
};

// The names the Logging page uses, in English like every log entry.
const pageText = JSON.parse(readFileSync(new URL("../dashboard/public/locales/en.json", import.meta.url), "utf8"));
export function routeName(route) {
  if (ROUTE_DEFAULTS[route] === "ticketLog") {
    const name = pageText[`ticketEvent_${route.charAt(6).toLowerCase()}${route.slice(7)}`];
    return name ? `Tickets: ${name}` : route;
  }
  return pageText[`logRoute_${route}`] ?? pageText[`logEvent_${route}`] ?? route;
}

// Where each kind of log entry goes now: { channels: [{ channelId, routes }],
// off: routes switched off, nowhere: routes with no channel }. It follows the
// same rules as the loggers, including the ticket log falling back to the
// "Other moderation actions" channel when it has no channel of its own.
export function planLogTest(guildSettings, guildId) {
  const offServer = new Set(guildSettings.getList(guildId, Setting.DISABLED_LOG_EVENTS));
  const offTicket = new Set(guildSettings.getList(guildId, Setting.DISABLED_TICKET_LOG_EVENTS));
  const ticketChannel = guildSettings.get(guildId, Setting.TICKET_LOG_CHANNEL);
  const byChannel = new Map();
  const off = [];
  const nowhere = [];
  for (const route of LEAF_ROUTES) {
    const section = ROUTE_DEFAULTS[route];
    const event = section === "ticketLog" ? `${route.charAt(6).toLowerCase()}${route.slice(7)}` : route;
    if ((section === "serverLog" && offServer.has(event)) || (section === "ticketLog" && offTicket.has(event))) {
      off.push(route);
      continue;
    }
    const chain = section === "ticketLog" && !ticketChannel ? [route, LogRoute.MOD_ACTIONS] : route;
    const channelId =
      routedChannelId(guildSettings, guildId, chain) ??
      SECTION_SETTINGS[section].map((setting) => guildSettings.get(guildId, setting)).find(Boolean);
    if (!channelId) {
      nowhere.push(route);
      continue;
    }
    byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), route]);
  }
  return { channels: [...byChannel].map(([channelId, routes]) => ({ channelId, routes })), off, nowhere };
}

const LOG_TEST_COLOR = 0x5865f2;

function logsTest({ guildSettings, guild, member, now }) {
  const plan = planLogTest(guildSettings, guild.id);
  if (plan.channels.length === 0) {
    throw new TestUnavailable(TestReason.NO_LOGS);
  }
  return plan.channels.slice(0, MAX_LOG_TEST_CHANNELS).map(({ channelId, routes }) => {
    const list = routes.map((route) => `• ${routeName(route)}`);
    let description = `These log entries are posted in this channel:\n${list.join("\n")}`;
    if (description.length > 4000) {
      description = `${description.slice(0, 3990)}\n…`;
    }
    const embed = {
      color: LOG_TEST_COLOR,
      title: "🧪 Test log entry",
      description,
      footer: { text: `Sent by ${member.displayName} · User ID ${member.id}` },
      timestamp: new Date(now()).toISOString(),
    };
    return { channelId, payload: { embeds: [embed] }, routes };
  });
}

// --- All together -----------------------------------------------------------------

const BUILDERS = {
  [TestKind.WELCOME]: (context) => welcomeTest(context, TestKind.WELCOME),
  [TestKind.LEAVE]: (context) => welcomeTest(context, TestKind.LEAVE),
  [TestKind.WELCOME_DM]: (context) => welcomeTest(context, TestKind.WELCOME_DM),
  [TestKind.LEVEL_UP]: levelUpTest,
  [TestKind.BIRTHDAY]: birthdayTest,
  [TestKind.STARBOARD]: starboardTest,
  [TestKind.LOGS]: logsTest,
  [TestKind.FEED]: feedTest,
  [TestKind.SCHEDULED]: scheduledTest,
  [TestKind.BUMP]: bumpTest,
  [TestKind.MILESTONE]: milestoneTest,
};

// The messages one test sends, each with the test line on top, as
// [{ channelId | dm: true, payload }]. Throws TestUnavailable.
// Context:
//   guildSettings
//   guild           { id, name, memberCount, preferredLocale }
//   member          the tester, as a GuildMember or memberLike()
//   language        the server's language (for default texts and the test line)
//   forcedLanguage  BOT_LANGUAGE, for the welcome defaults
//   hereChannelId   where /test was used (level-ups announced "here")
//   feed            the feed to test (FeedStore row)
//   scheduled       the scheduled message to test
export function buildTestMessages(kind, { now = Date.now, ...context }) {
  const build = BUILDERS[kind];
  if (!build) {
    throw new TypeError(`Unknown test: ${kind}`);
  }
  const label = testLabel(context.language, context.member.id);
  return build({ ...context, now }).map((message) => ({ ...message, payload: withTestLabel(message.payload, label) }));
}

// --- Automod -----------------------------------------------------------------------

// The rules a single message can be checked against; spam and repeated
// messages need several messages, so a test only lists them.
const NEEDS_SEVERAL = new Set([AutomodRule.SPAM, AutomodRule.DUPLICATES]);

// Which automod rules a message breaks, without posting or deleting anything.
// `config` is the saved setting or the dashboard's unsaved one (normalized
// here). Returns { enabled (automod on), hits: [{ rule, detail, action, ruleOn,
// on (it and automod are on) }],
// acted: the rule that would act first or null, untested: rules a single
// message can't trip }. Invites are listed even when they might be for this
// server (those are allowed); `maybeOwnServer` marks them.
export function checkAutomodText(savedConfig, text) {
  const config = normalizeAutomod(savedConfig);
  const content = String(text ?? "").slice(0, MAX_AUTOMOD_TEST_LENGTH);
  const hits = [];
  for (const rule of AUTOMOD_RULES) {
    if (NEEDS_SEVERAL.has(rule)) {
      continue;
    }
    const settings = config.rules[rule];
    let detail;
    let extra = {};
    switch (rule) {
      case AutomodRule.BANNED_WORDS:
        detail = findBannedWord(content, settings.words);
        break;
      case AutomodRule.INVITES: {
        const invite = findInvites(content)[0];
        detail = invite?.code;
        extra = invite?.lookup ? { maybeOwnServer: true } : {};
        break;
      }
      case AutomodRule.LINKS:
        detail = findBlockedLink(content, settings.allowedDomains);
        break;
      case AutomodRule.MENTIONS: {
        const count = countMentions(content);
        detail = count >= settings.limit ? String(count) : undefined;
        break;
      }
      case AutomodRule.CAPS:
        detail = isMostlyCaps(content, settings) ? `${settings.percent}%+` : undefined;
        break;
      default:
        detail = textRuleDetail(rule, content, settings);
    }
    if (detail) {
      hits.push({ rule, detail: String(detail).slice(0, 100), action: settings.action, ruleOn: settings.enabled, on: config.enabled && settings.enabled, ...extra });
    }
  }
  const active = new Set(config.enabled ? activeRules(config) : []);
  return {
    enabled: config.enabled,
    hits,
    acted: hits.find((hit) => hit.on)?.rule ?? null,
    untested: [...NEEDS_SEVERAL].filter((rule) => active.has(rule)),
  };
}
