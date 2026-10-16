// Posts scheduled messages (/schedule) when they're due, checking every 15
// seconds. A repeating message is moved to its next time before it's posted,
// so a crash can't post it twice; runs missed while the bot was offline are
// skipped, not posted all at once. A one-off message is deleted first and
// isn't retried.
//
// A message whose channel is gone is deleted. One that can't be posted for
// another reason (missing permissions) keeps its schedule.

import { getDiscordErrorCode } from "../utils/discordErrors.js";

export const MIN_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_SCHEDULED = 25;
export const MAX_SCHEDULED_LENGTH = 2000;
const UNKNOWN_CHANNEL = 10003;

// The first run of a repeating message after `now`.
export function nextRun(nextAt, intervalMs, now) {
  if (nextAt > now) {
    return nextAt;
  }
  return nextAt + (Math.floor((now - nextAt) / intervalMs) + 1) * intervalMs;
}

// What may ping: everything when whoever scheduled it could mention everyone, otherwise nothing.
export const mentionsFor = (scheduled) => (scheduled.allowMentions ? { parse: ["users", "roles", "everyone"] } : { parse: [] });

// Options: client, store (ScheduledMessageStore), logger, intervalMs, now
export function createScheduledMessageScheduler({ client, store, logger, intervalMs = 15_000, now = Date.now }) {
  let timer;
  let running = false;

  async function post(scheduled) {
    const guild = client.guilds.cache.get(scheduled.guildId);
    if (!guild) {
      return;
    }
    const channel = guild.channels.cache.get(scheduled.channelId);
    if (!channel?.isTextBased?.()) {
      store.delete(scheduled.id);
      logger.info("Deleted a scheduled message whose channel is gone", { guildId: guild.id, id: scheduled.id });
      return;
    }
    try {
      await channel.send({ content: scheduled.content.slice(0, 2000), allowedMentions: mentionsFor(scheduled) });
    } catch (error) {
      if (getDiscordErrorCode(error) === UNKNOWN_CHANNEL) {
        store.delete(scheduled.id);
        return;
      }
      logger.warn("Couldn't post a scheduled message; check the bot's permissions in that channel", {
        guildId: guild.id,
        channelId: channel.id,
        id: scheduled.id,
        error,
      });
    }
  }

  // Posts every message that is due. Never runs twice at once.
  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      const at = now();
      for (const scheduled of store.due(at)) {
        if (scheduled.intervalMs) {
          store.reschedule(scheduled.id, nextRun(scheduled.nextAt, scheduled.intervalMs, at));
        } else {
          store.delete(scheduled.id);
        }
        await post(scheduled).catch((error) => logger.error("Posting a scheduled message crashed", { guildId: scheduled.guildId, error }));
      }
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    start() {
      if (timer) {
        return;
      }
      const run = () => sweep().catch((error) => logger.error("Checking scheduled messages crashed", { error }));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
