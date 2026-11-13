import { LOG_EVENTS } from "../src/logs/logEvents.js";
import { describe, expect, it, vi } from "vitest";
import { buildTestCommandData, createTestCommand } from "../src/commands/test.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import {
  buildTestMessages,
  checkAutomodText,
  createTestLimiter,
  memberLike,
  planLogTest,
  routeName,
  TEST_COOLDOWN_MS,
  TESTS_PER_MINUTE,
  TestKind,
  TestUnavailable,
  withTestLabel,
} from "../src/testing/testMessages.js";
import { resetDms } from "../src/utils/dms.js";

const GUILD_ID = "900000000000000001";
const USER_ID = "300000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_ID = "800000000000000002";
const LABEL = `-# 🧪 Test sent by <@${USER_ID}>. The real message won't have this line.`;

const guild = { id: GUILD_ID, name: "Rabble *HQ*", memberCount: 1234, preferredLocale: "en-US" };
const member = memberLike({ id: USER_ID, username: "moe", globalName: "Moe", avatarUrl: "https://cdn.example/avatar.png" });

function build(kind, guildSettings, extra = {}) {
  return buildTestMessages(kind, { guildSettings, guild, member, language: "en", now: () => 1_700_000_000_000, ...extra });
}

const reasonOf = (work) => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(TestUnavailable);
    return error.reason;
  }
  throw new Error("expected TestUnavailable");
};

