import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildStatsCommandData, createStatsCommand } from "../src/commands/stats.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { checkTemplate, counterName, guildCounts, InvalidCounter, MAX_COUNTERS, normalizeCounters } from "../src/stats/statsCounters.js";
import { createStatsUpdater, RENAME_EVERY_MS } from "../src/stats/statsUpdater.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CATEGORY_ID = "800000000000000009";
const MINUTE = 60 * 1000;

describe("counter settings", () => {
  it("checks names", () => {
    expect(checkTemplate("  👥  Members: {members} ")).toBe("👥 Members: {members}");
    expect(() => checkTemplate("Members")).toThrow(InvalidCounter);
    expect(() => checkTemplate("x".repeat(55) + "{bots}")).toThrow(InvalidCounter);
    expect(() => checkTemplate(42)).toThrow(InvalidCounter);
  });

  it("drops malformed counters and keeps at most five", () => {
    const good = (id) => ({ id, template: "{members}", channelId: "800000000000000001" });
    const list = normalizeCounters([good("aaaaaaaa"), { id: "nope", template: "{members}" }, { id: "bbbbbbbb", template: "no number" }, good("cccccccc"), good("dddddddd"), good("eeeeeeee"), good("ffffffff"), good("abababab")]);
    expect(list.map((counter) => counter.id)).toEqual(["aaaaaaaa", "cccccccc", "dddddddd", "eeeeeeee", "ffffffff"]);
    expect(list).toHaveLength(MAX_COUNTERS);
    expect(normalizeCounters([{ id: "aaaaaaaa", template: "{bots}", channelId: "bad", categoryId: CATEGORY_ID }])[0]).toEqual({ id: "aaaaaaaa", template: "{bots}", channelId: null, categoryId: CATEGORY_ID, error: null });
    expect(normalizeCounters("junk")).toEqual([]);
  });

  it("counts and fills in names", () => {
    const guild = fakeGuild({ memberCount: 1234 });
    const counts = guildCounts(guild);
    expect(counts).toEqual({ members: 1234, humans: 1233, bots: 1, boosts: 7, tier: 2, channels: 1, roles: 2 });
    expect(counterName("👥 {members} · 🤖 {bots} · {tier}", counts)).toBe("👥 1,234 · 🤖 1 · 2");
  });
});

function fakeGuild({ memberCount = 10, canManage = true } = {}) {
  const channels = new Map();
  const memberCache = new Map([
    ["1", { user: { bot: false } }],
    ["2", { user: { bot: true } }],
  ]);
  const guild = {
    id: GUILD_ID,
    memberCount,
    premiumSubscriptionCount: 7,
    premiumTier: 2,
    roles: { cache: new Map([[GUILD_ID, {}], ["r1", {}], ["r2", {}]]) },
    members: {
      cache: memberCache,
      fetch: vi.fn(async () => memberCache),
      me: { id: "bot", permissions: { has: (permission) => permission !== PermissionFlagsBits.ManageChannels || canManage } },
    },
    channels: {
      cache: channels,
      create: vi.fn(async (options) => {
        if (!canManage) {
          throw new Error("Missing Permissions");
        }
        const id = `800000000000000${100 + channels.size}`;
        const channel = {
          id,
          guildId: GUILD_ID,
          name: options.name,
          type: ChannelType.GuildVoice,
          setName: vi.fn(async (name) => {
            channel.name = name;
          }),
          delete: vi.fn(async () => channels.delete(id)),
        };
        channels.set(id, channel);
        return channel;
      }),
    },
  };
  channels.set(CATEGORY_ID, { id: CATEGORY_ID, type: ChannelType.GuildCategory, isThread: () => false });
  return guild;
}

const counter = (overrides = {}) => ({ id: "aaaaaaaa", template: "👥 Members: {members}", channelId: null, categoryId: null, error: null, ...overrides });

