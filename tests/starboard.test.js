import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildStarboardCommandData, createStarboardCommand } from "../src/commands/starboard.js";
import { canFeature, createStarboard, emojiMatches, normalizeStarboard } from "../src/community/starboard.js";
import { StarboardStore } from "../src/community/starboardStore.js";
import { RecentIds } from "../src/logs/recentIds.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const GENERAL_ID = "800000000000000001";
const BOARD_ID = "800000000000000002";
const STAFF_ID = "800000000000000003";
const AUTHOR_ID = "300000000000000001";
const fan = (n) => `30000000000000010${n}`;

function fakeChannel(id, { everyoneCanSee = true, nsfw = false } = {}) {
  const posted = new Map();
  let next = 1;
  return {
    id,
    nsfw,
    posted,
    isTextBased: () => true,
    permissionsFor: (target) => ({ has: () => (target === "everyone" ? everyoneCanSee : true) }),
    send: vi.fn(async (payload) => {
      const message = { id: `61000000000000000${next++}`, payload, edit: vi.fn(async (update) => (message.payload = update)) };
      posted.set(message.id, message);
      return message;
    }),
    messages: {
      fetch: vi.fn(async (messageId) => {
        const message = posted.get(messageId);
        if (!message) {
          throw new Error("Unknown Message");
        }
        return message;
      }),
      delete: vi.fn(async (messageId) => posted.delete(messageId)),
    },
  };
}

function setup({ threshold = 2, emoji = "⭐" } = {}) {
  const guildSettings = new GuildSettings();
  guildSettings.set(GUILD_ID, Setting.STARBOARD, { channelId: BOARD_ID, threshold, emoji });
  const store = new StarboardStore();
  const botDeletions = new RecentIds();
  const general = fakeChannel(GENERAL_ID);
  const board = fakeChannel(BOARD_ID);
  const staff = fakeChannel(STAFF_ID, { everyoneCanSee: false });
  const guild = {
    id: GUILD_ID,
    preferredLocale: "en-US",
    roles: { everyone: "everyone" },
    channels: { cache: new Map([general, board, staff].map((channel) => [channel.id, channel])) },
  };
  const starboard = createStarboard({ guildSettings, store, logger: { debug: vi.fn() }, botDeletions });

  const message = (channel = general, id = "500000000000000001") => {
    const reactions = new Map();
    return {
      id,
      guild,
      guildId: GUILD_ID,
      channel,
      channelId: channel.id,
      partial: false,
      content: "What a play @everyone",
      url: `https://discord.com/channels/${GUILD_ID}/${channel.id}/${id}`,
      createdTimestamp: 1_700_000_000_000,
      author: { id: AUTHOR_ID, username: "player", displayAvatarURL: () => "https://cdn.example/a.png" },
      member: { displayName: "Player" },
      attachments: new Map([["1", { name: "clip.png", url: "https://cdn.example/clip.png", contentType: "image/png" }]]),
      reactions: { cache: { find: (test) => [...reactions.values()].find(test) } },
      reactionsMap: reactions,
    };
  };
  // Sets who reacted with `name` and tells the starboard.
  const react = async (msg, userIds, name = "⭐") => {
    const users = new Map(userIds.map((id) => [id, { id, bot: id.startsWith("bot") }]));
    const reaction = {
      emoji: { id: null, name },
      count: users.size,
      partial: false,
      message: msg,
      users: { fetch: vi.fn(async () => users) },
    };
    if (users.size > 0) {
      msg.reactionsMap.set(name, reaction);
    } else {
      msg.reactionsMap.delete(name);
    }
    await starboard.reactionChanged(reaction);
    return reaction;
  };
  return { guildSettings, store, starboard, board, general, staff, guild, message, react, botDeletions };
}

