import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildRaidCommandData, createRaidCommand } from "../src/commands/raid.js";
import { Status } from "../src/logs/actionLog.js";
import {
  applyLockdown,
  checkJoinGate,
  createRaidGuard,
  InvalidJoinGate,
  liftLockdown,
  normalizeJoinGate,
  planLockdown,
} from "../src/raid/raid.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const MEMBERS_ROLE = "700000000000000001";
const MODS_ROLE = "700000000000000002";
const BOT_ROLE = "700000000000000003";
const ADMIN_ID = "300000000000000001";
const NEW_ID = "300000000000000002";
const DAY = 24 * 60 * 60 * 1000;
const { SendMessages, ViewChannel, ManageChannels, ManageRoles, ManageMessages } = PermissionFlagsBits;

const bits = (...flags) => new PermissionsBitField(flags);
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

// A channel whose overwrites can be read and edited like discord.js's.
// `posting` lists the role IDs that can post there; `botCanEdit` whether the bot may change it.
function fakeChannel(id, { type = ChannelType.GuildText, posting = [], overwrites = {}, botCanEdit = true, failEdits = false } = {}) {
  const cache = new Map(Object.entries(overwrites).map(([target, { allow = [], deny = [] }]) => [target, { allow: bits(...allow), deny: bits(...deny) }]));
  const channel = {
    id,
    type,
    permissionOverwrites: {
      cache,
      edit: vi.fn(async (target, changes) => {
        if (failEdits) {
          throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
        }
        const current = cache.get(target) ?? { allow: bits(), deny: bits() };
        const allow = new PermissionsBitField(current.allow);
        const deny = new PermissionsBitField(current.deny);
        for (const [name, value] of Object.entries(changes)) {
          const bit = PermissionFlagsBits[name];
          allow.remove(bit);
          deny.remove(bit);
          if (value === true) allow.add(bit);
          if (value === false) deny.add(bit);
        }
        cache.set(target, { allow, deny });
      }),
    },
    permissionsFor: (who) => {
      if (who.id === "bot") {
        return botCanEdit ? bits(ManageChannels, ManageRoles, ViewChannel, SendMessages) : bits(ViewChannel);
      }
      return posting.includes(who.id) ? bits(ViewChannel, SendMessages) : bits(ViewChannel);
    },
  };
  return channel;
}

function fakeGuild(channels) {
  const roles = [
    { id: GUILD_ID, managed: false, permissions: bits(SendMessages) },
    { id: MEMBERS_ROLE, managed: false, permissions: bits(SendMessages) },
    { id: MODS_ROLE, managed: false, permissions: bits(ManageMessages) },
    { id: BOT_ROLE, managed: true, permissions: bits(ManageChannels) },
  ];
  const guild = {
    id: GUILD_ID,
    preferredLocale: "en-US",
    roles: { cache: new Map(roles.map((role) => [role.id, role])) },
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    members: { me: { id: "bot" } },
    systemChannel: null,
    client: { user: { id: "100000000000000001", tag: "Rumble Bot" } },
  };
  return guild;
}

describe("raid settings", () => {
  it("normalizes and checks the join gate", () => {
    expect(normalizeJoinGate(undefined)).toEqual({ minAgeDays: null, action: "kick", alertJoins: null });
    expect(normalizeJoinGate({ minAgeDays: 9999, action: "ban", alertJoins: 2 })).toEqual({ minAgeDays: null, action: "kick", alertJoins: null });
    expect(checkJoinGate({ minAgeDays: 7, action: "alert", alertJoins: null })).toEqual({ minAgeDays: 7, action: "alert", alertJoins: null });
    expect(checkJoinGate({ minAgeDays: null, action: "kick", alertJoins: null })).toBeNull();
    expect(() => checkJoinGate({ minAgeDays: 0, action: "kick", alertJoins: null })).toThrow(InvalidJoinGate);
    expect(() => checkJoinGate({ minAgeDays: 3, action: "ban", alertJoins: null })).toThrow(InvalidJoinGate);
    expect(() => checkJoinGate({ minAgeDays: null, action: "kick", alertJoins: 1 })).toThrow(InvalidJoinGate);
  });
});

