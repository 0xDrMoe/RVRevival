import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { checkRolePersist, createRolePersistence, InvalidRolePersist, KEEP_DAYS } from "../src/members/rolePersistence.js";
import { SavedRoles, SavedRoleStore } from "../src/members/savedRoleStore.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const MEMBER_ID = "300000000000000020";
const REGULAR = "700000000000000001";
const MUTED = "700000000000000002";
const MOD = "700000000000000003";
const BOOSTER = "700000000000000004";
const IGNORED = "700000000000000005";
const HIGH = "700000000000000006";
const DAY = 24 * 60 * 60 * 1000;

function fakeGuild() {
  const role = (id, position, { managed = false, permissions = [] } = {}) => ({ id, position, managed, permissions: new PermissionsBitField(permissions) });
  const roles = [
    role(GUILD_ID, 0),
    role(REGULAR, 2),
    role(MUTED, 3),
    role(MOD, 4, { permissions: [PermissionFlagsBits.BanMembers] }),
    role(BOOSTER, 5, { managed: true }),
    role(IGNORED, 6),
    role(HIGH, 90),
  ];
  return { id: GUILD_ID, roles: { cache: new Map(roles.map((entry) => [entry.id, entry])) }, members: { me: { roles: { highest: { position: 50 } } } } };
}

function fakeMember(guild, roleIds, extra = {}) {
  return {
    id: MEMBER_ID,
    guild,
    user: { id: MEMBER_ID, bot: false },
    partial: false,
    roles: { cache: new Map(roleIds.map((id) => [id, guild.roles.cache.get(id)])), add: vi.fn(async () => {}) },
    ...extra,
  };
}

function setup({ enabled = true, quarantined = false, now = () => 10 * DAY } = {}) {
  const guildSettings = new GuildSettings();
  guildSettings.set(GUILD_ID, Setting.ROLE_PERSIST, { enabled, ignoredRoleIds: [IGNORED] });
  const store = new SavedRoleStore();
  const persistence = createRolePersistence({ guildSettings, store, isQuarantined: () => quarantined, logger: fakeLogger(), now });
  return { guildSettings, store, persistence, guild: fakeGuild() };
}

describe("role persistence", () => {
  it("saves roles on leave and gives the safe ones back on rejoin", async () => {
    const { persistence, guild, store } = setup();
    expect(persistence.memberLeft(fakeMember(guild, [GUILD_ID, REGULAR, MUTED, MOD, BOOSTER, IGNORED, HIGH]))).toBe(true);
    expect(store.get(GUILD_ID, MEMBER_ID, SavedRoles.LEFT).roleIds).toEqual([REGULAR, MUTED, MOD, HIGH]);

    const rejoined = fakeMember(guild, [GUILD_ID]);
    expect(await persistence.memberJoined(rejoined)).toEqual([REGULAR, MUTED]);
    expect(rejoined.roles.add).toHaveBeenCalledWith([REGULAR, MUTED], "Role persistence: rejoined");
    // Used once.
    expect(store.get(GUILD_ID, MEMBER_ID, SavedRoles.LEFT)).toBeUndefined();
  });

  it("does nothing when off, for bots, uncached members, or quarantined members", async () => {
    const off = setup({ enabled: false });
    expect(off.persistence.memberLeft(fakeMember(off.guild, [REGULAR]))).toBe(false);
    const on = setup();
    expect(on.persistence.memberLeft(fakeMember(on.guild, [REGULAR], { partial: true }))).toBe(false);
    expect(on.persistence.memberLeft(fakeMember(on.guild, [REGULAR], { user: { bot: true } }))).toBe(false);
    const quarantined = setup({ quarantined: true });
    expect(quarantined.persistence.memberLeft(fakeMember(quarantined.guild, [REGULAR]))).toBe(false);
  });

  it("forgets saved roles if turned off before they rejoin, and prunes old ones", async () => {
    let time = 10 * DAY;
    const { persistence, guild, store, guildSettings } = setup({ now: () => time });
    persistence.memberLeft(fakeMember(guild, [REGULAR]));
    guildSettings.set(GUILD_ID, Setting.ROLE_PERSIST, { enabled: false, ignoredRoleIds: [] });
    expect(await persistence.memberJoined(fakeMember(guild, []))).toEqual([]);
    expect(store.get(GUILD_ID, MEMBER_ID, SavedRoles.LEFT)).toBeUndefined();

    guildSettings.set(GUILD_ID, Setting.ROLE_PERSIST, { enabled: true, ignoredRoleIds: [] });
    store.save({ guildId: GUILD_ID, userId: "300000000000000021", kind: SavedRoles.LEFT, roleIds: [REGULAR], savedAt: 0 });
    time = (KEEP_DAYS + 1) * DAY;
    persistence.memberLeft(fakeMember(guild, [REGULAR]));
    expect(store.get(GUILD_ID, "300000000000000021", SavedRoles.LEFT)).toBeUndefined();
  });

  it("checks dashboard input", () => {
    const isRole = (id) => id === REGULAR;
    expect(checkRolePersist({ enabled: true, ignoredRoleIds: [REGULAR] }, { isRole })).toEqual({ enabled: true, ignoredRoleIds: [REGULAR] });
    expect(checkRolePersist({ enabled: false, ignoredRoleIds: [] }, { isRole })).toBeNull();
    expect(() => checkRolePersist({ enabled: true, ignoredRoleIds: [MUTED] }, { isRole })).toThrow(InvalidRolePersist);
    expect(() => checkRolePersist({ enabled: "yes", ignoredRoleIds: [] }, { isRole })).toThrow(InvalidRolePersist);
  });
});
