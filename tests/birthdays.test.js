import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  birthdaySettings,
  createBirthdays,
  datesCelebrated,
  daysUntil,
  formatBirthday,
  isValidDate,
  isValidTimeZone,
  todayIn,
} from "../src/birthdays/birthdays.js";
import { BirthdayStore } from "../src/birthdays/birthdayStore.js";
import { buildBirthdayCommandData, createBirthdayCommand } from "../src/commands/birthday.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000001";
const ALICE = "300000000000000001";
const BOB = "300000000000000002";
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const at = (iso) => Date.parse(iso);

describe("dates", () => {
  it("checks dates and time zones", () => {
    expect(isValidDate(2, 29)).toBe(true);
    expect(isValidDate(2, 30)).toBe(false);
    expect(isValidDate(4, 31)).toBe(false);
    expect(isValidDate(13, 1)).toBe(false);
    expect(isValidTimeZone("America/Toronto")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("knows today's date in a time zone", () => {
    const now = at("2026-03-15T03:00:00Z");
    expect(todayIn("UTC", now)).toMatchObject({ month: 3, day: 15, key: "2026-03-15" });
    expect(todayIn("America/Toronto", now)).toMatchObject({ month: 3, day: 14, key: "2026-03-14" });
  });

  it("celebrates 29 February on the 28th in other years", () => {
    expect(datesCelebrated({ year: 2027, month: 2, day: 28 })).toEqual([
      [2, 28],
      [2, 29],
    ]);
    expect(datesCelebrated({ year: 2028, month: 2, day: 28 })).toEqual([[2, 28]]);
  });

  it("counts the days until the next birthday", () => {
    const today = { year: 2026, month: 12, day: 30 };
    expect(daysUntil({ month: 12, day: 30 }, today)).toBe(0);
    expect(daysUntil({ month: 1, day: 2 }, today)).toBe(3);
    expect(daysUntil({ month: 2, day: 29 }, { year: 2027, month: 2, day: 1 })).toBe(27);
  });

  it("writes the date in the reader's language", () => {
    expect(formatBirthday("en", { month: 3, day: 15 })).toBe("March 15");
    expect(formatBirthday("fr", { month: 3, day: 15 })).toBe("15 mars");
  });
});

describe("BirthdayStore", () => {
  it("saves, changes, finds and forgets birthdays", () => {
    const store = new BirthdayStore();
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 3, day: 15 });
    store.markCelebrated(GUILD_ID, ALICE, "2026-03-15");
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 3, day: 16 });
    expect(store.get(GUILD_ID, ALICE)).toMatchObject({ month: 3, day: 16, celebratedOn: "2026-03-15" });
    store.set({ guildId: GUILD_ID, userId: BOB, month: 1, day: 1 });
    expect(store.all(GUILD_ID).map((birthday) => birthday.userId)).toEqual([BOB, ALICE]);
    expect(store.on(GUILD_ID, 3, 16).map((birthday) => birthday.userId)).toEqual([ALICE]);
    store.markRole(GUILD_ID, BOB, "2026-01-01");
    expect(store.withRole(GUILD_ID).map((birthday) => birthday.userId)).toEqual([BOB]);
    expect(store.remove(GUILD_ID, BOB)).toBe(true);
    expect(store.remove(GUILD_ID, BOB)).toBe(false);
    expect(store.count(GUILD_ID)).toBe(1);
  });
});

function fakeGuild(memberIds) {
  const send = vi.fn(async () => {});
  const members = new Map(
    memberIds.map((id) => {
      const roles = new Set();
      const member = {
        id,
        roles: {
          cache: { has: (roleId) => roles.has(roleId) },
          add: vi.fn(async (roleId) => roles.add(roleId)),
          remove: vi.fn(async (roleId) => roles.delete(roleId)),
        },
      };
      return [id, member];
    }),
  );
  const guild = {
    id: GUILD_ID,
    name: "Rumbleverse",
    preferredLocale: "en-US",
    channels: { cache: new Map([[CHANNEL_ID, { id: CHANNEL_ID, isTextBased: () => true, send }]]) },
    members: { fetch: vi.fn(async (id) => members.get(id) ?? Promise.reject(new Error("Unknown Member"))) },
  };
  return { guild, members, send };
}

