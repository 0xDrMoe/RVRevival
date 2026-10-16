import { describe, expect, it, vi } from "vitest";
import { buildQuarantineCommandData, createQuarantineCommand } from "../src/commands/quarantine.js";
import { Status } from "../src/logs/actionLog.js";
import { SavedRoles, SavedRoleStore } from "../src/members/savedRoleStore.js";
import { AlreadyQuarantined, createQuarantine } from "../src/moderation/quarantine.js";
import { createAntiNuke } from "../src/raid/antiNuke.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "300000000000000000";
const BOT_ID = "300000000000000099";
const MOD_ID = "300000000000000010";
const MEMBER_ID = "300000000000000020";
const ROLE_A = "700000000000000001";
const ROLE_B = "700000000000000002";
const HIGH = "700000000000000003";
const BOOSTER = "700000000000000004";
const JAIL = "700000000000000005";

function fakeGuild() {
  const role = (id, position, extra = {}) => ({ id, position, managed: false, ...extra });
  const roles = new Map(
    [role(GUILD_ID, 0), role(ROLE_A, 2), role(ROLE_B, 3), role(HIGH, 60), role(BOOSTER, 4, { managed: true }), role(JAIL, 1)].map((entry) => [entry.id, entry]),
  );
  return {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    roles: { cache: roles },
    members: { me: { id: BOT_ID, roles: { highest: { position: 50 } } } },
    client: { user: { id: BOT_ID, tag: "Bot" } },
  };
}

function fakeMember(guild, roleIds, { id = MEMBER_ID, position = 3 } = {}) {
  const cache = new Map(roleIds.map((roleId) => [roleId, guild.roles.cache.get(roleId)]));
  const member = {
    id,
    guild,
    user: { id, tag: "member", bot: false },
    roles: {
      highest: { position },
      cache,
      set: vi.fn(async (ids) => {
        cache.clear();
        ids.forEach((roleId) => cache.set(roleId, guild.roles.cache.get(roleId)));
      }),
      add: vi.fn(async (roleId) => cache.set(roleId, guild.roles.cache.get(roleId))),
    },
  };
  return member;
}

function setup() {
  const guildSettings = new GuildSettings();
  const store = new SavedRoleStore();
  const modLog = { post: vi.fn(async () => {}) };
  const quarantine = createQuarantine({ guildSettings, store, modLog, logger: fakeLogger(), now: () => 5_000 });
  return { guildSettings, store, modLog, quarantine, guild: fakeGuild() };
}

describe("saved role store", () => {
  it("saves, replaces, lists, deletes and prunes", () => {
    const store = new SavedRoleStore();
    store.save({ guildId: GUILD_ID, userId: MEMBER_ID, kind: SavedRoles.LEFT, roleIds: [ROLE_A, ROLE_A], savedAt: 1 });
    store.save({ guildId: GUILD_ID, userId: MEMBER_ID, kind: SavedRoles.LEFT, roleIds: [ROLE_B], savedAt: 2 });
    store.save({ guildId: GUILD_ID, userId: MOD_ID, kind: SavedRoles.QUARANTINE, roleIds: [ROLE_A], reason: "spam", moderatorId: OWNER_ID, savedAt: 3 });
    expect(store.get(GUILD_ID, MEMBER_ID, SavedRoles.LEFT)).toMatchObject({ roleIds: [ROLE_B], savedAt: 2 });
    expect(store.list(GUILD_ID, SavedRoles.QUARANTINE)).toEqual([expect.objectContaining({ userId: MOD_ID, reason: "spam", moderatorId: OWNER_ID })]);
    expect(store.count(GUILD_ID, SavedRoles.QUARANTINE)).toBe(1);
    expect(store.prune(SavedRoles.LEFT, 3)).toBe(1);
    expect(store.delete(GUILD_ID, MOD_ID, SavedRoles.QUARANTINE)).toBe(true);
    expect(store.delete(GUILD_ID, MOD_ID, SavedRoles.QUARANTINE)).toBe(false);
  });
});

