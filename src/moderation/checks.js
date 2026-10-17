// Who may moderate whom. Each check returns a translation key explaining the
// refusal, or undefined when the action is allowed.

import { PermissionFlagsBits } from "discord.js";
import { Setting } from "../settings/guildSettings.js";

// The role that may use every moderation command: the mod role from /settings,
// or the staff role if no mod role is set. Once a permission setup was chosen
// on the dashboard, the staff role is only for country changes.
export function moderatorRoleId(guildSettings, guildId) {
  const modRoleId = guildSettings?.get(guildId, Setting.MOD_ROLE);
  if (modRoleId || guildSettings?.get(guildId, Setting.PERMISSION_PRESET)) {
    return modRoleId;
  }
  return guildSettings?.get(guildId, Setting.STAFF_ROLE);
}

// Members with the Discord permission, or with the moderator role, may use a
// moderation command.
export function isModerator(interaction, permission, guildSettings) {
  if (interaction.memberPermissions?.has(permission)) {
    return true;
  }
  const roleId = moderatorRoleId(guildSettings, interaction.guildId);
  return Boolean(roleId && interaction.member?.roles?.cache?.has(roleId));
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
