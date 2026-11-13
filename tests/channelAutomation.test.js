import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  BUMP_COOLDOWN_MS,
  checkAutomation,
  countedNumber,
  createChannelAutomation,
  describeAutomation,
  DISBOARD_ID,
  isBumpDone,
  normalizeAutomation,
  SLOWMODE_HOLD_MS,
  threadName,
} from "../src/channels/automation.js";
import { AutomationStore } from "../src/channels/automationStore.js";
import { buildAutomateCommandData, createAutomateCommand, splitEmojis } from "../src/commands/automate.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { buildTestMessages, TestKind, TestUnavailable } from "../src/testing/testMessages.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const TEXT_ID = "800000000000000001";
const NEWS_ID = "800000000000000002";
const OTHER_ID = "800000000000000003";
const ROLE_ID = "700000000000000001";
const USER_ID = "300000000000000001";
const OTHER_USER_ID = "300000000000000002";
const BOT_ID = "200000000000000001";

const server = {
  isChannel: (id, kind) => (kind === "publish" ? id === NEWS_ID : [TEXT_ID, NEWS_ID, OTHER_ID].includes(id)),
  isRole: (id) => id === ROLE_ID,
};

describe("channel automation settings", () => {
  it("cleans a saved value and drops anything broken", () => {
    const config = normalizeAutomation({
      publish: [NEWS_ID, NEWS_ID, "nope"],
      autoDelete: [{ channelId: TEXT_ID, minutes: 0 }, { channelId: OTHER_ID, minutes: 30 }],
      slowmode: [{ channelId: TEXT_ID, messages: 10, seconds: 5 }],
      reactions: [{ channelId: TEXT_ID, emojis: ["👍", "not an emoji", "👎"] }],
      bump: { roleId: ROLE_ID },
    });
    expect(config.publish).toEqual([NEWS_ID]);
    expect(config.autoDelete).toEqual([{ channelId: OTHER_ID, minutes: 30 }]);
    expect(config.reactions).toEqual([{ channelId: TEXT_ID, emojis: ["👍", "👎"] }]);
    expect(config.bump).toEqual({ channelId: null, roleId: ROLE_ID, message: null });
    expect(normalizeAutomation("junk").publish).toEqual([]);
  });

  it("checks dashboard input strictly, and saves nothing when everything is off", () => {
    expect(checkAutomation({ publish: [], threads: [] }, server)).toBeNull();
    expect(() => checkAutomation({ publish: [TEXT_ID] }, server)).toThrow(/announcement/);
    expect(() => checkAutomation({ autoDelete: [{ channelId: TEXT_ID, minutes: 99999 }] }, server)).toThrow(/minutes/);
    expect(() => checkAutomation({ reactions: [{ channelId: TEXT_ID, emojis: ["👍", "hello"] }] }, server)).toThrow(/emoji/);
    expect(() => checkAutomation({ bump: { roleId: "700000000000000999" } }, server)).toThrow(/role/);
    expect(() => checkAutomation({ countingChannelId: TEXT_ID, threads: [TEXT_ID] }, server)).toThrow(/counting/);
    const saved = checkAutomation({ publish: [NEWS_ID], countingChannelId: OTHER_ID, bump: { channelId: TEXT_ID, roleId: ROLE_ID, message: " Bump! " } }, server);
    expect(saved).toMatchObject({ publish: [NEWS_ID], countingChannelId: OTHER_ID, bump: { channelId: TEXT_ID, roleId: ROLE_ID, message: "Bump!" } });
    expect(describeAutomation(saved)).toContain("counting");
  });

  it("names threads after the post's first line, without markup", () => {
    expect(threadName({ content: "**Idea:** add a #lfg channel <@123456789012345678>\nmore", author: { username: "moe" } }, "en")).toBe("Idea: add a lfg channel");
    expect(threadName({ content: "https://example.com", member: { displayName: "Moe" } }, "en")).toBe("Moe's post");
    expect(threadName({ content: "x".repeat(200) }, "en")).toHaveLength(80);
  });

  it("reads counting numbers and DISBOARD bumps", () => {
    expect(countedNumber("12")).toBe(12);
    expect(countedNumber(" 12 nice")).toBe(12);
    expect(countedNumber("1.5")).toBeUndefined();
    expect(countedNumber("twelve")).toBeUndefined();
    expect(isBumpDone({ author: { id: DISBOARD_ID }, embeds: [{ description: "Bump done! :thumbsup:" }] })).toBe(true);
    expect(isBumpDone({ author: { id: USER_ID }, content: "Bump done!" })).toBe(false);
  });

  it("splits typed emoji", () => {
    expect(splitEmojis("👍 👎,<:yes:123456789012345678> 👨‍👩‍👧")).toEqual(["<:yes:123456789012345678>", "👍", "👎", "👨‍👩‍👧"]);
  });
});

