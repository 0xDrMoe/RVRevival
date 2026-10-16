// Lifts temporary bans when they end. Pending unbans are stored with their
// case, so they survive restarts: the bot checks every 30 seconds and unbans
// anyone whose time is up, recording an Unban case by the bot.

import { RESTJSONErrorCodes } from "discord.js";
import { getDiscordErrorCode } from "../utils/discordErrors.js";
import { CaseAction } from "./caseStore.js";

// Options:
//   client       the discord.js client
//   moderation   the moderation service (see moderationService.js)
//   botActions   remembers what the bot did itself, so it isn't recorded twice (RecentIds)
//   logger
export function createTempBanScheduler({ client, moderation, botActions, logger, intervalMs = 30_000, now = Date.now }) {
  const store = moderation.store;
  // "<server id>:<user id>" pairs already warned about, so a missing permission
  // doesn't add a console warning every 30 seconds.
  const warned = new Set();
  let timer;
  let running = false;

  async function liftBan(moderationCase) {
    const guild = client.guilds.cache.get(moderationCase.guildId);
    if (!guild) {
      // The bot isn't in that server right now; try again later.
      return;
    }
    const reason = `Temporary ban from case ${moderationCase.number} ended`;
    botActions?.add(`${guild.id}:${moderationCase.userId}:${CaseAction.UNBAN}`);
    try {
      await guild.members.unban(moderationCase.userId, reason);
    } catch (error) {
      if (getDiscordErrorCode(error) === RESTJSONErrorCodes.UnknownBan) {
        // Someone already unbanned them.
        store.clearPendingUnbans(guild.id, moderationCase.userId);
        return;
      }
      const key = `${guild.id}:${moderationCase.userId}`;
      if (!warned.has(key)) {
        warned.add(key);
        logger.warn("Couldn't lift a temporary ban; will keep trying. The bot needs Ban Members.", {
          guildId: guild.id,
          userId: moderationCase.userId,
          case: moderationCase.number,
          error,
        });
      }
      return;
    }
    store.clearPendingUnbans(guild.id, moderationCase.userId);
    await moderation.recordCase({
      guild,
      action: CaseAction.UNBAN,
      user: { id: moderationCase.userId, tag: moderationCase.userTag },
      moderator: client.user,
      reason,
    });
  }

  // Lifts every ban that is due. Never runs twice at once.
  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const moderationCase of store.dueUnbans(now())) {
        await liftBan(moderationCase).catch((error) =>
          logger.error("Lifting a temporary ban crashed", { guildId: moderationCase.guildId, error }),
        );
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
      sweep().catch((error) => logger.error("Checking temporary bans crashed", { error }));
      timer = setInterval(() => {
        sweep().catch((error) => logger.error("Checking temporary bans crashed", { error }));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
