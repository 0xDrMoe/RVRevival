// Fake Discord objects for tests. Nothing here talks to Discord.

import { vi } from "vitest";

export function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let lastId = 100000000000000000n;
export function newId() {
  lastId += 1n;
  return lastId.toString();
}

// A Discord error with the given error code, like discord.js's DiscordAPIError.
export function discordError(code) {
  return Object.assign(new Error("Discord API error"), { name: "DiscordAPIError", code, status: 403 });
}

// An in-memory server with roles and members, shaped like wrapServer() output.
export class FakeServer {
  guildId = "900000000000000001";
  roles = [];
  rolesByUser = new Map();
  canManageRoles = true;
  botRolePosition = 50;
  createDelayMs = 0;

  createRole = vi.fn(async (name) => {
    if (this.createDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    }
    const role = { id: newId(), name, position: 1, managed: false };
    this.roles.push(role);
    return role;
  });

  addRole(name, overrides = {}) {
    const role = { id: newId(), name, position: 5, managed: false, ...overrides };
    this.roles.push(role);
    return role;
  }

  listRoles() {
    return [...this.roles];
  }

  botCanManageRoles() {
    return this.canManageRoles;
  }

  botHighestRolePosition() {
    return this.botRolePosition;
  }

  // A member shaped like wrapMember() output.
  member(userId, roleIds = []) {
    if (!this.rolesByUser.has(userId)) {
      this.rolesByUser.set(userId, new Set(roleIds));
    }
    const roles = this.rolesByUser.get(userId);
    return {
      userId,
      hasRole: (roleId) => roles.has(roleId),
      addRole: vi.fn(async (roleId) => {
        roles.add(roleId);
      }),
      removeRole: vi.fn(async (roleId) => {
        roles.delete(roleId);
      }),
    };
  }
}