describe("lockdown", () => {
  it("locks channels members can post in, including roles with their own allow, and leaves staff alone", async () => {
    const general = fakeChannel("800000000000000001", { posting: [GUILD_ID, MEMBERS_ROLE] });
    // A members-only channel: @everyone can't see it, the Members role is allowed.
    const chat = fakeChannel("800000000000000002", {
      posting: [MEMBERS_ROLE, MODS_ROLE],
      overwrites: { [GUILD_ID]: { deny: [ViewChannel] }, [MEMBERS_ROLE]: { allow: [ViewChannel, SendMessages] }, [MODS_ROLE]: { allow: [SendMessages] } },
    });
    const staffOnly = fakeChannel("800000000000000003", { posting: [MODS_ROLE] });
    const voice = fakeChannel("800000000000000004", { type: ChannelType.GuildVoice, posting: [GUILD_ID] });
    const locked = fakeChannel("800000000000000005", { posting: [GUILD_ID], botCanEdit: false });
    const guild = fakeGuild([general, chat, staffOnly, voice, locked]);
    const guildSettings = new GuildSettings();

    const plan = planLockdown(guild, guildSettings);
    expect(plan.skipped).toBe(1);
    expect(plan.channels.map((entry) => entry.id)).toEqual([general.id, chat.id]);
    expect(plan.channels[1].targets.map((target) => target.id)).toEqual([GUILD_ID, MEMBERS_ROLE]);
    expect(plan.channels[1].targets[1].previous).toEqual({ SendMessages: true, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null });

    const done = await applyLockdown(guild, plan.channels, "test");
    expect(done).toHaveLength(2);
    expect(chat.permissionOverwrites.cache.get(MEMBERS_ROLE).deny.has(SendMessages)).toBe(true);
    // Its view permission is untouched.
    expect(chat.permissionOverwrites.cache.get(MEMBERS_ROLE).allow.has(ViewChannel)).toBe(true);
    expect(chat.permissionOverwrites.cache.get(MODS_ROLE).allow.has(SendMessages)).toBe(true);

    // Ending puts everything back exactly.
    expect(await liftLockdown(guild, { channels: done }, "test")).toEqual({ restored: 2, failed: 0 });
    expect(chat.permissionOverwrites.cache.get(MEMBERS_ROLE).allow.has(SendMessages)).toBe(true);
    expect(chat.permissionOverwrites.cache.get(MEMBERS_ROLE).deny.has(SendMessages)).toBe(false);
    expect(general.permissionOverwrites.cache.get(GUILD_ID).deny.has(SendMessages)).toBe(false);
  });

  it("treats the mod role as staff even without staff permissions", () => {
    const guild = fakeGuild([fakeChannel("800000000000000001", { posting: [MEMBERS_ROLE], overwrites: { [MEMBERS_ROLE]: { allow: [SendMessages] } } })]);
    const guildSettings = new GuildSettings();
    guildSettings.set(GUILD_ID, Setting.MOD_ROLE, MEMBERS_ROLE);
    expect(planLockdown(guild, guildSettings).channels).toEqual([]);
  });

  it("skips a channel whose edit fails, and skips deleted channels when lifting", async () => {
    const good = fakeChannel("800000000000000001", { posting: [GUILD_ID] });
    const bad = fakeChannel("800000000000000002", { posting: [GUILD_ID], failEdits: true });
    const guild = fakeGuild([good, bad]);
    const plan = planLockdown(guild, new GuildSettings());
    const done = await applyLockdown(guild, plan.channels, "test");
    expect(done.map((entry) => entry.id)).toEqual([good.id]);
    guild.channels.cache.delete(good.id);
    expect(await liftLockdown(guild, { channels: done }, "test")).toEqual({ restored: 0, failed: 0 });
  });
});

