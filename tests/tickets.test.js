import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildTicketsCommandData, createTicketsCommand } from "../src/commands/tickets.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { CLOSE_BUTTON, FORM_ID, MAX_OPEN_TICKETS, OPEN_BUTTON, threadName } from "../src/tickets/tickets.js";
import { TicketStore } from "../src/tickets/ticketStore.js";
import { buildTicketTranscript, fetchThreadMessages, MAX_TRANSCRIPT_MESSAGES } from "../src/tickets/transcript.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const ADMIN_ID = "300000000000000001";
const MEMBER_ID = "300000000000000002";
const STRANGER_ID = "300000000000000003";
const STAFF_ROLE_ID = "700000000000000001";
const MOD_ROLE_ID = "700000000000000002";

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

// Fake thread messages, newest first like Discord returns them.
function fakeMessages(count, { start = 0 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const n = start + count - index;
    return {
      id: String(500000000000000000n + BigInt(n)),
      createdTimestamp: 1_700_000_000_000 + n * 1000,
      author: { id: n % 2 ? MEMBER_ID : STRANGER_ID, tag: n % 2 ? "rumbler" : "kaz" },
      content: `message ${n}`,
      embeds: [],
      attachments: new Map(),
    };
  });
}

// thread.messages.fetch over `all` (newest first), honouring limit and before.
function fakeFetch(all) {
  return vi.fn(async ({ limit, before }) => {
    const from = before ? all.findIndex((message) => message.id === before) + 1 : 0;
    return new Map(all.slice(from, from + limit).map((message) => [message.id, message]));
  });
}

function setup({ canPost = true, mentionable = true, staffMembers = [], threadMessages = fakeMessages(3), canAttach = true } = {}) {
  let threadCount = 0;
  const threads = [];
  const guild = {
    id: GUILD_ID,
    preferredLocale: "en-US",
    channels: { cache: new Map() },
    roles: {
      cache: new Map([
        [STAFF_ROLE_ID, { id: STAFF_ROLE_ID, mentionable, members: new Map(staffMembers.map((id) => [id, { id, user: { bot: false } }])) }],
      ]),
    },
    name: "Rumbleverse Revival",
    members: { me: { permissions: { has: () => false } }, cache: new Map() },
  };
  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => canPost }),
    send: vi.fn(async () => ({ id: "600000000000000001" })),
    messages: { delete: vi.fn(async () => {}) },
    threads: {
      create: vi.fn(async (options) => {
        threadCount += 1;
        const thread = {
          id: `81000000000000000${threadCount}`,
          options,
          archived: false,
          members: { add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
          send: vi.fn(async () => ({})),
          edit: vi.fn(async (changes) => Object.assign(thread, changes)),
          messages: { fetch: fakeFetch(threadMessages) },
        };
        threads.push(thread);
        guild.channels.cache.set(thread.id, thread);
        return thread;
      }),
    },
  };
  guild.channels.cache.set(CHANNEL_ID, channel);
  guild.channels.cache.set(OTHER_CHANNEL_ID, { ...channel, id: OTHER_CHANNEL_ID, type: ChannelType.GuildVoice });

  let clock = 1_000_000;
  const guildSettings = new GuildSettings();
  const tickets = new TicketStore();
  const modLogPosts = [];
  const modLog = { post: vi.fn(async (_guild, build) => modLogPosts.push(build({ canAttach }))) };
  const command = createTicketsCommand({ tickets, guildSettings, logger, forcedLanguage: undefined, modLog, now: () => clock });

  function interaction({
    subcommand,
    options = {},
    userId = ADMIN_ID,
    manageGuild = false,
    manageThreads = false,
    roleIds = [],
    channelId = CHANNEL_ID,
    customId,
    subject,
  } = {}) {
    const permissions = new Set([manageGuild && PermissionFlagsBits.ManageGuild, manageThreads && PermissionFlagsBits.ManageThreads]);
    const self = {
      locale: "en-US",
      guildId: GUILD_ID,
      guild,
      channelId,
      get channel() {
        return guild.channels.cache.get(channelId);
      },
      customId,
      user: { id: userId, username: `user${userId.slice(-1)}` },
      member: { displayName: `Player ${userId.slice(-1)}`, roles: { cache: new Map(roleIds.map((id) => [id, {}])) } },
      deferred: false,
      replied: false,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => permissions.has(bit) },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => options[name] ?? null,
        getChannel: (name) => options[name] ?? null,
        getRole: (name) => options[name] ?? null,
        getUser: (name) => options[name] ?? null,
      },
      fields: { getTextInputValue: () => subject },
      reply: vi.fn(async () => {
        self.replied = true;
      }),
      deferReply: vi.fn(async () => {
        self.deferred = true;
      }),
      editReply: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
    };
    return self;
  }

  const lastText = (target) => (target.editReply.mock.calls.at(-1) ?? target.reply.mock.calls.at(-1))[0].content;

  async function postPanel(options = {}) {
    const run = interaction({ subcommand: "panel", manageGuild: true, options: { channel: { id: CHANNEL_ID }, ...options } });
    return { run, outcome: await command.execute(run) };
  }

  async function openTicket(userId = MEMBER_ID, subject = "My game crashes on start") {
    const click = interaction({ customId: OPEN_BUTTON, userId });
    await command.components[OPEN_BUTTON].handle(click);
    const form = interaction({ customId: FORM_ID, userId, subject });
    const outcome = await command.components[FORM_ID].handle(form);
    return { click, form, outcome };
  }

  return {
    guild,
    channel,
    threads,
    guildSettings,
    tickets,
    command,
    modLogPosts,
    interaction,
    lastText,
    postPanel,
    openTicket,
    advance: (ms) => (clock += ms),
  };
}

