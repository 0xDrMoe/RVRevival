// Fake Discord objects for the moderation tests. Nothing here talks to Discord.

import { PermissionFlagsBits } from "discord.js";
import { vi } from "vitest";

export const GUILD_ID = "900000000000000001";
export const OWNER_ID = "300000000000000000";
export const BOT_ID = "300000000000000099";
export const MOD_ID = "300000000000000010";
export const TARGET_ID = "300000000000000020";
export const STAFF_ROLE_ID = "700000000000000001";

export function fakeUser(id, { tag = `user-${id.slice(-2)}`, dmFails = false } = {}) {
  return {
    id,
    tag,
    username: tag,
    bot: false,
    displayAvatarURL: () => undefined,
    send: vi.fn(async () => {
      if (dmFails) {
        throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
      }
    }),
  };
}

// A member with a top role at `position`. `permissions` lists PermissionFlagsBits.
export function fakeMember(id, { position = 1, permissions = [], roleIds = [], timedOutUntil = null, ...userOptions } = {}) {
  const user = fakeUser(id, userOptions);
  const member = {
    id,
    user,
    roles: { highest: { position }, cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])) },
    permissions: { has: (bit) => permissions.includes(bit) },
    communicationDisabledUntilTimestamp: timedOutUntil,
    isCommunicationDisabled: () => Boolean(timedOutUntil && timedOutUntil > Date.now()),
    kick: vi.fn(async () => {}),
    timeout: vi.fn(async () => {}),
  };
  return member;
}

export function fakeGuild({ bot = fakeMember(BOT_ID, { position: 50 }), banned = new Set() } = {}) {
  return {
    id: GUILD_ID,
    name: "Rumbleverse *Revival*",
    ownerId: OWNER_ID,
    preferredLocale: "en-US",
    members: {
      me: bot,
      ban: vi.fn(async (userId) => {
        banned.add(userId);
      }),
      unban: vi.fn(async (userId) => {
        if (!banned.delete(userId)) {
          throw Object.assign(new Error("Unknown Ban"), { code: 10026 });
        }
      }),
    },
    bans: {
      fetch: vi.fn(async ({ user }) => {
        if (!banned.has(user)) {
          throw Object.assign(new Error("Unknown Ban"), { code: 10026 });
        }
        return { user: { id: user } };
      }),
    },
    channels: { cache: new Map() },
    banned,
  };
}

export const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;