describe("/raid", () => {
  function setup(channels = [fakeChannel("800000000000000001", { posting: [GUILD_ID] })]) {
    const guild = fakeGuild(channels);
    const guildSettings = new GuildSettings();
    const posts = [];
    const modLog = { post: vi.fn(async (_guild, build) => posts.push(build({ canAttach: true }))) };
    const command = createRaidCommand({ guildSettings, modLog, forcedLanguage: undefined, now: () => 5_000_000 });
    const run = async (subcommand, { options = {}, manageChannels = true, manageGuild = false } = {}) => {
      const permissions = new Set([manageChannels && ManageChannels, manageGuild && PermissionFlagsBits.ManageGuild]);
      const interaction = {
        locale: "en-US",
        guildId: GUILD_ID,
        guild,
        user: { id: ADMIN_ID, tag: "moe" },
        member: { roles: { cache: new Map() } },
        memberPermissions: { has: (bit) => permissions.has(bit) },
        inCachedGuild: () => true,
        deferred: false,
        replied: false,
        options: {
          getSubcommand: () => subcommand,
          getString: (name) => options[name] ?? null,
          getInteger: (name) => options[name] ?? null,
        },
        reply: vi.fn(async () => {}),
        deferReply: vi.fn(async () => {
          interaction.deferred = true;
        }),
        editReply: vi.fn(async () => {}),
      };
      const outcome = await command.execute(interaction);
      const text = (interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1))[0].content;
      return { outcome, text };
    };
    return { guild, guildSettings, posts, run, channels };
  }

  it("registers for people who can manage channels", () => {
    const data = buildRaidCommandData();
    expect(data.default_member_permissions).toBe(String(ManageChannels));
    expect(data.options.map((option) => option.name)).toEqual(["lockdown", "end", "status", "gate", "gate-off", "alert"]);
  });

  it("locks down, refuses a second lockdown, and ends it", async () => {
    const t = setup();
    const locked = await t.run("lockdown", { options: { reason: "Bot raid" } });
    expect(locked.outcome).toMatchObject({ status: Status.SUCCESS, key: "raidLockdownDone" });
    expect(locked.text).toContain("1 channels locked");
    expect(t.guildSettings.get(GUILD_ID, Setting.LOCKDOWN)).toMatchObject({ by: ADMIN_ID, reason: "Bot raid", channels: [{ id: "800000000000000001" }] });
    expect(t.posts[0].embed.data.description).toContain("Raid lockdown");

    expect((await t.run("lockdown")).outcome.key).toBe("raidLockdownAlready");
    expect((await t.run("status")).text).toContain("on since");

    const ended = await t.run("end");
    expect(ended.outcome.key).toBe("raidEndDone");
    expect(t.guildSettings.get(GUILD_ID, Setting.LOCKDOWN)).toBeUndefined();
    expect((await t.run("end")).outcome.key).toBe("raidNotLocked");
  });

  it("says when there's nothing to lock or the bot can't", async () => {
    expect((await setup([fakeChannel("800000000000000001", { posting: [MODS_ROLE] })]).run("lockdown")).outcome.key).toBe("raidNothingToLock");
    expect((await setup([fakeChannel("800000000000000001", { posting: [GUILD_ID], botCanEdit: false })]).run("lockdown")).outcome.key).toBe(
      "raidLockdownBotMissingPermission",
    );
  });

  it("needs Manage Server for the gate and alerts, and saves them", async () => {
    const t = setup();
    expect((await t.run("gate", { options: { "min-age": 7 } })).outcome.key).toBe("raidNeedsManageGuild");
    expect((await t.run("gate", { options: { "min-age": 7 }, manageGuild: true })).outcome.key).toBe("raidGateSet");
    expect((await t.run("alert", { options: { joins: 2 }, manageGuild: true })).outcome.key).toBe("raidAlertTooLow");
    expect((await t.run("alert", { options: { joins: 10 }, manageGuild: true })).outcome.key).toBe("raidAlertSet");
    expect(t.guildSettings.get(GUILD_ID, Setting.JOIN_GATE)).toEqual({ minAgeDays: 7, action: "kick", alertJoins: 10 });
    expect((await t.run("status")).text).toContain("kicks accounts younger than 7 days");
    await t.run("gate-off", { manageGuild: true });
    await t.run("alert", { options: { joins: 0 }, manageGuild: true });
    expect(t.guildSettings.get(GUILD_ID, Setting.JOIN_GATE)).toBeUndefined();
  });

  it("refuses lockdown without Manage Channels or the mod role", async () => {
    const t = setup();
    expect((await t.run("lockdown", { manageChannels: false })).outcome.key).toBe("modNoPermission");
  });
});

describe("raid guard", () => {
  function setup(gate) {
    let clock = 100 * DAY;
    const guildSettings = new GuildSettings();
    if (gate) {
      guildSettings.set(GUILD_ID, Setting.JOIN_GATE, gate);
    }
    const posts = [];
    const modLog = { post: vi.fn(async (_guild, build) => posts.push(build({ canAttach: true }))) };
    const moderation = { kick: vi.fn(async () => ({})) };
    const guard = createRaidGuard({ guildSettings, moderation, modLog, logger, now: () => clock });
    const guild = fakeGuild([]);
    const member = (ageDays, { id = NEW_ID, kickable = true, bot = false } = {}) => ({
      id,
      guild,
      kickable,
      client: guild.client,
      user: { id, tag: "newbie", bot, createdTimestamp: clock - ageDays * DAY },
    });
    return { guard, posts, moderation, member, advance: (ms) => (clock += ms) };
  }

  it("kicks accounts younger than the minimum, with a reason, and leaves older ones", async () => {
    const t = setup({ minAgeDays: 7, action: "kick" });
    await t.guard.memberJoined(t.member(2));
    expect(t.moderation.kick).toHaveBeenCalledWith(expect.objectContaining({ reason: "Join gate: account is 2 days old (minimum 7)" }));
    await t.guard.memberJoined(t.member(30));
    await t.guard.memberJoined(t.member(0, { bot: true }));
    expect(t.moderation.kick).toHaveBeenCalledTimes(1);
  });

  it("only alerts in alert mode, or when the member can't be kicked", async () => {
    const t = setup({ minAgeDays: 7, action: "alert" });
    await t.guard.memberJoined(t.member(1));
    expect(t.moderation.kick).not.toHaveBeenCalled();
    expect(t.posts[0].embed.data.description).toContain("New account joined");
    const k = setup({ minAgeDays: 7, action: "kick" });
    await k.guard.memberJoined(k.member(1, { kickable: false }));
    expect(k.posts[0].embed.data.description).toContain("couldn't be kicked");
  });

  it("alerts once when many join within a minute", async () => {
    const t = setup({ alertJoins: 3 });
    for (let index = 0; index < 5; index += 1) {
      await t.guard.memberJoined(t.member(400, { id: `30000000000000010${index}` }));
      t.advance(1000);
    }
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].embed.data.description).toContain("3 members joined in the last minute");
    // Slow joins never alert.
    const slow = setup({ alertJoins: 3 });
    for (let index = 0; index < 5; index += 1) {
      await slow.guard.memberJoined(slow.member(400));
      slow.advance(40_000);
    }
    expect(slow.posts).toHaveLength(0);
  });
});
