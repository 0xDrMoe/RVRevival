// Quarantine: takes away a member's roles (and gives them the quarantine role,
// if one is set, usually a role that can only see one channel) while staff
// look into something, then gives every role back. The roles are saved in
// data/bot.db, so a restart or the member leaving and rejoining changes
// nothing: someone who rejoins while quarantined gets the quarantine role
// back and no autoroles.

import { buildActionLogEmbed, noModLog } from "./modLog.js";
import { SavedRoles } from "../members/savedRoleStore.js";
import { Setting } from "../settings/guildSettings.js";

export class AlreadyQuarantined extends Error {
  name = "AlreadyQuarantined";
}

// Whether the bot may take or give `role`: not @everyone, not a bot or booster
// role, and below the bot's highest role.
export function canManageRole(guild, role) {
  if (!role || role.id === guild.id || role.managed) {
    return false;
  }
  if (typeof role.editable === "boolean") {
    return role.editable;
  }
  return role.position < (guild.members.me?.roles?.highest?.position ?? 0);
}

// Options: guildSettings, store (SavedRoleStore), modLog, logger, now
export function createQuarantine({ guildSettings, store, modLog = noModLog, logger, now = Date.now }) {
  const quarantineRole = (guild) => {
    const role = guild.roles.cache.get(guildSettings.get(guild.id, Setting.QUARANTINE_ROLE));
    return canManageRole(guild, role) ? role : undefined;
  };

  const log = (guild, moderator, summary, lines, color) =>
    modLog.post(guild, () => ({ embed: buildActionLogEmbed({ moderator, summary, lines, color }) }));

  return {
    isQuarantined(guildId, userId) {
      return Boolean(store.get(guildId, userId, SavedRoles.QUARANTINE));
    },

    get(guildId, userId) {
      return store.get(guildId, userId, SavedRoles.QUARANTINE);
    },

    list(guildId) {
      return store.list(guildId, SavedRoles.QUARANTINE);
    },

    // Takes every role the bot can and saves them. Returns { removed, kept,
    // roleGiven }. `kept` are roles the bot couldn't take (above it, or bot roles).
    async quarantine({ guild, member, moderator, reason = null, audit = reason ?? "Quarantine" }) {
      if (store.get(guild.id, member.id, SavedRoles.QUARANTINE)) {
        throw new AlreadyQuarantined();
      }
      const role = quarantineRole(guild);
      const current = [...member.roles.cache.values()].filter((entry) => entry.id !== guild.id && entry.id !== role?.id);
      const removed = current.filter((entry) => canManageRole(guild, entry));
      const kept = current.filter((entry) => !removed.includes(entry));
      // Saved first: if Discord refuses, nothing is lost.
      store.save({
        guildId: guild.id,
        userId: member.id,
        kind: SavedRoles.QUARANTINE,
        roleIds: removed.map((entry) => entry.id),
        reason,
        moderatorId: moderator?.id ?? null,
        savedAt: now(),
      });
      try {
        await member.roles.set([...kept.map((entry) => entry.id), ...(role ? [role.id] : [])], audit);
      } catch (error) {
        store.delete(guild.id, member.id, SavedRoles.QUARANTINE);
        throw error;
      }
      await log(
        guild,
        moderator,
        `🔒 **Quarantined** · <@${member.id}>`,
        [
          reason ? `Reason: ${reason}` : null,
          removed.length > 0 ? `Roles taken: ${removed.map((entry) => `<@&${entry.id}>`).join(", ")}` : "They had no roles the bot could take.",
          kept.length > 0 ? `Roles kept (above the bot or managed): ${kept.map((entry) => `<@&${entry.id}>`).join(", ")}` : null,
          role ? `Given <@&${role.id}>.` : null,
        ].filter(Boolean),
        0xe67e22,
      );
      return { removed: removed.map((entry) => entry.id), kept: kept.map((entry) => entry.id), roleGiven: Boolean(role) };
    },

    // Gives back the saved roles that still exist and the bot can give, and
    // takes the quarantine role. Returns { restored, missing } or undefined if
    // they weren't quarantined.
    async release({ guild, member, moderator, reason = null }) {
      const saved = store.get(guild.id, member.id, SavedRoles.QUARANTINE);
      if (!saved) {
        return undefined;
      }
      const roleId = guildSettings.get(guild.id, Setting.QUARANTINE_ROLE);
      const restored = saved.roleIds.filter((id) => canManageRole(guild, guild.roles.cache.get(id)));
      const missing = saved.roleIds.filter((id) => !restored.includes(id));
      const keep = [...member.roles.cache.keys()].filter((id) => id !== guild.id && id !== roleId);
      await member.roles.set([...new Set([...keep, ...restored])], reason ?? "Quarantine ended");
      store.delete(guild.id, member.id, SavedRoles.QUARANTINE);
      await log(
        guild,
        moderator,
        `🔓 **Released from quarantine** · <@${member.id}>`,
        [
          reason ? `Reason: ${reason}` : null,
          restored.length > 0 ? `Roles given back: ${restored.map((id) => `<@&${id}>`).join(", ")}` : null,
          missing.length > 0 ? `${missing.length} role(s) couldn't be given back: deleted, or now above the bot.` : null,
        ].filter(Boolean),
        0x57f287,
      );
      return { restored, missing };
    },

    // Forgets a quarantine without touching roles (the member is gone for good).
    forget(guildId, userId) {
      return store.delete(guildId, userId, SavedRoles.QUARANTINE);
    },

    // Someone who rejoins while quarantined gets the quarantine role back.
    async memberJoined(member) {
      if (!store.get(member.guild.id, member.id, SavedRoles.QUARANTINE)) {
        return false;
      }
      const role = quarantineRole(member.guild);
      if (role) {
        await member.roles.add(role.id, "Rejoined while quarantined").catch((error) =>
          logger.warn("Couldn't give the quarantine role back", { guildId: member.guild.id, error }),
        );
      }
      return true;
    },
  };
}
