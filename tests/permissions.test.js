import { Collection, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { beforeEach, describe, expect, it } from "vitest";
import { checkLogRoutes, InvalidLogRoutes, LOG_ROUTES, normalizeLogRoutes, withoutChannel } from "../src/logs/logRoutes.js";
import { LogEvent } from "../src/logs/serverLog.js";
import { moderatorRoleId } from "../src/moderation/checks.js";
import { botCommandCatalog } from "../src/permissions/catalog.js";
import {
  checkCommandRules,
  commandVerdict,
  InvalidCommandRules,
  normalizeCommandRules,
  RoleMode,
  withGrant,
} from "../src/permissions/commandRules.js";
import { HELPER_COMMANDS, InvalidPreset, planPreset, Preset } from "../src/permissions/presets.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const MOD_ROLE = "700000000000000001";
const HELPER_ROLE = "700000000000000002";
const MUTED_ROLE = "700000000000000003";
const CHANNEL_ID = "800000000000000001";
const CATEGORY_ID = "800000000000000002";
const OTHER_CHANNEL = "800000000000000003";

const command = (name, permission) => {
  const data = new SlashCommandBuilder().setName(name).setDescription(name);
  if (permission !== undefined) {
    data.setDefaultMemberPermissions(permission);
  }
  return { name, data };
};
const ban = command("ban", PermissionFlagsBits.BanMembers);
const rank = command("rank");
const antinuke = command("antinuke", PermissionFlagsBits.Administrator);

function interaction({ roles = [], permissions = 0n, channel = { id: CHANNEL_ID } } = {}) {
  return {
    guildId: GUILD_ID,
    channel,
    member: { roles: { cache: new Collection(roles.map((id) => [id, { id }])) } },
    memberPermissions: new PermissionsBitField(permissions).freeze(),
  };
}

describe("command rules", () => {
  let settings;

  beforeEach(() => {
    settings = new GuildSettings();
  });

  const rules = (value) => settings.set(GUILD_ID, Setting.COMMAND_RULES, value);

  it("lets every command run as usual without rules", () => {
    expect(commandVerdict(interaction(), ban, settings)).toEqual({});
  });

  it("turns a command off for everyone, admins included", async () => {
    await rules({ ban: { disabled: true } });
    expect(commandVerdict(interaction({ permissions: PermissionFlagsBits.Administrator }), ban, settings)).toMatchObject({
      refusal: "commandRuleDisabled",
    });
  });

  it("gives a role a command's permission, only for that command", async () => {
    await rules({ ban: { roleIds: [HELPER_ROLE] } });
    const verdict = commandVerdict(interaction({ roles: [HELPER_ROLE] }), ban, settings);
    expect(verdict).toEqual({ grant: PermissionFlagsBits.BanMembers });
    const permissions = withGrant(new PermissionsBitField(0n), verdict.grant);
    expect(permissions.has(PermissionFlagsBits.BanMembers)).toBe(true);
    expect(permissions.has(PermissionFlagsBits.KickMembers)).toBe(false);
    expect(commandVerdict(interaction({ roles: [MOD_ROLE] }), ban, settings)).toEqual({});
  });

  it("limits a command everyone can use to its roles", async () => {
    await rules({ rank: { roleIds: [HELPER_ROLE] } });
    expect(commandVerdict(interaction(), rank, settings)).toMatchObject({ refusal: "commandRuleRoles" });
    expect(commandVerdict(interaction({ roles: [HELPER_ROLE] }), rank, settings)).toEqual({});
  });

  it("blocks roles and keeps a command to its channels, except for Manage Server", async () => {
    await rules({ rank: { blockedRoleIds: [MUTED_ROLE], channelIds: [CATEGORY_ID] } });
    expect(commandVerdict(interaction({ roles: [MUTED_ROLE], channel: { id: CHANNEL_ID, parentId: CATEGORY_ID } }), rank, settings)).toMatchObject({
      refusal: "commandRuleBlocked",
    });
    expect(commandVerdict(interaction({ channel: { id: OTHER_CHANNEL } }), rank, settings)).toMatchObject({
      refusal: "commandRuleChannel",
      values: { channels: `<#${CATEGORY_ID}>` },
    });
    expect(commandVerdict(interaction({ channel: { id: "1", parent: { parentId: CATEGORY_ID } } }), rank, settings)).toEqual({});
    expect(commandVerdict(interaction({ roles: [MUTED_ROLE], permissions: PermissionFlagsBits.ManageGuild, channel: { id: OTHER_CHANNEL } }), rank, settings)).toEqual({});
  });

  describe("with Discord permissions not counting", () => {
    beforeEach(async () => {
      await settings.set(GUILD_ID, Setting.NATIVE_PERMISSIONS, false);
      await settings.set(GUILD_ID, Setting.MOD_ROLE, MOD_ROLE);
    });

    it("refuses a member who only has the Discord permission", () => {
      expect(commandVerdict(interaction({ permissions: PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageGuild }), ban, settings)).toMatchObject({
        refusal: "commandRuleNative",
      });
    });

    it("lets the mod role in with none of the member's own permissions", () => {
      expect(commandVerdict(interaction({ roles: [MOD_ROLE], permissions: PermissionFlagsBits.ManageGuild }), ban, settings)).toEqual({ only: 0n });
    });

    it("gives a role allowed the command only that command's permission", async () => {
      await rules({ ban: { roleIds: [HELPER_ROLE] } });
      expect(commandVerdict(interaction({ roles: [HELPER_ROLE], permissions: PermissionFlagsBits.KickMembers }), ban, settings)).toEqual({
        only: PermissionFlagsBits.BanMembers,
      });
    });

    it("leaves commands everyone can use open, without the member's permissions", () => {
      expect(commandVerdict(interaction({ permissions: PermissionFlagsBits.ManageGuild }), rank, settings)).toEqual({ only: 0n });
    });

    it("never limits administrators, and only they skip the role and channel limits", async () => {
      await rules({ rank: { channelIds: [CATEGORY_ID] } });
      const admin = { permissions: PermissionFlagsBits.Administrator, channel: { id: OTHER_CHANNEL } };
      expect(commandVerdict(interaction(admin), ban, settings)).toEqual({});
      expect(commandVerdict(interaction(admin), rank, settings)).toEqual({});
      expect(commandVerdict(interaction({ permissions: PermissionFlagsBits.ManageGuild, channel: { id: OTHER_CHANNEL } }), rank, settings)).toMatchObject({
        refusal: "commandRuleChannel",
      });
    });
  });

  it("never gives out a command that needs Administrator", async () => {
    await rules({ antinuke: { roleIds: [HELPER_ROLE] } });
    expect(commandVerdict(interaction({ roles: [HELPER_ROLE] }), antinuke, settings)).toEqual({});
  });

  describe("checking rules from the dashboard", () => {
    const catalog = botCommandCatalog();
    const server = { catalog, isRole: (id) => [MOD_ROLE, HELPER_ROLE, MUTED_ROLE].includes(id), isChannel: (id) => id === CHANNEL_ID };

    it("lists every command with how roles work on it", () => {
      const byName = Object.fromEntries(catalog.map((entry) => [entry.name, entry]));
      expect(byName.ban).toMatchObject({ roleMode: RoleMode.GRANT, permission: String(PermissionFlagsBits.BanMembers) });
      expect(byName.rank.roleMode).toBe(RoleMode.RESTRICT);
      expect(byName.antinuke.roleMode).toBe(RoleMode.NONE);
      expect(byName["country-staff"].roleMode).toBe(RoleMode.NONE);
    });

    it("keeps real rules and drops empty ones", () => {
      expect(checkCommandRules({ ban: { roleIds: [HELPER_ROLE] }, kick: {} }, server)).toEqual({
        ban: { disabled: false, roleIds: [HELPER_ROLE], blockedRoleIds: [], channelIds: [] },
      });
      expect(checkCommandRules({ kick: { disabled: false } }, server)).toBeNull();
    });

    it("refuses unknown commands, foreign IDs and impossible rules", () => {
      for (const value of [
        { nope: { disabled: true } },
        { ban: { roleIds: ["123"] } },
        { ban: { roleIds: ["700000000000000009"] } },
        { ban: { channelIds: [OTHER_CHANNEL] } },
        { antinuke: { roleIds: [HELPER_ROLE] } },
        { ban: { roleIds: [HELPER_ROLE], blockedRoleIds: [HELPER_ROLE] } },
        { ban: { disabled: "yes" } },
        [],
      ]) {
        expect(() => checkCommandRules(value, server)).toThrow(InvalidCommandRules);
      }
    });

    it("reads damaged saved rules safely", () => {
      expect(normalizeCommandRules({ ban: { roleIds: [HELPER_ROLE, 5] }, kick: null })).toEqual({
        ban: { disabled: false, roleIds: [HELPER_ROLE], blockedRoleIds: [], channelIds: [] },
      });
      expect(normalizeCommandRules("nope")).toEqual({});
    });
  });
});

describe("premade permission setups", () => {
  const isRole = (id) => [MOD_ROLE, HELPER_ROLE].includes(id);

  it("gives one team everything", () => {
    expect(planPreset(Preset.ONE_TEAM, { roles: { moderator: MOD_ROLE }, isRole })).toEqual({
      [Setting.MOD_ROLE]: MOD_ROLE,
      [Setting.STAFF_ROLE]: MOD_ROLE,
      [Setting.DASHBOARD_ROLES]: [MOD_ROLE],
      [Setting.COMMAND_RULES]: null,
      [Setting.PERMISSION_PRESET]: Preset.ONE_TEAM,
    });
  });

  it("gives helpers the everyday commands and keeps hand-made limits", () => {
    const current = { [Setting.COMMAND_RULES]: { ban: { disabled: true }, warn: { roleIds: [MOD_ROLE], channelIds: [CHANNEL_ID] } } };
    const plan = planPreset(Preset.TWO_TEAMS, { roles: { moderator: MOD_ROLE, helper: HELPER_ROLE }, isRole, current });
    expect(plan[Setting.STAFF_ROLE]).toBe(HELPER_ROLE);
    expect(plan[Setting.DASHBOARD_ROLES]).toEqual([MOD_ROLE, HELPER_ROLE]);
    expect(Object.keys(plan[Setting.COMMAND_RULES]).sort()).toEqual([...HELPER_COMMANDS, "ban"].sort());
    expect(plan[Setting.COMMAND_RULES].ban.disabled).toBe(true);
    expect(plan[Setting.COMMAND_RULES].warn).toEqual({ disabled: false, roleIds: [HELPER_ROLE], blockedRoleIds: [], channelIds: [CHANNEL_ID] });
  });

  it("leaves only Discord's permissions for admins-only", () => {
    const current = { [Setting.COMMAND_RULES]: { warn: { roleIds: [HELPER_ROLE] } } };
    expect(planPreset(Preset.ADMINS_ONLY, { isRole, current })).toMatchObject({
      [Setting.MOD_ROLE]: null,
      [Setting.DASHBOARD_ROLES]: null,
      [Setting.COMMAND_RULES]: null,
    });
  });

  it("needs the roles each setup uses", () => {
    expect(() => planPreset("everyone", { isRole })).toThrow(InvalidPreset);
    expect(() => planPreset(Preset.ONE_TEAM, { roles: {}, isRole })).toThrow(InvalidPreset);
    expect(() => planPreset(Preset.TWO_TEAMS, { roles: { moderator: MOD_ROLE, helper: MOD_ROLE }, isRole })).toThrow(InvalidPreset);
    expect(() => planPreset(Preset.ONE_TEAM, { roles: { moderator: "700000000000000009" }, isRole })).toThrow(InvalidPreset);
  });

  it("stops the staff role doubling as the mod role once a setup is chosen", async () => {
    const settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, HELPER_ROLE);
    expect(moderatorRoleId(settings, GUILD_ID)).toBe(HELPER_ROLE);
    await settings.set(GUILD_ID, Setting.PERMISSION_PRESET, Preset.ADMINS_ONLY);
    expect(moderatorRoleId(settings, GUILD_ID)).toBeUndefined();
  });
});