describe("stats updater", () => {
  it("creates channels, renames them at most every few minutes and forgets deleted ones", async () => {
    let time = 1_000_000;
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.STATS_COUNTERS, [counter({ categoryId: CATEGORY_ID })]);
    const guild = fakeGuild({ memberCount: 100 });
    const updater = createStatsUpdater({ guildSettings, logger: fakeLogger(), now: () => time });

    await updater.refresh(guild);
    const [options] = guild.channels.create.mock.calls[0];
    expect(options).toMatchObject({ name: "👥 Members: 100", type: ChannelType.GuildVoice, parent: CATEGORY_ID });
    expect(options.permissionOverwrites[0]).toEqual({ id: GUILD_ID, deny: [PermissionFlagsBits.Connect] });
    const saved = guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS)[0];
    expect(saved.channelId).toMatch(/^\d+$/);
    const channel = guild.channels.cache.get(saved.channelId);

    guild.memberCount = 101;
    time += MINUTE;
    await updater.refresh(guild);
    expect(channel.setName).not.toHaveBeenCalled();

    time += RENAME_EVERY_MS;
    await updater.refresh(guild);
    expect(channel.setName).toHaveBeenCalledWith("👥 Members: 101", expect.any(String));
    time += RENAME_EVERY_MS;
    await updater.refresh(guild);
    expect(channel.setName).toHaveBeenCalledTimes(1);

    await updater.channelDeleted(channel);
    expect(guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS)).toEqual([]);
  });

  it("drops counters whose channel vanished and records errors", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.STATS_COUNTERS, [counter({ channelId: "800000000000000555" }), counter({ id: "bbbbbbbb" })]);
    const updater = createStatsUpdater({ guildSettings, logger: fakeLogger() });
    await updater.refresh(fakeGuild({ canManage: false }));
    expect(guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS)).toEqual([counter({ id: "bbbbbbbb", error: "Couldn't create the channel: Missing Permissions" })]);
  });

  it("fetches members to count bots, but not too often", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.STATS_COUNTERS, [counter({ template: "{humans}" })]);
    const guild = fakeGuild({ memberCount: 50 });
    const updater = createStatsUpdater({ guildSettings, logger: fakeLogger() });
    await updater.refresh(guild);
    await updater.refresh(guild);
    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
  });
});

function interaction(guild, subcommand, options = {}) {
  const state = {};
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    guild,
    memberPermissions: { has: () => true },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
    },
    get deferred() {
      return Boolean(state.deferred);
    },
    replied: false,
    deferReply: vi.fn(async () => {
      state.deferred = true;
    }),
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  };
}

describe("/stats", () => {
  it("builds the command", () => {
    expect(buildStatsCommandData().options.map((option) => option.name)).toEqual(["add", "remove", "list"]);
  });

  it("adds, lists and removes counters", async () => {
    const guildSettings = new GuildSettings();
    const updater = createStatsUpdater({ guildSettings, logger: fakeLogger() });
    const command = createStatsCommand({ guildSettings, updater });
    const guild = fakeGuild({ memberCount: 42 });

    expect(await command.execute(interaction(guild, "add", { counter: "members" }))).toMatchObject({ key: "statsAdded" });
    expect(await command.execute(interaction(guild, "add", { counter: "bots", name: "Robots" }))).toMatchObject({ key: "statsBadName" });
    expect(await command.execute(interaction(guild, "add", { counter: "bots", name: "🤖 {bots} bots" }))).toMatchObject({ key: "statsAdded" });
    const counters = guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS);
    expect(counters.map((each) => guild.channels.cache.get(each.channelId).name)).toEqual(["👥 Members: 42", "🤖 1 bots"]);

    const list = interaction(guild, "list");
    expect(await command.execute(list)).toMatchObject({ key: "statsList" });
    expect(list.reply.mock.calls[0][0].content).toContain(`<#${counters[0].channelId}>`);

    const channel = guild.channels.cache.get(counters[0].channelId);
    expect(await command.execute(interaction(guild, "remove", { channel }))).toMatchObject({ key: "statsRemoved" });
    expect(channel.delete).toHaveBeenCalled();
    expect(await command.execute(interaction(guild, "remove", { channel }))).toMatchObject({ key: "statsNotACounter" });
  });

  it("refuses without Manage Channels, and when full", async () => {
    const guildSettings = new GuildSettings();
    const updater = createStatsUpdater({ guildSettings, logger: fakeLogger() });
    const command = createStatsCommand({ guildSettings, updater });
    expect(await command.execute(interaction(fakeGuild({ canManage: false }), "add", { counter: "members" }))).toMatchObject({ key: "statsNeedsManageChannels" });

    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"];
    await guildSettings.set(GUILD_ID, Setting.STATS_COUNTERS, ids.map((id) => counter({ id, channelId: "800000000000000001" })));
    expect(await command.execute(interaction(fakeGuild(), "add", { counter: "members" }))).toMatchObject({ key: "statsFull" });
  });

  it("doesn't keep a counter whose channel couldn't be made", async () => {
    const guildSettings = new GuildSettings();
    const updater = createStatsUpdater({ guildSettings, logger: fakeLogger() });
    const command = createStatsCommand({ guildSettings, updater });
    const guild = fakeGuild();
    guild.channels.create.mockRejectedValueOnce(new Error("Missing Access"));
    expect(await command.execute(interaction(guild, "add", { counter: "members" }))).toMatchObject({ key: "statsCreateFailed" });
    expect(guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS)).toEqual([]);
  });
});
