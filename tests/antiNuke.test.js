import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildAntiNukeCommandData, createAntiNukeCommand } from "../src/commands/antiNuke.js";
import { Status } from "../src/logs/actionLog.js";
import { checkAntiNuke, createAntiNuke, DEFAULT_LIMITS, InvalidAntiNuke, normalizeAntiNuke } from "../src/raid/antiNuke.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "300000000000000000";
const BOT_ID = "300000000000000099";
const ROGUE_ID = "300000000000000010";
const FRIEND_ID = "300000000000000011";
const ROLE_A = "700000000000000001";
const ROLE_B = "700000000000000002";
const HIGH_ROLE = "700000000000000003";

function fakeRogue({ bot = false } = {}) {
  const roles = new Map([
    [GUILD_ID, { id: GUILD_ID }],
    [ROLE_A, { id: ROLE_A, editable: true }],
    [ROLE_B, { id: ROLE_B, editable: true }],
    [HIGH_ROLE, { id: HIGH_ROLE, editable: false }],
  ]);
  return {
    id: ROGUE_ID,
    user: { id: ROGUE_ID, tag: "rogue", bot },
    kickable: true,
    bannable: true,
    roles: { cache: roles, remove: vi.fn(async () => {}) },
  };
}

function setup({ config = {}, member = fakeRogue(), now = () => 1_000_000 } = {}) {
  const guildSettings = new GuildSettings();
  guildSettings.set(GUILD_ID, Setting.ANTI_NUKE, { enabled: true, ...config });
  const owner = { send: vi.fn(async () => {}) };
  const guild = {
    id: GUILD_ID,
    name: "Rumbleverse",
    ownerId: OWNER_ID,
    preferredLocale: "en-US",
    client: { user: { id: BOT_ID, tag: "Bot" } },
    members: { me: { id: BOT_ID, permissions: { has: () => true } }, fetch: vi.fn(async () => member) },
    fetchOwner: vi.fn(async () => owner),
  };
  const moderation = { kick: vi.fn(async () => {}), ban: vi.fn(async () => {}) };
  const modLog = { post: vi.fn(async (_guild, build) => build()) };
  const antiNuke = createAntiNuke({ guildSettings, moderation, modLog, logger: fakeLogger(), now });
  return { guildSettings, guild, owner, moderation, modLog, antiNuke, member };
}

const entry = (action, executorId = ROGUE_ID) => ({ action, executorId });

describe("anti-nuke settings", () => {
  it("fills in defaults and drops bad values", () => {
    expect(normalizeAntiNuke(undefined)).toEqual({ enabled: false, punishment: "strip", limits: DEFAULT_LIMITS, trustedUserIds: [] });
    expect(normalizeAntiNuke({ enabled: true, punishment: "nuke", limits: { ban: 1, kick: 20 }, trustedUserIds: ["x", FRIEND_ID, FRIEND_ID] })).toEqual({
      enabled: true,
      punishment: "strip",
      limits: { ...DEFAULT_LIMITS, kick: 20 },
      trustedUserIds: [FRIEND_ID],
    });
  });

  it("checks dashboard input", () => {
    const good = { enabled: true, punishment: "ban", limits: DEFAULT_LIMITS, trustedUserIds: [FRIEND_ID] };
    expect(checkAntiNuke(good)).toEqual(good);
    for (const bad of [
      null,
      { ...good, enabled: "yes" },
      { ...good, punishment: "jail" },
      { ...good, limits: { ...DEFAULT_LIMITS, ban: 1 } },
      { ...good, limits: { ...DEFAULT_LIMITS, roleDelete: 51 } },
      { ...good, trustedUserIds: ["abc"] },
      { ...good, trustedUserIds: Array.from({ length: 26 }, (_, index) => `3000000000000001${String(index).padStart(2, "0")}`) },
    ]) {
      expect(() => checkAntiNuke(bad)).toThrow(InvalidAntiNuke);
    }
  });
});

