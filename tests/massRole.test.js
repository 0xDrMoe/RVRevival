import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildMassRoleCommandData, createMassRoleCommand, pickTargets, runMassRole, WHO } from "../src/commands/massRole.js";
import { discordError } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "900000000000000002";
const MOD_ID = "900000000000000003";
const ROLE_ID = "800000000000000001";
const OTHER_ROLE_ID = "800000000000000002";

function fakeMember(id, { bot = false, roleIds = [], fail } = {}) {
  const roles = new Set(roleIds);
  return {
    id,
    user: { id, bot },
    roles: {
      cache: { has: (roleId) => roles.has(roleId) },
      add: vi.fn(async (roleId) => {
        if (fail) {
          throw fail;
        }
        roles.add(roleId);
      }),
      remove: vi.fn(async (roleId) => {
        roles.delete(roleId);
      }),
    },
  };
}

function setup({ members, permissions = [PermissionFlagsBits.ManageRoles], userId = MOD_ID, rolePermissions = [], loaded = true } = {}) {
  const role = { id: ROLE_ID, position: 5, managed: false, permissions: new PermissionsBitField(rolePermissions) };
  const cache = new Map(members.map((member) => [member.id, member]));
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    members: { me: { id: "bot", roles: { highest: { position: 50 } } }, cache },
  };
  const modLog = { post: vi.fn(async () => {}) };
  const command = createMassRoleCommand({
    guildSettings: { get: () => undefined },
    modLog,
    memberLoader: { loadAll: vi.fn(async () => loaded) },
  });
  const interaction = (subcommand, { who = WHO.HUMANS, hasRole = null } = {}) => ({
    locale: "en-US",
    guildId: GUILD_ID,
    guild,
    user: { id: userId, tag: "mod" },
    member: { id: userId, roles: { highest: { position: 20 }, cache: new Map() } },
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getRole: (name) => (name === "role" ? role : hasRole),
      getString: () => who,
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async function () {
      this.replied = true;
    }),
    deferReply: vi.fn(async function () {
      this.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
  });
  return { command, interaction, modLog, role };
}

describe("/massrole", () => {
  it("has add, remove and cancel", () => {
    const data = buildMassRoleCommandData();
    expect(data.options.map((option) => option.name)).toEqual(["add", "remove", "cancel"]);
    expect(data.options[0].options.map((option) => option.name)).toEqual(["role", "who", "has-role"]);
    expect(data.options[0].options[1].choices.map((choice) => choice.value)).toEqual(["humans", "bots", "everyone"]);
  });

  it("picks members by who and has-role, skipping those already done", () => {
    const members = [
      fakeMember("1"),
      fakeMember("2", { bot: true }),
      fakeMember("3", { roleIds: [ROLE_ID] }),
      fakeMember("4", { roleIds: [OTHER_ROLE_ID] }),
    ];
    const ids = (list) => list.map((member) => member.id);
    expect(ids(pickTargets(members, { roleId: ROLE_ID, adding: true, who: WHO.HUMANS }))).toEqual(["1", "4"]);
    expect(ids(pickTargets(members, { roleId: ROLE_ID, adding: true, who: WHO.BOTS }))).toEqual(["2"]);
    expect(ids(pickTargets(members, { roleId: ROLE_ID, adding: true, who: WHO.EVERYONE }))).toEqual(["1", "2", "4"]);
    expect(ids(pickTargets(members, { roleId: ROLE_ID, adding: true, who: WHO.EVERYONE, hasRoleId: OTHER_ROLE_ID }))).toEqual(["4"]);
    expect(ids(pickTargets(members, { roleId: ROLE_ID, adding: false, who: WHO.EVERYONE }))).toEqual(["3"]);
  });

  it("skips members who left and stops when the bot loses the permission", async () => {
    const members = [fakeMember("1"), fakeMember("2", { fail: discordError(10007) }), fakeMember("3", { fail: discordError(50013) }), fakeMember("4")];
    const counts = await runMassRole({ members, roleId: ROLE_ID, adding: true, reason: "r", job: { cancelled: false } });
    expect(counts).toMatchObject({ done: 1, skipped: 1, failed: 0, total: 4, stopped: "noPermission" });
    expect(members[3].roles.add).not.toHaveBeenCalled();
  });

  it("stops when cancelled", async () => {
    const job = { cancelled: false };
    const members = [fakeMember("1"), fakeMember("2")];
    const counts = await runMassRole({
      members,
      roleId: ROLE_ID,
      adding: true,
      reason: "r",
      job,
      onProgress: () => {
        job.cancelled = true;
      },
    });
    expect(counts).toMatchObject({ done: 1, stopped: "cancelled" });
  });

  it("gives the role to every person and logs it", async () => {
    const members = [fakeMember("1"), fakeMember("2", { bot: true }), fakeMember("3")];
    const { command, interaction, modLog } = setup({ members });
    const reply = interaction("add");
    const outcome = await command.execute(reply);
    expect(outcome).toMatchObject({ status: "success", key: "massRoleAddedDone", values: { done: 2, total: 2 } });
    expect(members[0].roles.add).toHaveBeenCalledWith(ROLE_ID, expect.stringContaining("Mass role add"));
    expect(members[1].roles.add).not.toHaveBeenCalled();
    expect(modLog.post).toHaveBeenCalledTimes(1);
    expect(reply.editReply.mock.calls.at(-1)[0].content).toContain("gave <@&800000000000000001> to 2 of 2");
  });

  it("refuses without Manage Roles, and roles with moderator powers unless you're the owner", async () => {
    const members = [fakeMember("1")];
    expect((await setup({ members, permissions: [] }).command.execute(setup({ members, permissions: [] }).interaction("add"))).key).toBe("modNoPermission");
    const risky = setup({ members, rolePermissions: [PermissionFlagsBits.BanMembers] });
    expect((await risky.command.execute(risky.interaction("add"))).key).toBe("massRoleTooPowerful");
    const owner = setup({ members, rolePermissions: [PermissionFlagsBits.BanMembers], userId: OWNER_ID });
    expect((await owner.command.execute(owner.interaction("add"))).key).toBe("massRoleAddedDone");
    // Taking a powerful role away is always fine.
    const removing = setup({ members: [fakeMember("1", { roleIds: [ROLE_ID] })], rolePermissions: [PermissionFlagsBits.BanMembers] });
    expect((await removing.command.execute(removing.interaction("remove"))).key).toBe("massRoleRemovedDone");
  });

  it("says when the member list can't be loaded, or nobody needs changing", async () => {
    const offline = setup({ members: [fakeMember("1")], loaded: false });
    expect((await offline.command.execute(offline.interaction("add"))).key).toBe("massRoleNoMemberList");
    const done = setup({ members: [fakeMember("1", { roleIds: [ROLE_ID] })] });
    expect((await done.command.execute(done.interaction("add"))).key).toBe("massRoleNobody");
  });

  it("runs one at a time per server, and cancel stops it", async () => {
    let release;
    const slow = fakeMember("1");
    slow.roles.add = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const { command, interaction } = setup({ members: [slow, fakeMember("2")] });
    const running = command.execute(interaction("add"));
    await vi.waitFor(() => expect(slow.roles.add).toHaveBeenCalled());
    expect((await command.execute(interaction("add"))).key).toBe("massRoleBusy");
    expect((await command.execute(interaction("cancel"))).key).toBe("massRoleCancelling");
    release();
    expect((await running).key).toBe("massRoleCancelled");
    expect((await command.execute(interaction("cancel"))).key).toBe("massRoleNothingRunning");
  });
});
