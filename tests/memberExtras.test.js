import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDehoistCommand } from "../src/commands/dehoist.js";
import { createInvitesCommand } from "../src/commands/invites.js";
import { createMyDataCommand } from "../src/commands/myData.js";
import { createTimestampCommand } from "../src/commands/timestamp.js";
import { pickWinners, requirementProblem, weightedOrder } from "../src/giveaways/giveaways.js";
import { GiveawayStore } from "../src/giveaways/giveawayStore.js";
import { Status } from "../src/logs/actionLog.js";
import { createInviteTracker } from "../src/logs/inviteTracker.js";
import { GrowthStore } from "../src/members/growthStore.js";
import { createInviteStats } from "../src/members/inviteStats.js";
import { createPersonalData } from "../src/members/personalData.js";
import { createDehoist, dehoistedName, isHoisted } from "../src/moderation/dehoist.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { openDatabase } from "../src/storage/database.js";
import { parseMoment } from "../src/utils/timestamps.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const USER_ID = "300000000000000020";
const INVITER_ID = "300000000000000030";
const OTHER_ID = "300000000000000040";
const DAY = 24 * 60 * 60 * 1000;

const baseInteraction = (extra = {}) => ({
  locale: "en-US",
  guildId: GUILD_ID,
  user: { id: USER_ID },
  inCachedGuild: () => true,
  reply: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  deferReply: vi.fn(async () => {}),
  editReply: vi.fn(async () => {}),
  ...extra,
});
const content = (interaction) => (interaction.reply.mock.calls.at(-1) ?? interaction.editReply.mock.calls.at(-1))[0].content;

describe("invite tracking", () => {
  const manageGuild = { has: (bit) => bit === PermissionFlagsBits.ManageGuild };
  const fakeGuild = (canRead = true) => ({ id: GUILD_ID, members: { me: { permissions: { has: () => canRead } } } });

  it("saves who invited each member, and counts who's still here", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.INVITE_TRACKING, true);
    const store = new GrowthStore();
    const guild = fakeGuild();
    const tracker = { inviteUsed: vi.fn(async (member) => (member.id === OTHER_ID ? undefined : { code: "abc", inviterId: INVITER_ID })) };
    const stats = createInviteStats({ guildSettings, store, inviteTracker: tracker, logger: fakeLogger(), now: () => 1000 });
    await stats.memberJoined({ id: USER_ID, guild, user: { bot: false } });
    await stats.memberJoined({ id: OTHER_ID, guild, user: { bot: false } });
    await stats.memberJoined({ id: "300000000000000050", guild, user: { bot: true } });
    stats.memberLeft({ id: USER_ID, guild, user: { bot: false } });

    expect(store.statsFor(GUILD_ID, INVITER_ID)).toEqual({ total: 1, here: 0, left: 1 });
    expect(store.joinOf(GUILD_ID, OTHER_ID)).toMatchObject({ inviterId: null, code: null });
    expect(tracker.inviteUsed).toHaveBeenCalledTimes(2);
    // A rejoin replaces the old record and counts them as here again.
    await stats.memberJoined({ id: USER_ID, guild, user: { bot: false } });
    expect(store.top(GUILD_ID)).toEqual([{ inviterId: INVITER_ID, total: 1, here: 1, left: 0 }]);
  });

  it("does nothing while tracking is off", async () => {
    const store = new GrowthStore();
    const tracker = { inviteUsed: vi.fn() };
    await createInviteStats({ guildSettings: new GuildSettings(), store, inviteTracker: tracker, logger: fakeLogger() }).memberJoined({ id: USER_ID, guild: fakeGuild(), user: {} });
    expect(tracker.inviteUsed).not.toHaveBeenCalled();
  });

  it("shares one lookup between the server log and /invites", async () => {
    const fetch = vi.fn(async () => new Map([["abc", { code: "abc", uses: 1, maxUses: 0, inviterId: INVITER_ID }]]));
    const guild = { id: GUILD_ID, invites: { fetch }, members: { me: { permissions: { has: () => true } } } };
    const tracker = createInviteTracker({ logger: fakeLogger() });
    await tracker.prime({ ...guild, invites: { fetch: async () => new Map([["abc", { code: "abc", uses: 0, maxUses: 0, inviterId: INVITER_ID }]]) } });
    const member = { id: USER_ID, guild };
    const [first, second] = await Promise.all([tracker.inviteUsed(member), tracker.inviteUsed(member)]);
    expect(first).toMatchObject({ code: "abc", inviterId: INVITER_ID });
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("/invites switches tracking, and shows stats and the top inviters", async () => {
    const guildSettings = new GuildSettings();
    const growth = new GrowthStore();
    const inviteTracker = { prime: vi.fn(async () => {}) };
    const command = createInvitesCommand({ guildSettings, growth, inviteTracker });
    const run = async (subcommand, { manage = true, member = null, enabled = true, canRead = true } = {}) => {
      const interaction = baseInteraction({
        guild: fakeGuild(canRead),
        memberPermissions: manage ? manageGuild : { has: () => false },
        options: { getSubcommand: () => subcommand, getBoolean: () => enabled, getUser: () => member },
      });
      return { outcome: await command.execute(interaction), text: content(interaction) };
    };

    expect((await run("top")).outcome.key).toBe("invitesOff");
    expect((await run("tracking", { manage: false })).outcome.key).toBe("settingsNoPermission");
    const on = await run("tracking", { canRead: false });
    expect(on.outcome.key).toBe("invitesTrackingOn");
    expect(on.text).toContain("Manage Server");
    expect(inviteTracker.prime).toHaveBeenCalled();
    expect(guildSettings.get(GUILD_ID, Setting.INVITE_TRACKING)).toBe(true);

    growth.recordJoin(GUILD_ID, USER_ID, { inviterId: INVITER_ID, code: "abc" });
    growth.recordJoin(GUILD_ID, OTHER_ID, { inviterId: INVITER_ID, code: "abc" });
    growth.recordLeave(GUILD_ID, OTHER_ID);
    const mine = await run("member");
    expect(mine.text).toContain(`<@${INVITER_ID}>`);
    expect(mine.text).toContain("`abc`");
    const theirs = await run("member", { member: { id: INVITER_ID } });
    expect(theirs.text).toContain("**2**");
    expect(theirs.text).toContain("1 still here, 1 left");
    expect((await run("top")).text).toContain(`1. <@${INVITER_ID}>: 1 still here of 2`);

    await run("tracking", { enabled: false });
    expect(guildSettings.get(GUILD_ID, Setting.INVITE_TRACKING)).toBeUndefined();
  });
});

