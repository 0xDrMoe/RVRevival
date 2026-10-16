import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildScheduleCommandData, createScheduleCommand } from "../src/commands/schedule.js";
import { Status } from "../src/logs/actionLog.js";
import { ScheduledMessageStore } from "../src/scheduled/scheduledMessageStore.js";
import { createScheduledMessageScheduler, MAX_SCHEDULED, mentionsFor, nextRun } from "../src/scheduled/scheduler.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const STAFF_ID = "300000000000000001";
const HOUR = 60 * 60 * 1000;
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

function fakeClient(channels = {}) {
  const cache = new Map(Object.entries(channels));
  return { guilds: { cache: new Map([[GUILD_ID, { id: GUILD_ID, channels: { cache } }]]) } };
}

const textChannel = (send = vi.fn(async () => {})) => ({ id: CHANNEL_ID, isTextBased: () => true, send });

describe("ScheduledMessageStore", () => {
  it("adds, lists, finds due messages, reschedules and deletes", () => {
    const store = new ScheduledMessageStore();
    const first = store.add({ guildId: GUILD_ID, channelId: CHANNEL_ID, content: "a", nextAt: 200, createdBy: STAFF_ID, createdAt: 1 });
    const second = store.add({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      content: "b",
      nextAt: 100,
      intervalMs: HOUR,
      allowMentions: true,
      createdBy: STAFF_ID,
      createdAt: 1,
    });
    expect(second).toMatchObject({ content: "b", intervalMs: HOUR, allowMentions: true });
    expect(store.list(GUILD_ID).map((message) => message.id)).toEqual([second.id, first.id]);
    expect(store.due(150).map((message) => message.id)).toEqual([second.id]);
    store.reschedule(second.id, 500);
    expect(store.get(GUILD_ID, second.id).nextAt).toBe(500);
    expect(store.deleteInGuild("other", first.id)).toBe(false);
    expect(store.deleteInGuild(GUILD_ID, first.id)).toBe(true);
    expect(store.count(GUILD_ID)).toBe(1);
  });
});

describe("nextRun and mentionsFor", () => {
  it("skips runs missed while offline", () => {
    expect(nextRun(1000, HOUR, 500)).toBe(1000);
    expect(nextRun(1000, HOUR, 1000)).toBe(1000 + HOUR);
    expect(nextRun(1000, HOUR, 1000 + 5.5 * HOUR)).toBe(1000 + 6 * HOUR);
  });

  it("only pings when allowed", () => {
    expect(mentionsFor({ allowMentions: false })).toEqual({ parse: [] });
    expect(mentionsFor({ allowMentions: true }).parse).toContain("everyone");
  });
});

