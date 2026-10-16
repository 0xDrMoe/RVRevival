// The web dashboard: a small JSON API plus the static page in public/.
//
//   GET  /auth/login                      sends the person to Discord to log in
//   GET  /auth/callback                   Discord sends them back here
//   POST /auth/logout
//   GET  /api/me                          who is logged in, and the servers they can open
//   GET  /api/guilds/:id                  a server's settings, channels, roles and case counts
//   GET  /api/guilds/:id/stats            numbers for the overview page (?tz=)
//   PUT  /api/guilds/:id/settings         change some settings
//   GET  /api/guilds/:id/cases            search cases (?user=&moderator=&action=&from=&to=&q=&before=)
//   GET  /api/guilds/:id/cases/export     the same search as a CSV file
//   PATCH  /api/guilds/:id/cases/:number  change a case's reason
//   DELETE /api/guilds/:id/cases/:number  delete a case
//   GET  /api/guilds/:id/members          find members by name, or a user by ID (?q=)
//   GET  /api/guilds/:id/members/:user    one person's history: cases, tickets, joins, leaves, roles, level
//   GET  /api/guilds/:id/levels           the XP leaderboard (?page=)
//   GET  /api/guilds/:id/tickets          support tickets (?status=open|closed|all&user=&before=)
//   GET  /api/guilds/:id/tickets/:number  one ticket and its transcript (?download=1 for a .txt file)
//
// Two levels of access to a server the bot is in:
//   - "manage": Manage Server, Administrator or the owner. Everything.
//   - "cases": anyone with one of the server's dashboard roles (a setting). The
//     overview, the cases, member history and tickets, but not the settings.
// That is checked on every request: permissions against their Discord server
// list (re-read at most every few minutes), roles against the bot's view of
// the member (re-read at most every 30 seconds).
// Every change is posted in the server's logs channel, like bot commands are.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { normalizeAutomod } from "../automod/config.js";
import { normalizeAntiNuke } from "../raid/antiNuke.js";
import { levelProgress, normalizeLeveling } from "../leveling/config.js";
import { LevelStore } from "../leveling/levelStore.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { CaseAction } from "../moderation/caseStore.js";
import { MemberEventStore } from "../members/memberEventStore.js";
import { TicketStore } from "../tickets/ticketStore.js";
import { SavedRoles, SavedRoleStore } from "../members/savedRoleStore.js";
import { TempRoleStore } from "../tempRoles/tempRoleStore.js";
import { AppealStatus, APPEAL_STATUSES, AppealStore } from "../appeals/appealStore.js";
import { appealQuestions, MAX_ANSWER_LENGTH, normalizeAppeals } from "../appeals/config.js";
import { normalizeCategories } from "../tickets/categories.js";
import { checkMessage, editableMessage, InvalidMessage, messageSummary, parseMessageLink } from "../messages/embedMessage.js";
import { SentMessageStore } from "../messages/sentMessageStore.js";
import { addFeed, FeedDuplicate, FeedError, FeedLimit } from "../feeds/feeds.js";
import { FEED_KINDS } from "../feeds/fetchFeed.js";
import { FeedStore, MAX_FEEDS } from "../feeds/feedStore.js";
import { checkTemplate, COUNTER_PRESETS, InvalidCounter, MAX_COUNTERS, newCounterId, normalizeCounters } from "../stats/statsCounters.js";
import { buildPanelButtons, buildPanelMessage } from "../tickets/tickets.js";
import { ScheduledMessageStore } from "../scheduled/scheduledMessageStore.js";
import { MAX_DELAY_MS, MAX_INTERVAL_MS, MAX_SCHEDULED, MAX_SCHEDULED_LENGTH, MIN_INTERVAL_MS } from "../scheduled/scheduler.js";
import { buildCaseEmbed } from "../moderation/modLog.js";
import { Setting } from "../settings/guildSettings.js";
import { ActivityStore } from "./activityStore.js";
import { canManage, DiscordApiError } from "./discordApi.js";
import { SESSION_DAYS, SessionStore } from "./sessions.js";
import { checkSettingChanges, describeValue, InvalidSetting, SETTING_RULES } from "./settingsRules.js";

const PUBLIC_FOLDER = fileURLToPath(new URL("./public/", import.meta.url));
const SESSION_COOKIE = "rv_session";
const STATE_COOKIE = "rv_oauth_state";
// How long a person's Discord server list (and their permissions) is trusted.
const GUILD_LIST_MS = 5 * 60 * 1000;
const MAX_REASON_LENGTH = 512;
const CASES_PAGE = 50;
const EXPORT_LIMIT = 10_000;
const LEADERBOARD_PAGE = 25;
const TICKETS_PAGE = 25;
const TICKET_STATUSES = ["open", "closed", "all"];
const MAX_LEADERBOARD_PAGE = 400;
const MAX_SEARCH_LENGTH = 100;
const STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_ID = /^\d{17,20}$/;
const CASE_ACTIONS = Object.values(CaseAction);
const MAX_MEMBER_QUERY = 32;
const HISTORY_CASES = 100;
// Discord IDs hold the time they were made, counted from the start of 2015.
const DISCORD_EPOCH = 1420070400000n;

export const Access = Object.freeze({ MANAGE: "manage", CASES: "cases" });

// What the browser gets for a case.
const caseJson = (moderationCase) => ({
  number: moderationCase.number,
  action: moderationCase.action,
  userId: moderationCase.userId,
  userTag: moderationCase.userTag ?? null,
  moderatorId: moderationCase.moderatorId,
  moderatorTag: moderationCase.moderatorTag ?? null,
  reason: moderationCase.reason ?? null,
  durationMs: moderationCase.durationMs ?? null,
  expiresAt: moderationCase.expiresAt ?? null,
  dmSent: moderationCase.dmSent ?? null,
  createdAt: moderationCase.createdAt,
  updatedAt: moderationCase.updatedAt ?? null,
});

// What the browser gets for a role.
const roleJson = ({ id, name, color, position, managed, hoist, mentionable, permissions, unicode_emoji: emoji }) => ({
  id,
  name,
  color,
  position,
  managed,
  hoist: hoist ?? false,
  mentionable: mentionable ?? false,
  permissions: permissions ?? "0",
  emoji: emoji ?? null,
});

// The case search filters from a query string, or { error } for a 400 reply.
export function parseCaseFilters(query = {}) {
  const { user, moderator, action, from, to, q } = query;
  if (user && !DISCORD_ID.test(user)) {
    return { error: "bad-user", message: "Paste a user ID (17 to 20 digits)." };
  }
  if (moderator && !DISCORD_ID.test(moderator)) {
    return { error: "bad-moderator", message: "Paste a moderator's user ID (17 to 20 digits)." };
  }
  const actions = action ? [...new Set(String(action).split(","))] : [];
  if (!actions.every((name) => CASE_ACTIONS.includes(name))) {
    return { error: "bad-action" };
  }
  const time = (value) => (value === undefined || value === "" ? undefined : Number(value));
  const [fromMs, toMs] = [time(from), time(to)];
  if ([fromMs, toMs].some((value) => value !== undefined && !(Number.isSafeInteger(value) && value >= 0))) {
    return { error: "bad-date" };
  }
  const text = typeof q === "string" ? q.trim() : "";
  if (text.length > MAX_SEARCH_LENGTH) {
    return { error: "bad-search", message: `Search for at most ${MAX_SEARCH_LENGTH} characters.` };
  }
  return {
    filters: {
      userId: user || undefined,
      moderatorId: moderator || undefined,
      actions: actions.length > 0 ? actions : undefined,
      from: fromMs,
      to: toMs,
      text: text || undefined,
    },
  };
}

