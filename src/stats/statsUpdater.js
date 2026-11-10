// Keeps server stats channels up to date. Every minute it creates counters
// added on the dashboard or with /stats, and renames channels whose count
// changed. Discord lets a channel be renamed twice per 10 minutes, so each
// channel is renamed at most once every RENAME_EVERY_MS, and only when its
// name would change. If Discord still says to wait (after a restart, or when
// someone renamed it by hand), the bot doesn't wait in line: it tries again
// once Discord's wait is over. A channel that can't be made is tried again
// after a growing pause (1 minute, doubling up to an hour) rather than every
// minute, and not at all while the bot lacks Manage Channels.

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createMemberLoader } from "../guilds/memberCache.js";
import { Setting } from "../settings/guildSettings.js";
import { retryAfterMs } from "../utils/rateLimits.js";
import { counterName, guildCounts, normalizeCounters } from "./statsCounters.js";

export const RENAME_EVERY_MS = 5 * 60 * 1000;
// How often a server's whole member list is fetched to count bots.
const FETCH_MEMBERS_EVERY_MS = 6 * 60 * 60 * 1000;
const REASON = "Server stats counter";
// Pauses between tries at making a channel that couldn't be made.
const CREATE_RETRY_MS = 60_000;
const CREATE_RETRY_MAX_MS = 60 * 60 * 1000;
const NO_PERMISSION = "Couldn't create the channel: the bot needs Manage Channels.";

// Options: guildSettings, logger, now, intervalMs, memberLoader (guilds/memberCache.js; shared with /massrole)
export function createStatsUpdater({ guildSettings, logger, now = Date.now, intervalMs = 60_000, memberLoader = createMemberLoader({ now }) }) {
  let client;
  let timer;
  let running = false;
  // channel ID -> when the bot may rename it next
  const renameAfter = new Map();
  // counter ID -> { failures, retryAt } for channels that couldn't be made
  const createFailures = new Map();
  // server ID -> when its members were last fetched
  const fetchedAt = new Map();
  const busy = new Set();

  const counters = (guildId) => normalizeCounters(guildSettings.get(guildId, Setting.STATS_COUNTERS));

  // Saves changes to some counters, re-reading the list first so edits made
  // meanwhile (on the dashboard, say) aren't lost.
  async function save(guildId, changes) {
    if (changes.size === 0) {
      return;
    }
    const updated = counters(guildId)
      .filter((counter) => changes.get(counter.id) !== null)
      .map((counter) => (changes.has(counter.id) ? { ...counter, ...changes.get(counter.id) } : counter));
    await guildSettings.set(guildId, Setting.STATS_COUNTERS, updated);
  }

  async function countBots(guild) {
    const last = fetchedAt.get(guild.id) ?? 0;
    if ((guild.members.cache.size >= guild.memberCount) || now() - last < FETCH_MEMBERS_EVERY_MS) {
      return;
    }
    fetchedAt.set(guild.id, now());
    // Shared with other features, so the server's member list is asked for once.
    if (!(await memberLoader.loadAll(guild, { timeMs: 60_000 }))) {
      logger.debug("Couldn't fetch members for stats", { guildId: guild.id });
    }
  }

  async function create(guild, counter, name) {
    const me = guild.members.me;
    const parent = counter.categoryId && guild.channels.cache.get(counter.categoryId)?.type === ChannelType.GuildCategory ? counter.categoryId : null;
    return guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent,
      position: 0,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.Connect] },
        ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }] : []),
      ],
      reason: REASON,
    });
  }

  // Creates missing channels and renames changed ones in one server.
  async function refresh(guild) {
    const list = counters(guild.id);
    if (list.length === 0 || busy.has(guild.id)) {
      return;
    }
    busy.add(guild.id);
    try {
      if (list.some((counter) => counter.template.includes("{humans}") || counter.template.includes("{bots}"))) {
        await countBots(guild);
      }
      const counts = guildCounts(guild);
      // counter ID -> fields to change, or null to drop it
      const changes = new Map();
      for (const counter of list) {
        const name = counterName(counter.template, counts);
        if (!counter.channelId) {
          const failed = createFailures.get(counter.id);
          if (failed && now() < failed.retryAt) {
            continue;
          }
          // Without the permission Discord would only refuse, which counts against the bot.
          if (guild.members.me && !guild.members.me.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
            if (counter.error !== NO_PERMISSION) {
              changes.set(counter.id, { error: NO_PERMISSION });
            }
            continue;
          }
          try {
            const channel = await create(guild, counter, name);
            createFailures.delete(counter.id);
            renameAfter.set(channel.id, now() + RENAME_EVERY_MS);
            changes.set(counter.id, { channelId: channel.id, error: null });
          } catch (error) {
            const failures = (failed?.failures ?? 0) + 1;
            const pause = Math.max(retryAfterMs(error), Math.min(CREATE_RETRY_MS * 2 ** (failures - 1), CREATE_RETRY_MAX_MS));
            createFailures.set(counter.id, { failures, retryAt: now() + pause });
            const message = `Couldn't create the channel: ${error.message ?? error}`.slice(0, 200);
            if (counter.error !== message) {
              changes.set(counter.id, { error: message });
            }
            logger.debug("Couldn't create a stats channel", { guildId: guild.id, error });
          }
          continue;
        }
        const channel = guild.channels.cache.get(counter.channelId);
        if (!channel) {
          // Deleted while the bot was offline.
          changes.set(counter.id, null);
          continue;
        }
        if (channel.name === name || now() < (renameAfter.get(channel.id) ?? 0)) {
          continue;
        }
        renameAfter.set(channel.id, now() + RENAME_EVERY_MS);
        try {
          await channel.setName(name, REASON);
          if (counter.error) {
            changes.set(counter.id, { error: null });
          }
        } catch (error) {
          const wait = retryAfterMs(error);
          if (wait > 0) {
            // Discord's own limit: not a problem to show, just try again after it.
            renameAfter.set(channel.id, now() + wait);
            logger.debug("Stats channel rename is rate-limited; trying again later", { guildId: guild.id, channelId: channel.id, waitMs: wait });
            continue;
          }
          const message = `Couldn't rename the channel: ${error.message ?? error}`.slice(0, 200);
          if (counter.error !== message) {
            changes.set(counter.id, { error: message });
          }
          logger.debug("Couldn't rename a stats channel", { guildId: guild.id, channelId: channel.id, error });
        }
      }
      await save(guild.id, changes);
    } finally {
      busy.delete(guild.id);
    }
  }

  async function tick() {
    if (running || !client) {
      return;
    }
    running = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        await refresh(guild).catch((error) => logger.error("Updating stats channels crashed", { guildId: guild.id, error }));
      }
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    tick,
    // A deleted counter channel stops being a counter.
    async channelDeleted(channel) {
      const guildId = channel.guildId;
      if (!guildId) {
        return;
      }
      const counter = counters(guildId).find((each) => each.channelId === channel.id);
      if (counter) {
        renameAfter.delete(channel.id);
        await save(guildId, new Map([[counter.id, null]]));
      }
    },
    start(readyClient) {
      client = readyClient;
      if (!timer) {
        timer = setInterval(() => tick().catch((error) => logger.error("Stats update crashed", { error })), intervalMs);
        timer.unref?.();
      }
      tick().catch((error) => logger.error("Stats update crashed", { error }));
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
