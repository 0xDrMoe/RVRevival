// Helpers for recognizing Discord API errors by their error code.

import { RESTJSONErrorCodes } from "discord.js";

export function getDiscordErrorCode(error) {
  return typeof error?.code === "number" ? error.code : undefined;
}

// The bot lacks a permission, or the role is above the bot's role.
export function isPermissionError(error) {
  const code = getDiscordErrorCode(error);
  return code === RESTJSONErrorCodes.MissingPermissions || code === RESTJSONErrorCodes.MissingAccess;
}

// The server already has Discord's maximum number of roles.
export function isRoleLimitError(error) {
  return getDiscordErrorCode(error) === RESTJSONErrorCodes.MaximumNumberOfGuildRolesReached;
}

// The interaction expired or was already answered, so replying can't work.
export function isExpiredInteractionError(error) {
  const code = getDiscordErrorCode(error);
  return (
    code === RESTJSONErrorCodes.UnknownInteraction ||
    code === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged
  );
}
