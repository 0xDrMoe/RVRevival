import { Collection, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { wrapServer, wrapMember } from "../src/roles/discordAdapters.js";

const GUILD_ID = "900000000000000001";

/** @param {{ manageRoles: boolean, botTop: number }} options */
function fakeGuild(options) {
  const roles = new Collection([
    [GUILD_ID, { id: GUILD_ID, name: "@everyone", position: 0, managed: false }],
    ["111111111111111111", { id: "111111111111111111", name: "Canada", position: 3, managed: false }],
  ]);
  const create = vi.fn(async (opts) => ({ id: "222222222222222222", name: opts.name, position: 1, managed: false }));
  const guild = {
    id: GUILD_ID,
    roles: { cache: roles, create },
    members: {
      me: {
        permissions: { has: (flag) => flag === PermissionFlagsBits.ManageRoles && options.manageRoles },
        roles: { highest: { position: options.botTop } },
      },
    },
  };
  return { guild: guild, create };
}

describe("discord.js adapters", () => {
  it("lists roles without @everyone and reports bot permissions", () => {
    const { guild } = fakeGuild({ manageRoles: true, botTop: 10 });
    const port = wrapServer(guild);
    expect(port.listRoles().map((r) => r.name)).toEqual(["Canada"]);
    expect(port.botCanManageRoles()).toBe(true);
    expect(port.botHighestRolePosition()).toBe(10);
    expect(wrapServer(fakeGuild({ manageRoles: false, botTop: 10 }).guild).botCanManageRoles()).toBe(false);
  });

  it("creates roles with no permissions, no color, not hoisted or mentionable", async () => {
    const { guild, create } = fakeGuild({ manageRoles: true, botTop: 10 });
    await wrapServer(guild).createRole("Japan", "reason");
    expect(create).toHaveBeenCalledWith({
      name: "Japan",
      permissions: [],
      hoist: false,
      mentionable: false,
      reason: "reason",
    });
    const args = create.mock.calls[0]?.[0];
    expect(args).not.toHaveProperty("color");
    expect(args).not.toHaveProperty("colors");
  });

  it("adds and removes roles only on the wrapped member", async () => {
    const add = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const member = { id: "300000000000000001", roles: { cache: new Collection([["1", {}]]), add, remove } };
    const port = wrapMember(member);
    expect(port.hasRole("1")).toBe(true);
    expect(port.hasRole("2")).toBe(false);
    await port.addRole("2", "why");
    expect(add).toHaveBeenCalledWith("2", "why");
    await port.removeRole("1", "why");
    expect(remove).toHaveBeenCalledWith("1", "why");
  });
});