describe("quarantine", () => {
  it("takes the roles the bot can, gives the quarantine role, and gives everything back", async () => {
    const { guildSettings, quarantine, guild, store, modLog } = setup();
    guildSettings.set(GUILD_ID, Setting.QUARANTINE_ROLE, JAIL);
    const member = fakeMember(guild, [GUILD_ID, ROLE_A, ROLE_B, HIGH, BOOSTER]);
    const result = await quarantine.quarantine({ guild, member, moderator: { id: MOD_ID }, reason: "spam" });
    expect(result).toEqual({ removed: [ROLE_A, ROLE_B], kept: [HIGH, BOOSTER], roleGiven: true });
    expect(member.roles.set).toHaveBeenCalledWith([HIGH, BOOSTER, JAIL], "spam");
    expect(store.get(GUILD_ID, MEMBER_ID, SavedRoles.QUARANTINE)).toMatchObject({ roleIds: [ROLE_A, ROLE_B], reason: "spam", moderatorId: MOD_ID });
    await expect(quarantine.quarantine({ guild, member, moderator: { id: MOD_ID } })).rejects.toThrow(AlreadyQuarantined);

    // ROLE_B was deleted in the meantime.
    guild.roles.cache.delete(ROLE_B);
    const released = await quarantine.release({ guild, member, moderator: { id: MOD_ID } });
    expect(released).toEqual({ restored: [ROLE_A], missing: [ROLE_B] });
    expect([...member.roles.cache.keys()].sort()).toEqual([BOOSTER, HIGH, ROLE_A].sort());
    expect(quarantine.isQuarantined(GUILD_ID, MEMBER_ID)).toBe(false);
    expect(modLog.post).toHaveBeenCalledTimes(2);
    expect(await quarantine.release({ guild, member, moderator: { id: MOD_ID } })).toBeUndefined();
  });

  it("forgets the saved roles if Discord refuses", async () => {
    const { quarantine, guild } = setup();
    const member = fakeMember(guild, [ROLE_A]);
    member.roles.set.mockRejectedValueOnce(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    await expect(quarantine.quarantine({ guild, member, moderator: { id: MOD_ID } })).rejects.toThrow("Missing Permissions");
    expect(quarantine.isQuarantined(GUILD_ID, MEMBER_ID)).toBe(false);
  });

  it("puts the quarantine role back on someone who rejoins", async () => {
    const { guildSettings, quarantine, guild } = setup();
    guildSettings.set(GUILD_ID, Setting.QUARANTINE_ROLE, JAIL);
    await quarantine.quarantine({ guild, member: fakeMember(guild, [ROLE_A]), moderator: { id: MOD_ID } });
    const rejoined = fakeMember(guild, []);
    expect(await quarantine.memberJoined(rejoined)).toBe(true);
    expect(rejoined.roles.add).toHaveBeenCalledWith(JAIL, "Rejoined while quarantined");
    expect(await quarantine.memberJoined(fakeMember(guild, [], { id: MOD_ID }))).toBe(false);
  });

  it("is what anti-nuke uses to take roles", async () => {
    const { guildSettings, quarantine, guild } = setup();
    guildSettings.set(GUILD_ID, Setting.ANTI_NUKE, { enabled: true, limits: { roleDelete: 2 } });
    const member = fakeMember(guild, [ROLE_A]);
    Object.assign(guild, {
      name: "Server",
      preferredLocale: "en-US",
      members: { ...guild.members, fetch: vi.fn(async () => member) },
      fetchOwner: vi.fn(async () => ({ send: vi.fn(async () => {}) })),
    });
    const antiNuke = createAntiNuke({ guildSettings, quarantine, modLog: { post: vi.fn(async () => {}) }, logger: fakeLogger() });
    await antiNuke.record(guild, MEMBER_ID, "roleDelete");
    await antiNuke.record(guild, MEMBER_ID, "roleDelete");
    expect(quarantine.get(GUILD_ID, MEMBER_ID)).toMatchObject({ roleIds: [ROLE_A], moderatorId: BOT_ID });
  });
});

describe("/quarantine", () => {
  function interaction(guild, { subcommand, member, options = {}, permissions = ["ManageRoles", "ManageGuild"] }) {
    const reply = vi.fn(async () => {});
    const editReply = vi.fn(async () => {});
    const self = {
      locale: "en-US",
      guildId: GUILD_ID,
      guild,
      user: { id: OWNER_ID, tag: "owner" },
      member: { id: OWNER_ID, roles: { highest: { position: 100 }, cache: new Map() } },
      memberPermissions: { has: (bit) => permissions.some((name) => BigInt(bit) === BigInt(PERMS[name])) },
      inCachedGuild: () => true,
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => {
        self.deferred = true;
      }),
      options: {
        getSubcommand: () => subcommand,
        getMember: () => member ?? null,
        getUser: () => (member ? member.user : options.user ? { id: options.user } : null),
        getString: (name) => options[name] ?? null,
        getRole: () => options.role ?? null,
      },
      reply,
      editReply,
    };
    return self;
  }
  const PERMS = { ManageRoles: 1n << 28n, ManageGuild: 1n << 5n };
  const text = (call) => call.mock.calls.at(-1)[0].content;

  it("builds the command", () => {
    expect(buildQuarantineCommandData().options.map((option) => option.name)).toEqual(["add", "release", "list", "role"]);
  });

  it("quarantines, lists and releases", async () => {
    const { guildSettings, quarantine, guild } = setup();
    const command = createQuarantineCommand({ guildSettings, quarantine });
    const member = fakeMember(guild, [ROLE_A]);
    guild.members.me.roles.highest.position = 50;

    const add = interaction(guild, { subcommand: "add", member, options: { reason: "alt" } });
    expect(await command.execute(add)).toMatchObject({ status: Status.SUCCESS, key: "quarantineDoneNoRole" });
    const list = interaction(guild, { subcommand: "list" });
    await command.execute(list);
    expect(text(list.reply)).toContain(`<@${MEMBER_ID}>`);
    const release = interaction(guild, { subcommand: "release", member });
    expect(await command.execute(release)).toMatchObject({ status: Status.SUCCESS, key: "quarantineReleased" });
    expect(member.roles.cache.has(ROLE_A)).toBe(true);
  });

  it("forgets the quarantine of someone who left", async () => {
    const { guildSettings, quarantine, guild } = setup();
    await quarantine.quarantine({ guild, member: fakeMember(guild, [ROLE_A]), moderator: { id: MOD_ID } });
    const command = createQuarantineCommand({ guildSettings, quarantine });
    const release = interaction(guild, { subcommand: "release", options: { user: MEMBER_ID } });
    expect(await command.execute(release)).toMatchObject({ key: "quarantineForgotten" });
    expect(quarantine.isQuarantined(GUILD_ID, MEMBER_ID)).toBe(false);
  });

  it("sets the quarantine role only with Manage Server, and refuses roles it can't give", async () => {
    const { guildSettings, quarantine, guild } = setup();
    const command = createQuarantineCommand({ guildSettings, quarantine });
    const noPermission = interaction(guild, { subcommand: "role", options: { role: guild.roles.cache.get(JAIL) }, permissions: ["ManageRoles"] });
    expect(await command.execute(noPermission)).toMatchObject({ status: Status.REFUSED });
    const high = interaction(guild, { subcommand: "role", options: { role: guild.roles.cache.get(HIGH) } });
    expect(await command.execute(high)).toMatchObject({ key: "quarantineRoleUnusable" });
    await command.execute(interaction(guild, { subcommand: "role", options: { role: guild.roles.cache.get(JAIL) } }));
    expect(guildSettings.get(GUILD_ID, Setting.QUARANTINE_ROLE)).toBe(JAIL);
    await command.execute(interaction(guild, { subcommand: "role" }));
    expect(guildSettings.get(GUILD_ID, Setting.QUARANTINE_ROLE)).toBeUndefined();
  });
});