describe("starboard helpers", () => {
  it("fills in defaults and turns off without a channel", () => {
    expect(normalizeStarboard({ channelId: BOARD_ID })).toEqual({ channelId: BOARD_ID, threshold: 3, emoji: "⭐" });
    expect(normalizeStarboard({ channelId: BOARD_ID, threshold: 999, emoji: "nope" })).toEqual({ channelId: BOARD_ID, threshold: 50, emoji: "⭐" });
    expect(normalizeStarboard(null)).toBeUndefined();
  });

  it("matches unicode and custom emoji", () => {
    expect(emojiMatches("⭐", { id: null, name: "⭐" })).toBe(true);
    expect(emojiMatches("❤️", { id: null, name: "❤" })).toBe(true);
    expect(emojiMatches("⭐", { id: "1", name: "⭐" })).toBe(false);
    expect(emojiMatches("<:rv:123456789012345678>", { id: "123456789012345678", name: "rv" })).toBe(true);
    expect(emojiMatches("<:rv:123456789012345678>", { id: null, name: "rv" })).toBe(false);
  });

  it("never leaks private or age-restricted channels onto a public board", () => {
    const guild = { roles: { everyone: "everyone" } };
    const board = fakeChannel(BOARD_ID);
    expect(canFeature(fakeChannel(GENERAL_ID), board, guild)).toBe(true);
    expect(canFeature(fakeChannel(STAFF_ID, { everyoneCanSee: false }), board, guild)).toBe(false);
    expect(canFeature(fakeChannel(STAFF_ID, { everyoneCanSee: false }), fakeChannel(BOARD_ID, { everyoneCanSee: false }), guild)).toBe(true);
    expect(canFeature(fakeChannel(GENERAL_ID, { nsfw: true }), board, guild)).toBe(false);
    expect(canFeature(board, board, guild)).toBe(false);
  });
});

describe("starboard", () => {
  it("posts a message once it has enough stars, then keeps the count up to date", async () => {
    const { message, react, board, store } = setup({ threshold: 2 });
    const msg = message();
    await react(msg, [fan(1)]);
    expect(board.send).not.toHaveBeenCalled();

    await react(msg, [fan(1), fan(2)]);
    expect(board.send).toHaveBeenCalledTimes(1);
    const [post] = [...board.posted.values()];
    expect(post.payload.content).toBe(`⭐ **2** · <#${GENERAL_ID}>`);
    expect(post.payload.allowedMentions).toEqual({ parse: [] });
    const embed = post.payload.embeds[0].toJSON();
    expect(embed).toMatchObject({ description: "What a play @everyone", author: { name: "Player" }, image: { url: "https://cdn.example/clip.png" } });
    expect(post.payload.components[0].toJSON().components[0].url).toBe(msg.url);

    await react(msg, [fan(1), fan(2), fan(3)]);
    expect(board.send).toHaveBeenCalledTimes(1);
    expect(post.payload.content).toContain("**3**");
    expect(store.get(msg.id)).toMatchObject({ starMessageId: post.id, stars: 3 });
  });

  it("doesn't count the author's own star or bots", async () => {
    const { message, react, board } = setup({ threshold: 2 });
    await react(message(), [AUTHOR_ID, "bot000000000000001", fan(1)]);
    expect(board.send).not.toHaveBeenCalled();
  });

  it("ignores other emoji", async () => {
    const { message, react, board } = setup({ threshold: 1 });
    await react(message(), [fan(1)], "🔥");
    expect(board.send).not.toHaveBeenCalled();
  });

  it("removes the post when the stars drop below the threshold, without logging it", async () => {
    const { message, react, board, store, botDeletions } = setup({ threshold: 2 });
    const msg = message();
    await react(msg, [fan(1), fan(2)]);
    const [post] = [...board.posted.values()];
    await react(msg, [fan(1)]);
    expect(board.posted.size).toBe(0);
    expect(store.get(msg.id)).toBeUndefined();
    expect(botDeletions.has(post.id)).toBe(true);
  });

  it("removes the post when every reaction is cleared", async () => {
    const { message, react, starboard, board } = setup({ threshold: 1 });
    const msg = message();
    await react(msg, [fan(1)]);
    msg.reactionsMap.clear();
    await starboard.reactionsCleared(msg);
    expect(board.posted.size).toBe(0);
  });

  it("removes the post when the original message is deleted", async () => {
    const { message, react, starboard, board, store } = setup({ threshold: 1 });
    const msg = message();
    await react(msg, [fan(1)]);
    await starboard.messageDeleted(msg);
    expect(board.posted.size).toBe(0);
    expect(store.get(msg.id)).toBeUndefined();
  });

  it("keeps a message off the board once staff delete its post", async () => {
    const { message, react, starboard, board, store } = setup({ threshold: 1 });
    const msg = message();
    await react(msg, [fan(1)]);
    const [post] = [...board.posted.values()];
    board.posted.delete(post.id);
    await starboard.messageDeleted({ id: post.id, guildId: GUILD_ID });
    expect(store.get(msg.id)).toMatchObject({ removed: true, starMessageId: null });

    await react(msg, [fan(1), fan(2)]);
    expect(board.send).toHaveBeenCalledTimes(1);
  });

  it("never posts messages from a channel everyone can't see", async () => {
    const { message, react, board, staff } = setup({ threshold: 1 });
    await react(message(staff), [fan(1)]);
    expect(board.send).not.toHaveBeenCalled();
  });

  it("does nothing when the starboard is off", async () => {
    const { message, react, board, guildSettings } = setup({ threshold: 1 });
    await guildSettings.clear(GUILD_ID, Setting.STARBOARD);
    await react(message(), [fan(1)]);
    expect(board.send).not.toHaveBeenCalled();
  });
});