describe("dehoist", () => {
  it("spots hoisted names and cleans them", () => {
    expect(isHoisted("!Moe")).toBe(true);
    expect(isHoisted("  .x")).toBe(true);
    expect(isHoisted("Moe")).toBe(false);
    expect(isHoisted("~tilde")).toBe(false);
    expect(dehoistedName("!!!Moe")).toBe("Moe");
    expect(dehoistedName("!!!")).toBe("Dehoisted");
  });

  function fakeMember(name, { bot = false, manageable = true, id = USER_ID } = {}) {
    return {
      id,
      displayName: name,
      manageable,
      user: { bot },
      guild: { id: GUILD_ID, ownerId: "1", members: { me: { permissions: { has: () => true } } } },
      setNickname: vi.fn(async () => {}),
    };
  }

  it("renames new members and renames only when auto-dehoist is on", async () => {
    const guildSettings = new GuildSettings();
    const dehoist = createDehoist({ guildSettings, logger: fakeLogger() });
    const member = fakeMember("!Moe");
    await dehoist.memberJoined(member);
    expect(member.setNickname).not.toHaveBeenCalled();
    await guildSettings.set(GUILD_ID, Setting.DEHOIST, true);
    await dehoist.memberJoined(member);
    expect(member.setNickname).toHaveBeenCalledWith("Moe", "Auto-dehoist");
    const bot = fakeMember("!Bot", { bot: true });
    await dehoist.memberUpdated(fakeMember("Bot"), bot);
    expect(bot.setNickname).not.toHaveBeenCalled();
  });

  it("/dehoist run fixes everyone it can", async () => {
    const guildSettings = new GuildSettings();
    const members = [fakeMember("!a", { id: "1" }), fakeMember("!b", { id: "2" }), fakeMember("fine", { id: "3" }), fakeMember("!c", { id: "4", manageable: false }), fakeMember("!d", { id: "5" })];
    members[4].setNickname.mockRejectedValue(new Error("Missing Permissions"));
    const guild = { id: GUILD_ID, members: { me: { permissions: { has: () => true } }, fetch: vi.fn(async () => new Map(members.map((m) => [m.id, m]))) } };
    const command = createDehoistCommand({ guildSettings, logger: fakeLogger() });
    const interaction = baseInteraction({ guild, memberPermissions: { has: () => true }, options: { getSubcommand: () => "run" } });
    const outcome = await command.execute(interaction);
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "dehoistDone" });
    // The owner (id "1") is skipped, and so is anyone above the bot.
    expect(members[0].setNickname).not.toHaveBeenCalled();
    expect(members[1].setNickname).toHaveBeenCalledWith("b", "/dehoist run");
    expect(members[3].setNickname).not.toHaveBeenCalled();
    expect(content(interaction)).toContain("Renamed 1 member(s). 1 couldn't");
  });
});

