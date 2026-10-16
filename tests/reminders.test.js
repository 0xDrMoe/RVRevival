import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createRemindCommand, MAX_REMINDERS_PER_MEMBER } from "../src/commands/remind.js";
import { Status } from "../src/logs/actionLog.js";
import { createReminderScheduler } from "../src/reminders/reminderScheduler.js";
import { ReminderStore } from "../src/reminders/reminderStore.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const USER_ID = "300000000000000020";
const OTHER_ID = "300000000000000030";
const MINUTE = 60 * 1000;

function reminderValues(overrides = {}) {
  return {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    text: "Tournament check-in",
    createdAt: 0,
    dueAt: 10 * MINUTE,
    ...overrides,
  };
}

describe("ReminderStore", () => {
  it("adds, lists, counts and returns due reminders in order", () => {
    const store = new ReminderStore();
    const later = store.add(reminderValues({ dueAt: 20 * MINUTE }));
    const sooner = store.add(reminderValues({ dueAt: 5 * MINUTE, private: true }));
    store.add(reminderValues({ userId: OTHER_ID }));

    expect(sooner).toMatchObject({ id: expect.any(Number), private: true, dueAt: 5 * MINUTE });
    expect(store.listForUser(GUILD_ID, USER_ID).map((r) => r.id)).toEqual([sooner.id, later.id]);
    expect(store.countForUser(GUILD_ID, USER_ID)).toBe(2);
    expect(store.due(10 * MINUTE).map((r) => r.userId)).toEqual([USER_ID, OTHER_ID]);
  });

  it("only lets members delete their own reminders", () => {
    const store = new ReminderStore();
    const reminder = store.add(reminderValues());
    expect(store.deleteForUser(reminder.id, GUILD_ID, OTHER_ID)).toBe(false);
    expect(store.deleteForUser(reminder.id, "900000000000000002", USER_ID)).toBe(false);
    expect(store.deleteForUser(reminder.id, GUILD_ID, USER_ID)).toBe(true);
    expect(store.countForUser(GUILD_ID, USER_ID)).toBe(0);
  });
});

function fakeClient({ channel, guild = true, dmFails = false } = {}) {
  const send = vi.fn(async () => {
    if (dmFails) {
      throw new Error("Cannot send messages to this user");
    }
  });
  const channels = new Map(channel ? [[CHANNEL_ID, channel]] : []);
  return {
    dm: send,
    client: {
      guilds: { cache: new Map(guild ? [[GUILD_ID, { id: GUILD_ID, name: "RV", preferredLocale: "en-US", channels: { cache: channels } }]] : []) },
      users: { fetch: vi.fn(async () => ({ send })) },
    },
  };
}

const fakeChannel = (send = vi.fn(async () => {})) => ({ isTextBased: () => true, send });
const logger = { debug: vi.fn(), error: vi.fn() };