describe("/starboard", () => {
  function run(guildSettings, { subcommand, options = {}, manageGuild = true, canPost = true }) {
    const me = {};
    const interaction = {
      locale: "en-US",
      guildId: GUILD_ID,
      guild: { members: { me } },
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => manageGuild && bit === PermissionFlagsBits.ManageGuild },
      options: {
        getSubcommand: () => subcommand,
        getChannel: () => options.channel ?? null,
        getInteger: () => options.threshold ?? null,
        getString: () => options.emoji ?? null,
      },
      reply: vi.fn(async () => {}),
    };
    if (options.channel) {
      options.channel.permissionsFor = (member) => ({ has: () => member === me && canPost });
    }
    return createStarboardCommand({ guildSettings }).execute(interaction).then((outcome) => ({ outcome, interaction }));
  }

  it("is for admins only", async () => {
    expect(buildStarboardCommandData().default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    const { outcome } = await run(new GuildSettings(), { subcommand: "show", manageGuild: false });
    expect(outcome.key).toBe("modNoPermission");
  });

  it("sets, shows and turns off the starboard", async () => {
    const guildSettings = new GuildSettings();
    expect((await run(guildSettings, { subcommand: "show" })).outcome.key).toBe("starboardShowOff");

    const { outcome, interaction } = await run(guildSettings, { subcommand: "set", options: { channel: { id: BOARD_ID } } });
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "starboardSet" });
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(guildSettings.get(GUILD_ID, Setting.STARBOARD)).toEqual({ channelId: BOARD_ID, threshold: 3, emoji: "⭐" });

    await run(guildSettings, { subcommand: "set", options: { channel: { id: BOARD_ID }, threshold: 5, emoji: "🔥" } });
    await run(guildSettings, { subcommand: "set", options: { channel: { id: GENERAL_ID } } });
    expect(guildSettings.get(GUILD_ID, Setting.STARBOARD)).toEqual({ channelId: GENERAL_ID, threshold: 5, emoji: "🔥" });
    expect((await run(guildSettings, { subcommand: "show" })).outcome.key).toBe("starboardShow");

    expect((await run(guildSettings, { subcommand: "off" })).outcome.key).toBe("starboardOff");
    expect(guildSettings.get(GUILD_ID, Setting.STARBOARD)).toBeUndefined();
  });

  it("refuses a bad emoji or a channel the bot can't post in", async () => {
    const guildSettings = new GuildSettings();
    expect((await run(guildSettings, { subcommand: "set", options: { channel: { id: BOARD_ID }, emoji: "star" } })).outcome.key).toBe(
      "starboardBadEmoji",
    );
    expect((await run(guildSettings, { subcommand: "set", options: { channel: { id: BOARD_ID } }, canPost: false })).outcome.key).toBe(
      "starboardCannotPost",
    );
    expect(guildSettings.get(GUILD_ID, Setting.STARBOARD)).toBeUndefined();
  });
});
