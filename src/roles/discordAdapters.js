// Wraps discord.js objects in the small "server" and "member" shapes that
// countryRoles.js works with.

import { PermissionFlagsBits } from "discord.js";

function describeRole(role) {
  return { id: role.id, name: role.name, position: role.position, managed: role.managed };
}

export function wrapServer(guild) {
  const bot = () => guild.members.me;

  return {
    guildId: guild.id,

    // Every role except @everyone (whose ID is the server's ID).
    listRoles: () => guild.roles.cache.filter((role) => role.id !== guild.id).map(describeRole),

    // Country roles are purely cosmetic: no permissions, default color,
    // not shown separately in the member list, not mentionable.
    createRole: async (name, reason) => {
      const role = await guild.roles.create({
        name,
        permissions: [],
        hoist: false,
        mentionable: false,
        reason,
      });
      return describeRole(role);
    },

    botCanManageRoles: () => bot()?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false,
    botHighestRolePosition: () => bot()?.roles.highest.position ?? 0,
  };
}

export function wrapMember(member) {
  return {
    userId: member.id,
    hasRole: (roleId) => member.roles.cache.has(roleId),
    addRole: async (roleId, reason) => {
      await member.roles.add(roleId, reason);
    },
  };
}