describe("log routes", () => {
  it("names every server-log event as a route", () => {
    expect(Object.values(LogEvent).every((event) => LOG_ROUTES.includes(event))).toBe(true);
  });

  it("keeps the channels set and drops cleared ones", () => {
    const isChannel = (id) => id === CHANNEL_ID;
    expect(checkLogRoutes({ cases: CHANNEL_ID, automod: null, memberJoin: "" }, { isChannel })).toEqual({ cases: CHANNEL_ID });
    expect(checkLogRoutes({ cases: null }, { isChannel })).toBeNull();
    expect(() => checkLogRoutes({ nope: CHANNEL_ID }, { isChannel })).toThrow(InvalidLogRoutes);
    expect(() => checkLogRoutes({ cases: OTHER_CHANNEL }, { isChannel })).toThrow(InvalidLogRoutes);
  });

  it("forgets a deleted channel", () => {
    const saved = { cases: CHANNEL_ID, automod: OTHER_CHANNEL };
    expect(withoutChannel(saved, CHANNEL_ID)).toEqual({ automod: OTHER_CHANNEL });
    expect(withoutChannel(saved, "800000000000000009")).toBeUndefined();
    expect(normalizeLogRoutes({ cases: 5, automod: OTHER_CHANNEL })).toEqual({ automod: OTHER_CHANNEL });
  });
});