describe("test messages", () => {
  it("labels the message and keeps it within 2,000 characters", () => {
    expect(withTestLabel({ content: "Hi" }, "-# test")).toEqual({ content: "-# test\nHi", allowedMentions: { parse: [] } });
    expect(withTestLabel({ embeds: [{ title: "x" }] }, "-# test")).toMatchObject({ content: "-# test", embeds: [{ title: "x" }] });
    const long = withTestLabel({ content: "a".repeat(2000) }, "-# test");
    expect(long.content.length).toBe(2000);
    expect(long.content.endsWith("…")).toBe(true);
  });

  it("posts the welcome and leave messages in their channels and the DM to the tester", async () => {
    const settings = new GuildSettings();
    expect(reasonOf(() => build(TestKind.WELCOME, settings))).toBe("noChannel");
    expect(reasonOf(() => build(TestKind.WELCOME_DM, settings))).toBe("noDm");

    await settings.set(GUILD_ID, Setting.WELCOME_CHANNEL, CHANNEL_ID);
    await settings.set(GUILD_ID, Setting.WELCOME_EMBED, { title: "Hi {username}", memberAvatar: true });
    const [welcome] = build(TestKind.WELCOME, settings);
    expect(welcome.channelId).toBe(CHANNEL_ID);
    // With an embed, only the server's own text goes with it: here, just the label.
    expect(welcome.payload.content).toBe(LABEL);
    expect(welcome.payload.embeds[0]).toMatchObject({ title: "Hi Moe", thumbnail: { url: "https://cdn.example/avatar.png" } });
    expect(welcome.payload.allowedMentions).toEqual({ parse: [] });

    await settings.set(GUILD_ID, Setting.LEAVE_CHANNEL, OTHER_ID);
    const [leave] = build(TestKind.LEAVE, settings);
    expect(leave).toMatchObject({ channelId: OTHER_ID });
    expect(leave.payload.content.startsWith(`${LABEL}\n`)).toBe(true);

    await settings.set(GUILD_ID, Setting.WELCOME_DM, "Welcome to {server}, {username}!");
    expect(build(TestKind.WELCOME_DM, settings)).toEqual([
      { dm: true, payload: { content: `${LABEL}\nWelcome to Rabble \\*HQ\\*, Moe!`, allowedMentions: { parse: [] } } },
    ]);
  });

  it("announces a test level-up where level-ups are announced", async () => {
    const settings = new GuildSettings();
    expect(reasonOf(() => build(TestKind.LEVEL_UP, settings))).toBe("levelingOff");
    const base = { enabled: true, message: "{user} hit {level}!" };
    await settings.set(GUILD_ID, Setting.LEVELING, { ...base, announce: "off" });
    expect(reasonOf(() => build(TestKind.LEVEL_UP, settings))).toBe("levelUpOff");
    await settings.set(GUILD_ID, Setting.LEVELING, { ...base, announce: "here" });
    expect(reasonOf(() => build(TestKind.LEVEL_UP, settings))).toBe("levelUpHere");
    expect(build(TestKind.LEVEL_UP, settings, { hereChannelId: OTHER_ID })[0]).toMatchObject({ channelId: OTHER_ID, payload: { content: `${LABEL}\n<@${USER_ID}> hit 5!` } });
    await settings.set(GUILD_ID, Setting.LEVELING, { ...base, announce: "channel", announceChannelId: CHANNEL_ID });
    expect(build(TestKind.LEVEL_UP, settings, { hereChannelId: OTHER_ID })[0]).toMatchObject({ channelId: CHANNEL_ID });
    await settings.set(GUILD_ID, Setting.LEVELING, { ...base, announce: "dm" });
    expect(build(TestKind.LEVEL_UP, settings)[0]).toMatchObject({ dm: true });
  });

  it("builds birthday, starboard, feed and scheduled tests", async () => {
    const settings = new GuildSettings();
    expect(reasonOf(() => build(TestKind.BIRTHDAY, settings))).toBe("noChannel");
    await settings.set(GUILD_ID, Setting.BIRTHDAYS, { channelId: CHANNEL_ID, message: "Happy birthday {user}!" });
    expect(build(TestKind.BIRTHDAY, settings)[0]).toMatchObject({ channelId: CHANNEL_ID, payload: { content: `${LABEL}\nHappy birthday <@${USER_ID}>!` } });

    expect(reasonOf(() => build(TestKind.STARBOARD, settings))).toBe("noChannel");
    await settings.set(GUILD_ID, Setting.STARBOARD, { channelId: OTHER_ID, threshold: 4, emoji: "🔥" });
    const [star] = build(TestKind.STARBOARD, settings);
    expect(star.channelId).toBe(OTHER_ID);
    expect(star.payload.content).toBe(`${LABEL}\n🔥 **4** · <#${OTHER_ID}>`);
    expect(star.payload.embeds[0]).toMatchObject({ author: { name: "Moe" } });
    expect(star.payload.components[0].components[0]).toMatchObject({ url: `https://discord.com/channels/${GUILD_ID}/${OTHER_ID}` });

    expect(reasonOf(() => build(TestKind.FEED, settings, { feed: null }))).toBe("notFound");
    const feed = { guildId: GUILD_ID, kind: "rss", name: "News", url: "https://example.com/feed.xml", channelId: CHANNEL_ID, roleId: "700000000000000001", message: "{feed}: {title} {link}" };
    expect(build(TestKind.FEED, settings, { feed })[0]).toMatchObject({
      channelId: CHANNEL_ID,
      payload: { content: `${LABEL}\n<@&700000000000000001> News: Sample post to show how this feed looks https://example.com/feed.xml`, allowedMentions: { parse: [] } },
    });

    expect(build(TestKind.SCHEDULED, settings, { scheduled: { channelId: OTHER_ID, content: "@everyone news" } })[0]).toEqual({
      channelId: OTHER_ID,
      payload: { content: `${LABEL}\n@everyone news`, allowedMentions: { parse: [] } },
    });
  });

  it("plans the log test the way the loggers route entries", async () => {
    const settings = new GuildSettings();
    expect(reasonOf(() => build(TestKind.LOGS, settings))).toBe("noLogs");
    await settings.set(GUILD_ID, Setting.LOGS_CHANNEL, CHANNEL_ID);
    await settings.set(GUILD_ID, Setting.LOG_ROUTES, { modActions: OTHER_ID });
    await settings.set(GUILD_ID, Setting.DISABLED_TICKET_LOG_EVENTS, ["rated"]);
    const plan = planLogTest(settings, GUILD_ID);
    const routesIn = (id) => plan.channels.find((entry) => entry.channelId === id).routes;
    // Cases fall back from the mod-log channel to the logs channel.
    expect(routesIn(CHANNEL_ID)).toEqual(expect.arrayContaining(["commands", "dashboard", "caseBan", "automod", "raidAlert"]));
    // Without a ticket log channel, ticket events follow "Other moderation actions".
    expect(routesIn(OTHER_ID)).toEqual(expect.arrayContaining(["purge", "ticketOpened"]));
    expect(plan.off).toEqual(["ticketRated"]);
    expect(plan.nowhere).toEqual(LOG_EVENTS);

    const messages = build(TestKind.LOGS, settings);
    expect(messages.map((message) => message.channelId).sort()).toEqual([CHANNEL_ID, OTHER_ID].sort());
    expect(messages[0].payload.embeds[0].title).toBe("🧪 Test log entry");
    expect(routeName("ticketOpened")).toBe("Tickets: Opened");
    expect(routeName("messageEdit")).toBe("Edited messages");
    expect(routeName("caseBan")).toBe("Bans and temporary bans");
  });

  it("allows one test per person every few seconds and a few per server", () => {
    let time = 0;
    const limiter = createTestLimiter({ now: () => time });
    expect(limiter.take(GUILD_ID, "1")).toBe(0);
    expect(limiter.take(GUILD_ID, "1")).toBe(TEST_COOLDOWN_MS);
    for (let index = 2; index <= TESTS_PER_MINUTE; index += 1) {
      expect(limiter.take(GUILD_ID, String(index))).toBe(0);
    }
    expect(limiter.take(GUILD_ID, "someone else")).toBeGreaterThan(0);
    expect(limiter.take("other server", "1")).toBe(0);
    time = 60_000;
    expect(limiter.take(GUILD_ID, "1")).toBe(0);
  });

  it("checks a message against automod without acting on it", () => {
    const config = {
      enabled: true,
      rules: {
        bannedWords: { enabled: true, words: ["darn"], action: "delete" },
        invites: { enabled: false },
        caps: { enabled: true, action: "warn", percent: 50 },
        spam: { enabled: true },
      },
    };
    const check = checkAutomodText(config, "DARN THIS IS LOUD discord.gg/abc");
    expect(check).toMatchObject({ enabled: true, acted: "bannedWords", untested: ["spam"] });
    expect(check.hits.map((hit) => [hit.rule, hit.on])).toEqual([
      ["bannedWords", true],
      ["invites", false],
      ["caps", true],
    ]);
    expect(check.hits[1]).toMatchObject({ detail: "abc", maybeOwnServer: true, ruleOn: false });
    expect(checkAutomodText(null, "hello")).toEqual({ enabled: false, hits: [], acted: null, untested: [] });
  });
});

