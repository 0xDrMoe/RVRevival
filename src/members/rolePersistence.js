// Role persistence: remembers a member's roles when they leave and gives them
// back when they rejoin, so leaving can't shake off a muted or restricted
// role, and regulars get their roles back.
//
// Roles with moderator permissions are never given back automatically, and
// neither are bot or booster roles, roles above the bot, or roles the server
// chose to ignore. Saved roles are forgotten after a year.

import { PermissionFlagsBits } from "discord.js";
import { SavedRoles } from "./savedRoleStore.js";
import { canManageRole } from "../moderation/quarantine.js";
import { Setting } from "../settings/guildSettings.js";

export const MAX_IGNORED_ROLES = 25;
export const KEEP_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Never handed back without a human: anything a moderator or admin could use.
const STAFF_PERMISSIONS = [
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
];

export const DEFAULT_ROLE_PERSIST = Object.freeze({ enabled: false, ignoredRoleIds: [] });

export function normalizeRolePersist(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return {
    enabled: value.enabled === true,
    ignoredRoleIds: Array.isArray(value.ignoredRoleIds)
      ? [...new Set(value.ignoredRoleIds.filter((id) => typeof id === "string"))].slice(0, MAX_IGNORED_ROLES)
      : [],
  };
}

export class InvalidRolePersist extends Error {
  name = "InvalidRolePersist";
}

// Checks dashboard input; `isRole(id)` says whether the server has the role.
export function checkRolePersist(value, { isRole }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.enabled !== "boolean") {
    throw new InvalidRolePersist("Say whether roles are given back.");
  }
  if (!Array.isArray(value.ignoredRoleIds) || value.ignoredRoleIds.length > MAX_IGNORED_ROLES) {
    throw new InvalidRolePersist(`Ignore at most ${MAX_IGNORED_ROLES} roles.`);
  }
  if (!value.ignoredRoleIds.every(isRole)) {
    throw new InvalidRolePersist("Pick roles from this server.");
  }
  const config = normalizeRolePersist(value);
  return config.enabled || config.ignoredRoleIds.length > 0 ? config : null;
}

const isStaffRole = (role) => STAFF_PERMISSIONS.some((bit) => role.permissions?.has?.(bit));

// Options: guildSettings, store (SavedRoleStore), isQuarantined(guildId, userId), logger, now
export function createRolePersistence({ guildSettings, store, isQuarantined = () => false, logger, now = Date.now }) {
  const configFor = (guildId) => normalizeRolePersist(guildSettings.get(guildId, Setting.ROLE_PERSIST));

  return {
    // Saves the roles of someone leaving. Quarantined members keep their
    // quarantine instead.
    memberLeft(member) {
      const guild = member.guild;
      const config = configFor(guild.id);
      if (!config.enabled || member.partial || member.user?.bot || isQuarantined(guild.id, member.id)) {
        return false;
      }
      const quarantineRole = guildSettings.get(guild.id, Setting.QUARANTINE_ROLE);
      const roleIds = [...member.roles.cache.values()]
        .filter((role) => role.id !== guild.id && !role.managed && role.id !== quarantineRole && !config.ignoredRoleIds.includes(role.id))
        .map((role) => role.id);
      if (roleIds.length === 0) {
        store.delete(guild.id, member.id, SavedRoles.LEFT);
        return false;
      }
      store.save({ guildId: guild.id, userId: member.id, kind: SavedRoles.LEFT, roleIds, savedAt: now() });
      store.prune(SavedRoles.LEFT, now() - KEEP_DAYS * DAY_MS);
      return true;
    },

    // Gives the saved roles back. Returns the role IDs given.
    async memberJoined(member) {
      const guild = member.guild;
      const saved = store.get(guild.id, member.id, SavedRoles.LEFT);
      if (!saved) {
        return [];
      }
      store.delete(guild.id, member.id, SavedRoles.LEFT);
      const config = configFor(guild.id);
      if (!config.enabled || isQuarantined(guild.id, member.id)) {
        return [];
      }
      const roleIds = saved.roleIds.filter((id) => {
        const role = guild.roles.cache.get(id);
        return canManageRole(guild, role) && !isStaffRole(role) && !config.ignoredRoleIds.includes(id) && !member.roles.cache.has(id);
      });
      if (roleIds.length === 0) {
        return [];
      }
      try {
        await member.roles.add(roleIds, "Role persistence: rejoined");
        return roleIds;
      } catch (error) {
        logger.warn("Couldn't give roles back to a member who rejoined", { guildId: guild.id, error });
        return [];
      }
    },
  };
}
