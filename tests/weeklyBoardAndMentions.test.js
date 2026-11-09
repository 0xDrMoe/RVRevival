import { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandMention, linkCommands, rememberCommands } from "../src/commands/commandMentions.js";
import { createGuideCommand } from "../src/commands/guide.js";
import { createGuildJoinHandler, missingInvitePermissions } from "../src/guilds/guildJoin.js";
import { INVITE_PERMISSIONS } from "../src/guilds/invite.js";
import { dayNumber, LevelStore } from "../src/leveling/levelStore.js";
import { createWeeklyBoard, WeeklyBoardStore, weekNumber, weekStartDay } from "../src/leveling/weeklyBoard.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { openDatabase } from "../src/storage/database.js";

const GUILD_ID = "100000000000000010";
const CHANNEL_ID = "200000000000000001";
const ROLE_ID = "300000000000000001";
const DAY = 24 * 60 * 60 * 1000;
// Monday 9 November 2026, 00:05 UTC.
const MONDAY = Date.UTC(2026, 10, 9, 0, 5);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const COMMANDS = [
  { id: "11", name: "guide", type: 1, options: [{ type: ApplicationCommandOptionType.String, name: "topic" }] },
  {
    id: "22",
    name: "settings",
    type: 1,
    options: [
      { type: ApplicationCommandOptionType.Subcommand, name: "mod-role" },
      { type: ApplicationCommandOptionType.Subcommand, name: "mod-log-channel" },
    ],
  },
  { id: "33", name: "automod", type: 1, options: [{ type: ApplicationCommandOptionType.SubcommandGroup, name: "rule", options: [{ type: ApplicationCommandOptionType.Subcommand, name: "add" }] }] },
  { id: "44", name: "Report message", type: 3 },
];

describe("command mentions", () => {
  afterEach(() => rememberCommands([]));

  it("leaves text alone until the command IDs are known", () => {
    expect(linkCommands("Run `/guide` now")).toBe("Run `/guide` now");
  });

  it("links commands and subcommands, but not options, unknown paths or base commands with subcommands", () => {
    rememberCommands(COMMANDS);
    expect(commandMention("guide")).toBe("</guide:11>");
    expect(commandMention("settings")).toBeUndefined();
    expect(commandMention("automod rule add")).toBe("</automod rule add:33>");
    expect(linkCommands("Run `/guide`, `/settings mod-role` or `/automod rule add`.")).toBe("Run </guide:11>, </settings mod-role:22> or </automod rule add:33>.");
    expect(linkCommands("`/guide topic:tickets` `/settings` `/settings nope` `/ban`")).toBe("`/guide topic:tickets` `/settings` `/settings nope` `/ban`");
  });

  it("makes commands clickable in /guide without changing how pages split", async () => {
    const pageOf = async () => {
      const interaction = {
        locale: "en-US",
        options: { getString: () => "cmdwarn" },
        reply: vi.fn(async () => {}),
      };
      await createGuideCommand({}).execute(interaction);
      return interaction.reply.mock.calls[0][0];
    };
    const plain = await pageOf();
    rememberCommands([{ id: "55", name: "timeout", type: 1, options: [] }]);
    const linked = await pageOf();
    expect(JSON.stringify(plain.embeds[0])).toContain("`/timeout`");
    expect(JSON.stringify(linked.embeds[0])).toContain("</timeout:55>");
    expect(linked.embeds[0].data.title).toBe(plain.embeds[0].data.title);
  });
});

describe("setup message", () => {
  afterEach(() => rememberCommands([]));

  const fakeGuild = (permissions) => {
    const channel = { id: "1", type: ChannelType.GuildText, rawPosition: 0, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({})) };
    return {
      channel,
      guild: {
        id: GUILD_ID,
        preferredLocale: "en-US",
        joinedTimestamp: MONDAY,
        systemChannel: channel,
        members: { me: { id: "bot", permissions: { has: (bit) => permissions.includes(bit) } } },
        channels: { cache: new Map([["1", channel]]) },
      },
    };
  };

  it("lists the invite permissions the bot's role is missing", () => {
    const all = Object.entries(PermissionFlagsBits)
      .filter(([, bit]) => (BigInt(INVITE_PERMISSIONS) & bit) === bit)
      .map(([, bit]) => bit);
    expect(missingInvitePermissions({ permissions: { has: (bit) => all.includes(bit) } })).toEqual([]);
    const withoutRoles = all.filter((bit) => bit !== PermissionFlagsBits.ManageRoles);
    expect(missingInvitePermissions({ permissions: { has: (bit) => withoutRoles.includes(bit) } })).toEqual(["Manage Roles"]);
    expect(missingInvitePermissions({ permissions: { has: (bit) => bit === PermissionFlagsBits.Administrator } })).toEqual([]);
  });

  it("posts a checklist with clickable commands, missing permissions and two buttons", async () => {
    rememberCommands(COMMANDS);
    const { guild, channel } = fakeGuild([PermissionFlagsBits.SendMessages]);
    const join = createGuildJoinHandler({ guildSettings: new GuildSettings(), logger, dashboardUrl: "https://rabble.example.com", now: () => MONDAY });
    await join.guildJoined(guild);
    const sent = channel.send.mock.calls[0][0];
    const text = sent.embeds[0].data.description;
    expect(text).toContain("**Quick setup**");
    expect(text).toContain("1. Pick where moderation cases go: </settings mod-log-channel:22>");
    expect(text).toContain("</guide:11>");
    expect(text).toContain("My role is missing permissions I asked for:");
    expect(text).toContain("Manage Roles");
    const buttons = sent.components[0].toJSON().components;
    expect(buttons.map((button) => button.url)).toEqual([`https://rabble.example.com/g/${GUILD_ID}`, "https://rabble.example.com/guide"]);
  });
});