// A /test interaction in a server where the tester has Manage Server.
function fakeInteraction({ subcommand, text = null, channels = new Map(), canManage = true }) {
  const interaction = {
    locale: "en-US",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: USER_ID, send: vi.fn(async () => ({})) },
    member: memberLike({ id: USER_ID, username: "moe" }),
    guild: { ...guild, channels: { cache: channels }, members: { me: null } },
    memberPermissions: { has: () => canManage },
    options: { getSubcommand: () => subcommand, getString: () => text },
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
  };
  return interaction;
}

const lastText = (interaction) => (interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1))[0].content;

describe("/test", () => {
  it("has a subcommand per test, for Manage Server only", () => {
    const data = buildTestCommandData();
    expect(data.default_member_permissions).toBe("32");
    expect(data.options.map((option) => option.name)).toEqual(["welcome", "leave", "welcome-dm", "level-up", "birthday", "starboard", "logs", "automod"]);
  });

  it("posts the test where the real message goes and waits between tests", async () => {
    resetDms();
    const settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.WELCOME_CHANNEL, OTHER_ID);
    const channel = { id: OTHER_ID, isTextBased: () => true, send: vi.fn(async () => ({})) };
    const command = createTestCommand({ guildSettings: settings });

    const refused = fakeInteraction({ subcommand: "welcome", canManage: false });
    await command.execute(refused);
    expect(lastText(refused)).toContain("Manage Server");

    const first = fakeInteraction({ subcommand: "welcome", channels: new Map([[OTHER_ID, channel]]) });
    await command.execute(first);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(channel.send.mock.calls[0][0].content.startsWith(LABEL)).toBe(true);
    expect(lastText(first)).toBe(`🧪 Test sent to <#${OTHER_ID}>.`);

    const second = fakeInteraction({ subcommand: "leave" });
    await command.execute(second);
    // No leave channel: explained, and it doesn't count toward the wait.
    expect(lastText(second)).toBe("Nothing to test yet: pick a channel for it first.");

    const third = fakeInteraction({ subcommand: "welcome", channels: new Map([[OTHER_ID, channel]]) });
    await command.execute(third);
    expect(lastText(third)).toMatch(/^Wait \ds before the next test\.$/);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("checks automod text privately", async () => {
    const settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.AUTOMOD, { enabled: true, rules: { links: { enabled: true, action: "timeout" } } });
    const interaction = fakeInteraction({ subcommand: "automod", text: "see https://evil.example/x" });
    await createTestCommand({ guildSettings: settings }).execute(interaction);
    expect(lastText(interaction)).toBe("- **Links** (evil.example): automod would delete it and time them out.");
  });
});
