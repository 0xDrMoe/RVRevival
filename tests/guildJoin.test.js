import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { COUNTRY_COMMANDS, createGuildJoinHandler, pickIntroChannel, RECENT_JOIN_MS } from "../src/guilds/guildJoin.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "100000000000000010";
const NOW = 1_800_000_000_000;
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

function fakeChannel(id, { canSend = true, position = 0, type = ChannelType.GuildText } = {}) {
  return { id, type, rawPosition: position, permissionsFor: () => ({ has: () => canSend }), send: vi.fn(async () => ({})) };
}

function fakeGuild({ systemChannel = null, channels = [], joinedTimestamp = NOW - 1000 } = {}) {
  return {
    id: GUILD_ID,
    preferredLocale: "en-US",
    memberCount: 42,
    joinedTimestamp,
    systemChannel,
    members: { me: { id: "bot" } },
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
  };
}

function handler(guildSettings = new GuildSettings()) {
  return {
    guildSettings,
    join: createGuildJoinHandler({ guildSettings, logger, dashboardUrl: "https://rabble.example.com", now: () => NOW }),
  };
}

describe("pickIntroChannel", () => {
  it("prefers the system channel", () => {
    const system = fakeChannel("1", { position: 5 });
    expect(pickIntroChannel(fakeGuild({ systemChannel: system, channels: [fakeChannel("2"), system] }))).toBe(system);
  });

  it("falls back to the highest text channel the bot can post in", () => {
    const blocked = fakeChannel("1", { canSend: false });
    const voice = fakeChannel("2", { type: ChannelType.GuildVoice });
    const lower = fakeChannel("3", { position: 4 });
    const higher = fakeChannel("4", { position: 1 });
    expect(pickIntroChannel(fakeGuild({ systemChannel: blocked, channels: [blocked, voice, lower, higher] }))).toBe(higher);
  });

  it("returns null when there's nowhere to post", () => {
    expect(pickIntroChannel(fakeGuild({ channels: [fakeChannel("1", { canSend: false })] }))).toBeNull();
  });
});

describe("guildJoined", () => {
  it("switches country commands off in a new server and posts the setup message", async () => {
    const { guildSettings, join } = handler();
    const channel = fakeChannel("1");
    await join.guildJoined(fakeGuild({ systemChannel: channel }));

    const rules = guildSettings.get(GUILD_ID, Setting.COMMAND_RULES);
    expect(Object.keys(rules)).toEqual(COUNTRY_COMMANDS);
    expect(Object.values(rules).every((rule) => rule.disabled)).toBe(true);

    const { embeds, allowedMentions } = channel.send.mock.calls[0][0];
    const text = embeds[0].data.description;
    expect(embeds[0].data.title).toBe("Thanks for adding Rabble!");
    expect(text).toContain(`https://rabble.example.com/#/g/${GUILD_ID}`);
    expect(text).toContain("/country");
    expect(allowedMentions).toEqual({ parse: [] });
  });

  it("keeps the settings of a server that had the bot before", async () => {
    const { guildSettings, join } = handler();
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, "200000000000000001");
    const channel = fakeChannel("1");
    await join.guildJoined(fakeGuild({ systemChannel: channel }));

    expect(guildSettings.get(GUILD_ID, Setting.COMMAND_RULES)).toBeUndefined();
    expect(channel.send.mock.calls[0][0].embeds[0].data.description).not.toContain("/country");
  });

  it("does nothing when a server it joined long ago comes back online", async () => {
    const { guildSettings, join } = handler();
    const channel = fakeChannel("1");
    await join.guildJoined(fakeGuild({ systemChannel: channel, joinedTimestamp: NOW - RECENT_JOIN_MS - 1 }));

    expect(channel.send).not.toHaveBeenCalled();
    expect(guildSettings.all(GUILD_ID)).toEqual({});
  });
});
