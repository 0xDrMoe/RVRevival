// Who may moderate whom. Each check returns a translation key explaining the
// refusal, or undefined when the action is allowed.

import { PermissionFlagsBits } from "discord.js";
import { Setting } from "../settings/guildSettings.js";

// Members with the Discord permission, or with the staff role from /settings,
// may use a moderation command.
export function isModerator(interaction, permission, guildSettings) {
  if (interaction.memberPermissions?.has(permission)) {
    return true;
  }
  const staffRoleId = guildSettings?.get(interaction.guildId, Setting.STAFF_ROLE);
  return Boolean(staffRoleId && interaction.member?.roles?.cache?.has(staffRoleId));
}

const topPosition = (member) => member?.roles?.highest?.position ?? 0;

// Checks a moderator acting on a member of the server:
// - nobody can act on themselves, the bot or the server owner;
// - the moderator's top role must be above the member's (the owner can act on anyone);
// - the bot's top role must be above the member's, or Discord refuses;
// - Discord never lets anyone time out an administrator.
//
// `moderator`, `target` and `bot` are GuildMembers. Leave out `bot` when the
// bot's own role doesn't matter (a warning); `botId` still stops acting on it.
export function hierarchyProblem({ moderator, target, bot, botId = bot?.id, ownerId, forTimeout = false }) {
  if (target.id === moderator.id) {
    return "modSelf";
  }
  if (target.id === botId) {
    return "modBot";
  }
  if (target.id === ownerId) {
    return "modOwner";
  }
  if (moderator.id !== ownerId && topPosition(moderator) <= topPosition(target)) {
    return "modTargetHigher";
  }
  if (bot && topPosition(bot) <= topPosition(target)) {
    return "modBotLower";
  }
  if (forTimeout && target.permissions?.has(PermissionFlagsBits.Administrator)) {
    return "modTimeoutAdmin";
  }
  return undefined;
}

// Checks a moderator acting on someone who isn't in the server (ban or unban by ID).
export function outsiderProblem({ moderator, userId, botId }) {
  if (userId === moderator.id) {
    return "modSelf";
  }
  if (userId === botId) {
    return "modBot";
  }
  return undefined;
}
