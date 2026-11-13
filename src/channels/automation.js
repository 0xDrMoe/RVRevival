// Channel automation: small jobs the bot does in chosen channels, all in one
// setting (Setting.CHANNEL_AUTOMATION), set up on the dashboard's Channel
// automation page or with /automate.
//
//   publish      posts in announcement channels are published to following servers
//   threads      every new post gets its own thread for replies
//   keepAlive    threads in these channels (or these threads) never auto-archive
//   autoDelete   messages are deleted after N minutes (pinned ones stay)
//   slowmode     slowmode switches on by itself when a channel gets busy
//   reactions    the bot reacts to every new post with the same emoji
//   counting     a counting game channel (see counting below)
//   bump         a reminder 2 hours after someone bumps the server with DISBOARD
//
// Counting and bump state lives in data/bot.db (channels/automationStore.js).

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { cleanEmoji } from "../community/rolePanels.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { derivedSetting, Setting } from "../settings/guildSettings.js";
import { deleteMessage } from "../utils/rateLimits.js";

export const AUTOMATION_LIMITS = Object.freeze({
  channels: 10, // per list (publish, threads, auto-delete, slowmode, reactions)
  keepAlive: 25,
  emojis: 5, // reactions per channel
  minMinutes: 1,
  maxMinutes: 10_080, // a week
  minBurst: 5, // messages in SLOWMODE_WINDOW_MS that switch slowmode on
  maxBurst: 100,
  minSlowmode: 1, // seconds
  maxSlowmode: 300,
  bumpMessage: 500,
});
// Auto-slowmode counts messages in this window, and stays on until the
// channel has been quiet (under the limit) for SLOWMODE_HOLD_MS.
export const SLOWMODE_WINDOW_MS = 10_000;
export const SLOWMODE_HOLD_MS = 5 * 60_000;
// DISBOARD lets a server bump every 2 hours.
export const BUMP_COOLDOWN_MS = 2 * 60 * 60_000;
export const DISBOARD_ID = "302050872383242240";
// How often the sweeper runs (auto-delete and bump reminders).
export const SWEEP_INTERVAL_MS = 60_000;
// Messages deleted per channel per sweep, so one busy channel can't use up the rate limit.
const MAX_DELETES_PER_SWEEP = 100;
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60_000 - 60_000;
const THREAD_NAME_LENGTH = 80;

const SNOWFLAKE = /^\d{17,20}$/;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isId = (id) => typeof id === "string" && SNOWFLAKE.test(id);
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export class InvalidAutomation extends Error {
  name = "InvalidAutomation";
}

// Everything off.
export const emptyAutomation = () => ({
  publish: [],
  threads: [],
  keepAlive: [],
  autoDelete: [],
  slowmode: [],
  reactions: [],
  countingChannelId: null,
  bump: null,
});

const uniqueIds = (list, max) => (Array.isArray(list) ? [...new Set(list.filter(isId))].slice(0, max) : []);
// One entry per channel: the last one wins, like saving the same channel twice.
const byChannel = (list, clean, max) => {
  const entries = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    const cleaned = isObject(entry) && isId(entry.channelId) ? clean(entry) : undefined;
    if (cleaned) {
      entries.set(cleaned.channelId, cleaned);
    }
  }
  return [...entries.values()].slice(0, max);
};
const cleanDelete = (entry) => (inRange(entry.minutes, AUTOMATION_LIMITS.minMinutes, AUTOMATION_LIMITS.maxMinutes) ? { channelId: entry.channelId, minutes: entry.minutes } : undefined);
const cleanSlowmode = (entry) =>
  inRange(entry.messages, AUTOMATION_LIMITS.minBurst, AUTOMATION_LIMITS.maxBurst) && inRange(entry.seconds, AUTOMATION_LIMITS.minSlowmode, AUTOMATION_LIMITS.maxSlowmode)
    ? { channelId: entry.channelId, messages: entry.messages, seconds: entry.seconds }
    : undefined;
