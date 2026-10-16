import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildLevelsCommandData, createLevelCommands, progressBar } from "../src/commands/levels.js";
import {
  checkLeveling,
  InvalidLeveling,
  levelForXp,
  levelProgress,
  normalizeLeveling,
  totalXpForLevel,
  XP_COOLDOWN_MS,
  xpToNextLevel,
} from "../src/leveling/config.js";
import { createLeveling, fillLevelMessage, rewardRolesFor } from "../src/leveling/leveling.js";
import { LevelStore } from "../src/leveling/levelStore.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const CATEGORY_ID = "800000000000000009";
const MEMBER_ID = "300000000000000002";
const ADMIN_ID = "300000000000000001";
const ROLE_5 = "700000000000000005";
const ROLE_10 = "700000000000000010";
const MUTED_ROLE = "700000000000000099";

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

describe("level math", () => {
  it("needs a little more XP for each level", () => {
    expect([0, 1, 2, 3].map(xpToNextLevel)).toEqual([100, 155, 220, 295]);
    expect(totalXpForLevel(0)).toBe(0);
    expect(totalXpForLevel(2)).toBe(255);
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(99)).toBe(0);
    expect(levelForXp(100)).toBe(1);
    expect(levelForXp(255)).toBe(2);
    expect(levelProgress(300)).toEqual({ level: 2, current: 45, needed: 220 });
    for (const level of [5, 17, 60]) {
      expect(levelForXp(totalXpForLevel(level))).toBe(level);
      expect(levelForXp(totalXpForLevel(level) - 1)).toBe(level - 1);
    }
  });

  it("draws a progress bar", () => {
    expect(progressBar(0, 100)).toBe("▱▱▱▱▱▱▱▱▱▱▱▱ 0%");
    expect(progressBar(50, 100)).toBe("▰▰▰▰▰▰▱▱▱▱▱▱ 50%");
    expect(progressBar(100, 100)).toBe("▰▰▰▰▰▰▰▰▰▰▰▰ 100%");
  });
});

describe("leveling settings", () => {
  it("fills in defaults and drops bad values", () => {
    expect(normalizeLeveling(undefined)).toMatchObject({ enabled: false, announce: "here", rewards: [], stackRewards: true });
    const config = normalizeLeveling({
      enabled: true,
      announce: "everywhere",
      rewards: [
        { level: 10, roleId: ROLE_10 },
        { level: 5, roleId: ROLE_5 },
        { level: 5, roleId: "700000000000000006" },
        { level: 0, roleId: "700000000000000007" },
        { level: 7, roleId: ROLE_5 },
      ],
      noXpChannelIds: [CHANNEL_ID, CHANNEL_ID, "nope"],
    });
    expect(config.announce).toBe("here");
    expect(config.rewards).toEqual([
      { level: 5, roleId: ROLE_5 },
      { level: 10, roleId: ROLE_10 },
    ]);
    expect(config.noXpChannelIds).toEqual([CHANNEL_ID]);
  });

  it("checks dashboard input strictly", () => {
    const server = { isRole: (id) => id !== GUILD_ID, isRewardRole: (id) => id === ROLE_5 || id === ROLE_10, isChannel: (id) => id === CHANNEL_ID };
    const valid = {
      enabled: true,
      announce: "channel",
      announceChannelId: CHANNEL_ID,
      message: "GG {user}, level {level}!",
      rewards: [{ level: 5, roleId: ROLE_5 }],
      stackRewards: false,
      noXpChannelIds: [],
      noXpRoleIds: [MUTED_ROLE],
    };
    expect(checkLeveling(valid, server)).toMatchObject({ enabled: true, announceChannelId: CHANNEL_ID, stackRewards: false });
    expect(checkLeveling({ ...valid, announce: "dm" }, server).announceChannelId).toBeNull();
    expect(() => checkLeveling({ ...valid, announceChannelId: OTHER_CHANNEL_ID }, server)).toThrow(InvalidLeveling);
    expect(() => checkLeveling({ ...valid, rewards: [{ level: 5, roleId: MUTED_ROLE }] }, server)).toThrow(InvalidLeveling);
    expect(() => checkLeveling({ ...valid, rewards: [{ level: 5, roleId: ROLE_5 }, { level: 5, roleId: ROLE_10 }] }, server)).toThrow(
      "once",
    );
    expect(() => checkLeveling({ ...valid, message: "x".repeat(501) }, server)).toThrow(InvalidLeveling);
    expect(() => checkLeveling({ ...valid, enabled: "yes" }, server)).toThrow(InvalidLeveling);
  });

  it("picks reward roles, stacked or only the highest", () => {
    const rewards = [
      { level: 5, roleId: ROLE_5 },
      { level: 10, roleId: ROLE_10 },
    ];
    expect(rewardRolesFor({ rewards, stackRewards: true }, 12)).toEqual([ROLE_5, ROLE_10]);
    expect(rewardRolesFor({ rewards, stackRewards: false }, 12)).toEqual([ROLE_10]);
    expect(rewardRolesFor({ rewards, stackRewards: false }, 4)).toEqual([]);
  });

  it("fills in the level-up message", () => {
    const text = fillLevelMessage("{user} ({username}) hit {level} in {server}", {
      member: { id: MEMBER_ID, displayName: "Champ" },
      level: 3,
      guild: { name: "RV" },
    });
    expect(text).toBe(`<@${MEMBER_ID}> (Champ) hit 3 in RV`);
  });
});

