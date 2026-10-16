// Keeps server stats channels up to date. Every minute it creates counters
// added on the dashboard or with /stats, and renames channels whose count
// changed. Discord lets a channel be renamed twice per 10 minutes, so each
// channel is renamed at most once every RENAME_EVERY_MS.

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { Setting } from "../settings/guildSettings.js";
import { counterName, guildCounts, normalizeCounters } from "./statsCounters.js";

export const RENAME_EVERY_MS = 5 * 60 * 1000;
// How often a server's whole member list is fetched to count bots.
const FETCH_MEMBERS_EVERY_MS = 6 * 60 * 60 * 1000;
const REASON = "Server stats counter";

// Options: guildSettings, logger, now, intervalMs
export function createStatsUpdater({ guildSettings, logger, now = Date.now, intervalMs = 60_000 }) {
  let client;
  let timer;
  let running = false;
  // channel ID -> when the bot last renamed it
  const renamedAt = new Map();
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
    await guild.members.fetch().catch((error) => logger.debug("Couldn't fetch members for stats", { guildId: guild.id, error }));
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
          try {
            const channel = await create(guild, counter, name);
            renamedAt.set(channel.id, now());
            changes.set(counter.id, { channelId: channel.id, error: null });
          } catch (error) {
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
        if (channel.name === name || now() - (renamedAt.get(channel.id) ?? 0) < RENAME_EVERY_MS) {
          continue;
        }
        renamedAt.set(channel.id, now());
        try {
          await channel.setName(name, REASON);
          if (counter.error) {
            changes.set(counter.id, { error: null });
          }
        } catch (error) {
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
        renamedAt.delete(channel.id);
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
