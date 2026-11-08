// Permissions that make a role a staff role. The bot never hands out such a
// role by itself: not from a role panel, as an autorole, a level reward or a
// birthday role. Anyone could otherwise get moderator powers by joining,
// chatting or clicking a button.

import { PermissionFlagsBits } from "discord.js";

export const MODERATOR_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
]);

export const MODERATOR_PERMISSION_BITS = MODERATOR_PERMISSIONS.reduce((bits, bit) => bits | bit, 0n);

// Whether a role has any of them. Takes a discord.js Role (permissions is a
// PermissionsBitField) or a role from the REST API (permissions is a string).
export function isModeratorRole(role) {
  const permissions = role?.permissions;
  if (typeof permissions?.has === "function") {
    return MODERATOR_PERMISSIONS.some((bit) => permissions.has(bit));
  }
  return (BigInt(permissions ?? 0) & MODERATOR_PERMISSION_BITS) !== 0n;
}