function setup({ settings = { channelId: CHANNEL_ID, roleId: ROLE_ID, message: null, timezone: "UTC" }, memberIds = [ALICE, BOB] } = {}) {
  const guildSettings = new GuildSettings();
  if (settings) {
    guildSettings.set(GUILD_ID, Setting.BIRTHDAYS, settings);
  }
  const store = new BirthdayStore();
  const { guild, members, send } = fakeGuild(memberIds);
  let now = at("2026-03-15T00:01:00Z");
  const birthdays = createBirthdays({
    client: { guilds: { cache: new Map([[GUILD_ID, guild]]) } },
    guildSettings,
    store,
    logger,
    now: () => now,
  });
  return { guildSettings, store, members, send, birthdays, setNow: (iso) => (now = at(iso)) };
}

describe("the birthday check", () => {
  it("greets everyone born today once, gives the role and takes it back the next day", async () => {
    const { store, members, send, birthdays, setNow } = setup();
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 3, day: 15 });
    store.set({ guildId: GUILD_ID, userId: BOB, month: 3, day: 15 });

    await birthdays.sweep();
    await birthdays.sweep();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: `🎂 Happy birthday, <@${ALICE}> and <@${BOB}>! Have a great day!`,
      allowedMentions: { users: [ALICE, BOB] },
    });
    expect(members.get(ALICE).roles.add).toHaveBeenCalledWith(ROLE_ID, "Happy birthday!");

    setNow("2026-03-16T00:01:00Z");
    await birthdays.sweep();
    expect(members.get(ALICE).roles.remove).toHaveBeenCalledWith(ROLE_ID, "Their birthday is over");
    expect(store.withRole(GUILD_ID)).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits for the day to start in the server's time zone, and uses the server's message", async () => {
    const { store, send, birthdays, setNow } = setup({
      settings: { channelId: CHANNEL_ID, roleId: null, message: "Happy birthday {user} from {server}!", timezone: "America/Toronto" },
    });
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 3, day: 15 });
    await birthdays.sweep();
    expect(send).not.toHaveBeenCalled();
    setNow("2026-03-15T04:30:00Z");
    await birthdays.sweep();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: `Happy birthday <@${ALICE}> from Rumbleverse!` }));
  });

  it("celebrates 29 February birthdays on the 28th, and skips members who left", async () => {
    const { store, send, birthdays, setNow } = setup({ memberIds: [ALICE] });
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 2, day: 29 });
    store.set({ guildId: GUILD_ID, userId: BOB, month: 2, day: 28 });
    setNow("2027-02-28T12:00:00Z");
    await birthdays.sweep();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { users: [ALICE] } }));
  });

  it("does nothing when birthdays are off", async () => {
    const { store, send, birthdays } = setup({ settings: null });
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 3, day: 15 });
    await birthdays.sweep();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("/birthday", () => {
  function interactionFor({ subcommand, options = {}, manage = false, me = true, botCanPost = true }) {
    const granted = new PermissionsBitField(manage ? [PermissionFlagsBits.ManageGuild] : []);
    const bot = { id: "bot", roles: { highest: { position: 10 } } };
    return {
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, ownerId: "owner", members: { me: me ? bot : null } },
      member: { id: ALICE, roles: { highest: { position: 20 } } },
      user: { id: ALICE },
      locale: "en-US",
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => granted.has(bit) },
      options: {
        getSubcommand: () => subcommand,
        getInteger: (name) => options[name] ?? null,
        getUser: (name) => options[name] ?? null,
        getRole: (name) => options[name] ?? null,
        getString: (name) => options[name] ?? null,
        getFocused: () => options.focused ?? "",
        getChannel: (name) =>
          options[name]
            ? {
                id: options[name],
                permissionsFor: () =>
                  new PermissionsBitField(botCanPost ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] : []),
              }
            : null,
      },
      reply: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
    };
  }

  it("builds its subcommands", () => {
    expect(buildBirthdayCommandData().options.map((option) => option.name)).toEqual(["set", "remove", "show", "upcoming", "setup", "off"]);
  });

  it("saves, shows and forgets a member's own birthday", async () => {
    const guildSettings = new GuildSettings();
    const store = new BirthdayStore();
    const command = createBirthdayCommand({ guildSettings, store });
    expect((await command.execute(interactionFor({ subcommand: "set", options: { month: 2, day: 30 } }))).key).toBe("birthdayBadDate");
    expect(await command.execute(interactionFor({ subcommand: "set", options: { month: 3, day: 15 } }))).toMatchObject({
      status: Status.SUCCESS,
      key: "birthdaySavedOff",
      values: { date: "March 15" },
    });
    expect(store.get(GUILD_ID, ALICE)).toMatchObject({ month: 3, day: 15 });
    expect((await command.execute(interactionFor({ subcommand: "show" }))).key).toBe("birthdayShow");
    expect((await command.execute(interactionFor({ subcommand: "remove" }))).key).toBe("birthdayRemoved");
    expect(store.get(GUILD_ID, ALICE)).toBeUndefined();
  });

  it("needs Manage Server to remove someone else's birthday", async () => {
    const store = new BirthdayStore();
    store.set({ guildId: GUILD_ID, userId: BOB, month: 1, day: 1 });
    const command = createBirthdayCommand({ guildSettings: new GuildSettings(), store });
    const bob = { id: BOB };
    expect((await command.execute(interactionFor({ subcommand: "remove", options: { user: bob } }))).key).toBe("birthdayNeedsManageGuild");
    expect((await command.execute(interactionFor({ subcommand: "remove", options: { user: bob }, manage: true }))).status).toBe(Status.SUCCESS);
  });

  it("lists upcoming birthdays, soonest first", async () => {
    const store = new BirthdayStore();
    store.set({ guildId: GUILD_ID, userId: ALICE, month: 1, day: 5 });
    store.set({ guildId: GUILD_ID, userId: BOB, month: 12, day: 31 });
    const command = createBirthdayCommand({ guildSettings: new GuildSettings(), store, now: () => at("2026-12-31T12:00:00Z") });
    const interaction = interactionFor({ subcommand: "upcoming" });
    await command.execute(interaction);
    expect(interaction.reply.mock.calls[0][0].content).toBe(
      `**Upcoming birthdays**\n• December 31: <@${BOB}> 🎂 today\n• January 5: <@${ALICE}>`,
    );
  });

  it("sets up and turns off, keeping what isn't changed", async () => {
    const guildSettings = new GuildSettings();
    const command = createBirthdayCommand({ guildSettings, store: new BirthdayStore() });
    expect((await command.execute(interactionFor({ subcommand: "setup", options: { channel: CHANNEL_ID } }))).key).toBe(
      "birthdayNeedsManageGuild",
    );
    expect((await command.execute(interactionFor({ subcommand: "setup", manage: true }))).key).toBe("birthdayNeedsChannelOrRole");
    expect(
      (await command.execute(interactionFor({ subcommand: "setup", manage: true, options: { channel: CHANNEL_ID, timezone: "Nowhere/City" } }))).key,
    ).toBe("birthdayBadTimezone");
    expect(
      (await command.execute(interactionFor({ subcommand: "setup", manage: true, options: { channel: CHANNEL_ID }, botCanPost: false }))).key,
    ).toBe("birthdayBotCantPost");
    const modRole = { id: ROLE_ID, managed: false, position: 1, permissions: new PermissionsBitField([PermissionFlagsBits.KickMembers]) };
    expect((await command.execute(interactionFor({ subcommand: "setup", manage: true, options: { role: modRole } }))).key).toBe(
      "birthdayBadRole",
    );

    await command.execute(interactionFor({ subcommand: "setup", manage: true, options: { channel: CHANNEL_ID, timezone: "Europe/London" } }));
    const role = { id: ROLE_ID, managed: false, position: 1, permissions: new PermissionsBitField() };
    await command.execute(interactionFor({ subcommand: "setup", manage: true, options: { role } }));
    expect(birthdaySettings(guildSettings, GUILD_ID)).toEqual({ channelId: CHANNEL_ID, roleId: ROLE_ID, message: null, timezone: "Europe/London" });

    expect((await command.execute(interactionFor({ subcommand: "off", manage: true }))).key).toBe("birthdayOffDone");
    expect(birthdaySettings(guildSettings, GUILD_ID)).toBeUndefined();
  });

  it("suggests time zones", async () => {
    const command = createBirthdayCommand({ guildSettings: new GuildSettings(), store: new BirthdayStore() });
    const interaction = interactionFor({ options: { focused: "toronto" } });
    await command.autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "America/Toronto", value: "America/Toronto" }]);
  });
});
