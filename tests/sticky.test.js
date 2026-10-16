import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildStickyCommandData, createStickyCommand, stickyText } from "../src/commands/sticky.js";
import { createStickies } from "../src/sticky/stickies.js";
import { MAX_STICKIES, StickyStore } from "../src/sticky/stickyStore.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const USER_ID = "300000000000000001";

function fakeChannel(id = CHANNEL_ID) {
  let next = 1;
  const channel = {
    id,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    sent: [],
    send: vi.fn(async (payload) => {
      const message = { id: `81000000000000000${next++}`, ...payload, delete: vi.fn(async () => {}) };
      channel.sent.push(message);
      return message;
    }),
    messages: { delete: vi.fn(async () => {}) },
  };
  return channel;
}

const message = (channel, { bot = false } = {}) => ({ inGuild: () => true, channelId: channel.id, channel, author: { id: USER_ID, bot } });

function setup() {
  let time = 1_000_000;
  const timers = [];
  const store = new StickyStore();
  const stickies = createStickies({
    store,
    logger: fakeLogger(),
    now: () => time,
    setTimer: (fn, delay) => {
      const timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => timers.splice(timers.indexOf(timer), 1),
  });
  const runTimers = async () => {
    const due = timers.splice(0);
    for (const timer of due) {
      time += timer.delay;
      timer.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { store, stickies, timers, runTimers, advance: (ms) => (time += ms) };
}

describe("sticky messages", () => {
  it("reposts after people talk, deleting the last copy, at most every 15 seconds", async () => {
    const { store, stickies, timers, runTimers } = setup();
    const channel = fakeChannel();
    store.set({ channelId: CHANNEL_ID, guildId: GUILD_ID, content: "Read the rules", messageId: "810000000000000099", createdBy: USER_ID });

    stickies.messageCreated(message(channel));
    stickies.messageCreated(message(channel));
    expect(timers).toHaveLength(1);
    await runTimers();
    expect(channel.messages.delete).toHaveBeenCalledWith("810000000000000099");
    expect(channel.send).toHaveBeenCalledWith({ content: "Read the rules", allowedMentions: { parse: [] } });
    expect(store.get(CHANNEL_ID).messageId).toBe(channel.sent[0].id);

    stickies.messageCreated(message(channel));
    expect(timers[0].delay).toBe(15_000);
    await runTimers();
    expect(channel.messages.delete).toHaveBeenLastCalledWith(channel.sent[0].id);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("ignores bots and channels without a sticky, and stops when removed", async () => {
    const { store, stickies, timers } = setup();
    const channel = fakeChannel();
    stickies.messageCreated(message(channel));
    expect(timers).toHaveLength(0);
    store.set({ channelId: CHANNEL_ID, guildId: GUILD_ID, content: "x", createdBy: USER_ID });
    stickies.messageCreated(message(channel, { bot: true }));
    expect(timers).toHaveLength(0);
    stickies.messageCreated(message(channel));
    stickies.channelDeleted(channel);
    expect(timers).toHaveLength(0);
    expect(store.get(CHANNEL_ID)).toBeUndefined();
  });
});

function interaction(channel, subcommand, options = {}) {
  const state = {};
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, members: { me: { id: "bot" } }, channels: { cache: new Map([[channel.id, channel]]) } },
    channel,
    user: { id: USER_ID },
    memberPermissions: { has: () => true },
    inCachedGuild: () => true,
    options: { getSubcommand: () => subcommand, getString: (name) => options[name] ?? null, getChannel: () => options.channel ?? null },
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

describe("/sticky", () => {
  it("builds the command and turns \\n into line breaks", () => {
    expect(buildStickyCommandData().options.map((option) => option.name)).toEqual(["set", "remove", "list"]);
    expect(stickyText("  Rules:\\n1. Be nice  ")).toBe("Rules:\n1. Be nice");
  });

  it("sets, changes, lists and removes stickies", async () => {
    const { store, stickies } = setup();
    const command = createStickyCommand({ store, stickies });
    const channel = fakeChannel();

    expect(await command.execute(interaction(channel, "set", { message: "First" }))).toMatchObject({ key: "stickySet" });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(await command.execute(interaction(channel, "set", { message: "Second" }))).toMatchObject({ key: "stickyChanged" });
    expect(channel.messages.delete).toHaveBeenCalledWith(channel.sent[0].id);
    expect(store.get(CHANNEL_ID)).toMatchObject({ content: "Second", messageId: channel.sent[1].id });

    const list = interaction(channel, "list");
    expect(await command.execute(list)).toMatchObject({ key: "stickyList" });
    expect(list.reply.mock.calls[0][0].content).toContain("Second");

    expect(await command.execute(interaction(channel, "remove"))).toMatchObject({ key: "stickyRemoved" });
    expect(channel.messages.delete).toHaveBeenLastCalledWith(channel.sent[1].id);
    expect(await command.execute(interaction(channel, "remove"))).toMatchObject({ key: "stickyNone" });
  });

  it("refuses when full, in voice channels, and forgets a sticky it couldn't post", async () => {
    const { store, stickies } = setup();
    const command = createStickyCommand({ store, stickies });
    for (let i = 0; i < MAX_STICKIES; i += 1) {
      store.set({ channelId: `80000000000000010${i}`, guildId: GUILD_ID, content: "x", createdBy: USER_ID });
    }
    expect(await command.execute(interaction(fakeChannel(), "set", { message: "x" }))).toMatchObject({ key: "stickyFull" });

    const voice = { ...fakeChannel("800000000000000002"), type: ChannelType.GuildVoice };
    expect(await command.execute(interaction(voice, "set", { message: "x" }))).toMatchObject({ key: "stickyBadChannel" });

    const fresh = setup();
    const broken = fakeChannel();
    broken.send.mockRejectedValueOnce(new Error("Missing Access"));
    expect(await createStickyCommand({ store: fresh.store, stickies: fresh.stickies }).execute(interaction(broken, "set", { message: "x" }))).toMatchObject({ key: "stickyCannotPost" });
    expect(fresh.store.get(CHANNEL_ID)).toBeUndefined();
  });
});