describe("level store", () => {
  it("awards XP at most once per cooldown and ranks members", () => {
    const store = new LevelStore();
    const award = (userId, amount, now) => store.award({ guildId: GUILD_ID, userId, userTag: "x", amount, now, cooldownMs: XP_COOLDOWN_MS });
    expect(award(MEMBER_ID, 20, 1_000_000)).toEqual({ before: 0, after: 20 });
    expect(award(MEMBER_ID, 20, 1_000_000 + 1000)).toBeUndefined();
    expect(award(MEMBER_ID, 15, 1_000_000 + XP_COOLDOWN_MS)).toEqual({ before: 20, after: 35 });
    award(ADMIN_ID, 25, 1_000_000);
    expect(store.get(GUILD_ID, MEMBER_ID)).toMatchObject({ xp: 35, messages: 2 });
    expect(store.rank(GUILD_ID, MEMBER_ID)).toBe(1);
    expect(store.rank(GUILD_ID, ADMIN_ID)).toBe(2);
    expect(store.top(GUILD_ID).map((entry) => entry.userId)).toEqual([MEMBER_ID, ADMIN_ID]);
    expect(store.count(GUILD_ID)).toBe(2);
    store.setXp(GUILD_ID, ADMIN_ID, 500);
    expect(store.rank(GUILD_ID, ADMIN_ID)).toBe(1);
    expect(store.reset(GUILD_ID, ADMIN_ID)).toBe(true);
    expect(store.rank(GUILD_ID, ADMIN_ID)).toBeUndefined();
  });
});

function fakeRole(id, { editable = true, position = 1 } = {}) {
  return { id, editable, position, managed: false, permissions: { has: () => false } };
}