describe("channel automation at work", () => {
  function setup(config) {
    let time = 1_700_000_000_000;
    const timers = [];
    const guildSettings = new GuildSettings();
    guildSettings.set(GUILD_ID, Setting.CHANNEL_AUTOMATION, config);
    const store = new AutomationStore();
    const sent = [];
    const me = { id: BOT_ID };
    const channel = (id, type = ChannelType.GuildText) => ({
      id,
      type,
      rateLimitPerUser: 0,
      guild: { members: { me } },
      permissionsFor: () => ({ has: () => true }),
      isTextBased: () => true,
      send: vi.fn(async (payload) => sent.push({ channelId: id, ...payload })),
      setRateLimitPerUser: vi.fn(async function (seconds) {
        this.rateLimitPerUser = seconds;
      }),
      bulkDelete: vi.fn(async () => {}),
      messages: { fetch: vi.fn(async () => new Map()) },
    });
    const channels = new Map([TEXT_ID, OTHER_ID].map((id) => [id, channel(id)]));
    channels.set(NEWS_ID, channel(NEWS_ID, ChannelType.GuildAnnouncement));
    const guild = { id: GUILD_ID, preferredLocale: "en-US", channels: { cache: channels }, members: { me } };
    const client = { user: { id: BOT_ID }, guilds: { cache: new Map([[GUILD_ID, guild]]) } };
    const automation = createChannelAutomation({
      guildSettings,
      store,
      logger: fakeLogger(),
      client,
      now: () => time,
      setTimer: (fn, delay) => {
        const timer = { fn, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
    });
    let next = 1;
    const message = (channelId, content, { author = USER_ID, ...extra } = {}) => ({
      id: `61000000000000000${next++}`,
      guildId: GUILD_ID,
      channelId,
      channel: channels.get(channelId),
      guild,
      client,
      content,
      inGuild: () => true,
      author: { id: author, bot: false, username: "moe" },
      member: { displayName: "Moe" },
      createdTimestamp: time,
      crosspostable: true,
      crosspost: vi.fn(async () => {}),
      startThread: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
      ...extra,
    });
    return { automation, store, channels, message, sent, timers, advance: (ms) => (time += ms), now: () => time };
  }

  it("publishes, starts threads and reacts", async () => {
    const { automation, message } = setup({ publish: [NEWS_ID], threads: [TEXT_ID], reactions: [{ channelId: TEXT_ID, emojis: ["👍", "👎"] }] });
    const news = message(NEWS_ID, "Patch notes");
    await automation.messageCreated(news);
    expect(news.crosspost).toHaveBeenCalled();
    const post = message(TEXT_ID, "My idea");
    await automation.messageCreated(post);
    expect(post.startThread).toHaveBeenCalledWith(expect.objectContaining({ name: "My idea" }));
    expect(post.react.mock.calls.map(([emoji]) => emoji)).toEqual(["👍", "👎"]);
    const own = message(TEXT_ID, "bot says hi", { author: BOT_ID });
    await automation.messageCreated(own);
    expect(own.startThread).not.toHaveBeenCalled();
  });

  it("runs the counting game, one person at a time", async () => {
    const { automation, store, message, sent } = setup({ countingChannelId: TEXT_ID });
    for (const [content, author] of [["1", USER_ID], ["2", OTHER_USER_ID], ["chat", USER_ID], ["3", USER_ID]]) {
      await automation.messageCreated(message(TEXT_ID, content, { author }));
    }
    expect(store.counting(TEXT_ID)).toMatchObject({ count: 3, best: 3, lastUserId: USER_ID });
    const twice = message(TEXT_ID, "4", { author: USER_ID });
    await automation.messageCreated(twice);
    expect(twice.react).toHaveBeenCalledWith("❌");
    expect(sent.at(-1).content).toContain("can't count twice");
    expect(store.counting(TEXT_ID)).toMatchObject({ count: 0, best: 3 });
    const wrong = message(TEXT_ID, "5", { author: OTHER_USER_ID });
    await automation.messageCreated(wrong);
    expect(sent.at(-1).content).toContain("ruined it");
  });

  it("switches slowmode on when busy and back once calm", async () => {
    const { automation, message, channels, timers, advance } = setup({ slowmode: [{ channelId: TEXT_ID, messages: 5, seconds: 15 }] });
    for (let index = 0; index < 5; index += 1) {
      await automation.messageCreated(message(TEXT_ID, `hi ${index}`));
    }
    const channel = channels.get(TEXT_ID);
    expect(channel.setRateLimitPerUser).toHaveBeenCalledWith(15, expect.any(String));
    advance(SLOWMODE_HOLD_MS);
    timers.at(-1).fn();
    expect(channel.setRateLimitPerUser).toHaveBeenLastCalledWith(0, expect.any(String));
  });

  it("keeps threads open in keep-alive channels", async () => {
    const { automation } = setup({ keepAlive: [TEXT_ID] });
    const thread = { id: "810000000000000001", guildId: GUILD_ID, parentId: TEXT_ID, archived: true, locked: false, setArchived: vi.fn(async () => {}) };
    await automation.threadUpdated({ archived: false }, thread);
    expect(thread.setArchived).toHaveBeenCalledWith(false, "Keep alive");
    const locked = { ...thread, locked: true, setArchived: vi.fn() };
    await automation.threadUpdated({ archived: false }, locked);
    expect(locked.setArchived).not.toHaveBeenCalled();
  });

  it("deletes old messages but keeps pinned ones", async () => {
    const { automation, channels, now } = setup({ autoDelete: [{ channelId: TEXT_ID, minutes: 10 }] });
    const old = (id, extra = {}) => [id, { id, pinned: false, system: false, createdTimestamp: now() - 11 * 60_000, ...extra }];
    channels.get(TEXT_ID).messages.fetch.mockResolvedValue(new Map([old("1"), old("2"), old("3", { pinned: true }), ["4", { id: "4", pinned: false, createdTimestamp: now() }]]));
    await automation.sweep();
    expect(channels.get(TEXT_ID).bulkDelete).toHaveBeenCalledWith(["1", "2"], true);
  });

  it("reminds the server to bump two hours after a DISBOARD bump", async () => {
    const { automation, store, message, sent, advance } = setup({ bump: { roleId: ROLE_ID } });
    const bump = message(OTHER_ID, "", { author: DISBOARD_ID, embeds: [{ description: "Bump done! :thumbsup:" }] });
    bump.author.bot = true;
    await automation.messageCreated(bump);
    expect(bump.react).toHaveBeenCalledWith("⏰");
    expect(store.bump(GUILD_ID)).toMatchObject({ channelId: OTHER_ID });
    await automation.sweep();
    expect(sent).toHaveLength(0);
    advance(BUMP_COOLDOWN_MS);
    await automation.sweep();
    expect(sent).toEqual([expect.objectContaining({ channelId: OTHER_ID, content: expect.stringContaining(`<@&${ROLE_ID}>`), allowedMentions: { roles: [ROLE_ID] } })]);
    expect(store.bump(GUILD_ID)).toBeUndefined();
  });

  it("has a bump test message", () => {
    const guildSettings = new GuildSettings();
    const context = { guildSettings, guild: { id: GUILD_ID, name: "Test" }, member: { id: USER_ID }, language: "en", hereChannelId: TEXT_ID };
    expect(() => buildTestMessages(TestKind.BUMP, context)).toThrow(TestUnavailable);
    guildSettings.set(GUILD_ID, Setting.CHANNEL_AUTOMATION, { bump: { roleId: ROLE_ID } });
    const [test] = buildTestMessages(TestKind.BUMP, context);
    expect(test.channelId).toBe(TEXT_ID);
    expect(test.payload.allowedMentions).toEqual({ parse: [] });
  });
});

describe("/automate", () => {
  function interaction(subcommand, options = {}) {
    const channels = new Map([
      [TEXT_ID, { id: TEXT_ID, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }],
      [NEWS_ID, { id: NEWS_ID, type: ChannelType.GuildAnnouncement, permissionsFor: () => ({ has: () => false }) }],
    ]);
    return {
      locale: "en-US",
      inCachedGuild: () => true,
      memberPermissions: { has: () => true },
      guild: { id: GUILD_ID, channels: { cache: channels }, roles: { cache: new Map([[ROLE_ID, { id: ROLE_ID }]]) }, members: { me: { id: BOT_ID } } },
      options: {
        getSubcommand: () => subcommand,
        getChannel: () => (options.channel ? channels.get(options.channel) : null),
        getBoolean: () => options.enabled ?? true,
        getInteger: (name) => options[name] ?? null,
        getString: (name) => options[name] ?? null,
        getRole: () => null,
      },
      reply: vi.fn(async () => {}),
    };
  }

  it("is for Manage Channels", () => {
    expect(buildAutomateCommandData().default_member_permissions).toBe("16");
  });

  it("switches jobs on and off and says what the bot is missing", async () => {
    const guildSettings = new GuildSettings();
    const command = createAutomateCommand({ guildSettings });
    await command.execute(interaction("publish", { channel: NEWS_ID }));
    const publishReply = interaction("publish", { channel: NEWS_ID });
    await command.execute(publishReply);
    expect(publishReply.reply.mock.calls[0][0].content).toContain("still needs");
    await command.execute(interaction("auto-delete", { channel: TEXT_ID, minutes: 60 }));
    expect(guildSettings.get(GUILD_ID, Setting.CHANNEL_AUTOMATION)).toMatchObject({ publish: [NEWS_ID], autoDelete: [{ channelId: TEXT_ID, minutes: 60 }] });
    const refused = interaction("reactions", { channel: TEXT_ID, emojis: "👍 hello" });
    await command.execute(refused);
    expect(refused.reply.mock.calls[0][0].content).toContain("isn't an emoji");
    await command.execute(interaction("publish", { channel: NEWS_ID, enabled: false }));
    await command.execute(interaction("auto-delete", { channel: TEXT_ID, minutes: 0 }));
    expect(guildSettings.get(GUILD_ID, Setting.CHANNEL_AUTOMATION)).toBeUndefined();
    const show = interaction("show");
    await command.execute(show);
    expect(show.reply.mock.calls[0][0].content).toContain("No channel automation");
  });
});