describe("reminder scheduler", () => {
  function setup(clientOptions) {
    const store = new ReminderStore();
    let time = 0;
    const { client, dm } = fakeClient(clientOptions);
    const scheduler = createReminderScheduler({ client, store, logger, now: () => time });
    return { store, scheduler, dm, at: (ms) => (time = ms) };
  }

  it("posts a due reminder in its channel, pinging only the member, then forgets it", async () => {
    const channel = fakeChannel();
    const { store, scheduler, dm, at } = setup({ channel });
    store.add(reminderValues({ text: "Check in @everyone" }));

    await scheduler.sweep();
    expect(channel.send).not.toHaveBeenCalled();

    at(10 * MINUTE);
    await scheduler.sweep();
    expect(channel.send).toHaveBeenCalledTimes(1);
    const message = channel.send.mock.calls[0][0];
    expect(message.content).toContain(`<@${USER_ID}>`);
    expect(message.content).toContain("Check in @everyone");
    expect(message.allowedMentions).toEqual({ users: [USER_ID] });
    expect(dm).not.toHaveBeenCalled();
    expect(store.due(Infinity)).toEqual([]);

    await scheduler.sweep();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("DMs private reminders with the server's name", async () => {
    const channel = fakeChannel();
    const { store, scheduler, dm, at } = setup({ channel });
    store.add(reminderValues({ private: true }));
    at(10 * MINUTE);
    await scheduler.sweep();
    expect(channel.send).not.toHaveBeenCalled();
    expect(dm.mock.calls[0][0].content).toContain("Reminder from RV");
  });

  it("falls back to a DM when the channel is gone or refuses the message", async () => {
    const { store, scheduler, dm, at } = setup({ channel: undefined });
    store.add(reminderValues());
    at(10 * MINUTE);
    await scheduler.sweep();
    expect(dm).toHaveBeenCalledTimes(1);

    const refusing = fakeChannel(vi.fn(async () => Promise.reject(new Error("Missing Access"))));
    const second = setup({ channel: refusing });
    second.store.add(reminderValues());
    second.at(10 * MINUTE);
    await second.scheduler.sweep();
    expect(refusing.send).toHaveBeenCalled();
    expect(second.dm).toHaveBeenCalledTimes(1);
  });

  it("drops a reminder it can't deliver anywhere", async () => {
    const { store, scheduler, at } = setup({ channel: undefined, dmFails: true });
    store.add(reminderValues());
    at(10 * MINUTE);
    await scheduler.sweep();
    expect(store.due(Infinity)).toEqual([]);
  });
});

function fakeInteraction({ subcommand, options = {}, canPost = true, focused = "" } = {}) {
  const me = {};
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: USER_ID },
    guild: { members: { me } },
    channel: { permissionsFor: (member) => ({ has: () => member === me && canPost }) },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getFocused: () => focused,
    },
    reply: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

describe("/remind", () => {
  function setup() {
    const reminders = new ReminderStore();
    const command = createRemindCommand({ reminders, now: () => 1_000_000 });
    const set = (options, extra) => command.execute(fakeInteraction({ subcommand: "set", options, ...extra }));
    return { reminders, command, set };
  }

  it("sets a reminder in this channel", async () => {
    const { reminders, set } = setup();
    const outcome = await set({ in: "2h", about: "Tournament check-in" });
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "remindSetHere" });
    expect(reminders.listForUser(GUILD_ID, USER_ID)).toEqual([
      expect.objectContaining({ channelId: CHANNEL_ID, text: "Tournament check-in", private: false, dueAt: 1_000_000 + 120 * MINUTE }),
    ]);
  });

  it("sets private reminders, and falls back to a DM when the bot can't post here", async () => {
    const { reminders, set } = setup();
    expect((await set({ in: "10m", about: "a", private: true })).key).toBe("remindSetPrivate");
    expect((await set({ in: "10m", about: "b" }, { canPost: false })).key).toBe("remindSetDmFallback");
    expect(reminders.listForUser(GUILD_ID, USER_ID).map((r) => r.private)).toEqual([true, true]);
  });

  it("refuses bad times, times out of range, empty text and a full list", async () => {
    const { reminders, set } = setup();
    expect((await set({ in: "soon", about: "a" })).key).toBe("remindBadDuration");
    expect((await set({ in: "30s", about: "a" })).key).toBe("remindOutOfRange");
    expect((await set({ in: "400d", about: "a" })).key).toBe("remindOutOfRange");
    expect((await set({ in: "1h", about: "   " })).key).toBe("remindEmpty");
    for (let index = 0; index < MAX_REMINDERS_PER_MEMBER; index++) {
      reminders.add(reminderValues({ dueAt: 2_000_000 }));
    }
    expect((await set({ in: "1h", about: "one more" })).key).toBe("remindFull");
  });

  it("lists, suggests and cancels only the member's own reminders", async () => {
    const { reminders, command, set } = setup();
    await set({ in: "1h", about: "Stream starts" });
    const theirs = reminders.add(reminderValues({ userId: OTHER_ID }));
    const [mine] = reminders.listForUser(GUILD_ID, USER_ID);

    const list = fakeInteraction({ subcommand: "list" });
    await command.execute(list);
    const reply = list.reply.mock.calls[0][0];
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(reply.content).toContain(`#${mine.id}`);
    expect(reply.content).toContain("Stream starts");
    expect(reply.content).not.toContain(`#${theirs.id}\``);

    const suggest = fakeInteraction({ focused: "stream" });
    await command.autocomplete(suggest);
    expect(suggest.respond).toHaveBeenCalledWith([{ name: `#${mine.id} Stream starts`, value: mine.id }]);

    const cancelTheirs = fakeInteraction({ subcommand: "cancel", options: { reminder: theirs.id } });
    expect((await command.execute(cancelTheirs)).key).toBe("remindNotFound");
    const cancelMine = fakeInteraction({ subcommand: "cancel", options: { reminder: mine.id } });
    expect((await command.execute(cancelMine)).key).toBe("remindCancelled");
    expect(reminders.countForUser(GUILD_ID, USER_ID)).toBe(0);
  });

  it("says when there are no reminders", async () => {
    const { command } = setup();
    expect((await command.execute(fakeInteraction({ subcommand: "list" }))).key).toBe("remindListEmpty");
  });
});