function setup({ config = {}, roles = [fakeRole(ROLE_5), fakeRole(ROLE_10)] } = {}) {
  let clock = 10_000_000;
  const guildSettings = new GuildSettings();
  guildSettings.set(GUILD_ID, Setting.LEVELING, { enabled: true, ...config });
  const store = new LevelStore();
  const sent = [];
  const channel = {
    id: CHANNEL_ID,
    parentId: CATEGORY_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async (payload) => sent.push({ channel: CHANNEL_ID, ...payload })),
  };
  const otherChannel = { ...channel, id: OTHER_CHANNEL_ID, send: vi.fn(async (payload) => sent.push({ channel: OTHER_CHANNEL_ID, ...payload })) };
  const guild = {
    id: GUILD_ID,
    name: "RV",
    preferredLocale: "en-US",
    roles: { cache: new Map(roles.map((role) => [role.id, role])) },
    channels: { cache: new Map([[CHANNEL_ID, channel], [OTHER_CHANNEL_ID, otherChannel]]) },
    members: { me: {} },
  };
  const memberRoles = new Map();
  const member = {
    id: MEMBER_ID,
    guild,
    displayName: "Champ",
    user: { id: MEMBER_ID, username: "champ", bot: false },
    roles: {
      cache: memberRoles,
      add: vi.fn(async (ids) => ids.forEach((id) => memberRoles.set(id, {}))),
      remove: vi.fn(async (ids) => ids.forEach((id) => memberRoles.delete(id))),
    },
    send: vi.fn(async (payload) => sent.push({ channel: "dm", ...payload })),
  };
  // Always the most XP per message (25), so the numbers are predictable.
  const leveling = createLeveling({ guildSettings, store, logger, random: (max) => max - 1, now: () => clock });
  const message = (overrides = {}) => ({
    inGuild: () => true,
    guildId: GUILD_ID,
    guild,
    channel,
    member,
    author: member.user,
    webhookId: null,
    system: false,
    ...overrides,
  });
  // Sends messages a minute apart until the member has at least `xp`.
  async function chatUntil(xp) {
    let outcome;
    while ((store.get(GUILD_ID, MEMBER_ID)?.xp ?? 0) < xp) {
      outcome = await leveling.handleMessage(message());
      clock += XP_COOLDOWN_MS;
    }
    return outcome;
  }
  return { guildSettings, store, leveling, message, member, guild, sent, chatUntil, advance: (ms) => (clock += ms) };
}

describe("earning XP", () => {
  it("gives XP once a minute and announces level-ups in the channel", async () => {
    const t = setup();
    expect(await t.leveling.handleMessage(t.message())).toMatchObject({ xp: 25, level: 0, leveledUp: false });
    expect(await t.leveling.handleMessage(t.message())).toBeUndefined();
    t.advance(XP_COOLDOWN_MS);
    await t.chatUntil(100);
    expect(t.store.get(GUILD_ID, MEMBER_ID).xp).toBe(100);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      channel: CHANNEL_ID,
      content: `🎉 <@${MEMBER_ID}> reached level **1**!`,
      allowedMentions: { users: [MEMBER_ID] },
    });
  });

  it("does nothing when leveling is off, for bots, or in no-XP channels and roles", async () => {
    const off = setup({ config: { enabled: false } });
    expect(await off.leveling.handleMessage(off.message())).toBeUndefined();

    const t = setup({ config: { noXpChannelIds: [CATEGORY_ID], noXpRoleIds: [MUTED_ROLE] } });
    expect(await t.leveling.handleMessage(t.message())).toBeUndefined();
    expect(await t.leveling.handleMessage(t.message({ author: { bot: true } }))).toBeUndefined();
    const elsewhere = { id: OTHER_CHANNEL_ID, parentId: null };
    expect(await t.leveling.handleMessage(t.message({ channel: elsewhere }))).toMatchObject({ xp: 25 });
    t.member.roles.cache.set(MUTED_ROLE, {});
    t.advance(XP_COOLDOWN_MS);
    expect(await t.leveling.handleMessage(t.message({ channel: elsewhere }))).toBeUndefined();

    const country = setup();
    await country.guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    expect(await country.leveling.handleMessage(country.message())).toBeUndefined();
  });

  it("announces in a chosen channel, by DM, or not at all, with a custom message", async () => {
    const inChannel = setup({ config: { announce: "channel", announceChannelId: OTHER_CHANNEL_ID, message: "GG {username}, level {level}" } });
    await inChannel.chatUntil(100);
    expect(inChannel.sent).toEqual([expect.objectContaining({ channel: OTHER_CHANNEL_ID, content: "GG Champ, level 1" })]);

    const dm = setup({ config: { announce: "dm" } });
    await dm.chatUntil(100);
    expect(dm.sent).toEqual([expect.objectContaining({ channel: "dm", allowedMentions: { parse: [] } })]);

    const quiet = setup({ config: { announce: "off" } });
    await quiet.chatUntil(100);
    expect(quiet.sent).toEqual([]);
  });

  it("gives reward roles, and only the highest when rewards don't stack", async () => {
    const rewards = [
      { level: 1, roleId: ROLE_5 },
      { level: 2, roleId: ROLE_10 },
    ];
    const stacked = setup({ config: { rewards } });
    await stacked.chatUntil(totalXpForLevel(2));
    expect([...stacked.member.roles.cache.keys()].sort()).toEqual([ROLE_10, ROLE_5].sort());

    const highest = setup({ config: { rewards, stackRewards: false } });
    await highest.chatUntil(totalXpForLevel(1));
    expect([...highest.member.roles.cache.keys()]).toEqual([ROLE_5]);
    await highest.chatUntil(totalXpForLevel(2));
    expect([...highest.member.roles.cache.keys()]).toEqual([ROLE_10]);
  });

  it("skips reward roles the bot can't give", async () => {
    const t = setup({ config: { rewards: [{ level: 1, roleId: ROLE_5 }] }, roles: [fakeRole(ROLE_5, { editable: false })] });
    await t.chatUntil(100);
    expect(t.member.roles.add).not.toHaveBeenCalled();
  });

  it("catches up members who passed a level before its reward existed", async () => {
    const t = setup();
    await t.chatUntil(totalXpForLevel(1));
    await t.guildSettings.set(GUILD_ID, Setting.LEVELING, { enabled: true, rewards: [{ level: 1, roleId: ROLE_5 }] });
    await t.leveling.handleMessage(t.message());
    expect(t.member.roles.cache.has(ROLE_5)).toBe(true);
  });
});