describe("weekly leaderboard", () => {
  it("numbers weeks from Monday", () => {
    expect(new Date(weekStartDay(weekNumber(MONDAY)) * DAY).getUTCDay()).toBe(1);
    expect(weekNumber(MONDAY - 10 * 60 * 1000)).toBe(weekNumber(MONDAY) - 1);
    expect(weekNumber(MONDAY + 6 * DAY)).toBe(weekNumber(MONDAY));
  });

  function setup({ roleOk = true } = {}) {
    const db = openDatabase();
    const levels = new LevelStore(db);
    const store = new WeeklyBoardStore(db);
    const guildSettings = new GuildSettings();
    const channel = { id: CHANNEL_ID, isTextBased: () => true, send: vi.fn(async () => ({})) };
    const members = new Map(
      ["1", "2", "3"].map((id) => [id, { id, roles: { add: vi.fn(async () => {}), remove: vi.fn(async () => {}) } }]),
    );
    const guild = {
      id: GUILD_ID,
      preferredLocale: "en-US",
      channels: { cache: new Map([[CHANNEL_ID, channel]]) },
      roles: { cache: new Map([[ROLE_ID, { id: ROLE_ID, position: roleOk ? 1 : 9 }]]) },
      members: {
        me: { permissions: { has: () => true }, roles: { highest: { position: 5 } } },
        fetch: vi.fn(async (id) => members.get(id) ?? Promise.reject(new Error("Unknown Member"))),
      },
    };
    let time = MONDAY - 7 * DAY;
    const board = createWeeklyBoard({ client: { guilds: { cache: new Map([[GUILD_ID, guild]]) } }, guildSettings, levels, store, logger, now: () => time });
    return { levels, store, guildSettings, channel, members, board, setTime: (value) => (time = value) };
  }

  it("waits a week after setup, then posts last week's top members once", async () => {
    const { levels, guildSettings, channel, board, setTime } = setup();
    await guildSettings.set(GUILD_ID, Setting.LEVELING, { enabled: true });
    await guildSettings.set(GUILD_ID, Setting.WEEKLY_BOARD_CHANNEL, CHANNEL_ID);
    await board.sweep();
    expect(channel.send).not.toHaveBeenCalled();

    levels.addXp({ guildId: GUILD_ID, userId: "1", amount: 50, now: MONDAY - 3 * DAY });
    levels.addXp({ guildId: GUILD_ID, userId: "2", amount: 80, now: MONDAY - 1 * DAY });
    // Too old, and too new: not part of last week.
    levels.addXp({ guildId: GUILD_ID, userId: "3", amount: 500, now: MONDAY - 8 * DAY });
    levels.addXp({ guildId: GUILD_ID, userId: "3", amount: 500, now: MONDAY });
    setTime(MONDAY);
    await board.sweep();
    await board.sweep();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const text = channel.send.mock.calls[0][0].embeds[0].data.description;
    expect(text.split("\n").slice(2)).toEqual(["🥇 <@2> · 80 XP", "🥈 <@1> · 50 XP"]);
    expect(channel.send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  });

  it("passes the top member role on each week", async () => {
    const { levels, guildSettings, store, members, board, setTime } = setup();
    await guildSettings.set(GUILD_ID, Setting.LEVELING, { enabled: true });
    await guildSettings.set(GUILD_ID, Setting.WEEKLY_BOARD_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.WEEKLY_BOARD_ROLE, ROLE_ID);
    store.set(GUILD_ID, weekNumber(MONDAY) - 1, "1");
    levels.addXp({ guildId: GUILD_ID, userId: "2", amount: 10, now: MONDAY - DAY });
    setTime(MONDAY);
    await board.sweep();
    expect(members.get("1").roles.remove).toHaveBeenCalledWith(ROLE_ID, expect.any(String));
    expect(members.get("2").roles.add).toHaveBeenCalledWith(ROLE_ID, expect.any(String));
    expect(store.get(GUILD_ID)).toEqual({ week: weekNumber(MONDAY), winnerId: "2" });
  });

  it("posts nothing when leveling is off or nobody earned XP", async () => {
    const { levels, guildSettings, store, channel, board, setTime } = setup();
    await guildSettings.set(GUILD_ID, Setting.WEEKLY_BOARD_CHANNEL, CHANNEL_ID);
    store.set(GUILD_ID, weekNumber(MONDAY) - 1);
    levels.addXp({ guildId: GUILD_ID, userId: "2", amount: 10, now: MONDAY - DAY });
    setTime(MONDAY);
    await board.sweep();
    expect(channel.send).not.toHaveBeenCalled();
    await guildSettings.set(GUILD_ID, Setting.LEVELING, { enabled: true });
    store.set(GUILD_ID, weekNumber(MONDAY));
    setTime(MONDAY + 7 * DAY);
    await board.sweep();
    expect(channel.send).not.toHaveBeenCalled();
    expect(levels.topBetween(GUILD_ID, dayNumber(MONDAY) - 7, dayNumber(MONDAY))).toEqual([{ userId: "2", userTag: null, gained: 10 }]);
  });
});