describe("tickets", () => {
  it("registers /tickets for people who can manage the server", () => {
    const data = buildTicketsCommandData();
    expect(data.name).toBe("tickets");
    expect(data.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
    expect(data.options.map((option) => option.name)).toEqual(["panel", "off", "close", "add", "remove", "list"]);
  });

  it("posts the panel and saves it", async () => {
    const t = setup();
    const { run, outcome } = await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID }, title: "Support" });
    expect(outcome.status).toBe(Status.SUCCESS);
    const panel = t.channel.send.mock.calls[0][0];
    expect(panel.embeds[0].toJSON().title).toBe("Support");
    expect(panel.components[0].toJSON().components[0].custom_id).toBe(OPEN_BUTTON);
    expect(t.guildSettings.get(GUILD_ID, Setting.TICKETS)).toEqual({
      channelId: CHANNEL_ID,
      messageId: "600000000000000001",
      staffRoleId: STAFF_ROLE_ID,
      title: "Support",
      message: null,
    });
    expect(t.lastText(run)).toContain(`<@&${STAFF_ROLE_ID}>`);
  });

  it("replaces an old panel and removes it with off", async () => {
    const t = setup();
    await t.postPanel();
    await t.postPanel();
    expect(t.channel.messages.delete).toHaveBeenCalledWith("600000000000000001");
    const off = t.interaction({ subcommand: "off", manageGuild: true });
    expect((await t.command.execute(off)).status).toBe(Status.SUCCESS);
    expect(t.guildSettings.get(GUILD_ID, Setting.TICKETS)).toBeUndefined();
    expect((await t.command.execute(t.interaction({ subcommand: "off", manageGuild: true }))).key).toBe("ticketPanelNone");
  });

  it("refuses a panel without Manage Server, in a channel it can't use, or for @everyone", async () => {
    const t = setup({ canPost: false });
    const noPermission = t.interaction({ subcommand: "panel", options: { channel: { id: CHANNEL_ID } }, roleIds: [MOD_ROLE_ID] });
    expect((await t.command.execute(noPermission)).key).toBe("modNoPermission");
    expect((await t.postPanel()).outcome.key).toBe("ticketCannotCreate");

    const voice = setup();
    expect((await voice.postPanel({ channel: { id: OTHER_CHANNEL_ID } })).outcome.key).toBe("ticketCannotCreate");
    expect((await voice.postPanel({ "staff-role": { id: GUILD_ID } })).outcome.key).toBe("ticketStaffEveryone");
  });

  it("opens a private thread with the member and the staff role", async () => {
    const t = setup();
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    const { click, form, outcome } = await t.openTicket();
    expect(click.showModal).toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "ticketOpened" });

    const [thread] = t.threads;
    expect(thread.options).toMatchObject({ name: threadName(1, "Player 2"), type: ChannelType.PrivateThread, invitable: false });
    expect(thread.members.add).toHaveBeenCalledWith(MEMBER_ID);
    const welcome = thread.send.mock.calls[0][0];
    expect(welcome.content).toContain(`<@${MEMBER_ID}>`);
    expect(welcome.content).toContain(`<@&${STAFF_ROLE_ID}>`);
    expect(welcome.allowedMentions).toEqual({ users: [MEMBER_ID], roles: [STAFF_ROLE_ID] });
    expect(welcome.embeds[0].toJSON().description).toBe("My game crashes on start");
    expect(welcome.components[0].toJSON().components[0].custom_id).toBe(CLOSE_BUTTON);
    expect(t.lastText(form)).toContain(`<#${thread.id}>`);
    expect(t.tickets.openForUser(GUILD_ID, MEMBER_ID)).toMatchObject({ number: 1, threadId: thread.id });
  });

  it("has a button per category, each with its own questions and staff role", async () => {
    const t = setup();
    const BUGS_ROLE_ID = "700000000000000099";
    t.guild.roles.cache.set(BUGS_ROLE_ID, { id: BUGS_ROLE_ID, mentionable: true, members: new Map() });
    await t.guildSettings.set(GUILD_ID, Setting.TICKET_CATEGORIES, [
      { id: "bugs", label: "Bug report", emoji: "🐞", description: "Something broken in the game", staffRoleId: BUGS_ROLE_ID, questions: ["What happened?", "Your platform"] },
      { id: "other", label: "Something else", emoji: null, description: null, staffRoleId: null, questions: [] },
    ]);
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    const panel = t.channel.send.mock.calls[0][0];
    expect(panel.components[0].toJSON().components.map((button) => [button.custom_id, button.label])).toEqual([
      ["tk:open:bugs", "Bug report"],
      ["tk:open:other", "Something else"],
    ]);
    expect(panel.embeds[0].toJSON().fields).toEqual([{ name: "🐞 Bug report", value: "Something broken in the game" }]);

    const click = t.interaction({ customId: "tk:open:bugs", userId: MEMBER_ID });
    await t.command.componentPrefixes["tk:open:"].handle(click);
    const modal = click.showModal.mock.calls[0][0].toJSON();
    expect(modal.custom_id).toBe("tk:form:bugs");
    expect(modal.title).toBe("Bug report");
    expect(modal.components.map((label) => [label.label, label.component.custom_id])).toEqual([
      ["What happened?", "q0"],
      ["Your platform", "q1"],
    ]);

    const form = t.interaction({ customId: "tk:form:bugs", userId: MEMBER_ID });
    const answers = { q0: "Crash on start", q1: "PC" };
    form.fields = { getTextInputValue: (id) => answers[id] };
    expect((await t.command.componentPrefixes["tk:form:"].handle(form)).key).toBe("ticketOpened");
    const ticket = t.tickets.openForUser(GUILD_ID, MEMBER_ID);
    expect(ticket).toMatchObject({ categoryId: "bugs", categoryLabel: "Bug report", subject: "**What happened?**\nCrash on start\n\n**Your platform**\nPC" });
    const welcome = t.threads[0].send.mock.calls[0][0];
    expect(welcome.allowedMentions.roles).toEqual([BUGS_ROLE_ID]);
    expect(welcome.embeds[0].toJSON().title).toBe("Bug report");

    // The category's staff can close it without being general ticket staff.
    const close = t.interaction({ customId: CLOSE_BUTTON, userId: ADMIN_ID, channelId: t.threads[0].id, roleIds: [BUGS_ROLE_ID] });
    expect((await t.command.components[CLOSE_BUTTON].handle(close)).status).toBe(Status.SUCCESS);

    // A button left over from a removed category says so.
    await t.guildSettings.set(GUILD_ID, Setting.TICKET_CATEGORIES, []);
    const stale = t.interaction({ customId: "tk:open:bugs", userId: MEMBER_ID });
    expect((await t.command.componentPrefixes["tk:open:"].handle(stale)).key).toBe("ticketCategoryGone");
  });

  it("adds staff one by one when their role can't be pinged", async () => {
    const t = setup({ mentionable: false, staffMembers: ["300000000000000077", "300000000000000078"] });
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    await t.openTicket();
    const added = t.threads[0].members.add.mock.calls.map(([id]) => id);
    expect(added).toEqual([MEMBER_ID, "300000000000000077", "300000000000000078"]);
  });

  it("uses the mod role when the panel has no staff role", async () => {
    const t = setup();
    await t.guildSettings.set(GUILD_ID, Setting.MOD_ROLE, MOD_ROLE_ID);
    await t.postPanel();
    await t.openTicket();
    expect(t.threads[0].send.mock.calls[0][0].allowedMentions.roles).toEqual([MOD_ROLE_ID]);
  });

  it("allows one open ticket per member, until it's closed or its thread is gone", async () => {
    const t = setup();
    await t.postPanel();
    await t.openTicket();
    const again = t.interaction({ customId: OPEN_BUTTON, userId: MEMBER_ID });
    expect((await t.command.components[OPEN_BUTTON].handle(again)).key).toBe("ticketAlreadyOpen");
    expect(again.showModal).not.toHaveBeenCalled();

    // The thread was archived (Discord does that after a week of quiet): a new ticket is fine.
    t.threads[0].archived = true;
    const { outcome } = await t.openTicket();
    expect(outcome.key).toBe("ticketOpened");
    expect(t.tickets.openForUser(GUILD_ID, MEMBER_ID).number).toBe(2);
  });

  it("says tickets are off without a panel, and caps open tickets", async () => {
    const t = setup();
    const click = t.interaction({ customId: OPEN_BUTTON, userId: MEMBER_ID });
    expect((await t.command.components[OPEN_BUTTON].handle(click)).key).toBe("ticketsOff");

    await t.postPanel();
    for (let index = 0; index < MAX_OPEN_TICKETS; index += 1) {
      t.tickets.open({ guildId: GUILD_ID, userId: `4000000000000000${String(index).padStart(2, "0")}`, subject: "x" });
    }
    expect((await t.openTicket()).outcome.key).toBe("ticketTooMany");
  });

  it("forgets the ticket when its thread can't be made", async () => {
    const t = setup();
    await t.postPanel();
    t.channel.threads.create.mockRejectedValueOnce(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    expect((await t.openTicket()).outcome.key).toBe("ticketsBroken");
    expect(t.tickets.openForUser(GUILD_ID, MEMBER_ID)).toBeUndefined();
  });

  it("lets the member or staff close a ticket, which locks and archives the thread", async () => {
    const t = setup();
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    await t.openTicket();
    const [thread] = t.threads;

    const stranger = t.interaction({ customId: CLOSE_BUTTON, userId: STRANGER_ID, channelId: thread.id });
    expect((await t.command.components[CLOSE_BUTTON].handle(stranger)).key).toBe("ticketCloseNoPermission");

    const owner = t.interaction({ customId: CLOSE_BUTTON, userId: MEMBER_ID, channelId: thread.id });
    expect(await t.command.components[CLOSE_BUTTON].handle(owner)).toMatchObject({ status: Status.SUCCESS, key: "ticketClosedLog" });
    expect(owner.reply.mock.calls[0][0].content).toBe(`🔒 Ticket #1 closed by <@${MEMBER_ID}>.`);
    expect(owner.reply.mock.calls[0][0].flags).toBeUndefined();
    expect(thread.edit).toHaveBeenCalledWith(expect.objectContaining({ locked: true, archived: true }));
    expect(t.tickets.openForUser(GUILD_ID, MEMBER_ID)).toBeUndefined();

    const twice = t.interaction({ customId: CLOSE_BUTTON, userId: MEMBER_ID, channelId: thread.id });
    expect((await t.command.components[CLOSE_BUTTON].handle(twice)).key).toBe("ticketAlreadyClosed");
  });

  it("saves the transcript when a ticket closes and posts it in the mod log", async () => {
    const t = setup();
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    await t.openTicket();
    const [thread] = t.threads;
    const close = t.interaction({ subcommand: "close", userId: STRANGER_ID, roleIds: [STAFF_ROLE_ID], channelId: thread.id, options: { reason: "Fixed" } });
    await t.command.execute(close);

    const saved = t.tickets.byNumber(GUILD_ID, 1);
    expect(saved).toMatchObject({ hasTranscript: true, messageCount: 3 });
    const transcript = t.tickets.transcript(GUILD_ID, 1);
    expect(transcript).toContain("Ticket #1 · Rumbleverse Revival");
    expect(transcript).toContain("Subject: My game crashes on start");
    expect(transcript).toContain(`Closed by kaz (${STRANGER_ID})`);
    expect(transcript).toContain("Reason: Fixed");
    // Oldest first.
    expect(transcript.indexOf("message 1")).toBeLessThan(transcript.indexOf("message 3"));

    const [post] = t.modLogPosts;
    expect(post.embed.data.title).toBe("🎫 Ticket #1 closed");
    expect(post.files[0].name).toBe("ticket-0001.txt");
    // Saved before the thread is archived.
    expect(thread.edit).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it("still closes a ticket whose history can't be read", async () => {
    const t = setup();
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    await t.openTicket();
    const [thread] = t.threads;
    thread.messages.fetch = vi.fn(async () => {
      throw Object.assign(new Error("Missing Access"), { code: 50001 });
    });
    const owner = t.interaction({ customId: CLOSE_BUTTON, userId: MEMBER_ID, channelId: thread.id });
    expect(await t.command.components[CLOSE_BUTTON].handle(owner)).toMatchObject({ key: "ticketClosedLog" });
    expect(t.tickets.byNumber(GUILD_ID, 1)).toMatchObject({ hasTranscript: false });
    expect(thread.edit).toHaveBeenCalledWith(expect.objectContaining({ locked: true, archived: true }));
    expect(t.modLogPosts).toEqual([]);
  });

  it("closes with a reason from the command, for staff", async () => {
    const t = setup();
    await t.postPanel({ "staff-role": { id: STAFF_ROLE_ID } });
    await t.openTicket();
    const [thread] = t.threads;
    const close = t.interaction({ subcommand: "close", userId: STRANGER_ID, roleIds: [STAFF_ROLE_ID], channelId: thread.id, options: { reason: "Fixed" } });
    await t.command.execute(close);
    expect(close.reply.mock.calls[0][0].content).toBe(`🔒 Ticket #1 closed by <@${STRANGER_ID}>. Reason: Fixed`);
    expect(t.tickets.byThread(thread.id)).toMatchObject({ closedBy: STRANGER_ID, closeReason: "Fixed" });
  });

  it("adds and removes people, but never the person who opened it", async () => {
    const t = setup();
    await t.postPanel();
    await t.openTicket();
    const [thread] = t.threads;
    const staff = (subcommand, userId) =>
      t.interaction({ subcommand, manageThreads: true, channelId: thread.id, options: { member: { id: userId } } });

    expect((await t.command.execute(staff("add", STRANGER_ID))).key).toBe("ticketAdded");
    expect(thread.members.add).toHaveBeenCalledWith(STRANGER_ID);
    expect((await t.command.execute(staff("remove", STRANGER_ID))).key).toBe("ticketRemoved");
    expect(thread.members.remove).toHaveBeenCalledWith(STRANGER_ID);
    expect((await t.command.execute(staff("remove", MEMBER_ID))).key).toBe("ticketCannotRemoveOwner");

    thread.members.add.mockRejectedValueOnce(new Error("Unknown"));
    expect((await t.command.execute(staff("add", STRANGER_ID))).key).toBe("ticketCannotAdd");

    const member = t.interaction({ subcommand: "add", userId: MEMBER_ID, channelId: thread.id, options: { member: { id: STRANGER_ID } } });
    expect((await t.command.execute(member)).key).toBe("ticketStaffOnly");
    const outside = t.interaction({ subcommand: "add", manageThreads: true, options: { member: { id: STRANGER_ID } } });
    expect((await t.command.execute(outside)).key).toBe("ticketNotATicket");
  });

  it("lists open tickets for staff", async () => {
    const t = setup();
    await t.postPanel();
    const empty = t.interaction({ subcommand: "list", manageThreads: true });
    expect((await t.command.execute(empty)).key).toBe("ticketsListEmpty");
    await t.openTicket();
    const list = t.interaction({ subcommand: "list", manageThreads: true });
    await t.command.execute(list);
    const { content, flags } = list.reply.mock.calls[0][0];
    expect(flags).toBe(MessageFlags.Ephemeral);
    expect(content).toContain("**Open tickets (1)**");
    expect(content).toContain(`#1 <#${t.threads[0].id}> · <@${MEMBER_ID}>`);
  });

  it("closes a ticket whose thread was deleted", async () => {
    const t = setup();
    await t.postPanel();
    await t.openTicket();
    t.command.threadDeleted({ id: t.threads[0].id });
    expect(t.tickets.byThread(t.threads[0].id)).toMatchObject({ closeReason: "Thread deleted" });
    // Other threads are ignored.
    expect(() => t.command.threadDeleted({ id: "819999999999999999" })).not.toThrow();
  });
});

describe("ticket store", () => {
  it("numbers tickets per server and lists a member's tickets", () => {
    const store = new TicketStore();
    const first = store.open({ guildId: GUILD_ID, userId: MEMBER_ID, subject: "a", createdAt: 1 });
    store.close(first.id, { closedBy: MEMBER_ID, closedAt: 2 });
    store.open({ guildId: GUILD_ID, userId: MEMBER_ID, subject: "b", createdAt: 3 });
    expect(store.open({ guildId: "900000000000000002", userId: MEMBER_ID, subject: "c" }).number).toBe(1);
    expect(store.listForUser(GUILD_ID, MEMBER_ID).map((ticket) => [ticket.number, ticket.closedAt])).toEqual([
      [2, null],
      [1, 2],
    ]);
    expect(store.countOpen(GUILD_ID)).toBe(1);
  });

  it("never opens two tickets for the same member", () => {
    const store = new TicketStore();
    expect(store.open({ guildId: GUILD_ID, userId: MEMBER_ID, subject: "a" })).toBeDefined();
    expect(store.open({ guildId: GUILD_ID, userId: MEMBER_ID, subject: "b" })).toBeUndefined();
  });

  it("finds tickets by number and searches by status and member, a page at a time", () => {
    const store = new TicketStore();
    for (let index = 0; index < 5; index += 1) {
      const ticket = store.open({ guildId: GUILD_ID, userId: index % 2 ? MEMBER_ID : STRANGER_ID, subject: `t${index}`, createdAt: index });
      if (index < 3) {
        store.close(ticket.id, { closedAt: 10 + index });
      }
    }
    expect(store.byNumber(GUILD_ID, 2)).toMatchObject({ subject: "t1", hasTranscript: false, messageCount: null });
    expect(store.search(GUILD_ID).map((ticket) => ticket.number)).toEqual([5, 4, 3, 2, 1]);
    expect(store.search(GUILD_ID, { status: "open" }).map((ticket) => ticket.number)).toEqual([5, 4]);
    expect(store.search(GUILD_ID, { status: "closed", userId: MEMBER_ID }).map((ticket) => ticket.number)).toEqual([2]);
    expect(store.search(GUILD_ID, { before: 4, limit: 2 }).map((ticket) => ticket.number)).toEqual([3, 2]);
    store.setTranscript(store.byNumber(GUILD_ID, 1).id, "hello", 1);
    expect(store.transcript(GUILD_ID, 1)).toBe("hello");
    expect(store.transcript(GUILD_ID, 2)).toBeUndefined();
  });
});

describe("ticket transcripts", () => {
  it("reads a long thread a page at a time, up to the limit", async () => {
    const all = fakeMessages(250);
    const thread = { messages: { fetch: fakeFetch(all) } };
    const messages = await fetchThreadMessages(thread);
    expect(messages).toHaveLength(250);
    expect(thread.messages.fetch).toHaveBeenCalledTimes(3);
    const capped = await fetchThreadMessages({ messages: { fetch: fakeFetch(fakeMessages(MAX_TRANSCRIPT_MESSAGES + 50)) } });
    expect(capped).toHaveLength(MAX_TRANSCRIPT_MESSAGES);
  });

  it("writes embeds and files, and the header", () => {
    const text = buildTicketTranscript({
      ticket: { number: 7, userId: MEMBER_ID, subject: "Help", createdAt: 0, closedAt: null },
      guildName: "RV",
      names: { [MEMBER_ID]: "rumbler" },
      messages: [
        {
          createdTimestamp: 1000,
          author: { id: "1", tag: "Bot" },
          content: "",
          embeds: [{ title: "Subject", description: "Help" }],
          attachments: new Map([["a", { name: "clip.mp4", url: "https://cdn.example/clip.mp4" }]]),
        },
      ],
    });
    expect(text).toContain(`Opened by rumbler (${MEMBER_ID})`);
    expect(text).toContain("1 message");
    expect(text).toContain("[embed] Subject: Help");
    expect(text).toContain("[file: clip.mp4 https://cdn.example/clip.mp4]");
    expect(text).not.toContain("Closed by");
  });
});