// One CSV cell. Cells a spreadsheet would run as a formula get a leading '.
function csvCell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// When a Discord account (or anything with an ID) was made.
export const idCreatedAt = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

// What the browser gets for a person in a member search.
const memberResultJson = (user, member) => ({
  id: user.id,
  username: user.username,
  displayName: member?.nick ?? user.global_name ?? user.username,
  avatar: user.avatar ?? null,
  bot: user.bot ?? false,
  inServer: Boolean(member),
});

const sameText = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Options:
//   config          from loadDashboardConfig
//   db              the open database (shared with the bot)
//   discord         from createDiscordApi
//   guildSettings   GuildSettings on the same database
//   store           CaseStore on the same database
//   logger
// `feedFetchOptions` replaces fetch and DNS for feeds in tests.
export async function buildDashboard({ config, db, discord, guildSettings, store, logger, feedFetchOptions }) {
  const sessions = new SessionStore(db, { secret: config.sessionSecret });
  const memberEvents = new MemberEventStore(db);
  const tickets = new TicketStore(db);
  const levels = new LevelStore(db);
  const scheduledMessages = new ScheduledMessageStore(db);
  const activity = new ActivityStore(db);
  const savedRoles = new SavedRoleStore(db);
  const tempRoles = new TempRoleStore(db);
  const appeals = new AppealStore(db);
  const sentMessages = new SentMessageStore(db);
  const feeds = new FeedStore(db);
  const secureCookies = config.url.startsWith("https://");
  const cookieOptions = { path: "/", httpOnly: true, secure: secureCookies, sameSite: "lax" };

  // nginx (or Caddy) on the same machine forwards requests to us.
  const app = Fastify({ logger: false, trustProxy: "127.0.0.1", bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(fastifyStatic, { root: PUBLIC_FOLDER, index: "index.html" });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  // Changes can only come from our own page: browsers always send Origin on
  // these requests, and another site can't fake it.
  app.addHook("onRequest", async (request, reply) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== config.url) {
      return reply.code(403).send({ error: "bad-origin" });
    }
    // Pick up settings the bot (or another dashboard tab) changed.
    if (request.url.startsWith("/api/")) {
      guildSettings.reloadIfChanged();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.code ?? "bad-request", message: error.message });
    }
    logger.error("Dashboard request failed", { method: request.method, url: request.url, error });
    return reply.code(500).send({ error: "internal" });
  });

  // Clear out expired logins every hour.
  const cleanup = setInterval(() => sessions.deleteExpired(), 60 * 60 * 1000);
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));

  // --- Logging in -----------------------------------------------------------

  const authLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.get("/auth/login", authLimit, async (request, reply) => {
    const state = randomBytes(16).toString("base64url");
    reply.setCookie(STATE_COOKIE, state, { ...cookieOptions, signed: true, maxAge: 600 });
    return reply.redirect(discord.authorizeUrl(state));
  });

  app.get("/auth/callback", authLimit, async (request, reply) => {
    const { code, state, error } = request.query ?? {};
    const saved = request.unsignCookie(request.cookies[STATE_COOKIE] ?? "");
    reply.clearCookie(STATE_COOKIE, cookieOptions);
    if (error || !code || !saved.valid || !sameText(saved.value, state)) {
      return reply.redirect("/#/?login=failed");
    }
    let token;
    let user;
    try {
      token = await discord.exchangeCode(String(code));
      user = await discord.fetchUser(token.accessToken);
    } catch (loginError) {
      logger.warn("Dashboard login failed", { error: loginError });
      return reply.redirect("/#/?login=failed");
    }
    const sessionToken = sessions.create({
      userId: user.id,
      username: user.global_name ?? user.username,
      avatar: user.avatar,
      accessToken: token.accessToken,
      expiresInSeconds: token.expiresInSeconds,
    });
    reply.setCookie(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: SESSION_DAYS * 24 * 60 * 60 });
    logger.info("Dashboard login", { userId: user.id });
    return reply.redirect("/");
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = sessions.get(token);
    if (session) {
      await discord.revokeToken(session.accessToken);
    }
    sessions.delete(token);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });

  // --- Who is asking --------------------------------------------------------

  // The logged-in person, or a 401 reply.
  function requireSession(request, reply) {
    const token = request.cookies[SESSION_COOKIE];
    const session = sessions.get(token);
    if (!session) {
      reply.code(401).send({ error: "login" });
      return undefined;
    }
    return { ...session, token };
  }

  // The servers this person might open: the ones they manage, and the ones the
  // bot is in (where a dashboard role could let them in). [{ id, name, icon,
  // manage }], from Discord at most every GUILD_LIST_MS (or right away with
  // `refresh`). Lists saved by older versions only held managed servers.
  async function knownGuilds(session, { refresh = false } = {}) {
    const fresh = session.guilds && Date.now() - session.guildsLoadedAt < GUILD_LIST_MS;
    if (fresh && !refresh) {
      return session.guilds.map((guild) => ({ manage: true, ...guild }));
    }
    const [userGuilds, botGuilds] = await Promise.all([discord.fetchUserGuilds(session.accessToken), discord.botGuildIds()]);
    const guilds = userGuilds
      .filter((guild) => canManage(guild) || botGuilds.has(guild.id))
      .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon ?? null, manage: canManage(guild) }));
    sessions.setGuilds(session.token, guilds);
    return guilds;
  }

  // Access.MANAGE, Access.CASES or undefined, for one entry of knownGuilds.
  async function accessTo(session, guild) {
    if (guild.manage) {
      return Access.MANAGE;
    }
    const roles = guildSettings.getList(guild.id, Setting.DASHBOARD_ROLES);
    if (roles.length === 0) {
      return undefined;
    }
    const member = await discord.member(guild.id, session.userId);
    return member?.roles?.some((role) => roles.includes(role)) ? Access.CASES : undefined;
  }

  // Ends the session if Discord no longer accepts its access token.
  async function withDiscordLogin(session, reply, work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 401) {
        sessions.delete(session.token);
        reply.clearCookie(SESSION_COOKIE, cookieOptions);
        return reply.code(401).send({ error: "login" });
      }
      throw error;
    }
  }

  // The session, server and access level for /api/guilds/:id routes, or
  // undefined after replying 401, 403 or 404. `manage` routes need Access.MANAGE.
  async function requireGuild(request, reply, { manage = false } = {}) {
    const session = requireSession(request, reply);
    if (!session) {
      return undefined;
    }
    const guildId = request.params.id;
    if (!DISCORD_ID.test(guildId)) {
      reply.code(404).send({ error: "not-found" });
      return undefined;
    }
    const guilds = await withDiscordLogin(session, reply, () => knownGuilds(session));
    if (reply.sent) {
      return undefined;
    }
    const guild = guilds.find((entry) => entry.id === guildId);
    if (!guild) {
      reply.code(403).send({ error: "forbidden" });
      return undefined;
    }
    if (!(await discord.botGuildIds()).has(guildId)) {
      reply.code(404).send({ error: "bot-not-in-server" });
      return undefined;
    }
    const access = await accessTo(session, guild);
    if (!access || (manage && access !== Access.MANAGE)) {
      reply.code(403).send({ error: "forbidden" });
      return undefined;
    }
    return { session, guildId, access };
  }

  // A server's settings for the browser. Automod and leveling always come with
  // every default filled in, so the page can show them as they are.
  const settingsJson = (guildId) => ({
    ...guildSettings.all(guildId),
    [Setting.AUTOMOD]: normalizeAutomod(guildSettings.get(guildId, Setting.AUTOMOD)),
    [Setting.LEVELING]: normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING)),
    [Setting.ANTI_NUKE]: normalizeAntiNuke(guildSettings.get(guildId, Setting.ANTI_NUKE)),
    [Setting.APPEALS]: normalizeAppeals(guildSettings.get(guildId, Setting.APPEALS)),
  });

  // Gives the ticket panel's message the current category buttons. Panels
  // posted before titles were saved keep their text and only get new buttons.
  // Returns false if Discord refused (the message was deleted, say).
  async function redrawTicketPanel(guildId, guild) {
    const panel = guildSettings.get(guildId, Setting.TICKETS);
    if (!panel?.channelId) {
      return true;
    }
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const categories = normalizeCategories(guildSettings.get(guildId, Setting.TICKET_CATEGORIES));
    let payload;
    if ("title" in panel) {
      const message = buildPanelMessage(language, { title: panel.title, message: panel.message, categories });
      payload = { embeds: message.embeds.map((embed) => embed.toJSON()), components: message.components.map((row) => row.toJSON()) };
    } else {
      payload = { components: [buildPanelButtons(language, categories).toJSON()] };
    }
    try {
      await discord.editMessage(panel.channelId, panel.messageId, payload);
      return true;
    } catch (error) {
      logger.warn("Couldn't update the ticket panel", { guildId, error });
      return false;
    }
  }

  const communityDefaults = (guild) => {
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    return {
      [Setting.WELCOME_MESSAGE]: translate(language, "welcomeDefaultWelcome"),
      [Setting.LEAVE_MESSAGE]: translate(language, "welcomeDefaultLeave"),
      levelUpMessage: translate(language, "levelUpDefault"),
      birthdayMessage: translate(language, "birthdayDefaultMessage"),
    };
  };

  // Records what someone did on the dashboard (Activity page) and posts it in
  // the server's logs channel when there is one.
  async function logAction(guildId, session, summary, lines = []) {
    try {
      activity.add({ guildId, userId: session.userId, userName: session.username, summary, lines });
    } catch (error) {
      logger.warn("Couldn't save a dashboard change", { guildId, error });
    }
    const channelId = guildSettings.get(guildId, Setting.LOGS_CHANNEL);
    if (!channelId) {
      return;
    }
    const embed = {
      color: 0x5865f2,
      author: { name: `${session.username} · dashboard` },
      description: [summary, ...lines].join("\n").slice(0, 4096),
      footer: { text: `User ID ${session.userId}` },
      timestamp: new Date().toISOString(),
    };
    await discord.postMessage(channelId, { embeds: [embed] }).catch((error) =>
      logger.warn("Couldn't post a dashboard change in the logs channel", { guildId, error }),
    );
  }

  // --- API ------------------------------------------------------------------

  app.get("/api/me", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return reply;
    }
    return withDiscordLogin(session, reply, async () => {
      const guilds = await knownGuilds(session, { refresh: request.query?.refresh === "1" });
      const botGuilds = await discord.botGuildIds();
      const listed = await Promise.all(
        guilds.map(async (guild) => {
          const botPresent = botGuilds.has(guild.id);
          // A role lookup fails if the bot just left; then the server isn't listed.
          const access = botPresent ? await accessTo(session, guild).catch(() => undefined) : guild.manage && Access.MANAGE;
          if (!access) {
            return undefined;
          }
          return { id: guild.id, name: guild.name, icon: guild.icon, botPresent, access };
        }),
      );
      return {
        user: { id: session.userId, username: session.username, avatar: session.avatar ?? null },
        guilds: listed.filter(Boolean),
        inviteUrl:
          `https://discord.com/oauth2/authorize?client_id=${discord.clientId}` +
          "&scope=bot+applications.commands&permissions=1460709485718",
      };
    });
  });

  app.get("/api/guilds/:id", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const manage = access.access === Access.MANAGE;
    const [guild, channels] = await Promise.all([discord.guild(guildId), manage ? discord.channels(guildId) : []]);
    return {
      guild: {
        id: guild.id,
        name: guild.name,
        icon: guild.icon ?? null,
        memberCount: guild.approximate_member_count ?? null,
        onlineCount: guild.approximate_presence_count ?? null,
        // Community servers have Discord's Onboarding, which the Community page recommends over autoroles.
        community: Array.isArray(guild.features) && guild.features.includes("COMMUNITY"),
      },
      access: access.access,
      // Anti-nuke can only be changed by the owner.
      isOwner: guild.owner_id === access.session.userId,
      // Names for the user IDs the settings mention (anti-nuke's trusted people).
      people: manage ? await peopleNames(guildId, normalizeAntiNuke(guildSettings.get(guildId, Setting.ANTI_NUKE)).trustedUserIds) : {},
      // People with a dashboard role only see the cases, not how the server is set up.
      settings: manage ? settingsJson(guildId) : null,
      channels: channels
        .map(({ id, name, type, parent_id: parentId, position }) => ({ id, name, type, parentId: parentId ?? null, position }))
        .sort((a, b) => a.position - b.position),
      roles: manage
        ? guild.roles
            .filter((role) => role.id !== guildId)
            .map(roleJson)
            .sort((a, b) => b.position - a.position)
        : [],
      caseCounts: store.countGuildCases(guildId),
      // What the bot posts when no welcome or leave message is set, in the server's language.
      communityDefaults: manage ? communityDefaults(guild) : null,
    };
  });

  app.get("/api/guilds/:id/stats", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    // The viewer's time zone, as Date.getTimezoneOffset() gives it (minutes behind UTC).
    const tz = Number(request.query?.tz ?? 0);
    if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) {
      return reply.code(400).send({ error: "bad-time-zone" });
    }
    const dayOffsetMs = tz * 60 * 1000;
    const today = Math.floor((Date.now() - dayOffsetMs) / DAY_MS);
    const firstDay = today - (STATS_DAYS - 1);
    const stats = store.caseStats(access.guildId, { since: firstDay * DAY_MS + dayOffsetMs, dayOffsetMs });
    return {
      days: STATS_DAYS,
      firstDay,
      dayStarts: Array.from({ length: STATS_DAYS }, (_, index) => (firstDay + index) * DAY_MS + dayOffsetMs),
      perDay: stats.perDay.map((entry) => ({ ...entry, day: entry.day - firstDay })),
      topModerators: stats.topModerators,
      topMembers: stats.topMembers,
      runningTempBans: stats.runningTempBans,
      caseCounts: store.countGuildCases(access.guildId),
      recent: store.searchCases(access.guildId, { limit: 6 }).map(caseJson),
    };
  });

  app.put("/api/guilds/:id/settings", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    let changes;
    try {
      changes = checkSettingChanges(request.body, { guildId, channels, roles: guild.roles });
    } catch (error) {
      if (error instanceof InvalidSetting) {
        return reply.code(400).send({ error: "invalid-setting", setting: error.setting ?? null, message: error.message });
      }
      throw error;
    }

    const NORMALIZE = {
      [Setting.AUTOMOD]: normalizeAutomod,
      [Setting.LEVELING]: normalizeLeveling,
      [Setting.ANTI_NUKE]: normalizeAntiNuke,
      [Setting.APPEALS]: normalizeAppeals,
    };
    const ownerOnly = Object.keys(changes).filter((setting) => {
      if (!SETTING_RULES[setting].ownerOnly) {
        return false;
      }
      const before = NORMALIZE[setting] ? NORMALIZE[setting](guildSettings.get(guildId, setting)) : guildSettings.get(guildId, setting);
      return JSON.stringify(before ?? null) !== JSON.stringify(changes[setting]);
    });
    if (ownerOnly.length > 0 && guild.owner_id !== session.userId) {
      return reply.code(403).send({ error: "owner-only", setting: ownerOnly[0], message: "Only the server owner can change this." });
    }

    const lines = [];
    for (const [setting, value] of Object.entries(changes)) {
      const saved = guildSettings.get(guildId, setting);
      // Unsaved automod, leveling or anti-nuke means the defaults, which is what the page was shown.
      const before = NORMALIZE[setting] ? NORMALIZE[setting](saved) : saved;
      if (JSON.stringify(before ?? null) === JSON.stringify(value)) {
        continue;
      }
      if (value === null) {
        await guildSettings.clear(guildId, setting);
      } else {
        await guildSettings.set(guildId, setting, value);
      }
      lines.push(`**${SETTING_RULES[setting].label}:** ${describeValue(setting, before)} → ${describeValue(setting, value)}`);
      if (setting === Setting.TICKET_CATEGORIES && !(await redrawTicketPanel(guildId, guild))) {
        lines.push("The ticket panel couldn't be updated; post it again with `/tickets panel`.");
      }
    }
    if (lines.length > 0) {
      logger.info("Dashboard settings change", { guildId, userId: session.userId, settings: Object.keys(changes) });
      await logAction(guildId, session, "**Settings changed**", lines);
    }
    return { settings: settingsJson(guildId) };
  });

  app.get("/api/guilds/:id/cases", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { filters, error, message } = parseCaseFilters(request.query);
    if (error) {
      return reply.code(400).send({ error, message });
    }
    const before = request.query?.before;
    const beforeNumber = before === undefined ? undefined : Number(before);
    if (beforeNumber !== undefined && !Number.isInteger(beforeNumber)) {
      return reply.code(400).send({ error: "bad-page" });
    }
    const cases = store.searchCases(access.guildId, { ...filters, before: beforeNumber, limit: CASES_PAGE + 1 });
    const page = cases.slice(0, CASES_PAGE);
    return {
      cases: page.map(caseJson),
      nextBefore: cases.length > CASES_PAGE ? page.at(-1).number : null,
      // Only counted for the first page.
      total: beforeNumber === undefined ? store.countMatchingCases(access.guildId, filters) : null,
    };
  });

  app.get("/api/guilds/:id/cases/export", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { filters, error, message } = parseCaseFilters(request.query);
    if (error) {
      return reply.code(400).send({ error, message });
    }
    const header = ["Case", "Action", "Member ID", "Member", "Moderator ID", "Moderator", "Reason", "Duration (minutes)", "Date (UTC)"];
    const rows = store.searchCases(access.guildId, { ...filters, limit: EXPORT_LIMIT }).map((entry) => [
      entry.number,
      entry.action,
      entry.userId,
      entry.userTag,
      entry.moderatorId,
      entry.moderatorTag,
      entry.reason,
      entry.durationMs ? Math.round(entry.durationMs / 60000) : "",
      new Date(entry.createdAt).toISOString(),
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="cases-${access.guildId}.csv"`)
      .send(`\uFEFF${csv}\r\n`);
  });

  // The case number from the URL, or undefined after replying 404.
  function caseNumber(request, reply) {
    const number = Number(request.params.number);
    if (!Number.isInteger(number) || number < 1) {
      reply.code(404).send({ error: "not-found" });
      return undefined;
    }
    return number;
  }

  app.patch("/api/guilds/:id/cases/:number", async (request, reply) => {
    const access = await requireGuild(request, reply);
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const reason = request.body?.reason;
    if (typeof reason !== "string" || reason.trim().length > MAX_REASON_LENGTH) {
      return reply.code(400).send({ error: "bad-reason", message: `Reasons are at most ${MAX_REASON_LENGTH} characters.` });
    }
    const { guildId, session } = access;
    const updated = store.updateReason(guildId, number, reason.trim() || undefined);
    if (!updated) {
      return reply.code(404).send({ error: "not-found" });
    }
    // Update the case's post in the mod log, like /case reason does.
    if (updated.logChannelId && updated.logMessageId) {
      await discord
        .editMessage(updated.logChannelId, updated.logMessageId, { embeds: [buildCaseEmbed(updated).toJSON()] })
        .catch((error) => logger.warn("Couldn't update a case's mod-log post", { guildId, number, error }));
    }
    await logAction(guildId, session, `**Case #${number} reason changed**`, [updated.reason ?? "*no reason*"]);
    return { case: caseJson(updated) };
  });

  app.delete("/api/guilds/:id/cases/:number", async (request, reply) => {
    const access = await requireGuild(request, reply);
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const { guildId, session } = access;
    const existing = store.getCase(guildId, number);
    if (!existing || !store.deleteCase(guildId, number)) {
      return reply.code(404).send({ error: "not-found" });
    }
    await logAction(guildId, session, `**Case #${number} deleted** (${existing.action} of <@${existing.userId}>)`);
    return { ok: true };
  });

  // --- Member history ------------------------------------------------------

  const searchLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.get("/api/guilds/:id/members", searchLimit, async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const query = typeof request.query?.q === "string" ? request.query.q.trim() : "";
    if (query.length === 0 || query.length > MAX_MEMBER_QUERY) {
      return reply.code(400).send({ error: "bad-search", message: `Search for 1 to ${MAX_MEMBER_QUERY} characters.` });
    }
    const { guildId } = access;
    if (DISCORD_ID.test(query)) {
      const member = await discord.member(guildId, query);
      const user = member?.user ?? (await discord.user(query));
      return { members: user ? [memberResultJson(user, member)] : [] };
    }
    const found = await discord.searchMembers(guildId, query);
    return { members: found.map((member) => memberResultJson(member.user, member)) };
  });

  app.get("/api/guilds/:id/members/:user", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const userId = request.params.user;
    if (!DISCORD_ID.test(userId)) {
      return reply.code(404).send({ error: "not-found" });
    }
    const [member, guild] = await Promise.all([discord.member(guildId, userId), discord.guild(guildId)]);
    const user = member?.user ?? (await discord.user(userId));
    const cases = store.listCases(guildId, userId, HISTORY_CASES);
    if (!user && cases.length === 0) {
      return reply.code(404).send({ error: "not-found" });
    }
    // Only looked up for people who aren't in the server. Without Ban Members, Discord refuses (403).
    const ban = member ? null : await discord.ban(guildId, userId).catch(() => null);
    const rolesById = new Map(guild.roles.map((role) => [role.id, role]));
    const now = Date.now();
    const tempBan = cases.find((entry) => entry.action === CaseAction.BAN && entry.pendingUnban && entry.expiresAt > now);
    const timedOutUntil = member?.communication_disabled_until ? Date.parse(member.communication_disabled_until) : null;
    return {
      user: {
        id: userId,
        username: user?.username ?? cases[0].userTag ?? null,
        displayName: member?.nick ?? user?.global_name ?? user?.username ?? cases[0].userTag ?? null,
        avatar: user?.avatar ?? null,
        bot: user?.bot ?? false,
        createdAt: idCreatedAt(userId),
      },
      member: member
        ? {
            joinedAt: member.joined_at ? Date.parse(member.joined_at) : null,
            timedOutUntil: timedOutUntil > now ? timedOutUntil : null,
            roles: member.roles
              .map((roleId) => rolesById.get(roleId))
              .filter(Boolean)
              .sort((a, b) => b.position - a.position)
              .map(({ id, name, color }) => ({ id, name, color })),
          }
        : null,
      banned: ban ? { reason: ban.reason ?? null } : null,
      quarantine: (() => {
        const saved = savedRoles.get(guildId, userId, SavedRoles.QUARANTINE);
        return saved ? { since: saved.savedAt, reason: saved.reason, moderatorId: saved.moderatorId, roleIds: saved.roleIds } : null;
      })(),
      tempBanEndsAt: tempBan?.expiresAt ?? null,
      tempRoles: tempRoles.listForUser(guildId, userId).map((entry) => ({
        roleId: entry.roleId,
        roleName: rolesById.get(entry.roleId)?.name ?? null,
        expiresAt: entry.expiresAt,
      })),
      caseCounts: store.countCases(guildId, userId),
      cases: cases.map(caseJson),
      events: memberEvents.list(guildId, userId),
      joins: memberEvents.countJoins(guildId, userId),
      tickets: tickets.listForUser(guildId, userId).map((ticket) => ({
        number: ticket.number,
        subject: ticket.subject,
        threadId: ticket.threadId,
        createdAt: ticket.createdAt,
        closedAt: ticket.closedAt,
        closeReason: ticket.closeReason,
        hasTranscript: ticket.hasTranscript,
      })),
      level: levelJson(guildId, userId),
    };
  });

  // --- Tickets -------------------------------------------------------------

  // Names for the people on a page of tickets, from Discord (cached).
  async function peopleNames(guildId, userIds) {
    const entries = await Promise.all(
      [...new Set(userIds.filter(Boolean))].map(async (userId) => {
        const member = await discord.member(guildId, userId).catch(() => null);
        const user = member?.user ?? (await discord.user(userId).catch(() => null));
        return [userId, member?.nick ?? user?.global_name ?? user?.username ?? null];
      }),
    );
    return Object.fromEntries(entries);
  }

  const ticketJson = (ticket, names = {}) => ({
    number: ticket.number,
    userId: ticket.userId,
    userName: names[ticket.userId] ?? null,
    subject: ticket.subject,
    category: ticket.categoryLabel,
    threadId: ticket.threadId,
    createdAt: ticket.createdAt,
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    closedByName: names[ticket.closedBy] ?? null,
    closeReason: ticket.closeReason,
    hasTranscript: ticket.hasTranscript,
    messageCount: ticket.messageCount,
  });

  app.get("/api/guilds/:id/tickets", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const query = request.query ?? {};
    const status = TICKET_STATUSES.includes(query.status) ? query.status : "all";
    const userId = typeof query.user === "string" && query.user !== "" ? query.user : null;
    if (userId !== null && !DISCORD_ID.test(userId)) {
      return reply.code(400).send({ error: "bad-user", message: "Use a Discord user ID." });
    }
    const before = Number.parseInt(query.before ?? "", 10);
    const found = tickets.search(guildId, {
      status,
      userId,
      before: Number.isInteger(before) && before > 0 ? before : null,
      limit: TICKETS_PAGE + 1,
    });
    const page = found.slice(0, TICKETS_PAGE);
    const names = await peopleNames(guildId, page.flatMap((ticket) => [ticket.userId, ticket.closedBy]));
    return {
      tickets: page.map((ticket) => ticketJson(ticket, names)),
      next: found.length > TICKETS_PAGE ? page.at(-1).number : null,
      openCount: tickets.countOpen(guildId),
      panel: Boolean(guildSettings.get(guildId, Setting.TICKETS)?.channelId),
    };
  });

  app.get("/api/guilds/:id/tickets/:number", async (request, reply) => {
    const access = await requireGuild(request, reply);
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const { guildId } = access;
    const ticket = tickets.byNumber(guildId, number);
    if (!ticket) {
      return reply.code(404).send({ error: "not-found" });
    }
    const transcript = tickets.transcript(guildId, number) ?? null;
    if (request.query?.download === "1") {
      if (transcript === null) {
        return reply.code(404).send({ error: "no-transcript" });
      }
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="ticket-${String(number).padStart(4, "0")}.txt"`)
        .send(transcript);
    }
    const names = await peopleNames(guildId, [ticket.userId, ticket.closedBy]);
    return { ticket: ticketJson(ticket, names), transcript };
  });

  // --- Leveling ------------------------------------------------------------

  // A member's level, or null if they have no XP.
  const levelJson = (guildId, userId) => {
    const entry = levels.get(guildId, userId);
    if (!entry || entry.xp <= 0) {
      return null;
    }
    return { ...levelProgress(entry.xp), xp: entry.xp, messages: entry.messages, rank: levels.rank(guildId, userId) };
  };

  app.get("/api/guilds/:id/levels", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const requested = Number.parseInt(request.query?.page ?? "1", 10);
    const page = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_LEADERBOARD_PAGE) : 1;
    const offset = (page - 1) * LEADERBOARD_PAGE;
    const total = levels.count(guildId);
    return {
      enabled: normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING)).enabled,
      page,
      pageSize: LEADERBOARD_PAGE,
      total,
      entries: levels.top(guildId, { limit: LEADERBOARD_PAGE, offset }).map((entry, index) => ({
        rank: offset + index + 1,
        userId: entry.userId,
        userTag: entry.userTag,
        xp: entry.xp,
        messages: entry.messages,
        ...levelProgress(entry.xp),
      })),
    };
  });

  // --- Scheduled messages --------------------------------------------------

  const SCHEDULE_CHANNELS = [0, 5]; // text, announcement
  const MENTION_EVERYONE = (1n << 17n) | (1n << 3n); // Mention Everyone, or Administrator

  // Whether someone may ping @everyone and roles in this server, from their roles.
  async function canMentionEveryone(guild, userId) {
    if (guild.owner_id === userId) {
      return true;
    }
    const member = await discord.member(guild.id, userId).catch(() => null);
    const roleIds = new Set([guild.id, ...(member?.roles ?? [])]);
    const permissions = guild.roles
      .filter((role) => roleIds.has(role.id))
      .reduce((total, role) => total | BigInt(role.permissions ?? 0), 0n);
    return (permissions & MENTION_EVERYONE) !== 0n;
  }

  const scheduledJson = (message, names = {}) => ({
    id: message.id,
    channelId: message.channelId,
    content: message.content,
    nextAt: message.nextAt,
    intervalMs: message.intervalMs,
    allowMentions: message.allowMentions,
    createdBy: message.createdBy,
    createdByName: names[message.createdBy] ?? null,
    createdAt: message.createdAt,
  });

  app.get("/api/guilds/:id/scheduled", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const messages = scheduledMessages.list(access.guildId);
    const names = await peopleNames(access.guildId, messages.map((message) => message.createdBy));
    return { messages: messages.map((message) => scheduledJson(message, names)), max: MAX_SCHEDULED };
  });

  app.post("/api/guilds/:id/scheduled", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const body = request.body ?? {};
    const refuse = (message) => reply.code(400).send({ error: "invalid-scheduled", message });
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    if (!channels.some((channel) => channel.id === body.channelId && SCHEDULE_CHANNELS.includes(channel.type))) {
      return refuse("Pick a text or announcement channel from this server.");
    }
    const content = typeof body.content === "string" ? body.content.replace(/\r\n?/g, "\n").trim() : "";
    if (!content || content.length > MAX_SCHEDULED_LENGTH) {
      return refuse(`Write a message of 1 to ${MAX_SCHEDULED_LENGTH} characters.`);
    }
    const now = Date.now();
    if (!Number.isSafeInteger(body.at) || body.at <= now || body.at > now + MAX_DELAY_MS) {
      return refuse("Pick a time in the future, within a year.");
    }
    const intervalMs = body.intervalMs ?? null;
    if (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) {
      return refuse("Repeat at most once an hour and at least once a year.");
    }
    if (scheduledMessages.count(guildId) >= MAX_SCHEDULED) {
      return refuse(`This server already has ${MAX_SCHEDULED} scheduled messages. Delete one first.`);
    }
    const saved = scheduledMessages.add({
      guildId,
      channelId: body.channelId,
      content,
      nextAt: body.at,
      intervalMs,
      allowMentions: await canMentionEveryone(guild, session.userId),
      createdBy: session.userId,
      createdAt: now,
    });
    await logAction(guildId, session, `**Scheduled message #${saved.id} added** for <#${saved.channelId}>`, [
      `First post: <t:${Math.floor(saved.nextAt / 1000)}:f>${intervalMs ? ` · repeats every ${Math.round(intervalMs / 3_600_000)}h` : ""}`,
    ]);
    return { message: scheduledJson(saved) };
  });

  app.delete("/api/guilds/:id/scheduled/:number", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    if (!scheduledMessages.deleteInGuild(access.guildId, number)) {
      return reply.code(404).send({ error: "not-found" });
    }
    await logAction(access.guildId, access.session, `**Scheduled message #${number} deleted**`);
    return { ok: true };
  });

  // --- Ban appeals ------------------------------------------------------------
  //
  // Anyone logged in can open a server's appeal page; only people the server
  // banned can send an appeal there. Staff accept (which lifts the ban) or deny.

  const DAY_MS = 24 * 60 * 60 * 1000;
  const appealLimit = { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } };

  const appealJson = (appeal, names = {}) => ({
    number: appeal.number,
    userId: appeal.userId,
    userTag: appeal.userTag,
    userName: names[appeal.userId] ?? null,
    banReason: appeal.banReason,
    answers: appeal.answers,
    status: appeal.status,
    createdAt: appeal.createdAt,
    decidedAt: appeal.decidedAt,
    decidedBy: appeal.decidedBy,
    decidedByName: names[appeal.decidedBy] ?? null,
    decisionReason: appeal.decisionReason,
  });

  // Where someone stands with a server's appeals: closed (appeals are off),
  // not-banned, pending (an appeal is open), cooldown (recently denied) or
  // can-appeal. Returns { state, ban, latest, cooldownEndsAt, config }.
  async function appealState(guildId, userId) {
    const config = normalizeAppeals(guildSettings.get(guildId, Setting.APPEALS));
    const latest = appeals.latestFor(guildId, userId);
    if (!config.enabled) {
      return { state: "closed", latest, config };
    }
    // Without Ban Members the bot can't check (403); treat it as not banned.
    const ban = await discord.ban(guildId, userId).catch(() => null);
    const cooldownEndsAt =
      latest?.status === AppealStatus.DENIED && config.cooldownDays > 0 ? latest.decidedAt + config.cooldownDays * DAY_MS : null;
    const state = !ban
      ? "not-banned"
      : latest?.status === AppealStatus.OPEN
        ? "pending"
        : cooldownEndsAt && cooldownEndsAt > Date.now()
          ? "cooldown"
          : "can-appeal";
    return { state, ban, latest, cooldownEndsAt, config };
  }

  // The appeal page's server, or undefined after replying 404.
  async function appealGuild(request, reply) {
    const guildId = request.params.guildId;
    if (!DISCORD_ID.test(guildId) || !(await discord.botGuildIds()).has(guildId)) {
      reply.code(404).send({ error: "not-found" });
      return undefined;
    }
    return discord.guild(guildId);
  }

  app.get("/api/appeals/:guildId", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return reply;
    }
    const guild = await appealGuild(request, reply);
    if (!guild) {
      return reply;
    }
    const { state, ban, latest, cooldownEndsAt, config: appealConfig } = await appealState(guild.id, session.userId);
    return {
      guild: { id: guild.id, name: guild.name, icon: guild.icon ?? null },
      state,
      banReason: ban?.reason ?? null,
      questions: appealQuestions(appealConfig),
      maxAnswer: MAX_ANSWER_LENGTH,
      latest: latest
        ? { number: latest.number, status: latest.status, createdAt: latest.createdAt, decidedAt: latest.decidedAt, decisionReason: latest.decisionReason }
        : null,
      cooldownEndsAt: state === "cooldown" ? cooldownEndsAt : null,
    };
  });

  app.post("/api/appeals/:guildId", appealLimit, async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return reply;
    }
    const guild = await appealGuild(request, reply);
    if (!guild) {
      return reply;
    }
    const { state, ban, config: appealConfig } = await appealState(guild.id, session.userId);
    if (state !== "can-appeal") {
      return reply.code(409).send({ error: state });
    }
    const questions = appealQuestions(appealConfig);
    const answers = Array.isArray(request.body?.answers) ? request.body.answers : [];
    const cleaned = answers.map((answer) => (typeof answer === "string" ? answer.replace(/\r\n?/g, "\n").trim() : ""));
    if (cleaned.length !== questions.length || cleaned.some((answer) => !answer || answer.length > MAX_ANSWER_LENGTH)) {
      return reply.code(400).send({ error: "bad-answers", message: `Answer every question (up to ${MAX_ANSWER_LENGTH} characters each).` });
    }
    const appeal = appeals.add({
      guildId: guild.id,
      userId: session.userId,
      userTag: session.username,
      banReason: ban?.reason ?? null,
      answers: questions.map((question, index) => ({ question, answer: cleaned[index] })),
    });
    logger.info("Ban appeal sent", { guildId: guild.id, number: appeal.number });

    // Tell staff where they asked, or in the mod-log or logs channel.
    const channelId =
      appealConfig.channelId ?? guildSettings.get(guild.id, Setting.MOD_LOG_CHANNEL) ?? guildSettings.get(guild.id, Setting.LOGS_CHANNEL);
    if (channelId) {
      const embed = {
        color: 0xfee75c,
        title: `Ban appeal #${appeal.number}`,
        description: `<@${session.userId}> (${session.username}) asks to be unbanned.`,
        fields: [
          { name: "Ban reason", value: (appeal.banReason ?? "*none given*").slice(0, 1024) },
          ...appeal.answers.map((entry) => ({ name: (entry.question ?? "Why should the ban be lifted?").slice(0, 256), value: entry.answer.slice(0, 1024) })),
          { name: "Decide", value: `${config.url}/#/g/${guild.id}/appeals?appeal=${appeal.number}` },
        ],
        footer: { text: `User ID ${session.userId}` },
        timestamp: new Date(appeal.createdAt).toISOString(),
      };
      await discord.postMessage(channelId, { embeds: [embed] }).catch((error) =>
        logger.warn("Couldn't post a ban appeal for staff", { guildId: guild.id, error }),
      );
    }
    return { appeal: { number: appeal.number, status: appeal.status, createdAt: appeal.createdAt } };
  });

  app.get("/api/guilds/:id/appeals", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const status = APPEAL_STATUSES.includes(request.query?.status) ? request.query.status : undefined;
    const page = Math.max(0, Number.parseInt(request.query?.page ?? "0", 10) || 0);
    const list = appeals.list(access.guildId, { status, limit: 26, offset: page * 25 });
    const shown = list.slice(0, 25);
    const names = await peopleNames(access.guildId, shown.flatMap((appeal) => [appeal.userId, appeal.decidedBy]));
    return { appeals: shown.map((appeal) => appealJson(appeal, names)), more: list.length > 25, openCount: appeals.countOpen(access.guildId) };
  });

  app.get("/api/guilds/:id/appeals/:number", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const appeal = appeals.get(access.guildId, number);
    if (!appeal) {
      return reply.code(404).send({ error: "not-found" });
    }
    const names = await peopleNames(access.guildId, [appeal.userId, appeal.decidedBy]);
    return { appeal: appealJson(appeal, names) };
  });

  app.post("/api/guilds/:id/appeals/:number", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const { guildId, session } = access;
    const decision = request.body?.decision;
    if (decision !== "accept" && decision !== "deny") {
      return reply.code(400).send({ error: "bad-decision" });
    }
    const reason = typeof request.body?.reason === "string" ? request.body.reason.trim().slice(0, MAX_REASON_LENGTH) || null : null;
    const appeal = appeals.get(guildId, number);
    if (!appeal) {
      return reply.code(404).send({ error: "not-found" });
    }
    if (appeal.status !== AppealStatus.OPEN) {
      return reply.code(409).send({ error: "already-decided" });
    }

    if (decision === "accept") {
      try {
        await discord.unban(guildId, appeal.userId, `Appeal #${number} accepted by ${session.username}${reason ? `: ${reason}` : ""}`);
      } catch (error) {
        // Already unbanned (10026 Unknown Ban) is fine; anything else isn't.
        if (error.status !== 404) {
          logger.warn("Couldn't lift a ban for an accepted appeal", { guildId, number, error });
          return reply.code(502).send({ error: "unban-failed", message: "Discord refused to lift the ban. Does the bot have Ban Members?" });
        }
      }
      const unbanCase = store.createCase({
        guildId,
        action: CaseAction.UNBAN,
        userId: appeal.userId,
        userTag: appeal.userTag ?? undefined,
        moderatorId: session.userId,
        moderatorTag: session.username,
        reason: `Appeal #${number} accepted${reason ? `: ${reason}` : ""}`,
      });
      const logChannelId = guildSettings.get(guildId, Setting.MOD_LOG_CHANNEL) ?? guildSettings.get(guildId, Setting.LOGS_CHANNEL);
      if (logChannelId) {
        const posted = await discord.postMessage(logChannelId, { embeds: [buildCaseEmbed(unbanCase).toJSON()] }).catch(() => null);
        if (posted?.id) {
          store.setLogMessage(guildId, unbanCase.number, logChannelId, posted.id);
        }
      }
    }
    const decided = appeals.decide(guildId, number, {
      status: decision === "accept" ? AppealStatus.ACCEPTED : AppealStatus.DENIED,
      decidedBy: session.userId,
      reason,
    });
    if (!decided) {
      return reply.code(409).send({ error: "already-decided" });
    }

    // Let them know, in the server's language. Fails quietly when DMs are closed.
    const guild = await discord.guild(guildId);
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const lines = [translate(language, decision === "accept" ? "appealAcceptedDm" : "appealDeniedDm", { server: guild.name })];
    if (reason) {
      lines.push(translate(language, "dmReason", { reason }));
    }
    await discord.dm(appeal.userId, { content: lines.join("\n").slice(0, 2000) }).catch(() => {});
    await logAction(guildId, session, `**Ban appeal #${number} ${decision === "accept" ? "accepted" : "denied"}** for <@${appeal.userId}>`, reason ? [reason] : []);
    const names = await peopleNames(guildId, [decided.userId, decided.decidedBy]);
    return { appeal: appealJson(decided, names) };
  });

  // --- Embed builder ------------------------------------------------------------

  // Posts and edits the bot's own messages: some text and one embed.
  const POSTABLE = new Set([0, 5]); // text and announcement channels

  // The checked message body, or undefined after replying 400.
  function messageBody(request, reply) {
    try {
      return checkMessage(request.body?.message);
    } catch (error) {
      if (error instanceof InvalidMessage) {
        reply.code(400).send({ error: "invalid-message", message: error.message });
        return undefined;
      }
      throw error;
    }
  }

  // Discord's refusals, in words.
  function discordRefused(reply, error) {
    if (error.status === 403) {
      return reply.code(403).send({ error: "bot-forbidden", message: "The bot can't post there. It needs View Channel, Send Messages and Embed Links in that channel." });
    }
    if (error.status === 404) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    if (error.status === 400) {
      return reply.code(400).send({ error: "discord-refused", message: "Discord refused the message. Check the image and icon links." });
    }
    throw error;
  }

  const sentJson = (entry, names = {}) => ({ ...entry, sentByName: names[entry.sentBy] ?? null, editedByName: names[entry.editedBy] ?? null });

  app.get("/api/guilds/:id/messages", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const list = sentMessages.list(access.guildId, 25);
    const names = await peopleNames(access.guildId, list.flatMap((entry) => [entry.sentBy, entry.editedBy]));
    return { messages: list.map((entry) => sentJson(entry, names)) };
  });

  app.post("/api/guilds/:id/messages", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const channelId = request.body?.channelId;
    const channels = await discord.channels(guildId);
    if (!channels.some((channel) => channel.id === channelId && POSTABLE.has(channel.type))) {
      return reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
    }
    const body = messageBody(request, reply);
    if (!body) {
      return reply;
    }
    let posted;
    try {
      posted = await discord.postMessage(channelId, body);
    } catch (error) {
      return discordRefused(reply, error);
    }
    const entry = sentMessages.add({ guildId, channelId, messageId: posted.id, summary: messageSummary(body), sentBy: session.userId });
    await logAction(guildId, session, `**Message posted** in <#${channelId}>`, [entry.summary]);
    return { message: sentJson(entry, { [session.userId]: session.username }) };
  });

  // Finds a bot message by its link, to edit it.
  app.get("/api/guilds/:id/messages/lookup", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const link = parseMessageLink(request.query?.link);
    if (!link || link.guildId !== access.guildId) {
      return reply.code(400).send({ error: "bad-link", message: "Paste a message link from this server (right-click the message → Copy Message Link)." });
    }
    const channels = await discord.channels(access.guildId);
    if (!channels.some((channel) => channel.id === link.channelId)) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    let message;
    try {
      message = await discord.message(link.channelId, link.messageId);
    } catch (error) {
      return discordRefused(reply, error);
    }
    if (!message) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    if (message.author?.id !== discord.clientId) {
      return reply.code(400).send({ error: "not-bot-message", message: "The bot can only edit its own messages." });
    }
    return { channelId: link.channelId, messageId: link.messageId, message: editableMessage(message) };
  });

  app.put("/api/guilds/:id/messages/:channelId/:messageId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const { channelId, messageId } = request.params;
    if (!DISCORD_ID.test(channelId) || !DISCORD_ID.test(messageId)) {
      return reply.code(400).send({ error: "bad-id" });
    }
    const channels = await discord.channels(guildId);
    if (!channels.some((channel) => channel.id === channelId)) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    const body = messageBody(request, reply);
    if (!body) {
      return reply;
    }
    try {
      const current = await discord.message(channelId, messageId);
      if (!current) {
        sentMessages.delete(guildId, messageId);
        return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
      }
      if (current.author?.id !== discord.clientId) {
        return reply.code(400).send({ error: "not-bot-message", message: "The bot can only edit its own messages." });
      }
      await discord.editMessage(channelId, messageId, body);
    } catch (error) {
      return discordRefused(reply, error);
    }
    const summary = messageSummary(body);
    sentMessages.edited(guildId, messageId, { summary, editedBy: session.userId });
    await logAction(guildId, session, `**Message edited** in <#${channelId}>`, [summary, `https://discord.com/channels/${guildId}/${channelId}/${messageId}`]);
    return { ok: true };
  });

  // --- Feeds ------------------------------------------------------------------

  const feedJson = (feed) => ({
    id: feed.id,
    kind: feed.kind,
    source: feed.source,
    name: feed.name,
    channelId: feed.channelId,
    roleId: feed.roleId,
    message: feed.message,
    createdAt: feed.createdAt,
    checkedAt: feed.checkedAt,
    postedAt: feed.postedAt,
    lastError: feed.lastError,
  });

  app.get("/api/guilds/:id/feeds", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    return { feeds: feeds.list(access.guildId).map(feedJson), max: MAX_FEEDS };
  });

  // Adding reads the feed once, which can take a few seconds.
  app.post("/api/guilds/:id/feeds", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const { kind, source, channelId, roleId = null, message = null } = request.body ?? {};
    if (!FEED_KINDS.includes(kind) || typeof source !== "string") {
      return reply.code(400).send({ error: "bad-feed", message: "Pick YouTube, Reddit or RSS and type what to follow." });
    }
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    if (!channels.some((channel) => channel.id === channelId && POSTABLE.has(channel.type))) {
      return reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
    }
    if (roleId !== null && (roleId === guildId || !guild.roles.some((role) => role.id === roleId))) {
      return reply.code(400).send({ error: "bad-role", message: "Pick a role from this server (not @everyone)." });
    }
    if (message !== null && (typeof message !== "string" || message.length > 500)) {
      return reply.code(400).send({ error: "bad-message", message: "The message is at most 500 characters." });
    }
    let feed;
    try {
      feed = await addFeed({ store: feeds, guildId, kind, source, channelId, roleId, message, createdBy: session.userId, fetchOptions: feedFetchOptions });
    } catch (error) {
      if (error instanceof FeedLimit || error instanceof FeedDuplicate) {
        return reply.code(409).send({ error: "feed-refused", message: error.message });
      }
      if (error instanceof FeedError) {
        return reply.code(400).send({ error: error.reason, message: error.message });
      }
      throw error;
    }
    await logAction(guildId, session, `**Feed added:** ${feed.name} → <#${channelId}>`, [feed.url]);
    return { feed: feedJson(feed) };
  });

  app.delete("/api/guilds/:id/feeds/:feedId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const id = Number.parseInt(request.params.feedId, 10);
    const feed = Number.isInteger(id) ? feeds.get(id) : undefined;
    if (!feed || feed.guildId !== access.guildId) {
      return reply.code(404).send({ error: "not-found" });
    }
    feeds.delete(access.guildId, id);
    await logAction(access.guildId, access.session, `**Feed removed:** ${feed.name}`, []);
    return { ok: true };
  });

  // --- Server stats ---------------------------------------------------------
  // The bot creates the channel for a new counter within a minute and renames
  // them as counts change (stats/statsUpdater.js); the dashboard only edits the list.

  const statsCounters = (guildId) => normalizeCounters(guildSettings.get(guildId, Setting.STATS_COUNTERS));

  app.get("/api/guilds/:id/counters", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    return { counters: statsCounters(access.guildId), presets: COUNTER_PRESETS, max: MAX_COUNTERS };
  });

  // Checks a template and category from the request body; null after replying 400.
  async function counterBody(request, reply, guildId) {
    let template;
    try {
      template = checkTemplate(request.body?.template);
    } catch (error) {
      if (error instanceof InvalidCounter) {
        reply.code(400).send({ error: "bad-template", message: error.message });
        return null;
      }
      throw error;
    }
    const categoryId = request.body?.categoryId ?? null;
    if (categoryId !== null && !(await discord.channels(guildId)).some((channel) => channel.id === categoryId && channel.type === 4 /* category */)) {
      reply.code(400).send({ error: "bad-category", message: "Pick a category from this server." });
      return null;
    }
    return { template, categoryId };
  }

  app.post("/api/guilds/:id/counters", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const counters = statsCounters(guildId);
    if (counters.length >= MAX_COUNTERS) {
      return reply.code(409).send({ error: "stats-full", message: `A server can have up to ${MAX_COUNTERS} counters.` });
    }
    const body = await counterBody(request, reply, guildId);
    if (!body) {
      return reply;
    }
    const counter = { id: newCounterId(), ...body, channelId: null, error: null };
    await guildSettings.set(guildId, Setting.STATS_COUNTERS, [...counters, counter]);
    await logAction(guildId, session, `**Stats counter added:** ${counter.template}`, []);
    return { counter };
  });

  app.patch("/api/guilds/:id/counters/:counterId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const counters = statsCounters(guildId);
    const counter = counters.find((each) => each.id === request.params.counterId);
    if (!counter) {
      return reply.code(404).send({ error: "not-found" });
    }
    let template;
    try {
      template = checkTemplate(request.body?.template);
    } catch (error) {
      if (error instanceof InvalidCounter) {
        return reply.code(400).send({ error: "bad-template", message: error.message });
      }
      throw error;
    }
    const updated = { ...counter, template };
    await guildSettings.set(
      guildId,
      Setting.STATS_COUNTERS,
      counters.map((each) => (each.id === counter.id ? updated : each)),
    );
    await logAction(guildId, session, `**Stats counter renamed:** ${counter.template} → ${template}`, []);
    return { counter: updated };
  });

  app.delete("/api/guilds/:id/counters/:counterId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const counters = statsCounters(guildId);
    const counter = counters.find((each) => each.id === request.params.counterId);
    if (!counter) {
      return reply.code(404).send({ error: "not-found" });
    }
    await guildSettings.set(
      guildId,
      Setting.STATS_COUNTERS,
      counters.filter((each) => each.id !== counter.id),
    );
    let channelDeleted = !counter.channelId;
    if (counter.channelId) {
      channelDeleted = await discord
        .deleteChannel(guildId, counter.channelId, "Server stats counter removed on the dashboard")
        .then(() => true)
        .catch((error) => error?.status === 404);
    }
    await logAction(guildId, session, `**Stats counter removed:** ${counter.template}`, []);
    return { ok: true, channelDeleted };
  });

  // --- Activity -------------------------------------------------------------

  app.get("/api/guilds/:id/activity", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const before = Number.parseInt(request.query?.before ?? "", 10);
    return activity.page(access.guildId, { before: Number.isSafeInteger(before) ? before : undefined });
  });

  return app;
}
