import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, BACKUP_VERSION, buildBackup, InvalidBackup, planRestore, settingLabel } from "../src/dashboard/backup.js";
import { Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const OTHER_ID = "900000000000000002";
const TEXT_ID = "800000000000000001";
const GONE_ID = "800000000000000009";
const ROLE_ID = "700000000000000001";

const channels = [{ id: TEXT_ID, name: "general", type: ChannelType.GuildText, position: 1 }];
const roles = [
  { id: GUILD_ID, name: "@everyone", position: 0, managed: false },
  { id: ROLE_ID, name: "Mods", position: 3, managed: false },
];
const server = (overrides = {}) => ({ guildId: GUILD_ID, channels, roles, isOwner: false, current: {}, ...overrides });
const backupOf = (settings, guildId = GUILD_ID) => buildBackup({ guildId, guildName: "Rumbleverse Revival", settings, now: Date.UTC(2026, 9, 16) });

describe("settings backup", () => {
  it("holds every saved setting except the running lockdown", () => {
    const backup = backupOf({ [Setting.LOGS_CHANNEL]: TEXT_ID, [Setting.LOCKDOWN]: { channels: [] }, bogus: 1, [Setting.WELCOME_DM]: null });
    expect(backup).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: "2026-10-16T00:00:00.000Z",
      guild: { id: GUILD_ID, name: "Rumbleverse Revival" },
      settings: { [Setting.LOGS_CHANNEL]: TEXT_ID },
    });
  });

  it("refuses files that aren't a backup", () => {
    expect(() => planRestore(null, server())).toThrow(InvalidBackup);
    expect(() => planRestore({ format: "other" }, server())).toThrow(InvalidBackup);
    expect(() => planRestore({ format: BACKUP_FORMAT, version: 99, settings: {} }, server())).toThrow(/different version/);
    expect(() => planRestore({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: [] }, server())).toThrow(/no settings/);
  });

  it("restores settings that fit and skips the rest with a reason", () => {
    const plan = planRestore(
      backupOf({
        [Setting.LOGS_CHANNEL]: TEXT_ID,
        [Setting.MOD_LOG_CHANNEL]: GONE_ID,
        [Setting.STAFF_ROLE]: ROLE_ID,
        [Setting.ANTI_NUKE]: { enabled: true },
        [Setting.LOCKDOWN]: {},
      }),
      server(),
    );
    expect(plan.apply).toEqual({ [Setting.LOGS_CHANNEL]: TEXT_ID, [Setting.STAFF_ROLE]: ROLE_ID });
    expect(plan.skipped).toEqual([
      expect.objectContaining({ setting: Setting.MOD_LOG_CHANNEL, reason: "invalid", message: expect.any(String) }),
      { setting: Setting.ANTI_NUKE, reason: "owner-only" },
    ]);
  });

  it("restores command permissions only for the owner or whoever added the bot, and never who added it", () => {
    const backup = backupOf({
      [Setting.COMMAND_RULES]: { ban: { disabled: true } },
      [Setting.PERMISSION_PRESET]: "oneTeam",
      [Setting.BOT_INVITER]: "300000000000000001",
    });
    expect(backup.settings).not.toHaveProperty(Setting.BOT_INVITER);
    const refused = planRestore(backup, server());
    expect(refused.apply).toEqual({});
    expect(refused.skipped.map((entry) => entry.reason)).toEqual(["permissions-only", "permissions-only"]);
    const allowed = planRestore(backup, server({ canManagePermissions: true }));
    expect(allowed.apply).toEqual({
      [Setting.COMMAND_RULES]: { ban: { disabled: true, roleIds: [], blockedRoleIds: [], channelIds: [] } },
      [Setting.PERMISSION_PRESET]: "oneTeam",
    });
  });

  it("counts settings that are already the same", () => {
    const plan = planRestore(backupOf({ [Setting.LOGS_CHANNEL]: TEXT_ID }), server({ current: { [Setting.LOGS_CHANNEL]: TEXT_ID } }));
    expect(plan).toEqual({ apply: {}, skipped: [], unchanged: 1 });
  });

  it("compares settings the way they're saved", () => {
    const tags = [
      { name: "rules", content: "Read #rules" },
      { name: "faq", content: "See the FAQ" },
    ];
    expect(planRestore(backupOf({ [Setting.TAGS]: [...tags].reverse() }), server({ current: { [Setting.TAGS]: tags } })).unchanged).toBe(1);
  });

  it("skips unknown settings from a newer bot", () => {
    const backup = { ...backupOf({}), settings: { somethingNew: true } };
    expect(planRestore(backup, server()).skipped).toEqual([{ setting: "somethingNew", reason: "unknown" }]);
  });

  it("restores panels only on the server they were made on", () => {
    const tickets = { channelId: TEXT_ID, messageId: "810000000000000001" };
    expect(planRestore(backupOf({ [Setting.TICKETS]: tickets }), server()).apply).toEqual({ [Setting.TICKETS]: tickets });
    expect(planRestore(backupOf({ [Setting.TICKETS]: tickets }, OTHER_ID), server()).skipped).toEqual([{ setting: Setting.TICKETS, reason: "other-server" }]);
  });

  it("gives stats counters new channels on another server", () => {
    const counters = [{ id: "a1b2c3d4", template: "Members: {members}", channelId: TEXT_ID, categoryId: null, error: null }];
    expect(planRestore(backupOf({ [Setting.STATS_COUNTERS]: counters }), server()).apply[Setting.STATS_COUNTERS]).toEqual(counters);
    expect(planRestore(backupOf({ [Setting.STATS_COUNTERS]: counters }, OTHER_ID), server()).apply[Setting.STATS_COUNTERS]).toEqual([{ ...counters[0], channelId: null }]);
  });

  it("names settings the way the dashboard does", () => {
    expect(settingLabel(Setting.LOGS_CHANNEL)).toBe("Logs channel");
    expect(settingLabel(Setting.TICKETS)).toBe("Ticket panel");
    expect(settingLabel("somethingNew")).toBe("somethingNew");
  });
});
