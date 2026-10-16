// Keeps the /country channel clean: any message posted there is deleted, so the
// channel only holds the bot's own posts (such as the /country-help guide).
// Everyone's messages are deleted, staff and admins included. Threads inside
// the channel are left alone.
//
// Needs the GuildMessages intent (not privileged) and the Manage Messages
// permission in that channel. Each deletion is recorded in the logs channel
// with the message's text (if the Message Content intent is on), attachments
// and stickers.

import { RESTJSONErrorCodes } from "discord.js";
import { noActionLog, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { getDiscordErrorCode, isPermissionError } from "../utils/discordErrors.js";

// Errors that just mean there's nothing to delete.
const IGNORED_ERRORS = new Set([
  RESTJSONErrorCodes.UnknownMessage, // someone else deleted it first
  RESTJSONErrorCodes.CannotExecuteActionOnSystemMessage, // some system messages can't be deleted
]);

// Options:
//   guildSettings   where the /country channel is stored (GuildSettings)
//   logger
//   actionLog       records each deletion in the logs channel (see logs/actionLog.js)
//   botDeletions    remembers what the bot deleted, so the server log skips it (RecentIds)
export function createCountryChannelGuard({ guildSettings, logger, actionLog = noActionLog, botDeletions }) {
  // Servers already warned about missing permissions, so a busy channel can't
  // flood the log. A server is warned again once a delete has worked.
  const warnedGuilds = new Set();

  return async function handleMessage(message) {
    if (!message.inGuild()) {
      return;
    }
    if (guildSettings.get(message.guildId, Setting.COUNTRY_CHANNEL) !== message.channelId) {
      return;
    }
    if (message.author.id === message.client.user.id) {
      return;
    }

    // Start saving attachments before deleting: their links stop working after.
    const saving = actionLog.saveAttachments(message);
    botDeletions?.add(message.id);
    try {
      await message.delete();
    } catch (error) {
      saving.catch(() => {});
      if (IGNORED_ERRORS.has(getDiscordErrorCode(error))) {
        return;
      }
      if (!isPermissionError(error)) {
        throw error;
      }
      if (!warnedGuilds.has(message.guildId)) {
        warnedGuilds.add(message.guildId);
        logger.warn("Can't delete messages in the /country channel. Give the bot View Channel and Manage Messages there.", {
          guildId: message.guildId,
          channelId: message.channelId,
        });
        await actionLog.logDeletedMessage(message, {
          status: Status.FAILED,
          note: "The bot needs View Channel and Manage Messages in this channel. Logged once until a delete works again.",
        });
      }
      return;
    }
    warnedGuilds.delete(message.guildId);
    await actionLog.logDeletedMessage(message, { status: Status.SUCCESS }, await saving);
  };
}
