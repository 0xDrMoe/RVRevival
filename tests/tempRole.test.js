import { describe, expect, it, vi } from "vitest";
import { buildTempRoleCommandData, createTempRoleCommand } from "../src/commands/tempRole.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings } from "../src/settings/guildSettings.js";
import { createTempRoleScheduler } from "../src/tempRoles/tempRoleScheduler.js";
import { TempRoleStore } from "../src/tempRoles/tempRoleStore.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "300000000000000000";
const BOT_ID = "300000000000000099";
const MEMBER_ID = "300000000000000020";
const ROLE_ID = "700000000000000001";
const HOUR = 60 * 60 * 1000;

function fakeMember(roleIds = []) {
  const cache = new Map(roleIds.map((id) => [id, { id }]));
  return {
    id: MEMBER_ID,
    user: { id: MEMBER_ID },
    roles: {
      highest: { position: 1 },
      cache,
      add: vi.fn(async (id) => cache.set(id, { id })),
      remove: vi.fn(async (id) => cache.delete(id)),
    },
  };
}

function fakeGuild(member) {
  const role = { id: ROLE_ID, position: 5, managed: false };
  return {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    roles: { cache: new Map([[ROLE_ID, role]]) },
    members: { me: { id: BOT_ID, roles: { highest: { position: 50 } } }, fetch: vi.fn(async () => member) },
    role,
  };
}

function interaction(guild, member, subcommand, options = {}) {
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    guild,
    user: { id: OWNER_ID, tag: "owner" },
    member: { id: OWNER_ID, roles: { highest: { position: 100 }, cache: new Map() } },
    memberPermissions: { has: () => true },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getMember: () => member,
      getUser: (name) => (name === "member" && options.noMember ? null : member?.user ?? null),
      getRole: () => guild.role,
      getString: (name) => options[name] ?? null,
    },
    reply: vi.fn(async () => {}),
  };
}

describe("/temprole", () => {
  it("builds the command", () => {
    expect(buildTempRoleCommandData().options.map((option) => option.name)).toEqual(["add", "remove", "list"]);
  });

  it("gives a role, extends it, lists it and takes it away early", async () => {
    let time = 1_000_000;
    const store = new TempRoleStore();
    const modLog = { post: vi.fn(async () => {}) };
    const command = createTempRoleCommand({ guildSettings: new GuildSettings(), store, modLog, now: () => time });
    const member = fakeMember();
    const guild = fakeGuild(member);

    expect(await command.execute(interaction(guild, member, "add", { duration: "2h", reason: "event" }))).toMatchObject({ key: "temproleAdded" });
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(store.get(GUILD_ID, MEMBER_ID, ROLE_ID)).toMatchObject({ expiresAt: time + 2 * HOUR, reason: "event" });

    time += HOUR;
    expect(await command.execute(interaction(guild, member, "add", { duration: "3h" }))).toMatchObject({ key: "temproleExtended" });
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(store.get(GUILD_ID, MEMBER_ID, ROLE_ID).expiresAt).toBe(time + 3 * HOUR);

    const list = interaction(guild, null, "list", { noMember: true });
    await command.execute(list);
    expect(list.reply.mock.calls[0][0].content).toContain(`<@&${ROLE_ID}>`);

    expect(await command.execute(interaction(guild, member, "remove"))).toMatchObject({ key: "temproleRemoved" });
    expect(member.roles.cache.has(ROLE_ID)).toBe(false);
    expect(store.count(GUILD_ID)).toBe(0);
    expect(modLog.post).toHaveBeenCalledTimes(3);
  });

  it("refuses bad durations and roles the member already has for good", async () => {
    const command = createTempRoleCommand({ guildSettings: new GuildSettings(), store: new TempRoleStore() });
    const member = fakeMember();
    const guild = fakeGuild(member);
    for (const duration of ["soon", "30s", "400d"]) {
      expect(await command.execute(interaction(guild, member, "add", { duration }))).toMatchObject({ status: Status.REFUSED, key: "temproleBadDuration" });
    }
    const permanent = fakeMember([ROLE_ID]);
    expect(await command.execute(interaction(fakeGuild(permanent), permanent, "add", { duration: "1d" }))).toMatchObject({ key: "temproleAlreadyHas" });
  });
});

describe("temporary role scheduler", () => {
  it("takes roles away when they end, once", async () => {
    let time = 0;
    const store = new TempRoleStore();
    const member = fakeMember([ROLE_ID]);
    const guild = fakeGuild(member);
    const modLog = { post: vi.fn(async () => {}) };
    const client = { user: { id: BOT_ID }, guilds: { cache: new Map([[GUILD_ID, guild]]) } };
    const scheduler = createTempRoleScheduler({ client, store, modLog, logger: fakeLogger(), now: () => time });
    store.set({ guildId: GUILD_ID, userId: MEMBER_ID, roleId: ROLE_ID, expiresAt: HOUR, moderatorId: OWNER_ID });
    store.set({ guildId: GUILD_ID, userId: "300000000000000021", roleId: "700000000000000009", expiresAt: HOUR, moderatorId: OWNER_ID });

    await scheduler.sweep();
    expect(member.roles.remove).not.toHaveBeenCalled();
    time = HOUR;
    await scheduler.sweep();
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE_ID, "Temporary role ended");
    // The deleted role is just forgotten.
    expect(store.count(GUILD_ID)).toBe(0);
    expect(modLog.post).toHaveBeenCalledTimes(1);
    await scheduler.sweep();
    expect(member.roles.remove).toHaveBeenCalledTimes(1);
  });
});