describe("the scheduler", () => {
  it("posts a one-off message once and deletes it", async () => {
    const store = new ScheduledMessageStore();
    store.add({ guildId: GUILD_ID, channelId: CHANNEL_ID, content: "Hello @everyone", nextAt: 100, createdBy: STAFF_ID });
    const channel = textChannel();
    const scheduler = createScheduledMessageScheduler({ client: fakeClient({ [CHANNEL_ID]: channel }), store, logger, now: () => 150 });
    await scheduler.sweep();
    await scheduler.sweep();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith({ content: "Hello @everyone", allowedMentions: { parse: [] } });
    expect(store.count(GUILD_ID)).toBe(0);
  });

  it("moves a repeating message to its next run", async () => {
    const store = new ScheduledMessageStore();
    const saved = store.add({ guildId: GUILD_ID, channelId: CHANNEL_ID, content: "weekly", nextAt: 0, intervalMs: HOUR, createdBy: STAFF_ID });
    const channel = textChannel();
    const scheduler = createScheduledMessageScheduler({ client: fakeClient({ [CHANNEL_ID]: channel }), store, logger, now: () => 3.5 * HOUR });
    await scheduler.sweep();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(store.get(GUILD_ID, saved.id).nextAt).toBe(4 * HOUR);
  });

  it("deletes messages whose channel is gone, and keeps repeating ones it couldn't post", async () => {
    const store = new ScheduledMessageStore();
    store.add({ guildId: GUILD_ID, channelId: "gone", content: "x", nextAt: 0, intervalMs: HOUR, createdBy: STAFF_ID });
    const kept = store.add({ guildId: GUILD_ID, channelId: CHANNEL_ID, content: "y", nextAt: 0, intervalMs: HOUR, createdBy: STAFF_ID });
    const channel = textChannel(vi.fn(async () => Promise.reject(Object.assign(new Error("Missing Access"), { code: 50001 }))));
    const scheduler = createScheduledMessageScheduler({ client: fakeClient({ [CHANNEL_ID]: channel }), store, logger, now: () => 10 });
    await scheduler.sweep();
    expect(store.list(GUILD_ID).map((message) => message.id)).toEqual([kept.id]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("/schedule", () => {
  function interactionFor({ subcommand, options = {}, permissions = [PermissionFlagsBits.ManageGuild], customId, content, botCanPost = true }) {
    const granted = new PermissionsBitField(permissions);
    const channel = {
      id: CHANNEL_ID,
      type: ChannelType.GuildText,
      permissionsFor: () => new PermissionsBitField(botCanPost ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] : []),
    };
    return {
      guildId: GUILD_ID,
      guild: { members: { me: { id: "bot" } }, channels: { cache: new Map([[CHANNEL_ID, channel]]) } },
      user: { id: STAFF_ID },
      locale: "en-US",
      customId,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => granted.has(bit) },
      options: {
        getSubcommand: () => subcommand,
        getChannel: () => channel,
        getString: (name) => options[name] ?? null,
        getInteger: (name) => options[name] ?? null,
        getFocused: () => options.focused ?? "",
      },
      fields: { getTextInputValue: () => content },
      reply: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
    };
  }

  it("builds add, list and remove", () => {
    expect(buildScheduleCommandData().options.map((option) => option.name)).toEqual(["add", "list", "remove"]);
  });

  it("schedules a repeating message through the form", async () => {
    const store = new ScheduledMessageStore();
    const command = createScheduleCommand({ store, now: () => 1_000_000 });
    const open = interactionFor({ subcommand: "add", options: { in: "2h", every: "1w" } });
    expect(await command.execute(open)).toBeNull();
    const customId = open.showModal.mock.calls[0][0].toJSON().custom_id;
    expect(customId).toBe(`schedform:${CHANNEL_ID}:${1_000_000 + 2 * HOUR}:${7 * 24 * HOUR}`);

    const handle = command.componentPrefixes["schedform:"].handle;
    const added = await handle(
      interactionFor({ customId, content: " Weekly update!\r\nSee #news ", permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.MentionEveryone] }),
    );
    expect(added).toMatchObject({ status: Status.SUCCESS, key: "scheduleAddedRepeat" });
    expect(store.list(GUILD_ID)).toEqual([
      expect.objectContaining({
        channelId: CHANNEL_ID,
        content: "Weekly update!\nSee #news",
        nextAt: 1_000_000 + 2 * HOUR,
        intervalMs: 7 * 24 * HOUR,
        allowMentions: true,
        createdBy: STAFF_ID,
      }),
    ]);
  });

  it("refuses bad times, a full server, channels the bot can't post in and people without Manage Server", async () => {
    const store = new ScheduledMessageStore();
    const command = createScheduleCommand({ store });
    const keyFor = async (options) => (await command.execute(interactionFor({ subcommand: "add", ...options }))).key;
    expect(await keyFor({ options: { in: "soon" } })).toBe("scheduleBadDelay");
    expect(await keyFor({ options: { in: "10s" } })).toBe("scheduleBadDelay");
    expect(await keyFor({ options: { in: "1h", every: "10m" } })).toBe("scheduleBadInterval");
    expect(await keyFor({ options: { in: "1h" }, botCanPost: false })).toBe("scheduleBotCantPost");
    expect(await keyFor({ options: { in: "1h" }, permissions: [] })).toBe("scheduleNeedsManageGuild");
    for (let i = 0; i < MAX_SCHEDULED; i++) {
      store.add({ guildId: GUILD_ID, channelId: CHANNEL_ID, content: "x", nextAt: 1e15, createdBy: STAFF_ID });
    }
    expect(await keyFor({ options: { in: "1h" } })).toBe("scheduleFull");
  });

  it("doesn't let mentions ping without Mention Everyone, and never schedules in the past", async () => {
    const store = new ScheduledMessageStore();
    const command = createScheduleCommand({ store, now: () => 5_000_000 });
    const handle = command.componentPrefixes["schedform:"].handle;
    await handle(interactionFor({ customId: `schedform:${CHANNEL_ID}:1000:0`, content: "hi" }));
    expect(store.list(GUILD_ID)[0]).toMatchObject({ allowMentions: false, intervalMs: null, nextAt: 5_000_000 + 60_000 });
  });

  it("lists and removes", async () => {
    const store = new ScheduledMessageStore();
    const saved = store.add({ guildId: GUILD_ID, channelId: CHANNEL_ID, content: "Weekly news", nextAt: 3_600_000, intervalMs: 24 * HOUR, createdBy: STAFF_ID });
    const command = createScheduleCommand({ store });
    const list = interactionFor({ subcommand: "list" });
    await command.execute(list);
    expect(list.reply.mock.calls[0][0].content).toContain(`**#${saved.id}** <#${CHANNEL_ID}>`);
    expect(list.reply.mock.calls[0][0].content).toContain("every 1d");

    const suggest = interactionFor({ options: { focused: "news" } });
    await command.autocomplete(suggest);
    expect(suggest.respond).toHaveBeenCalledWith([{ name: `#${saved.id} · Weekly news`, value: saved.id }]);

    expect((await command.execute(interactionFor({ subcommand: "remove", options: { message: 999 } }))).key).toBe("scheduleNotFound");
    expect((await command.execute(interactionFor({ subcommand: "remove", options: { message: saved.id } }))).status).toBe(Status.SUCCESS);
    expect(store.count(GUILD_ID)).toBe(0);
  });
});
