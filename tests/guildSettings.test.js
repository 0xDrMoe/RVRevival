import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { closeDatabase, openDatabase, SCHEMA_VERSION } from "../src/storage/database.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const ROLE_ID = "700000000000000001";

describe("GuildSettings", () => {
  let folder;
  let dbFile;
  let jsonFile;
  let legacyFile;
  let databases;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "rumbleverse-bot-"));
    dbFile = join(folder, "data", "bot.db");
    jsonFile = join(folder, "data", "settings.json");
    legacyFile = join(folder, "data", "country-channels.json");
    databases = [];
    await mkdir(join(folder, "data"), { recursive: true });
  });

  afterEach(async () => {
    databases.forEach(closeDatabase);
    await rm(folder, { recursive: true, force: true });
  });

  // Opens the database and settings, like a bot restart.
  const load = () => {
    const db = openDatabase(dbFile);
    databases.push(db);
    return GuildSettings.load(db, { jsonFile, legacyFile });
  };

  it("starts empty when nothing is saved", async () => {
    const settings = await load();
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBeUndefined();
    expect(settings.getList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS)).toEqual([]);
  });

  it("saves each setting and reads them back after a restart", async () => {
    const settings = await load();
    await settings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await settings.set(GUILD_ID, Setting.DISABLED_LOG_EVENTS, ["messageEdit"]);

    const reloaded = await load();
    expect(reloaded.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBe(CHANNEL_ID);
    expect(reloaded.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
    expect(reloaded.getList(GUILD_ID, Setting.DISABLED_LOG_EVENTS)).toEqual(["messageEdit"]);
  });

  it("clears one setting without touching the other", async () => {
    const settings = await load();
    await settings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await settings.clear(GUILD_ID, Setting.COUNTRY_CHANNEL);

    const reloaded = await load();
    expect(reloaded.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBeUndefined();
    expect(reloaded.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });

  it("toggles items in a list setting", async () => {
    const settings = await load();
    expect(await settings.toggleInList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, CHANNEL_ID)).toBe(true);
    expect(await settings.toggleInList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, OTHER_CHANNEL_ID)).toBe(true);
    expect(await settings.toggleInList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, CHANNEL_ID)).toBe(false);
    expect((await load()).getList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS)).toEqual([OTHER_CHANNEL_ID]);

    await settings.toggleInList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, OTHER_CHANNEL_ID);
    expect(settings.get(GUILD_ID, Setting.LOG_IGNORED_CHANNELS)).toBeUndefined();
  });

  it("copies settings.json into the database once, keeping a backup", async () => {
    await writeFile(jsonFile, JSON.stringify({ [GUILD_ID]: { staffRoleId: ROLE_ID, logsChannelId: CHANNEL_ID, junk: "x" } }));

    const settings = await load();
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
    expect(settings.get(GUILD_ID, Setting.LOGS_CHANNEL)).toBe(CHANNEL_ID);
    expect(settings.get(GUILD_ID, "junk")).toBeUndefined();
    expect(JSON.parse(await readFile(`${jsonFile}.migrated`, "utf8"))[GUILD_ID].staffRoleId).toBe(ROLE_ID);
    await expect(readFile(jsonFile)).rejects.toThrow();

    expect((await load()).get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });

  it("carries over the channel saved by the oldest versions", async () => {
    await writeFile(legacyFile, JSON.stringify({ [GUILD_ID]: CHANNEL_ID }));
    const settings = await load();
    expect(settings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBe(CHANNEL_ID);
  });

  it("ignores old files once the database has settings", async () => {
    await (await load()).set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await writeFile(jsonFile, JSON.stringify({ [GUILD_ID]: { countryChannelId: CHANNEL_ID } }));

    const settings = await load();
    expect(settings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBeUndefined();
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });

  it("refuses to start with a corrupted settings.json instead of silently dropping settings", async () => {
    await writeFile(jsonFile, "{ not json");
    await expect(load()).rejects.toThrow();
  });

  it("rejects unknown settings", async () => {
    await expect(new GuildSettings().set(GUILD_ID, "somethingElse", "1")).rejects.toThrow();
  });

  it("keeps settings in memory only when there is no database", async () => {
    const settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });
});

describe("openDatabase", () => {
  it("upgrades a phase 1 database (cases only) without losing cases", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rumbleverse-db-"));
    const file = join(folder, "bot.db");
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE guild_counters (guild_id TEXT PRIMARY KEY, last_case INTEGER NOT NULL);
              CREATE TABLE cases (guild_id TEXT NOT NULL, case_number INTEGER NOT NULL, action TEXT NOT NULL,
                user_id TEXT NOT NULL, user_tag TEXT, moderator_id TEXT NOT NULL, moderator_tag TEXT, reason TEXT,
                duration_ms INTEGER, expires_at INTEGER, pending_unban INTEGER NOT NULL DEFAULT 0, dm_sent INTEGER,
                log_channel_id TEXT, log_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER,
                PRIMARY KEY (guild_id, case_number));
              INSERT INTO cases (guild_id, case_number, action, user_id, moderator_id, created_at) VALUES ('1', 1, 'warn', '2', '3', 0);
              PRAGMA user_version = 1;`);
    old.close();

    const db = openDatabase(file);
    expect(db.prepare("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT COUNT(*) AS total FROM cases").get().total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM guild_settings").get().total).toBe(0);
    closeDatabase(db);
    await rm(folder, { recursive: true, force: true });
  });
});
