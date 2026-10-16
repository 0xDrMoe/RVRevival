import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createAfk } from "../src/afk/afk.js";
import { AfkStore, NicknameChange } from "../src/afk/afkStore.js";
import { buildAfkCommandData, createAfkCommand } from "../src/commands/afk.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const AWAY_ID = "300000000000000010";
const OTHER_ID = "300000000000000011";
const CHANNEL_ID = "800000000000000001";

function fakeGuild({ canRename = true } = {}) {
  return {
    id: GUILD_ID,
    ownerId: "300000000000000000",
    preferredLocale: "en-US",
    members: { me: { permissions: { has: (permission) => permission !== PermissionFlagsBits.ManageNicknames || canRename }, roles: { highest: { position: 10 } } } },
  };
}

function fakeMember(guild, { id = AWAY_ID, nickname = null } = {}) {
  const member = {
    id,
    guild,
    nickname,
    user: { id, username: "rumbler", globalName: "Rumbler" },
    roles: { highest: { position: 1 } },
    setNickname: vi.fn(async (name) => {
      member.nickname = name;
    }),
  };
  return member;
}

function fakeMessage(guild, author, { mentions = [], repliedUser = null, member = null } = {}) {
  const sent = { delete: vi.fn(async () => {}) };
  return {
    inGuild: () => true,
    guild,
    guildId: guild.id,
    channelId: CHANNEL_ID,
    author: { id: author, bot: false },
    member,
    mentions: { users: new Map(mentions.map((id) => [id, { id }])), repliedUser: repliedUser ? { id: repliedUser } : null },
    reply: vi.fn(async () => sent),
    sent,
  };
}

function setup(options) {
  let time = 1_000_000_000;
  const timers = [];
  const store = new AfkStore();
  const afk = createAfk({ store, logger: fakeLogger(), now: () => time, setTimer: (fn) => timers.push(fn), ...options });
  return { store, afk, timers, advance: (ms) => (time += ms) };
}

describe("AFK", () => {
  it("answers mentions and replies once a minute per channel, then welcomes the member back", async () => {
    const { store, afk, timers, advance } = setup();
    const guild = fakeGuild();
    const member = fakeMember(guild, { nickname: "Champ" });
    await afk.setAway(member, "Eating");
    expect(member.setNickname).toHaveBeenCalledWith("[AFK] Champ", "AFK");
    expect(store.get(GUILD_ID, AWAY_ID)).toMatchObject({ message: "Eating", nickname: NicknameChange.PREFIXED });

    const mention = fakeMessage(guild, OTHER_ID, { mentions: [AWAY_ID] });
    await afk.messageCreated(mention);
    expect(mention.reply.mock.calls[0][0]).toMatchObject({ content: `💤 <@${AWAY_ID}> is AFK (<t:1000000:R>): Eating`, allowedMentions: { parse: [], repliedUser: false } });
    timers.forEach((fn) => fn());
    expect(mention.sent.delete).toHaveBeenCalled();

    const again = fakeMessage(guild, OTHER_ID, { repliedUser: AWAY_ID });
    await afk.messageCreated(again);
    expect(again.reply).not.toHaveBeenCalled();
    advance(61_000);
    await afk.messageCreated(again);
    expect(again.reply).toHaveBeenCalledTimes(1);

    const back = fakeMessage(guild, AWAY_ID, { member });
    await afk.messageCreated(back);
    expect(back.reply.mock.calls[0][0].content).toContain("Welcome back");
    expect(member.setNickname).toHaveBeenLastCalledWith("Champ", "Back from AFK");
    expect(store.get(GUILD_ID, AWAY_ID)).toBeUndefined();
  });

  it("clears an added nickname, and leaves names alone when it can't rename", async () => {
    const { afk } = setup();
    const guild = fakeGuild();
    const member = fakeMember(guild);
    await afk.setAway(member, null);
    expect(member.nickname).toBe("[AFK] Rumbler");
    await afk.messageCreated(fakeMessage(guild, AWAY_ID, { member }));
    expect(member.nickname).toBeNull();

    const locked = fakeGuild({ canRename: false });
    const other = fakeMember(locked);
    await afk.setAway(other, null);
    expect(other.setNickname).not.toHaveBeenCalled();
    const mention = fakeMessage(locked, OTHER_ID, { mentions: [AWAY_ID] });
    await afk.messageCreated(mention);
    expect(mention.reply.mock.calls[0][0].content).toBe(`💤 <@${AWAY_ID}> is AFK (<t:1000000:R>).`);
  });

  it("ignores bots, self-mentions and members who left", async () => {
    const { store, afk } = setup();
    const guild = fakeGuild({ canRename: false });
    await afk.setAway(fakeMember(guild), "Away");
    const bot = { ...fakeMessage(guild, OTHER_ID, { mentions: [AWAY_ID] }), author: { id: OTHER_ID, bot: true } };
    await afk.messageCreated(bot);
    expect(bot.reply).not.toHaveBeenCalled();
    afk.memberLeft({ guild, id: AWAY_ID });
    expect(store.count(GUILD_ID)).toBe(0);
  });
});

describe("/afk", () => {
  it("builds the command", () => {
    expect(buildAfkCommandData()).toMatchObject({ name: "afk", options: [{ name: "message" }] });
  });

  it("marks the member away with a cleaned-up message", async () => {
    const { store, afk } = setup();
    const guild = fakeGuild({ canRename: false });
    const member = fakeMember(guild);
    const command = createAfkCommand({ afk });
    const interaction = {
      locale: "en-US",
      member,
      inCachedGuild: () => true,
      options: { getString: () => "  back\n soon @everyone " },
      reply: vi.fn(async () => {}),
    };
    expect(await command.execute(interaction)).toMatchObject({ key: "afkSet" });
    expect(store.get(GUILD_ID, AWAY_ID).message).toBe("back soon @\u200beveryone");
  });
});
