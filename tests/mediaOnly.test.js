import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildMediaOnlyCommandData, createMediaOnlyCommand } from "../src/commands/mediaOnly.js";
import { checkMediaOnly, createMediaOnly, InvalidMediaOnly, isMedia, MAX_MEDIA_CHANNELS, normalizeMediaOnly } from "../src/community/mediaOnly.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const MEDIA_ID = "800000000000000001";
const OTHER_ID = "800000000000000002";
const USER_ID = "300000000000000001";

describe("media-only settings", () => {
  it("normalizes and checks", () => {
    expect(normalizeMediaOnly(undefined)).toEqual({ channelIds: [], allowLinks: true });
    expect(normalizeMediaOnly({ channelIds: [MEDIA_ID, MEDIA_ID, "bad"], allowLinks: false })).toEqual({ channelIds: [MEDIA_ID], allowLinks: false });
    const isChannel = (id) => id === MEDIA_ID;
    expect(checkMediaOnly({ channelIds: [MEDIA_ID], allowLinks: true }, { isChannel })).toEqual({ channelIds: [MEDIA_ID], allowLinks: true });
    expect(checkMediaOnly({ channelIds: [], allowLinks: true }, { isChannel })).toBeNull();
    expect(checkMediaOnly({ channelIds: [], allowLinks: false }, { isChannel })).toEqual({ channelIds: [], allowLinks: false });
    expect(() => checkMediaOnly({ channelIds: [OTHER_ID], allowLinks: true }, { isChannel })).toThrow(InvalidMediaOnly);
    expect(() => checkMediaOnly({ channelIds: [MEDIA_ID] }, { isChannel })).toThrow(InvalidMediaOnly);
  });

  it("knows what counts as media", () => {
    expect(isMedia({ attachments: { size: 1 }, content: "" }, { allowLinks: false })).toBe(true);
    expect(isMedia({ attachments: { size: 0 }, content: "look https://youtu.be/x" }, { allowLinks: true })).toBe(true);
    expect(isMedia({ attachments: { size: 0 }, content: "look https://youtu.be/x" }, { allowLinks: false })).toBe(false);
    expect(isMedia({ attachments: { size: 0 }, content: "nice!" }, { allowLinks: true })).toBe(false);
  });
});

function fakeMessage({ channelId = MEDIA_ID, content = "nice!", attachments = 0, staff = false, bot = false } = {}) {
  const note = { delete: vi.fn(async () => {}) };
  return {
    id: "810000000000000001",
    inGuild: () => true,
    guild: { preferredLocale: "en-US" },
    guildId: GUILD_ID,
    channelId,
    channel: { send: vi.fn(async () => note) },
    content,
    attachments: { size: attachments },
    author: { id: USER_ID, bot },
    member: { permissionsIn: () => ({ has: (permission) => staff && permission === PermissionFlagsBits.ManageMessages }) },
    delete: vi.fn(async () => {}),
    note,
  };
}

