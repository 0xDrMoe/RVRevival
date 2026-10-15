import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelSettings } from "../src/settings/channelSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";

describe("ChannelSettings", () => {
  let folder;
  let file;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "rumbleverse-bot-"));
    file = join(folder, "data", "country-channels.json");
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("starts empty when there is no file yet", async () => {
    const settings = await ChannelSettings.load(file);
    expect(settings.get(GUILD_ID)).toBeUndefined();
  });

  it("saves the chosen channel and reads it back after a restart", async () => {
    await (await ChannelSettings.load(file)).set(GUILD_ID, CHANNEL_ID);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [GUILD_ID]: CHANNEL_ID });
    expect((await ChannelSettings.load(file)).get(GUILD_ID)).toBe(CHANNEL_ID);
  });

  it("forgets the channel when cleared", async () => {
    const settings = await ChannelSettings.load(file);
    await settings.set(GUILD_ID, CHANNEL_ID);
    await settings.clear(GUILD_ID);

    expect(settings.get(GUILD_ID)).toBeUndefined();
    expect((await ChannelSettings.load(file)).get(GUILD_ID)).toBeUndefined();
  });

  it("refuses to start with a corrupted file instead of silently dropping the setting", async () => {
    await (await ChannelSettings.load(file)).set(GUILD_ID, CHANNEL_ID);
    await writeFile(file, "{ not json");
    await expect(ChannelSettings.load(file)).rejects.toThrow();
  });

  it("keeps settings in memory only when there is no file", async () => {
    const settings = new ChannelSettings();
    await settings.set(GUILD_ID, CHANNEL_ID);
    expect(settings.get(GUILD_ID)).toBe(CHANNEL_ID);
  });
});