describe("giveaway requirements and bonus entries", () => {
  it("checks account and server age", () => {
    const now = 100 * DAY;
    const giveaway = { minAccountDays: 30, minMemberDays: 7 };
    const member = (created, joined) => ({ user: { createdTimestamp: created }, joinedTimestamp: joined, roles: { cache: new Map() } });
    expect(requirementProblem(giveaway, member(now - 10 * DAY, now - 10 * DAY), now)).toBe("giveawayNeedsAccountAge");
    expect(requirementProblem(giveaway, member(now - 40 * DAY, now - 2 * DAY), now)).toBe("giveawayNeedsMemberAge");
    expect(requirementProblem(giveaway, member(now - 40 * DAY, now - 8 * DAY), now)).toBeNull();
    expect(requirementProblem({ requiredRoleId: "5" }, member(0, 0), now)).toBe("giveawayNeedsRole");
  });

  it("stores bonus entries and favours them in the draw, never picking anyone twice", async () => {
    const store = new GiveawayStore();
    const giveaway = store.create({ guildId: GUILD_ID, channelId: "1", hostId: "2", prize: "Nitro", winnerCount: 2, bonusRoleId: "7", minAccountDays: 30, createdAt: 0, endsAt: 1 });
    expect(giveaway).toMatchObject({ bonusRoleId: "7", minAccountDays: 30, minMemberDays: null });
    store.toggleEntry(giveaway.id, USER_ID, 2);
    store.toggleEntry(giveaway.id, OTHER_ID);
    expect(store.weightedEntries(giveaway.id)).toEqual(expect.arrayContaining([{ userId: USER_ID, weight: 2 }, { userId: OTHER_ID, weight: 1 }]));

    let firsts = 0;
    for (let index = 0; index < 2000; index++) {
      if (weightedOrder([{ userId: "a", weight: 2 }, { userId: "b", weight: 1 }])[0] === "a") {
        firsts++;
      }
    }
    // 2:1 odds: about two thirds of the time.
    expect(firsts / 2000).toBeGreaterThan(0.6);
    expect(firsts / 2000).toBeLessThan(0.73);

    const guild = { members: { cache: new Map([[USER_ID, { user: {}, roles: { cache: new Map() } }], [OTHER_ID, { user: {}, roles: { cache: new Map() } }]]) } };
    const winners = await pickWinners(guild, giveaway, [{ userId: USER_ID, weight: 2 }, { userId: USER_ID, weight: 2 }, { userId: OTHER_ID, weight: 1 }], { count: 3 });
    expect(winners.sort()).toEqual([USER_ID, OTHER_ID].sort());
  });
});

describe("/timestamp", () => {
  const NOW = Date.UTC(2026, 10, 13, 12, 0);

  it("reads durations, dates, times and Unix times in a time zone", () => {
    expect(parseMoment("2h", { now: NOW })).toBe(NOW + 2 * 60 * 60 * 1000);
    expect(parseMoment("in 3 days", { now: NOW })).toBe(NOW + 3 * DAY);
    expect(parseMoment("2 hours ago", { now: NOW })).toBe(NOW - 2 * 60 * 60 * 1000);
    expect(parseMoment("2026-12-24 18:00", { timeZone: "Europe/Berlin", now: NOW })).toBe(Date.UTC(2026, 11, 24, 17, 0));
    expect(parseMoment("2026-07-01 12:00", { timeZone: "America/New_York", now: NOW })).toBe(Date.UTC(2026, 6, 1, 16, 0));
    expect(parseMoment("6:30 pm", { now: NOW })).toBe(Date.UTC(2026, 10, 13, 18, 30));
    expect(parseMoment("1767225600", { now: NOW })).toBe(Date.UTC(2026, 0, 1));
    expect(parseMoment("2026-02-30", { now: NOW })).toBeUndefined();
    expect(parseMoment("soon", { now: NOW })).toBeUndefined();
    expect(parseMoment("13:00 pm", { now: NOW })).toBeUndefined();
  });

  it("lists every style with its code, and refuses unknown zones", async () => {
    const command = createTimestampCommand({ now: () => NOW });
    const run = async (when, zone = null) => {
      const interaction = baseInteraction({ options: { getString: (name) => (name === "when" ? when : zone) } });
      return { outcome: await command.execute(interaction), text: content(interaction) };
    };
    const { outcome, text } = await run("1767225600");
    expect(outcome.status).toBe(Status.SUCCESS);
    for (const style of ["t", "T", "d", "D", "f", "F", "R"]) {
      expect(text).toContain(`\`<t:1767225600:${style}>\``);
    }
    expect((await run("noon-ish")).outcome.key).toBe("timestampBadWhen");
    expect((await run("2h", "Mars/Olympus")).outcome.key).toBe("timestampBadZone");
  });
});