describe("level commands", () => {
  function commandSetup({ enabled = true } = {}) {
    const t = setup({ config: { enabled } });
    const commands = new Map(
      createLevelCommands({ levels: t.store, leveling: t.leveling, guildSettings: t.guildSettings }).map((command) => [command.name, command]),
    );
    const interaction = ({ name, subcommand, options = {}, manageGuild = true, userId = ADMIN_ID } = {}) => ({
      commandName: name,
      locale: "en-US",
      guildId: GUILD_ID,
      guild: { ...t.guild, members: { me: {} } },
      user: { id: userId, username: "admin", displayAvatarURL: () => null },
      member: { displayName: "Admin" },
      deferred: false,
      replied: false,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => manageGuild && bit === PermissionFlagsBits.ManageGuild },
      options: {
        getSubcommand: () => subcommand,
        getString: (key) => options[key] ?? null,
        getInteger: (key) => options[key] ?? null,
        getChannel: (key) => options[key] ?? null,
        getRole: (key) => options[key] ?? null,
        getUser: (key) => options[key] ?? null,
        getMember: (key) => options[`${key}Member`] ?? null,
      },
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    });
    const run = async (options) => {
      const target = interaction(options);
      return { target, outcome: await commands.get(options.name).execute(target) };
    };
    return { ...t, commands, run };
  }

  it("keeps /levels under Discord's limits and for Manage Server", () => {
    const data = buildLevelsCommandData();
    expect(data.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
    expect(data.options).toHaveLength(11);
  });

  it("shows a rank card and the leaderboard", async () => {
    const t = commandSetup();
    t.store.setXp(GUILD_ID, MEMBER_ID, 300, "champ");
    t.store.setXp(GUILD_ID, ADMIN_ID, 50, "admin");
    const { target } = await t.run({ name: "rank", options: { member: { id: MEMBER_ID, username: "champ", displayAvatarURL: () => null } } });
    const embed = target.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields.map((field) => field.value)).toEqual(["2", "45 / 220", "#1 of 2"]);

    const board = await t.run({ name: "leaderboard" });
    const description = board.target.reply.mock.calls[0][0].embeds[0].toJSON().description;
    expect(description.split("\n")).toEqual([`🥇 <@${MEMBER_ID}> · Level 2 · 300 XP`, `🥈 <@${ADMIN_ID}> · Level 0 · 50 XP`]);
  });

  it("says leveling is off, or that someone has no XP yet", async () => {
    const off = commandSetup({ enabled: false });
    expect((await off.run({ name: "rank" })).outcome.key).toBe("levelsDisabled");
    expect((await off.run({ name: "leaderboard" })).outcome.key).toBe("levelsDisabled");
    const t = commandSetup();
    expect((await t.run({ name: "rank" })).outcome.key).toBe("rankNoXpYou");
    expect((await t.run({ name: "leaderboard" })).outcome.key).toBe("leaderboardEmpty");
  });

  it("changes the settings", async () => {
    const t = commandSetup({ enabled: false });
    const config = () => normalizeLeveling(t.guildSettings.get(GUILD_ID, Setting.LEVELING));
    expect((await t.run({ name: "levels", subcommand: "on" })).outcome.status).toBe(Status.SUCCESS);
    expect(config().enabled).toBe(true);

    const channel = { id: OTHER_CHANNEL_ID, isTextBased: () => true, permissionsFor: () => ({ has: () => true }) };
    await t.run({ name: "levels", subcommand: "announce", options: { where: "channel", channel } });
    expect(config()).toMatchObject({ announce: "channel", announceChannelId: OTHER_CHANNEL_ID });
    expect((await t.run({ name: "levels", subcommand: "announce", options: { where: "channel" } })).outcome.key).toBe("levelsAnnounceNeedsChannel");

    await t.run({ name: "levels", subcommand: "message", options: { text: "GG {user}" } });
    expect(config().message).toBe("GG {user}");
    await t.run({ name: "levels", subcommand: "message" });
    expect(config().message).toBeNull();

    await t.run({ name: "levels", subcommand: "reward-add", options: { level: 5, role: fakeRole(ROLE_5) } });
    await t.run({ name: "levels", subcommand: "reward-add", options: { level: 10, role: fakeRole(ROLE_10) } });
    // The same role at another level moves it.
    await t.run({ name: "levels", subcommand: "reward-add", options: { level: 3, role: fakeRole(ROLE_5) } });
    expect(config().rewards).toEqual([
      { level: 3, roleId: ROLE_5 },
      { level: 10, roleId: ROLE_10 },
    ]);
    const locked = await t.run({ name: "levels", subcommand: "reward-add", options: { level: 7, role: fakeRole(MUTED_ROLE, { editable: false }) } });
    expect(locked.outcome.key).toBe("levelsRewardBadRole");
    expect((await t.run({ name: "levels", subcommand: "reward-remove", options: { level: 3 } })).outcome.key).toBe("levelsRewardRemoved");
    expect((await t.run({ name: "levels", subcommand: "reward-remove", options: { level: 3 } })).outcome.key).toBe("levelsRewardMissing");

    await t.run({ name: "levels", subcommand: "reward-mode", options: { mode: "highest" } });
    expect(config().stackRewards).toBe(false);

    await t.run({ name: "levels", subcommand: "no-xp", options: { channel: { id: CHANNEL_ID }, role: { id: MUTED_ROLE } } });
    expect(config()).toMatchObject({ noXpChannelIds: [CHANNEL_ID], noXpRoleIds: [MUTED_ROLE] });
    await t.run({ name: "levels", subcommand: "no-xp", options: { channel: { id: CHANNEL_ID } } });
    expect(config().noXpChannelIds).toEqual([]);

    const show = await t.run({ name: "levels", subcommand: "show" });
    expect(show.target.reply.mock.calls[0][0].content).toContain("**Leveling:** on");
  });

  it("sets and resets a member's level", async () => {
    const t = commandSetup();
    await t.run({ name: "levels", subcommand: "set", options: { member: { id: MEMBER_ID, username: "champ" }, level: 4 } });
    expect(levelForXp(t.store.get(GUILD_ID, MEMBER_ID).xp)).toBe(4);
    expect((await t.run({ name: "levels", subcommand: "reset", options: { member: { id: MEMBER_ID } } })).outcome.key).toBe("levelsResetDone");
    expect((await t.run({ name: "levels", subcommand: "reset", options: { member: { id: MEMBER_ID } } })).outcome.key).toBe("levelsResetNothing");
    expect((await t.run({ name: "levels", subcommand: "set", options: { member: { id: "1", bot: true }, level: 1 } })).outcome.key).toBe("levelsNoBots");
  });

  it("needs Manage Server for /levels", async () => {
    const t = commandSetup();
    expect((await t.run({ name: "levels", subcommand: "on", manageGuild: false })).outcome.key).toBe("modNoPermission");
  });
});