const cleanReactions = (entry) => {
  const emojis = [...new Set((Array.isArray(entry.emojis) ? entry.emojis : []).map(cleanEmoji).filter(Boolean))].slice(0, AUTOMATION_LIMITS.emojis);
  return emojis.length > 0 ? { channelId: entry.channelId, emojis } : undefined;
};
const cleanBump = (bump) =>
  isObject(bump) && bump.enabled !== false
    ? {
        channelId: isId(bump.channelId) ? bump.channelId : null,
        roleId: isId(bump.roleId) ? bump.roleId : null,
        message: typeof bump.message === "string" && bump.message.trim() ? bump.message.trim().slice(0, AUTOMATION_LIMITS.bumpMessage) : null,
      }
    : null;

// The saved setting with anything broken dropped. Never throws.
export function normalizeAutomation(saved) {
  if (!isObject(saved)) {
    return emptyAutomation();
  }
  return {
    publish: uniqueIds(saved.publish, AUTOMATION_LIMITS.channels),
    threads: uniqueIds(saved.threads, AUTOMATION_LIMITS.channels),
    keepAlive: uniqueIds(saved.keepAlive, AUTOMATION_LIMITS.keepAlive),
    autoDelete: byChannel(saved.autoDelete, cleanDelete, AUTOMATION_LIMITS.channels),
    slowmode: byChannel(saved.slowmode, cleanSlowmode, AUTOMATION_LIMITS.channels),
    reactions: byChannel(saved.reactions, cleanReactions, AUTOMATION_LIMITS.channels),
    countingChannelId: isId(saved.countingChannelId) ? saved.countingChannelId : null,
    bump: cleanBump(saved.bump),
  };
}

// Whether anything is switched on.
export const automationInUse = (config) =>
  ["publish", "threads", "keepAlive", "autoDelete", "slowmode", "reactions"].some((key) => config[key].length > 0) || Boolean(config.countingChannelId) || Boolean(config.bump);

// Checks dashboard or /automate input strictly. `isChannel(id, kind)` says
// whether an ID is a usable channel for that job ("publish" needs an
// announcement channel, "keepAlive" also takes forums and threads, the rest
// text or announcement channels); `isRole(id)` likewise. Returns what to save,
// or null when everything is off. Throws InvalidAutomation.
export function checkAutomation(value, { isChannel, isRole }) {
  if (!isObject(value)) {
    throw new InvalidAutomation("Channel automation is an object.");
  }
  const lists = { publish: AUTOMATION_LIMITS.channels, threads: AUTOMATION_LIMITS.channels, keepAlive: AUTOMATION_LIMITS.keepAlive };
  for (const [key, max] of Object.entries(lists)) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > max) {
      throw new InvalidAutomation(`Pick up to ${max} channels for ${key}.`);
    }
    if (!list.every((id) => isChannel(id, key))) {
      throw new InvalidAutomation(key === "publish" ? "Auto-publish only works in announcement channels." : `Pick channels from this server for ${key}.`);
    }
  }
  const entries = { autoDelete: cleanDelete, slowmode: cleanSlowmode, reactions: cleanReactions };
  for (const [key, clean] of Object.entries(entries)) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > AUTOMATION_LIMITS.channels) {
      throw new InvalidAutomation(`Up to ${AUTOMATION_LIMITS.channels} channels for ${key}.`);
    }
    for (const entry of list) {
      if (!isObject(entry) || !isChannel(entry.channelId, key)) {
        throw new InvalidAutomation(`Pick text channels from this server for ${key}.`);
      }
      if (!clean(entry)) {
        throw new InvalidAutomation(
          {
            autoDelete: `Delete after ${AUTOMATION_LIMITS.minMinutes} to ${AUTOMATION_LIMITS.maxMinutes} minutes.`,
            slowmode: `Slowmode needs ${AUTOMATION_LIMITS.minBurst} to ${AUTOMATION_LIMITS.maxBurst} messages and ${AUTOMATION_LIMITS.minSlowmode} to ${AUTOMATION_LIMITS.maxSlowmode} seconds.`,
            reactions: `Give each channel 1 to ${AUTOMATION_LIMITS.emojis} emoji.`,
          }[key],
        );
      }
      if (key === "reactions" && entry.emojis.length !== cleanReactions(entry).emojis.length) {
        throw new InvalidAutomation(`"${String(entry.emojis.find((emoji) => !cleanEmoji(emoji))).slice(0, 40)}" isn't an emoji.`);
      }
    }
  }
  const counting = value.countingChannelId ?? null;
  if (counting !== null && !isChannel(counting, "counting")) {
    throw new InvalidAutomation("Pick a text channel from this server for counting.");
  }
  const bump = value.bump ?? null;
  if (bump !== null) {
    if (!isObject(bump)) {
      throw new InvalidAutomation("Bump reminders are { channelId, roleId, message }.");
    }
    if (bump.channelId != null && !isChannel(bump.channelId, "bump")) {
      throw new InvalidAutomation("Pick a text channel from this server for bump reminders.");
    }
    if (bump.roleId != null && !isRole(bump.roleId)) {
      throw new InvalidAutomation("Pick a role from this server to ping for bumps.");
    }
    if (bump.message != null && (typeof bump.message !== "string" || bump.message.length > AUTOMATION_LIMITS.bumpMessage)) {
      throw new InvalidAutomation(`The bump reminder is up to ${AUTOMATION_LIMITS.bumpMessage} characters.`);
    }
  }
  const cleaned = normalizeAutomation(value);
  if (cleaned.countingChannelId && [...cleaned.threads, ...cleaned.reactions.map((entry) => entry.channelId), ...cleaned.autoDelete.map((entry) => entry.channelId)].includes(cleaned.countingChannelId)) {
    throw new InvalidAutomation("The counting channel can't also have auto-threads, auto-reactions or auto-delete.");
  }
  return automationInUse(cleaned) ? cleaned : null;
}

