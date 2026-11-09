import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, BACKUP_LIMITS, BACKUP_VERSION, buildBackup, checksum, InvalidBackup, LEGACY_FORMAT, LEGACY_VERSION, planRestore, readBackupFile, settingLabel } from "../src/dashboard/backup.js";
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
const SECRET = "a-long-random-dashboard-session-secret";
const server = (overrides = {}) => ({ guildId: GUILD_ID, channels, roles, isOwner: false, current: {}, secret: SECRET, ...overrides });
// A backup edited by hand, with its checksum worked out again (anyone can do
// that: the checksum catches damage, the signature catches forgery).
const resealed = (backup) => ({ ...backup, checksum: checksum(backup) });
const backupOf = (settings, guildId = GUILD_ID) => buildBackup({ guildId, guildName: "Rumbleverse Revival", settings, secret: SECRET, now: Date.UTC(2026, 9, 16) });

describe("settings backup", () => {
  it("holds every saved setting except the running lockdown", () => {
    const backup = backupOf({ [Setting.LOGS_CHANNEL]: TEXT_ID, [Setting.LOCKDOWN]: { channels: [] }, bogus: 1, [Setting.WELCOME_DM]: null });
    expect(backup).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: "2026-10-16T00:00:00.000Z",
      guild: { id: GUILD_ID, name: "Rumbleverse Revival" },
      settings: { [Setting.LOGS_CHANNEL]: TEXT_ID },
      checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      signature: expect.stringMatching(/^[\w-]{43}$/),
    });
  });

  it("refuses files that aren't a backup", () => {
    expect(() => planRestore(null, server())).toThrow(InvalidBackup);
    expect(() => planRestore({ format: "other" }, server())).toThrow(InvalidBackup);
    expect(() => planRestore({ format: BACKUP_FORMAT, version: 99, settings: {} }, server())).toThrow(/different version/);
    expect(() => planRestore({ ...backupOf({}), settings: [] }, server())).toThrow(/no settings/);
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
    const backup = resealed({ ...backupOf({}), settings: { somethingNew: true } });
    expect(planRestore(backup, server()).skipped).toEqual([{ setting: "somethingNew", reason: "unknown" }]);
  });

  it("restores panels only on the server they were made on", () => {
    const tickets = { channelId: TEXT_ID, messageId: "810000000000000001" };
    expect(planRestore(backupOf({ [Setting.TICKETS]: tickets }), server()).apply).toEqual({ [Setting.TICKETS]: tickets });
    expect(planRestore(backupOf({ [Setting.TICKETS]: tickets }, OTHER_ID), server()).skipped).toEqual([{ setting: Setting.TICKETS, reason: "other-server" }]);
  });

  it("restores the posted country guide only on the server it was posted on", () => {
    const post = { channelId: TEXT_ID, messageId: "810000000000000001" };
    expect(planRestore(backupOf({ [Setting.COUNTRY_GUIDE_POST]: post }), server()).apply).toEqual({ [Setting.COUNTRY_GUIDE_POST]: post });
    expect(planRestore(backupOf({ [Setting.COUNTRY_GUIDE_POST]: post }, OTHER_ID), server()).skipped).toEqual([{ setting: Setting.COUNTRY_GUIDE_POST, reason: "other-server" }]);
  });

  it("gives stats counters new channels on another server", () => {
    const counters = [{ id: "a1b2c3d4", template: "Members: {members}", channelId: TEXT_ID, categoryId: null, error: null }];
    expect(planRestore(backupOf({ [Setting.STATS_COUNTERS]: counters }), server()).apply[Setting.STATS_COUNTERS]).toEqual(counters);
    expect(planRestore(backupOf({ [Setting.STATS_COUNTERS]: counters }, OTHER_ID), server()).apply[Setting.STATS_COUNTERS]).toEqual([{ ...counters[0], channelId: null }]);
  });

  it("restores panels and posted messages only from an unchanged, signed backup of this server", () => {
    const tickets = { channelId: TEXT_ID, messageId: "810000000000000001" };
    const counters = [{ id: "a1b2c3d4", template: "Members: {members}", channelId: TEXT_ID, categoryId: null, error: null }];
    const genuine = backupOf({ [Setting.TICKETS]: tickets, [Setting.STATS_COUNTERS]: counters });
    // The file survives being saved and opened again.
    expect(planRestore(JSON.parse(JSON.stringify(genuine, null, 2)), server()).apply).toEqual({ [Setting.TICKETS]: tickets, [Setting.STATS_COUNTERS]: counters });

    const forged = resealed({ ...genuine, settings: { ...genuine.settings, [Setting.TICKETS]: { ...tickets, channelId: GONE_ID } } });
    const { signature, ...unsigned } = genuine;
    expect(signature).toBeTruthy();
    const otherSecret = server({ secret: "another-secret-entirely" });
    for (const [backup, target] of [[forged, server()], [unsigned, server()], [genuine, otherSecret]]) {
      const plan = planRestore(backup, target);
      expect(plan.apply).not.toHaveProperty(Setting.TICKETS);
      expect(plan.skipped).toContainEqual({ setting: Setting.TICKETS, reason: "unsigned" });
      // Counters still come back, with new channels instead of the ones in the file.
      expect(plan.apply[Setting.STATS_COUNTERS]).toEqual([{ ...counters[0], channelId: null }]);
    }
    // Copying a signature onto another server's ID doesn't help either.
    const moved = resealed({ ...backupOf({ [Setting.TICKETS]: tickets }, OTHER_ID), guild: { id: GUILD_ID, name: "x" } });
    expect(planRestore(moved, server()).skipped).toEqual([{ setting: Setting.TICKETS, reason: "unsigned" }]);
  });

  it("still restores settings with a form from a hand-made backup", () => {
    const handMade = resealed({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: "2026-10-16T00:00:00.000Z", guild: { id: GUILD_ID }, settings: { [Setting.LOGS_CHANNEL]: TEXT_ID } });
    expect(planRestore(handMade, server()).apply).toEqual({ [Setting.LOGS_CHANNEL]: TEXT_ID });
  });

  it("still reads version 1 files, signed the old way", () => {
    const legacy = { format: LEGACY_FORMAT, version: LEGACY_VERSION, exportedAt: "2026-10-16T00:00:00.000Z", guild: { id: GUILD_ID, name: "Old" }, settings: { [Setting.LOGS_CHANNEL]: TEXT_ID } };
    expect(planRestore(legacy, server()).apply).toEqual({ [Setting.LOGS_CHANNEL]: TEXT_ID });
    expect(() => planRestore({ ...legacy, checksum: "sha256:" + "0".repeat(64) }, server())).toThrow(/field this bot doesn't use/);
  });


  it("names settings the way the dashboard does", () => {
    expect(settingLabel(Setting.LOGS_CHANNEL)).toBe("Logs channel");
    expect(settingLabel(Setting.TICKETS)).toBe("Ticket panel");
    expect(settingLabel("somethingNew")).toBe("somethingNew");
  });
});