describe("anti-nuke", () => {
  it("takes the roles of someone who deletes too many channels, and alerts the mod log and owner", async () => {
    const { guild, antiNuke, member, modLog, owner } = setup();
    expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.ChannelDelete), guild)).toBe(false);
    expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.ChannelDelete), guild)).toBe(false);
    expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.ChannelDelete), guild)).toBe(true);
    expect(member.roles.remove).toHaveBeenCalledWith([ROLE_A, ROLE_B], "Anti-nuke: 3 channels deleted in a minute");
    const { embed } = modLog.post.mock.calls[0][1]();
    expect(JSON.stringify(embed)).toContain(`<@${ROGUE_ID}> made 3 channels deleted`);
    expect(JSON.stringify(embed)).toContain(`<@&${HIGH_ROLE}>`);
    expect(owner.send.mock.calls[0][0].content).toContain("Channels deleted: 3");
    // One attempt, one alert.
    expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.ChannelDelete), guild)).toBe(false);
    expect(modLog.post).toHaveBeenCalledTimes(1);
  });

  it("only counts actions within a minute", async () => {
    let time = 0;
    const { guild, antiNuke } = setup({ now: () => time });
    await antiNuke.auditLogEntry(entry(AuditLogEvent.RoleDelete), guild);
    await antiNuke.auditLogEntry(entry(AuditLogEvent.RoleDelete), guild);
    time = 61_000;
    expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.RoleDelete), guild)).toBe(false);
  });

  it("never counts the owner, the bot, trusted people, or when it's off", async () => {
    const { guild, antiNuke, guildSettings } = setup({ config: { trustedUserIds: [FRIEND_ID] } });
    for (const who of [OWNER_ID, BOT_ID, FRIEND_ID]) {
      for (let index = 0; index < 5; index += 1) {
        expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.ChannelDelete, who), guild)).toBe(false);
      }
    }
    guildSettings.set(GUILD_ID, Setting.ANTI_NUKE, { enabled: false });
    for (let index = 0; index < 5; index += 1) {
      expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.ChannelDelete), guild)).toBe(false);
    }
    expect(await antiNuke.auditLogEntry(entry(AuditLogEvent.MessageDelete), guild)).toBe(false);
  });

  it("kicks bots, and kicks or bans when asked to", async () => {
    const bot = setup({ member: fakeRogue({ bot: true }), config: { limits: { webhookCreate: 2 } } });
    await bot.antiNuke.auditLogEntry(entry(AuditLogEvent.WebhookCreate), bot.guild);
    await bot.antiNuke.auditLogEntry(entry(AuditLogEvent.WebhookCreate), bot.guild);
    expect(bot.moderation.kick).toHaveBeenCalledWith(expect.objectContaining({ member: bot.member }));
    expect(bot.member.roles.remove).not.toHaveBeenCalled();

    const banned = setup({ config: { punishment: "ban", limits: { ban: 2 } } });
    await banned.antiNuke.record(banned.guild, ROGUE_ID, "ban");
    await banned.antiNuke.record(banned.guild, ROGUE_ID, "ban");
    expect(banned.moderation.ban).toHaveBeenCalledWith(expect.objectContaining({ user: banned.member.user, reason: "Anti-nuke: 2 bans in a minute" }));
  });

  it("still alerts when the person already left", async () => {
    const { guild, antiNuke, modLog } = setup({ member: null, config: { limits: { kick: 2 } } });
    await antiNuke.record(guild, ROGUE_ID, "kick");
    await antiNuke.record(guild, ROGUE_ID, "kick");
    expect(JSON.stringify(modLog.post.mock.calls[0][1]().embed)).toContain("no longer in the server");
  });
});

describe("/antinuke", () => {
  function interaction({ userId = OWNER_ID, subcommand, options = {}, admin = true, auditLog = true }) {
    const reply = vi.fn(async () => {});
    return {
      interaction: {
        locale: "en-US",
        guildId: GUILD_ID,
        user: { id: userId },
        guild: { id: GUILD_ID, ownerId: OWNER_ID, members: { me: { permissions: { has: () => auditLog } } } },
        inCachedGuild: () => true,
        member: { permissions: { has: () => admin }, roles: { cache: new Map() } },
        memberPermissions: { has: (bit) => admin && bit === PermissionFlagsBits.Administrator },
        options: {
          getSubcommand: () => subcommand,
          getString: (name) => options[name] ?? null,
          getInteger: (name) => options[name] ?? null,
          getUser: (name) => (options[name] ? { id: options[name] } : null),
        },
        reply,
      },
      reply,
    };
  }

  it("builds the command", () => {
    const data = buildAntiNukeCommandData();
    expect(data.options.map((option) => option.name)).toEqual(["status", "on", "off", "limit", "punishment", "trust", "untrust"]);
  });

  it("lets only the owner change it", async () => {
    const guildSettings = new GuildSettings();
    const command = createAntiNukeCommand({ guildSettings });
    const refused = interaction({ userId: FRIEND_ID, subcommand: "on" });
    expect(await command.execute(refused.interaction)).toMatchObject({ status: Status.REFUSED });
    expect(guildSettings.get(GUILD_ID, Setting.ANTI_NUKE)).toBeUndefined();

    await command.execute(interaction({ subcommand: "on" }).interaction);
    await command.execute(interaction({ subcommand: "limit", options: { action: "ban", count: 4 } }).interaction);
    await command.execute(interaction({ subcommand: "punishment", options: { type: "kick" } }).interaction);
    await command.execute(interaction({ subcommand: "trust", options: { user: FRIEND_ID } }).interaction);
    expect(normalizeAntiNuke(guildSettings.get(GUILD_ID, Setting.ANTI_NUKE))).toMatchObject({
      enabled: true,
      punishment: "kick",
      limits: { ban: 4 },
      trustedUserIds: [FRIEND_ID],
    });

    const status = interaction({ userId: FRIEND_ID, subcommand: "status" });
    await command.execute(status.interaction);
    expect(status.reply.mock.calls[0][0].content).toContain(`<@${FRIEND_ID}>`);

    const untrust = interaction({ subcommand: "untrust", options: { user: FRIEND_ID } });
    await command.execute(untrust.interaction);
    expect(normalizeAntiNuke(guildSettings.get(GUILD_ID, Setting.ANTI_NUKE)).trustedUserIds).toEqual([]);
  });

  it("warns when the bot can't read the audit log", async () => {
    const command = createAntiNukeCommand({ guildSettings: new GuildSettings() });
    const on = interaction({ subcommand: "on", auditLog: false });
    await command.execute(on.interaction);
    expect(on.reply.mock.calls[0][0].content).toContain("View Audit Log");
  });
});
