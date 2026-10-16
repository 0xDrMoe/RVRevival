import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { hierarchyProblem, isModerator, outsiderProblem } from "../src/moderation/checks.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { BOT_ID, GUILD_ID, MOD_ID, OWNER_ID, STAFF_ROLE_ID, TARGET_ID, fakeMember } from "./helpers/moderationFakes.js";

describe("isModerator", () => {
  const interaction = (permissions, roleIds = []) => ({
    guildId: GUILD_ID,
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    member: fakeMember(MOD_ID, { roleIds }),
  });

  it("allows members with the Discord permission", () => {
    expect(isModerator(interaction([PermissionFlagsBits.BanMembers]), PermissionFlagsBits.BanMembers, new GuildSettings())).toBe(true);
    expect(isModerator(interaction([PermissionFlagsBits.KickMembers]), PermissionFlagsBits.BanMembers, new GuildSettings())).toBe(false);
  });

  it("allows the staff role from /settings", async () => {
    const settings = new GuildSettings();
    expect(isModerator(interaction([], [STAFF_ROLE_ID]), PermissionFlagsBits.BanMembers, settings)).toBe(false);
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, STAFF_ROLE_ID);
    expect(isModerator(interaction([], [STAFF_ROLE_ID]), PermissionFlagsBits.BanMembers, settings)).toBe(true);
    expect(isModerator(interaction([], []), PermissionFlagsBits.BanMembers, settings)).toBe(false);
  });

  it("uses the mod role instead of the staff role once one is set", async () => {
    const MOD_ROLE_ID = "700000000000000002";
    const settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, STAFF_ROLE_ID);
    await settings.set(GUILD_ID, Setting.MOD_ROLE, MOD_ROLE_ID);
    expect(isModerator(interaction([], [MOD_ROLE_ID]), PermissionFlagsBits.BanMembers, settings)).toBe(true);
    expect(isModerator(interaction([], [STAFF_ROLE_ID]), PermissionFlagsBits.BanMembers, settings)).toBe(false);
  });
});

describe("hierarchyProblem", () => {
  const moderator = fakeMember(MOD_ID, { position: 10 });
  const bot = fakeMember(BOT_ID, { position: 20 });
  const check = (target, overrides = {}) => hierarchyProblem({ moderator, target, bot, ownerId: OWNER_ID, ...overrides });

  it("allows acting on a lower member", () => {
    expect(check(fakeMember(TARGET_ID, { position: 5 }))).toBeUndefined();
  });

  it("refuses yourself, the bot and the owner", () => {
    expect(check(fakeMember(MOD_ID))).toBe("modSelf");
    expect(check(fakeMember(BOT_ID))).toBe("modBot");
    expect(check(fakeMember(OWNER_ID))).toBe("modOwner");
  });

  it("refuses members at or above the moderator, unless the moderator owns the server", () => {
    expect(check(fakeMember(TARGET_ID, { position: 10 }))).toBe("modTargetHigher");
    expect(check(fakeMember(TARGET_ID, { position: 15 }))).toBe("modTargetHigher");
    const owner = fakeMember(OWNER_ID, { position: 1 });
    expect(check(fakeMember(TARGET_ID, { position: 15 }), { moderator: owner })).toBeUndefined();
  });

  it("refuses members at or above the bot", () => {
    const owner = fakeMember(OWNER_ID, { position: 99 });
    expect(check(fakeMember(TARGET_ID, { position: 20 }), { moderator: owner })).toBe("modBotLower");
    // A warning doesn't need the bot's role, but still can't target the bot.
    expect(check(fakeMember(TARGET_ID, { position: 20 }), { moderator: owner, bot: undefined, botId: BOT_ID })).toBeUndefined();
    expect(check(fakeMember(BOT_ID), { bot: undefined, botId: BOT_ID })).toBe("modBot");
  });

  it("refuses timing out administrators", () => {
    const admin = fakeMember(TARGET_ID, { position: 5, permissions: [PermissionFlagsBits.Administrator] });
    expect(check(admin)).toBeUndefined();
    expect(check(admin, { forTimeout: true })).toBe("modTimeoutAdmin");
  });
});

describe("outsiderProblem", () => {
  it("refuses yourself and the bot", () => {
    const moderator = fakeMember(MOD_ID);
    expect(outsiderProblem({ moderator, userId: MOD_ID, botId: BOT_ID })).toBe("modSelf");
    expect(outsiderProblem({ moderator, userId: BOT_ID, botId: BOT_ID })).toBe("modBot");
    expect(outsiderProblem({ moderator, userId: TARGET_ID, botId: BOT_ID })).toBeUndefined();
  });
});