describe("reading an uploaded backup file", () => {
  const fileOf = (backup) => JSON.stringify(backup, null, 2);
  const genuine = () => backupOf({ [Setting.LOGS_CHANNEL]: TEXT_ID, [Setting.TAGS]: [{ name: "rules", content: "Read #rules" }] });
  const refuses = (text, pattern, name = "settings.json") => expect(() => readBackupFile(text, name)).toThrow(pattern);

  it("reads a file the Backup page downloaded, with or without a byte order mark or reordered keys", () => {
    const backup = genuine();
    expect(readBackupFile(fileOf(backup), "settings-1-2026-10-16.json")).toEqual(backup);
    expect(readBackupFile(`\uFEFF${fileOf(backup)}`, "SETTINGS.JSON")).toEqual(backup);
    const reordered = Object.fromEntries(Object.entries(backup).reverse());
    expect(readBackupFile(JSON.stringify(reordered), "a.json").settings).toEqual(backup.settings);
    expect(planRestore(readBackupFile(fileOf(backup), "a.json"), server()).apply).toHaveProperty(Setting.LOGS_CHANNEL, TEXT_ID);
  });

  it("refuses anything that isn't a .json file of the right size", () => {
    const text = fileOf(genuine());
    for (const name of ["settings.exe", "settings.json.exe", "settings", "", undefined, `${"a".repeat(200)}.json`, "a\u0000.json"]) {
      expect(() => readBackupFile(text, name)).toThrow(/\.json file/);
    }
    refuses("", /empty/);
    refuses(undefined, /empty/);
    refuses(" ".repeat(BACKUP_LIMITS.bytes + 1), /too big/);
    // Multibyte text counts in bytes, not characters.
    refuses("é".repeat(BACKUP_LIMITS.bytes / 2 + 1), /too big/);
  });

  it("refuses binary data, broken text and things that aren't one JSON object", () => {
    refuses("MZ\u0090\u0000\u0003", /binary/);
    refuses("PK\u0003\u0004", /binary/);
    refuses(`{"a":"\uD800"}`, /UTF-8/);
    refuses("[1,2,3]", /isn't a settings backup/);
    refuses('"text"', /isn't a settings backup/);
    refuses("<script>alert(1)</script>", /isn't a settings backup/);
    refuses("{ not json", /valid JSON/);
    refuses(`${fileOf(genuine())} trailing`, /valid JSON/);
  });

  it("refuses files that were changed or damaged after download", () => {
    const backup = genuine();
    refuses(fileOf({ ...backup, settings: { ...backup.settings, [Setting.LOGS_CHANNEL]: GONE_ID } }), /changed or damaged/);
    refuses(fileOf({ ...backup, exportedAt: "2026-10-17T00:00:00.000Z" }), /changed or damaged/);
    refuses(fileOf({ ...backup, checksum: "md5:abc" }), /checksum isn't valid/);
    const { checksum: _removed, ...noChecksum } = backup;
    refuses(fileOf(noChecksum), /missing checksum/);
  });

  it("refuses fields and values the format doesn't have", () => {
    const backup = genuine();
    const strict = [
      [{ ...backup, extra: 1 }, /field this bot doesn't use/],
      [{ ...backup, guild: { ...backup.guild, owner: "1" } }, /field this bot doesn't use/],
      [{ ...backup, guild: { id: "../../etc" } }, /server ID/],
      [{ ...backup, guild: { id: GUILD_ID, name: 5 } }, /server name/],
      [{ ...backup, exportedAt: "yesterday" }, /date/],
      [{ ...backup, exportedAt: "2999-01-01T00:00:00.000Z" }, /date/],
      [{ ...backup, signature: "<img src=x>" }, /signature/],
      [{ ...backup, settings: { "bad name!": 1 } }, /setting name/],
      [{ ...backup, settings: Object.fromEntries(Array.from({ length: BACKUP_LIMITS.settings + 1 }, (_, i) => [`s${i}`, 1])) }, /too many settings/],
      [{ ...backup, settings: { tags: "x".repeat(BACKUP_LIMITS.string + 1) } }, /too long/],
      [{ ...backup, settings: { tags: "hi\u0007" } }, /control characters/],
      [{ ...backup, settings: { tags: JSON.parse("[".repeat(BACKUP_LIMITS.depth + 1) + "]".repeat(BACKUP_LIMITS.depth + 1)) } }, /nested too deeply/],
      [{ ...backup, settings: { tags: Array.from({ length: BACKUP_LIMITS.values + 1 }, () => 0) } }, /too much data/],
    ];
    for (const [file, pattern] of strict) {
      refuses(fileOf(resealed(file)), pattern);
    }
  });

  it("refuses keys that could reach an object's prototype", () => {
    const text = fileOf(genuine()).replace('"settings": {', '"settings": { "__proto__": { "polluted": true },');
    refuses(text, /field name that isn't allowed/);
    refuses(text.replace("__proto__", "logsChannelId").replace('"logsChannelId": { "polluted"', '"automod": { "constructor"'), InvalidBackup);
    expect({}.polluted).toBeUndefined();
  });

  it("makes files that always pass its own checks", () => {
    const big = backupOf({ [Setting.WELCOME_MESSAGE]: "Welcome {user}!\n\tRead the rules.", [Setting.TAGS]: [{ name: "faq", content: "ü ✓ 漢字" }] });
    expect(readBackupFile(fileOf(big), "a.json")).toEqual(big);
  });
});
