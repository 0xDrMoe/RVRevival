import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000001";

describe("GuildSettings", () => {
  let folder;
  let file;
  let legacyFile;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "rumbleverse-bot-"));
    file = join(folder, "data", "settings.json");
    legacyFile = join(folder, "data", "country-channels.json");
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const load = () => GuildSettings.load(file, legacyFile);

  it("starts empty when there is no file yet", async () => {
    const settings = await load();
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBeUndefined();
    expect(settings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBeUndefined();
  });

  it("saves each setting and reads them back after a restart", async () => {
    const settings = await load();
    await settings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      [GUILD_ID]: { countryChannelId: CHANNEL_ID, staffRoleId: ROLE_ID },
    });
    const reloaded = await load();
    expect(reloaded.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBe(CHANNEL_ID);
    expect(reloaded.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });

  it("clears one setting without touching the other", async () => {
    const settings = await load();
    await settings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await settings.clear(GUILD_ID, Setting.COUNTRY_CHANNEL);

    const reloaded = await load();
    expect(reloaded.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBeUndefined();
    expect(reloaded.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);

    await reloaded.clear(GUILD_ID, Setting.STAFF_ROLE);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
  });

  it("carries over the channel saved by older versions", async () => {
    await mkdir(join(folder, "data"), { recursive: true });
    await writeFile(legacyFile, JSON.stringify({ [GUILD_ID]: CHANNEL_ID }));

    const settings = await load();

    expect(settings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBe(CHANNEL_ID);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [GUILD_ID]: { countryChannelId: CHANNEL_ID } });
  });

  it("prefers the new file once it exists", async () => {
    await (await load()).set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await writeFile(legacyFile, JSON.stringify({ [GUILD_ID]: CHANNEL_ID }));

    const settings = await load();
    expect(settings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBeUndefined();
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });

  it("refuses to start with a corrupted file instead of silently dropping settings", async () => {
    await (await load()).set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await writeFile(file, "{ not json");
    await expect(load()).rejects.toThrow();
  });

  it("rejects unknown settings", async () => {
    await expect(new GuildSettings().set(GUILD_ID, "somethingElse", "1")).rejects.toThrow();
  });

  it("keeps settings in memory only when there is no file", async () => {
    const settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    expect(settings.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
  });
});
