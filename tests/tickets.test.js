import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildTicketsCommandData, createTicketsCommand } from "../src/commands/tickets.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { CLOSE_BUTTON, FORM_ID, MAX_OPEN_TICKETS, OPEN_BUTTON, threadName } from "../src/tickets/tickets.js";
import { TicketStore } from "../src/tickets/ticketStore.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const ADMIN_ID = "300000000000000001";
const MEMBER_ID = "300000000000000002";
const STRANGER_ID = "300000000000000003";
const STAFF_ROLE_ID = "700000000000000001";
const MOD_ROLE_ID = "700000000000000002";

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

function setup({ canPost = true, mentionable = true, staffMembers = [] } = {}) {
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
    members: { me: { permissions: { has: () => false } } },
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
  const command = createTicketsCommand({ tickets, guildSettings, logger, forcedLanguage: undefined, now: () => clock });

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
});