describe("/mydata", () => {
  function setup() {
    const db = openDatabase();
    const onDeleted = vi.fn();
    const personalData = createPersonalData({ database: db, onDeleted });
    db.prepare("INSERT INTO reminders (guild_id, channel_id, user_id, text, created_at, due_at) VALUES (?, '1', ?, 'x', 0, 1)").run(GUILD_ID, USER_ID);
    db.prepare("INSERT INTO highlights (guild_id, user_id, word) VALUES (?, ?, 'rabble')").run(GUILD_ID, USER_ID);
    db.prepare("INSERT INTO highlights (guild_id, user_id, word) VALUES (?, ?, 'rabble')").run(GUILD_ID, OTHER_ID);
    db.prepare("INSERT INTO invite_joins (guild_id, user_id, inviter_id, joined_at) VALUES (?, ?, ?, 0)").run(GUILD_ID, OTHER_ID, USER_ID);
    db.prepare("INSERT INTO counting_state (channel_id, guild_id, count, last_user_id, best, updated_at) VALUES ('5', ?, 3, ?, 3, 0)").run(GUILD_ID, USER_ID);
    return { db, personalData, onDeleted };
  }

  it("lists a member's own data and deletes it after asking twice", async () => {
    const { db, personalData, onDeleted } = setup();
    const command = createMyDataCommand({ personalData, privacyUrl: "https://example.test/privacy" });
    const opened = baseInteraction();
    await command.execute(opened);
    const shown = opened.reply.mock.calls[0][0];
    expect(shown.content).toContain("Reminders waiting: **1**");
    expect(shown.content).toContain("Highlight words: **1**");
    expect(shown.content).toContain("Invite records (who invited you, or whom you invited): **1**");
    expect(shown.content).toContain("https://example.test/privacy");
    const askId = shown.components[0].toJSON().components[0].custom_id;
    expect(askId).toBe(`mydata:ask:${USER_ID}`);

    const handle = command.componentPrefixes["mydata:"].handle;
    const stranger = baseInteraction({ user: { id: OTHER_ID }, customId: `mydata:yes:${USER_ID}` });
    expect(await handle(stranger)).toMatchObject({ key: "myDataNotYours", status: Status.REFUSED });

    const ask = baseInteraction({ customId: askId });
    await handle(ask);
    expect(ask.update.mock.calls[0][0].content).toContain("can't be undone");
    expect(await handle(baseInteraction({ customId: `mydata:yes:${USER_ID}` }))).toMatchObject({ key: "myDataDeleted", values: { count: 4 } });

    expect(personalData.summary(USER_ID).every((row) => row.count === 0)).toBe(true);
    expect(onDeleted).toHaveBeenCalledWith({ userId: USER_ID, highlightGuildIds: [GUILD_ID] });
    // Other people's data stays; the person they invited is still counted.
    expect(db.prepare("SELECT COUNT(*) AS total FROM highlights").get().total).toBe(1);
    expect(db.prepare("SELECT inviter_id FROM invite_joins WHERE user_id = ?").get(OTHER_ID).inviter_id).toBeNull();
  });
});

describe("milestone test message", () => {
  it("posts the next milestone with the tester, and explains when it's off", async () => {
    const { buildTestMessages, memberLike, TestKind, TestUnavailable } = await import("../src/testing/testMessages.js");
    const guildSettings = new GuildSettings();
    const guild = { id: GUILD_ID, name: "Rabble", memberCount: 1234 };
    const member = memberLike({ id: USER_ID, username: "moe" });
    expect(() => buildTestMessages(TestKind.MILESTONE, { guildSettings, guild, member, language: "en" })).toThrow(TestUnavailable);
    await guildSettings.set(GUILD_ID, Setting.MILESTONES, { channelId: "800000000000000001", every: 100, message: null });
    const [message] = buildTestMessages(TestKind.MILESTONE, { guildSettings, guild, member, language: "en" });
    expect(message.channelId).toBe("800000000000000001");
    expect(message.payload.content).toContain("1,300");
    expect(message.payload.allowedMentions).toEqual({ parse: [] });
  });
});