// A short English summary for the activity and action logs.
export function describeAutomation(value) {
  const config = normalizeAutomation(value);
  const channels = (ids) => ids.map((id) => `<#${id}>`).join(", ");
  const parts = [];
  if (config.publish.length > 0) parts.push(`publish ${channels(config.publish)}`);
  if (config.threads.length > 0) parts.push(`threads ${channels(config.threads)}`);
  if (config.keepAlive.length > 0) parts.push(`keep threads open ${channels(config.keepAlive)}`);
  if (config.autoDelete.length > 0) parts.push(`auto-delete ${config.autoDelete.map((entry) => `<#${entry.channelId}> after ${entry.minutes} min`).join(", ")}`);
  if (config.slowmode.length > 0) parts.push(`auto-slowmode ${config.slowmode.map((entry) => `<#${entry.channelId}> ${entry.seconds}s at ${entry.messages} msgs/10s`).join(", ")}`);
  if (config.reactions.length > 0) parts.push(`reactions ${config.reactions.map((entry) => `<#${entry.channelId}> ${entry.emojis.join(" ")}`).join(", ")}`);
  if (config.countingChannelId) parts.push(`counting <#${config.countingChannelId}>`);
  if (config.bump) parts.push(`bump reminders${config.bump.channelId ? ` in <#${config.bump.channelId}>` : ""}${config.bump.roleId ? ` pinging <@&${config.bump.roleId}>` : ""}`);
  return parts.length > 0 ? parts.join(" · ") : "all off";
}

// The channel kinds each job accepts, for checkAutomation's isChannel.
export const AUTOMATION_CHANNEL_TYPES = Object.freeze({
  publish: [ChannelType.GuildAnnouncement],
  keepAlive: [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread],
  default: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
});
export const channelTypesFor = (kind) => AUTOMATION_CHANNEL_TYPES[kind] ?? AUTOMATION_CHANNEL_TYPES.default;

// --- Pure helpers -------------------------------------------------------------------

// A thread name for a post: its first line without markup, or "<name>'s post".
export function threadName(message, language) {
  const firstLine = String(message.content ?? "")
    .split("\n")
    .map((line) => line.replace(/<a?:(\w+):\d+>/g, ":$1:").replace(/<[@#][!&]?\d+>/g, "").replace(/https?:\/\/\S+/g, "").replace(/[*_`~|>#-]+/g, " ").replace(/\s+/g, " ").trim())
    .find(Boolean);
  const fallback = translate(language, "automationThreadName", { user: message.member?.displayName ?? message.author?.username ?? "" });
  const name = firstLine || fallback;
  return name.length > THREAD_NAME_LENGTH ? `${name.slice(0, THREAD_NAME_LENGTH - 1).trimEnd()}…` : name;
}

// The number a counting message says, or undefined. "12", "12!" and "12 nice"
// count; "twelve" or "1 2" don't.
export function countedNumber(content) {
  const match = /^\s*(\d{1,9})(?![\d.,])/.exec(String(content ?? ""));
  return match ? Number(match[1]) : undefined;
}

// Whether a DISBOARD message says a bump just worked.
export function isBumpDone(message) {
  if (message.author?.id !== DISBOARD_ID) {
    return false;
  }
  const texts = [message.content ?? "", ...(message.embeds ?? []).flatMap((embed) => [embed.description ?? "", embed.title ?? ""])];
  return texts.some((text) => /bump done|:thumbsup:|👍/i.test(text));
}

// --- Runtime ------------------------------------------------------------------------

// Options: guildSettings, store (channels/automationStore.js), logger,
// forcedLanguage, botDeletions (RecentIds), client (start() sets it; tests
// pass one), now, setTimer, clearTimer (tests).
export function createChannelAutomation({ guildSettings, store, logger, forcedLanguage, botDeletions, client: initialClient, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let client = initialClient;
  const config = (guildId) => derivedSetting(guildSettings, guildId, Setting.CHANNEL_AUTOMATION, normalizeAutomation);
  const languageOf = (guild) => pickLanguage(guild?.preferredLocale, forcedLanguage);
  // Recent message times per auto-slowmode channel, and the slowmode the bot switched on.
  const traffic = new Map();
  const slowed = new Map(); // channelId -> { previous, seconds, timer }
  const lastSwept = new Map();
  // One counting check at a time per channel, so two fast messages can't both be "next".
  const countingQueue = new Map();
  let sweeper;

  const canIn = (channel, permissions) => Boolean(channel?.guild?.members?.me && channel.permissionsFor?.(channel.guild.members.me)?.has(permissions));

  async function publish(message) {
    if (message.channel?.type !== ChannelType.GuildAnnouncement || !message.crosspostable) {
      return;
    }
    try {
      await message.crosspost();
    } catch (error) {
      logger.debug("Couldn't auto-publish a message (Discord allows 10 an hour per channel)", { guildId: message.guildId, channelId: message.channelId, error });
    }
  }

  async function startThread(message) {
    if (message.hasThread || !message.startThread || message.system) {
      return;
    }
    if (!canIn(message.channel, [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads])) {
      logger.warn("Couldn't start an auto-thread. Give the bot Create Public Threads there.", { guildId: message.guildId, channelId: message.channelId });
      return;
    }
    try {
      await message.startThread({ name: threadName(message, languageOf(message.guild)), autoArchiveDuration: 1440, reason: "Auto-thread" });
    } catch (error) {
      logger.debug("Couldn't start an auto-thread", { guildId: message.guildId, channelId: message.channelId, error });
    }
  }

  async function react(message, emojis) {
    for (const emoji of emojis) {
      try {
        await message.react(emoji);
      } catch (error) {
        logger.debug("Couldn't add an auto-reaction", { guildId: message.guildId, channelId: message.channelId, emoji, error });
        return;
      }
    }
  }

  function endSlowmode(channel) {
    const active = slowed.get(channel.id);
    if (!active) {
      return;
    }
    const recent = (traffic.get(channel.id) ?? []).filter((at) => at >= now() - SLOWMODE_WINDOW_MS);
    if (recent.length >= active.messages) {
      active.timer = setTimer(() => endSlowmode(channel), SLOWMODE_HOLD_MS);
      active.timer?.unref?.();
      return;
    }
    slowed.delete(channel.id);
    // Only put it back if nobody changed it in the meantime.
    if (channel.rateLimitPerUser === active.seconds) {
      channel.setRateLimitPerUser(active.previous, "Auto-slowmode: the channel calmed down").catch((error) => logger.debug("Couldn't end auto-slowmode", { channelId: channel.id, error }));
    }
  }

  async function watchTraffic(message, rule) {
    const channel = message.channel;
    const cutoff = now() - SLOWMODE_WINDOW_MS;
    const times = [...(traffic.get(channel.id) ?? []).filter((at) => at >= cutoff), now()];
    traffic.set(channel.id, times);
    if (times.length < rule.messages || slowed.has(channel.id) || (channel.rateLimitPerUser ?? 0) >= rule.seconds) {
      return;
    }
    if (!canIn(channel, PermissionFlagsBits.ManageChannels)) {
      return;
    }
    const active = { previous: channel.rateLimitPerUser ?? 0, seconds: rule.seconds, messages: rule.messages, timer: null };
    slowed.set(channel.id, active);
    try {
      await channel.setRateLimitPerUser(rule.seconds, `Auto-slowmode: ${times.length} messages in ${SLOWMODE_WINDOW_MS / 1000} seconds`);
    } catch (error) {
      slowed.delete(channel.id);
      logger.debug("Couldn't switch on auto-slowmode", { channelId: channel.id, error });
      return;
    }
    active.timer = setTimer(() => endSlowmode(channel), SLOWMODE_HOLD_MS);
    active.timer?.unref?.();
  }

  async function count(message) {
    const number = countedNumber(message.content);
    if (number === undefined) {
      return;
    }
    const state = store.counting(message.channelId) ?? { count: 0, lastUserId: null, best: 0 };
    const language = languageOf(message.guild);
    if (number === state.count + 1 && message.author.id !== state.lastUserId) {
      const best = Math.max(state.best, number);
      store.setCounting(message.channelId, message.guildId, { count: number, lastUserId: message.author.id, best });
      await message.react(number > state.best && state.best > 0 && number === state.best + 1 ? "🏆" : number % 100 === 0 ? "💯" : "✅").catch(() => {});
      return;
    }
    // A mistake: start again from 1.
    store.setCounting(message.channelId, message.guildId, { count: 0, lastUserId: null, best: state.best });
    await message.react("❌").catch(() => {});
    const key = message.author.id === state.lastUserId && number === state.count + 1 ? "countingTwice" : "countingWrong";
    await message.channel
      .send({
        content: translate(language, key, { user: `<@${message.author.id}>`, count: state.count, expected: state.count + 1, best: state.best }),
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  function queueCount(message) {
    const previous = countingQueue.get(message.channelId) ?? Promise.resolve();
    const next = previous.then(() => count(message)).catch((error) => logger.debug("Counting failed", { channelId: message.channelId, error }));
    countingQueue.set(message.channelId, next);
    next.finally(() => countingQueue.get(message.channelId) === next && countingQueue.delete(message.channelId));
    return next;
  }

  // Posts bump reminders that are due.
  async function remindBumps() {
    for (const due of store.dueBumps(now())) {
      store.clearBump(due.guildId);
      const guild = client?.guilds?.cache?.get(due.guildId);
      const bump = guild ? config(guild.id).bump : null;
      if (!bump) {
        continue;
      }
      const channel = guild.channels.cache.get(bump.channelId ?? due.channelId);
      if (!channel?.isTextBased?.()) {
        continue;
      }
      await channel.send(bumpReminderPayload(bump, languageOf(guild))).catch((error) => logger.warn("Couldn't post a bump reminder. Give the bot Send Messages there.", { guildId: guild.id, channelId: channel.id, error }));
    }
  }

  // Deletes messages that are older than their channel allows.
  async function sweepChannel(guild, rule) {
    const channel = guild.channels.cache.get(rule.channelId);
    if (!channel?.messages || !canIn(channel, [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])) {
      return;
    }
    const cutoff = now() - rule.minutes * 60_000;
    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: 100, cache: false });
    } catch (error) {
      logger.debug("Couldn't read messages to auto-delete", { guildId: guild.id, channelId: channel.id, error });
      return;
    }
    const old = [...fetched.values()].filter((message) => !message.pinned && !message.system && message.createdTimestamp <= cutoff).slice(0, MAX_DELETES_PER_SWEEP);
    const recent = old.filter((message) => message.createdTimestamp > now() - BULK_DELETE_MAX_AGE_MS);
    const ancient = old.filter((message) => !recent.includes(message)).slice(0, 5);
    recent.forEach((message) => botDeletions?.add(message.id));
    try {
      if (recent.length === 1) {
        await deleteMessage(recent[0]);
      } else if (recent.length > 1) {
        await channel.bulkDelete(recent.map((message) => message.id), true);
      }
      for (const message of ancient) {
        botDeletions?.add(message.id);
        await deleteMessage(message);
      }
    } catch (error) {
      logger.debug("Couldn't auto-delete messages", { guildId: guild.id, channelId: channel.id, error });
    }
  }

  async function sweep() {
    await remindBumps().catch((error) => logger.warn("Bump reminders failed", { error }));
    for (const guild of client?.guilds?.cache?.values?.() ?? []) {
      for (const rule of config(guild.id).autoDelete) {
        // Short timers are swept every minute, long ones less often.
        const every = Math.min(30 * 60_000, Math.max(SWEEP_INTERVAL_MS, (rule.minutes * 60_000) / 4));
        if (now() - (lastSwept.get(rule.channelId) ?? 0) < every) {
          continue;
        }
        lastSwept.set(rule.channelId, now());
        await sweepChannel(guild, rule);
      }
    }
  }

  return {
    // Every new message in a server.
    async messageCreated(message) {
      if (!message.inGuild?.() || message.author?.id === message.client?.user?.id) {
        return;
      }
      const settings = config(message.guildId);
      if (!automationInUse(settings)) {
        return;
      }
      if (settings.bump && isBumpDone(message)) {
        store.setBump(message.guildId, message.channelId, now() + BUMP_COOLDOWN_MS);
        await message.react("⏰").catch(() => {});
        return;
      }
      const channelId = message.channelId;
      const jobs = [];
      if (settings.publish.includes(channelId)) {
        jobs.push(publish(message));
      }
      if (message.author?.bot || message.webhookId || message.system) {
        await Promise.all(jobs);
        return;
      }
      if (channelId === settings.countingChannelId) {
        jobs.push(queueCount(message));
      }
      if (settings.threads.includes(channelId)) {
        jobs.push(startThread(message));
      }
      const reactions = settings.reactions.find((entry) => entry.channelId === channelId);
      if (reactions) {
        jobs.push(react(message, reactions.emojis));
      }
      const slowmode = settings.slowmode.find((entry) => entry.channelId === channelId);
      if (slowmode) {
        jobs.push(watchTraffic(message, slowmode));
      }
      await Promise.all(jobs);
    },

    // A thread archiving by itself in a keep-alive channel is opened again.
    async threadUpdated(before, after) {
      if (!after?.guildId || before?.archived || !after.archived || after.locked) {
        return;
      }
      const { keepAlive } = config(after.guildId);
      if (!keepAlive.includes(after.parentId) && !keepAlive.includes(after.id)) {
        return;
      }
      try {
        await after.setArchived(false, "Keep alive");
      } catch (error) {
        logger.debug("Couldn't keep a thread open. Give the bot Manage Threads.", { guildId: after.guildId, threadId: after.id, error });
      }
    },

    // The counting score of a channel, for /automate show and the dashboard.
    countingState: (channelId) => store.counting(channelId) ?? { count: 0, lastUserId: null, best: 0 },

    // Starts the sweeper (auto-delete and bump reminders) once the bot is online.
    start(readyClient) {
      client = readyClient ?? client;
      if (!sweeper) {
        sweeper = setInterval(() => sweep().catch((error) => logger.warn("Channel automation sweep failed", { error })), SWEEP_INTERVAL_MS);
        sweeper.unref?.();
      }
    },
    stop() {
      clearInterval(sweeper);
      sweeper = undefined;
      for (const active of slowed.values()) {
        clearTimer(active.timer);
      }
      slowed.clear();
    },
    // For tests.
    sweep,
  };
}

// The bump reminder message, with the role pinged.
export function bumpReminderPayload(bump, language) {
  const text = bump.message ?? translate(language, "bumpReminderDefault");
  const ping = bump.roleId ? `<@&${bump.roleId}> ` : "";
  return { content: `${ping}${text}`.slice(0, 2000), allowedMentions: { roles: bump.roleId ? [bump.roleId] : [] } };
}
