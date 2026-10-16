import { describe, expect, it } from "vitest";
import { ConfigError, loadBotConfig, loadRegisterConfig } from "../src/config.js";

const TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OQ", "GabcDE", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("."); // fake; split so secret scanners ignore it
const CLIENT_ID = "123456789012345678";
const GUILD_ID = "223456789012345678";

describe("loadBotConfig", () => {
  it("reads the token and trims whitespace", () => {
    expect(loadBotConfig({ DISCORD_TOKEN: ` ${TOKEN} ` })).toEqual({ token: TOKEN, forcedLanguage: undefined });
  });

  it("requires a token and never repeats a malformed one", () => {
    expect(() => loadBotConfig({})).toThrow(ConfigError);
    try {
      loadBotConfig({ DISCORD_TOKEN: "Bot not-a-real-token" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).not.toContain("not-a-real-token");
    }
  });

  it("accepts a supported BOT_LANGUAGE and rejects others", () => {
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, BOT_LANGUAGE: " AR " }).forcedLanguage).toBe("ar");
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, BOT_LANGUAGE: "" }).forcedLanguage).toBeUndefined();
    expect(() => loadBotConfig({ DISCORD_TOKEN: TOKEN, BOT_LANGUAGE: "klingon" })).toThrow(/BOT_LANGUAGE/);
  });
});

describe("loadBotConfig DASHBOARD_URL", () => {
  it("keeps a valid dashboard address for appeal links and ignores a bad one", () => {
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, DASHBOARD_URL: "https://dash.example.com/path" }).dashboardUrl).toBe("https://dash.example.com");
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, DASHBOARD_URL: "http://dash.example.com" }).dashboardUrl).toBeUndefined();
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, DASHBOARD_URL: "nope" }).dashboardUrl).toBeUndefined();
  });
});

describe("loadRegisterConfig", () => {
  const env = { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_GUILD_ID: GUILD_ID };

  it("reads the IDs", () => {
    expect(loadRegisterConfig(env, { needsGuildId: true })).toEqual({ token: TOKEN, clientId: CLIENT_ID, guildId: GUILD_ID });
  });

  it("validates IDs", () => {
    expect(() => loadRegisterConfig({ ...env, DISCORD_GUILD_ID: "abc" }, { needsGuildId: true })).toThrow(/DISCORD_GUILD_ID/);
    expect(() => loadRegisterConfig({ ...env, DISCORD_GUILD_ID: "" }, { needsGuildId: true })).toThrow(/DISCORD_GUILD_ID/);
    expect(() => loadRegisterConfig({ ...env, DISCORD_CLIENT_ID: "my-bot" }, { needsGuildId: false })).toThrow(/DISCORD_CLIENT_ID/);
  });

  it("doesn't need a server ID for global registration", () => {
    expect(loadRegisterConfig({ ...env, DISCORD_GUILD_ID: "" }, { needsGuildId: false }).guildId).toBeUndefined();
  });
});