describe("media-only channels", () => {
  async function setup(config = { channelIds: [MEDIA_ID], allowLinks: true }) {
    let time = 1_000_000;
    const timers = [];
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.MEDIA_ONLY, config);
    const botDeletions = { add: vi.fn() };
    const mediaOnly = createMediaOnly({ guildSettings, logger: fakeLogger(), botDeletions, now: () => time, setTimer: (fn) => timers.push(fn) });
    return { guildSettings, mediaOnly, botDeletions, timers, advance: (ms) => (time += ms) };
  }

  it("deletes text-only messages with a self-deleting note, once per 30 seconds", async () => {
    const { mediaOnly, botDeletions, timers, advance } = await setup();
    const text = fakeMessage();
    expect(await mediaOnly.messageCreated(text)).toBe(true);
    expect(text.delete).toHaveBeenCalled();
    expect(botDeletions.add).toHaveBeenCalledWith(text.id);
    expect(text.channel.send.mock.calls[0][0]).toMatchObject({ content: expect.stringContaining(`<@${USER_ID}>`), allowedMentions: { users: [USER_ID] } });
    timers.forEach((fn) => fn());
    expect(text.note.delete).toHaveBeenCalled();

    const again = fakeMessage();
    await mediaOnly.messageCreated(again);
    expect(again.delete).toHaveBeenCalled();
    expect(again.channel.send).not.toHaveBeenCalled();
    advance(31_000);
    const later = fakeMessage();
    await mediaOnly.messageCreated(later);
    expect(later.channel.send).toHaveBeenCalled();
  });

  it("keeps media, links, staff, bots and other channels", async () => {
    const { mediaOnly } = await setup();
    for (const message of [
      fakeMessage({ attachments: 1 }),
      fakeMessage({ content: "https://clips.example/1" }),
      fakeMessage({ staff: true }),
      fakeMessage({ bot: true }),
      fakeMessage({ channelId: OTHER_ID }),
    ]) {
      expect(await mediaOnly.messageCreated(message)).toBe(false);
      expect(message.delete).not.toHaveBeenCalled();
    }
  });

  it("deletes links alone when links don't count, and forgets deleted channels", async () => {
    const { guildSettings, mediaOnly } = await setup({ channelIds: [MEDIA_ID], allowLinks: false });
    expect(await mediaOnly.messageCreated(fakeMessage({ content: "https://clips.example/1" }))).toBe(true);
    await mediaOnly.channelDeleted({ guildId: GUILD_ID, id: MEDIA_ID });
    expect(guildSettings.get(GUILD_ID, Setting.MEDIA_ONLY)).toBeUndefined();
  });
});

function interaction(subcommand, options = {}, { canManage = true } = {}) {
  const channel = { id: MEDIA_ID, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => canManage }) };
  return {
    locale: "en-US",
    guild: { id: GUILD_ID, members: { me: {} }, channels: { cache: new Map([[MEDIA_ID, channel]]) } },
    memberPermissions: { has: () => true },
    inCachedGuild: () => true,
    options: { getSubcommand: () => subcommand, getChannel: () => options.channel ?? channel, getBoolean: () => options.allow ?? null },
    reply: vi.fn(async () => {}),
  };
}

describe("/mediaonly", () => {
  it("builds the command", () => {
    expect(buildMediaOnlyCommandData().options.map((option) => option.name)).toEqual(["add", "remove", "links", "list"]);
  });

  it("adds, lists, switches links and removes channels", async () => {
    const guildSettings = new GuildSettings();
    const command = createMediaOnlyCommand({ guildSettings });
    expect(await command.execute(interaction("add", {}, { canManage: false }))).toMatchObject({ key: "mediaOnlyNeedsManageMessages" });
    expect(await command.execute(interaction("add"))).toMatchObject({ key: "mediaOnlyAdded" });
    expect(await command.execute(interaction("add"))).toMatchObject({ key: "mediaOnlyAlready" });
    expect(await command.execute(interaction("links", { allow: false }))).toMatchObject({ key: "mediaOnlyLinksOff" });
    expect(guildSettings.get(GUILD_ID, Setting.MEDIA_ONLY)).toEqual({ channelIds: [MEDIA_ID], allowLinks: false });
    expect(await command.execute(interaction("list"))).toMatchObject({ key: "mediaOnlyListNoLinks" });
    expect(await command.execute(interaction("remove"))).toMatchObject({ key: "mediaOnlyRemoved" });
    expect(await command.execute(interaction("remove"))).toMatchObject({ key: "mediaOnlyNot" });

    await guildSettings.set(GUILD_ID, Setting.MEDIA_ONLY, { channelIds: Array.from({ length: MAX_MEDIA_CHANNELS }, (_, i) => `80000000000000010${i}`), allowLinks: true });
    expect(await command.execute(interaction("add"))).toMatchObject({ key: "mediaOnlyFull" });
  });
});
