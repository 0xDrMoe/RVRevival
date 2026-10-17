import { Collection, GatewayIntentBits, IntentsBitField } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogChannelPoster } from "../src/logs/logChannel.js";
import { RecentIds } from "../src/logs/recentIds.js";
import { buildMemberChangedEmbed, createServerLog, LogEvent } from "../src/logs/serverLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const LOG_ID = "800000000000000007";
const CHANNEL_ID = "800000000000000001";
const USER_ID = "300000000000000001";

const client = { options: { intents: new IntentsBitField([GatewayIntentBits.MessageContent]) } };
const author = { id: USER_ID, tag: "member", bot: false, displayAvatarURL: () => undefined };

function fakeMessage(overrides = {}) {
  return {
    id: "600000000000000001",
    channelId: CHANNEL_ID,
    content: "hello",
    author,
    client,
    partial: false,
    attachments: new Map(),
    url: "https://discord.com/channels/1/2/3",
    createdTimestamp: 1_700_000_000_000,
    ...overrides,
  };
}

const roles = (...ids) => ({ cache: new Collection(ids.map((id) => [id, { id }])) });

describe("server log", () => {
  let logChannel;
  let guild;
  let settings;
  let botDeletions;
  let serverLog;

  beforeEach(async () => {
    logChannel = { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({})) };
    guild = { id: GUILD_ID, members: { me: {} }, channels: { cache: new Map([[LOG_ID, logChannel]]) }, memberCount: 42 };
    settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.SERVER_LOG_CHANNEL, LOG_ID);
    botDeletions = new RecentIds();
    serverLog = createServerLog({
      poster: createLogChannelPoster({ guildSettings: settings, logger: fakeLogger() }),
      botDeletions,
      guildSettings: settings,
    });
  });

  const posted = () => logChannel.send.mock.calls.map((call) => call[0].embeds[0].toJSON());

  it("logs a deleted message with its text", async () => {
    await serverLog.messageDeleted(fakeMessage({ guild }));
    const [embed] = posted();
    expect(embed.description).toContain(`**Message deleted** in <#${CHANNEL_ID}>`);
    expect(embed.description).toContain("hello");
  });

  it("posts an event in its own channel when it has one, even without a server-log channel", async () => {
    const joinChannel = { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({})) };
    guild.channels.cache.set(CHANNEL_ID, joinChannel);
    await settings.clear(GUILD_ID, Setting.SERVER_LOG_CHANNEL);
    await settings.set(GUILD_ID, Setting.LOG_ROUTES, { [LogEvent.MEMBER_JOIN]: CHANNEL_ID });
    const member = { id: USER_ID, guild, user: { ...author, createdTimestamp: 0 } };
    await serverLog.memberJoined(member);
    await serverLog.memberLeft({ ...member, joinedTimestamp: 0 });
    expect(joinChannel.send).toHaveBeenCalledTimes(1);
    expect(logChannel.send).not.toHaveBeenCalled();
  });

  it("skips bots, messages the bot deleted itself, and servers without a channel", async () => {
    await serverLog.messageDeleted(fakeMessage({ guild, author: { ...author, bot: true } }));
    botDeletions.add("600000000000000001");
    await serverLog.messageDeleted(fakeMessage({ guild }));
    await settings.clear(GUILD_ID, Setting.SERVER_LOG_CHANNEL);
    await serverLog.messageDeleted(fakeMessage({ guild, id: "600000000000000002" }));
    expect(logChannel.send).not.toHaveBeenCalled();
  });

  it("logs a deleted message the bot never saw", async () => {
    await serverLog.messageDeleted({ id: "600000000000000003", channelId: CHANNEL_ID, guild, partial: true, author: null });
    expect(posted()[0].description).toContain("sent before the bot last started");
  });

  it("logs edits with before and after, but not link previews loading", async () => {
    await serverLog.messageEdited(fakeMessage({ guild }), fakeMessage({ guild, editedTimestamp: 1 }));
    expect(logChannel.send).not.toHaveBeenCalled();

    await serverLog.messageEdited(fakeMessage({ guild }), fakeMessage({ guild, content: "hello there" }));
    expect(logChannel.send).not.toHaveBeenCalled();

    await serverLog.messageEdited(fakeMessage({ guild }), fakeMessage({ guild, content: "hello there", editedTimestamp: 1 }));
    const [embed] = posted();
    expect(embed.description).toMatch(/\*\*Before\*\*\n```\nhello\n```\n\*\*After\*\*\n```\nhello there\n```/);
  });

  it("logs bulk deletions with a transcript, skipping the bot's own purges", async () => {
    const channel = { id: CHANNEL_ID, guild };
    const messages = new Collection([
      ["1", fakeMessage({ id: "1" })],
      ["2", fakeMessage({ id: "2" })],
    ]);
    botDeletions.add("1", "2");
    await serverLog.messagesBulkDeleted(messages, channel);
    expect(logChannel.send).not.toHaveBeenCalled();

    const others = new Collection([
      ["3", fakeMessage({ id: "3" })],
      ["4", { id: "4", partial: true }],
    ]);
    await serverLog.messagesBulkDeleted(others, channel);
    const payload = logChannel.send.mock.calls[0][0];
    expect(payload.embeds[0].toJSON().description).toContain("2 messages bulk-deleted");
    expect(payload.files).toHaveLength(1);
  });

  it("logs joins, flagging new accounts", async () => {
    await serverLog.memberJoined({ id: USER_ID, guild, user: { ...author, createdTimestamp: Date.now() - 1000 } });
    expect(posted()[0].description).toContain("New account");
    expect(posted()[0].description).toContain("Member #42");
  });

  it("logs leaves with the member's roles", async () => {
    await serverLog.memberLeft({ id: USER_ID, guild, user: author, partial: false, joinedTimestamp: 1_600_000_000_000, roles: roles(GUILD_ID, "1") });
    expect(posted()[0].description).toContain("**Roles:** <@&1>");
  });

  it("logs nickname and role changes only", async () => {
    const before = { id: USER_ID, guild, user: author, partial: false, nickname: null, roles: roles("1", "2") };
    await serverLog.memberUpdated(before, { ...before });
    expect(logChannel.send).not.toHaveBeenCalled();

    await serverLog.memberUpdated(before, { ...before, nickname: "Rumbler", roles: roles("2", "3") });
    const { description } = posted()[0];
    expect(description).toContain("**Nickname:** *none* → `Rumbler`");
    expect(description).toContain("**Roles added:** <@&3>");
    expect(description).toContain("**Roles removed:** <@&1>");
  });

  it("skips events switched off in /settings log-event", async () => {
    await settings.set(GUILD_ID, Setting.DISABLED_LOG_EVENTS, [LogEvent.MESSAGE_DELETE, LogEvent.MEMBER_JOIN]);
    await serverLog.messageDeleted(fakeMessage({ guild }));
    await serverLog.memberJoined({ id: USER_ID, guild, user: { ...author, createdTimestamp: 0 } });
    expect(logChannel.send).not.toHaveBeenCalled();

    await serverLog.messageEdited(fakeMessage({ guild }), fakeMessage({ guild, content: "edited", editedTimestamp: 1 }));
    expect(logChannel.send).toHaveBeenCalledTimes(1);
  });

  it("skips messages in ignored channels, their threads and channels in ignored categories", async () => {
    const CATEGORY_ID = "800000000000000050";
    const THREAD_ID = "800000000000000051";
    const OTHER_ID = "800000000000000052";
    await settings.set(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, [CHANNEL_ID, CATEGORY_ID]);

    await serverLog.messageDeleted(fakeMessage({ guild }));
    await serverLog.messageDeleted(fakeMessage({ guild, channel: { id: THREAD_ID, parentId: CHANNEL_ID } }));
    await serverLog.messageDeleted(fakeMessage({ guild, channel: { id: OTHER_ID, parentId: CATEGORY_ID } }));
    await serverLog.messageDeleted(
      fakeMessage({ guild, channel: { id: THREAD_ID, parentId: OTHER_ID, parent: { id: OTHER_ID, parentId: CATEGORY_ID } } }),
    );
    await serverLog.messagesBulkDeleted(new Collection([["9", fakeMessage({ id: "9" })]]), { id: CHANNEL_ID, guild });
    expect(logChannel.send).not.toHaveBeenCalled();

    await serverLog.messageDeleted(fakeMessage({ guild, channelId: OTHER_ID }));
    expect(logChannel.send).toHaveBeenCalledTimes(1);
  });

  it("can't compare members the bot never saw", () => {
    const member = { id: USER_ID, user: author, nickname: null, roles: roles() };
    expect(buildMemberChangedEmbed(member, member)).toBeUndefined();
  });
});

describe("RecentIds", () => {
  it("forgets ids after a while", () => {
    let now = 0;
    const ids = new RecentIds({ ttlMs: 100, now: () => now });
    ids.add("a");
    now = 50;
    ids.add(["b"]);
    expect(ids.has("a")).toBe(true);
    now = 120;
    expect(ids.has("a")).toBe(false);
    expect(ids.has("b")).toBe(true);
    ids.add("c");
    now = 200;
    expect(ids.has("b")).toBe(false);
    expect(ids.has("c")).toBe(true);
  });
});
