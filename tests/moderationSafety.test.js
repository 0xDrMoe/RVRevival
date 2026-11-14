import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContextMenus, REPORT_ACTION_PREFIX, REPORT_FORM_PREFIX } from "../src/commands/contextMenus.js";
import { createModerationCommands } from "../src/commands/moderation.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { buildMemberJoinedEmbed } from "../src/logs/serverLog.js";
import { AltHints, nameKey } from "../src/moderation/altHints.js";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";
import { createModerationService } from "../src/moderation/moderationService.js";
import { MAX_REPORTS_PER_WINDOW, ReportStatus, ReportStore } from "../src/moderation/reports.js";
import {
  checkWarnThresholds,
  describeWarnStep,
  describeWarnThresholds,
  InvalidWarnThresholds,
  mergeEscalation,
  normalizeWarnThresholds,
  reachedThreshold,
  stepFromEscalation,
  withoutStep,
  withStep,
} from "../src/moderation/warnThresholds.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { openDatabase } from "../src/storage/database.js";
import { fakeLogger } from "./helpers/fakes.js";
import { BOT_ID, GUILD_ID, MOD_ID, TARGET_ID, fakeGuild, fakeMember } from "./helpers/moderationFakes.js";

const DAY = 24 * 60 * 60 * 1000;

describe("alt hints", () => {
  it("turns names into keys of letters only, and ignores short ones", () => {
    expect(nameKey("Kaz_99")).toBe(null);
    expect(nameKey("Kazzy.2")).toBe("kazzy");
    expect(nameKey("ＢＲＵＴＥ")).toBe("brute");
    expect(nameKey("Ñandú_7")).toBe("ñandú");
    expect(nameKey(undefined)).toBe(null);
  });

  it("matches a joiner by avatar or name, and forgets an unbanned account", () => {
    const hints = new AltHints(openDatabase());
    hints.banned(GUILD_ID, { id: "1", username: "brawler_01", avatar: "abc" }, 1);
    hints.banned(GUILD_ID, { id: "2", username: "someone", globalName: null, avatar: "def" }, 2);
    expect(hints.matches(GUILD_ID, { id: "9", username: "Brawler.77", avatar: null })).toEqual([{ userId: "1", reason: "name" }]);
    expect(hints.matches(GUILD_ID, { id: "9", username: "other", avatar: "def" })).toEqual([{ userId: "2", reason: "avatar" }]);
    expect(hints.matches("other-guild", { id: "9", username: "brawler", avatar: "def" })).toEqual([]);
    // The banned account itself never matches.
    expect(hints.matches(GUILD_ID, { id: "1", username: "brawler", avatar: "abc" })).toEqual([]);
    hints.unbanned(GUILD_ID, "1");
    expect(hints.matches(GUILD_ID, { id: "9", username: "brawler", avatar: null })).toEqual([]);
  });

  it("adds a warning line to the join log", () => {
    const member = { id: TARGET_ID, user: { id: TARGET_ID, username: "x", createdTimestamp: 0, displayAvatarURL: () => undefined }, guild: { memberCount: 5 } };
    const embed = buildMemberJoinedEmbed(member, Date.now(), [{ userId: "1", reason: "avatar" }, { userId: "2", reason: "name" }]).toJSON();
    expect(embed.description).toContain("🚩 Looks like banned <@1> (same avatar)");
    expect(embed.description).toContain("🚩 Looks like banned <@2> (similar name)");
    expect(buildMemberJoinedEmbed(member, Date.now()).toJSON().description).not.toContain("🚩");
  });
});

describe("warning thresholds", () => {
  it("checks, sorts and describes thresholds", () => {
    const value = [
      { count: 5, days: 30, action: "ban" },
      { count: 3, days: 7, action: "timeout", minutes: 60 },
    ];
    expect(checkWarnThresholds(value)).toEqual([value[1], value[0]]);
    expect(checkWarnThresholds([])).toBe(null);
    expect(describeWarnThresholds(value)).toBe("3 warnings within 7 days → time out for 1 hour; 5 warnings within 30 days → ban");
    expect(describeWarnThresholds([{ count: 1, days: 1, action: "timeout", minutes: 2880 }])).toBe("1 warning within 1 day → time out for 2 days");
    expect(describeWarnThresholds(undefined)).toBe("*none*");
    for (const bad of [
      [{ count: 0, days: 7, action: "kick" }],
      [{ count: 21, days: 7, action: "kick" }],
      [{ count: 3, days: 0, action: "kick" }],
      [{ count: 3, days: 7, action: "mute" }],
      [{ count: 3, days: 7, action: "timeout" }],
      [{ count: 3, days: 7, action: "kick" }, { count: 3, days: 9, action: "ban" }],
      Array.from({ length: 6 }, (_, index) => ({ count: index + 2, days: 7, action: "kick" })),
      "nope",
    ]) {
      expect(() => checkWarnThresholds(bad)).toThrow(InvalidWarnThresholds);
    }
    expect(normalizeWarnThresholds([{ count: 1 }])).toEqual([]);
  });

  it("adds, replaces and removes single steps", () => {
    const steps = [{ count: 3, days: 7, action: "kick" }];
    expect(withStep(steps, { count: 2, days: 1, action: "timeout", minutes: 10 })).toEqual([
      { count: 2, days: 1, action: "timeout", minutes: 10 },
      { count: 3, days: 7, action: "kick" },
    ]);
    expect(withStep(steps, { count: 3, days: 30, action: "ban" })).toEqual([{ count: 3, days: 30, action: "ban" }]);
    const full = Array.from({ length: 5 }, (_, index) => ({ count: index + 1, days: 7, action: "kick" }));
    expect(() => withStep(full, { count: 9, days: 7, action: "ban" })).toThrow(InvalidWarnThresholds);
    expect(withoutStep(steps, 3)).toEqual([]);
    expect(withoutStep(steps, 4)).toEqual(steps);
  });

  it("describes a step in the reader's language", () => {
    const en = (key, values) => translate("en", key, values);
    expect(describeWarnStep({ count: 3, days: 30, action: "timeout", minutes: 60 }, en)).toBe("3 warnings within 30 days → time out for 1h");
    expect(describeWarnStep({ count: 1, days: 1, action: "ban" }, en)).toBe("Every warning → ban");
    expect(describeWarnStep({ count: 2, days: 1, action: "ban" }, en)).toBe("2 warnings within 24 hours → ban");
    expect(describeWarnStep({ count: 2, days: 7, action: "kick" }, (key, values) => translate("de", key, values))).toBe("2 Verwarnungen innerhalb von 7 Tagen → kicken");
  });

  it("turns automod's old escalation into a step within 1 day", () => {
    expect(stepFromEscalation({ warnings: 3, action: "timeout", timeoutMinutes: 90 })).toEqual({ count: 3, days: 1, action: "timeout", minutes: 90 });
    expect(stepFromEscalation({ warnings: 2, action: "ban", timeoutMinutes: 60 })).toEqual({ count: 2, days: 1, action: "ban" });
    expect(stepFromEscalation({ warnings: 0, action: "kick" })).toBeUndefined();
    expect(stepFromEscalation({ warnings: 3, action: "nuke" })).toBeUndefined();
    expect(stepFromEscalation(undefined)).toBeUndefined();
    const existing = [{ count: 3, days: 30, action: "kick" }];
    // A step the server already has for that count wins.
    expect(mergeEscalation(existing, { warnings: 3, action: "ban" })).toEqual(existing);
    expect(mergeEscalation(existing, { warnings: 2, action: "kick" })).toEqual([{ count: 2, days: 1, action: "kick" }, ...existing]);
    const full = Array.from({ length: 5 }, (_, index) => ({ count: index + 4, days: 7, action: "kick" }));
    expect(mergeEscalation(full, { warnings: 2, action: "ban" })).toEqual(full);
  });

  it("fires only on an exact count, and the highest step wins", () => {
    const thresholds = [
      { count: 3, days: 7, action: "timeout", minutes: 60 },
      { count: 5, days: 30, action: "ban" },
    ];
    expect(reachedThreshold(thresholds, () => 2)).toBeUndefined();
    expect(reachedThreshold(thresholds, () => 3)).toBe(thresholds[0]);
    expect(reachedThreshold(thresholds, () => 4)).toBeUndefined();
    expect(reachedThreshold(thresholds, () => 5)).toBe(thresholds[1]);
  });
});

function warnInteraction(guild, target, reason) {
  const moderator = fakeMember(MOD_ID, { position: 10 });
  const interaction = {
    commandName: "warn",
    locale: "en-US",
    guildId: GUILD_ID,
    guild,
    user: moderator.user,
    member: moderator,
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    memberPermissions: { has: () => true },
    options: { getUser: () => target.user, getMember: () => target, getString: (name) => (name === "reason" ? reason : null), getInteger: () => null },
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
  };
  return interaction;
}

describe("/warn with thresholds and reason suggestions", () => {
  let store;
  let guildSettings;
  let commands;

  beforeEach(() => {
    store = new CaseStore();
    guildSettings = new GuildSettings();
    const moderation = createModerationService({ store, logger: fakeLogger() });
    commands = new Map(createModerationCommands({ guildSettings, moderation, logger: fakeLogger() }).map((command) => [command.name, command]));
  });

  afterEach(() => store.close());

  it("times the member out when a warning reaches a threshold", async () => {
    await guildSettings.set(GUILD_ID, Setting.WARN_THRESHOLDS, [{ count: 2, days: 7, action: "timeout", minutes: 30 }]);
    const guild = fakeGuild();
    const target = fakeMember(TARGET_ID, { position: 2 });
    await commands.get("warn").execute(warnInteraction(guild, target, "spam"));
    expect(target.timeout).not.toHaveBeenCalled();

    const second = warnInteraction(guild, target, "spam again");
    await commands.get("warn").execute(second);
    expect(target.timeout).toHaveBeenCalledWith(30 * 60_000, expect.stringContaining("Automatic punishment: 2 warnings within 7 days"));
    const answer = second.editReply.mock.calls.at(-1)[0].content;
    expect(answer).toContain(translate("en", "modWarnThresholdApplied", { step: "2 warnings within 7 days → time out for 30m", number: 3 }));
    expect(store.getCase(GUILD_ID, 3).action).toBe(CaseAction.TIMEOUT);
  });

  it("says when it can't act on a threshold", async () => {
    await guildSettings.set(GUILD_ID, Setting.WARN_THRESHOLDS, [{ count: 2, days: 7, action: "kick" }]);
    const guild = fakeGuild();
    const target = { ...fakeMember(TARGET_ID, { position: 2 }), kickable: false };
    await commands.get("warn").execute(warnInteraction(guild, target, "a"));
    const second = warnInteraction(guild, target, "b");
    await commands.get("warn").execute(second);
    expect(target.kick).not.toHaveBeenCalled();
    expect(second.editReply.mock.calls.at(-1)[0].content).toContain(translate("en", "modWarnThresholdFailed"));
  });

  it("suggests the reasons moderators use most, to moderators only", async () => {
    const add = (reason) => store.createCase({ guildId: GUILD_ID, action: CaseAction.WARN, userId: TARGET_ID, userTag: "t", moderatorId: MOD_ID, moderatorTag: "m", reason });
    add("Spamming links");
    add("Spamming links");
    add("Rude to staff");
    add("Automod: bad words");
    const respond = vi.fn(async () => {});
    const interaction = (typed, isMod = true) => ({
      guildId: GUILD_ID,
      inCachedGuild: () => true,
      memberPermissions: { has: () => isMod },
      member: { roles: { cache: new Map() } },
      options: { getFocused: () => ({ name: "reason", value: typed }) },
      respond,
    });
    await commands.get("warn").autocomplete(interaction(""));
    expect(respond).toHaveBeenLastCalledWith([
      { name: "Spamming links", value: "Spamming links" },
      { name: "Rude to staff", value: "Rude to staff" },
    ]);
    await commands.get("warn").autocomplete(interaction("rude"));
    expect(respond).toHaveBeenLastCalledWith([{ name: "Rude to staff", value: "Rude to staff" }]);
    await commands.get("warn").autocomplete(interaction("", false));
    expect(respond).toHaveBeenLastCalledWith([]);
  });
});

describe("report store", () => {
  it("rate-limits reporters and counts reports against an author", () => {
    const reports = new ReportStore(openDatabase());
    const now = 1_000_000_000;
    for (let index = 0; index < MAX_REPORTS_PER_WINDOW; index += 1) {
      reports.add({ guildId: GUILD_ID, channelId: "c", messageId: `m${index}`, authorId: "a", reporterId: "r", createdAt: now });
    }
    expect(reports.canReport(GUILD_ID, "r", now)).toBe(false);
    expect(reports.canReport(GUILD_ID, "r", now + 11 * 60 * 1000)).toBe(true);
    expect(reports.recentAgainst(GUILD_ID, "a", now)).toBe(MAX_REPORTS_PER_WINDOW);
    expect(reports.recentAgainst(GUILD_ID, "a", now + 31 * DAY)).toBe(0);
    expect(reports.openForMessage(GUILD_ID, "m0").status).toBe(ReportStatus.OPEN);
    const first = reports.openForMessage(GUILD_ID, "m0");
    expect(reports.resolve(first.id, ReportStatus.DISMISSED, "s")).toMatchObject({ status: ReportStatus.DISMISSED, handledBy: "s" });
    expect(reports.resolve(first.id, ReportStatus.DELETED, "s")).toBeUndefined();
    expect(reports.openForMessage(GUILD_ID, "m0")).toBeUndefined();
  });
});

describe("right-click apps", () => {
  const MOD_LOG = "800000000000000001";
  let guildSettings;
  let reports;
  let store;
  let guild;
  let modLog;
  let reported;
  let apps;

  beforeEach(async () => {
    guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.MOD_LOG_CHANNEL, MOD_LOG);
    reports = new ReportStore(openDatabase());
    store = new CaseStore();
    guild = fakeGuild();
    guild.members.fetch = vi.fn(async (id) => (id === TARGET_ID ? reportedMember : undefined));
    modLog = { id: MOD_LOG, isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({ id: "post-1" })) };
    reported = { id: "m1", channelId: "c1", content: "bad words", author: { id: TARGET_ID, bot: false }, attachments: new Map(), delete: vi.fn(async () => {}) };
    const source = { id: "c1", messages: { fetch: vi.fn(async (id) => (id === "m1" ? reported : Promise.reject(new Error("Unknown Message")))) } };
    guild.channels.cache = new Map([
      [MOD_LOG, modLog],
      ["c1", source],
    ]);
    const moderation = createModerationService({ store, logger: fakeLogger() });
    apps = new Map(createContextMenus({ guildSettings, reports, moderation, logger: fakeLogger() }).map((app) => [app.name, app]));
  });

  afterEach(() => store.close());

  const reportedMember = fakeMember(TARGET_ID, { position: 2 });

  const base = (extra) => {
    const interaction = {
      locale: "en-US",
      guildId: GUILD_ID,
      guild,
      user: { id: "500000000000000001", tag: "reporter" },
      member: fakeMember("500000000000000001", { position: 1 }),
      deferred: false,
      replied: false,
      inCachedGuild: () => true,
      memberPermissions: { has: () => false },
      reply: vi.fn(async () => {
        interaction.replied = true;
      }),
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      ...extra,
    };
    return interaction;
  };

  const submit = (reason = "rude") =>
    base({ customId: `${REPORT_FORM_PREFIX}c1:m1`, fields: { getTextInputValue: () => reason } });

  it("asks why, then posts the report for staff with buttons", async () => {
    const opened = base({ targetMessage: reported });
    await apps.get("Report message").execute(opened);
    expect(opened.showModal).toHaveBeenCalledTimes(1);
    expect(opened.showModal.mock.calls[0][0].toJSON().custom_id).toBe(`${REPORT_FORM_PREFIX}c1:m1`);

    const form = submit();
    const outcome = await apps.get("Report message").componentPrefixes[REPORT_FORM_PREFIX].handle(form);
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "reportSent" });
    expect(form.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const post = modLog.send.mock.calls[0][0];
    const embed = post.embeds[0].toJSON();
    expect(embed.fields.find((field) => field.name === "Reason").value).toBe("rude");
    expect(embed.fields.find((field) => field.name === "Message").value).toBe("bad words");
    expect(post.components[0].toJSON().components.map((button) => button.custom_id)).toEqual([
      `${REPORT_ACTION_PREFIX}1:delete`,
      `${REPORT_ACTION_PREFIX}1:timeout`,
      `${REPORT_ACTION_PREFIX}1:dismiss`,
    ]);
    expect(reports.get(1)).toMatchObject({ reportChannelId: MOD_LOG, reportMessageId: "post-1" });

    // The same message is only reported once while the report is open.
    const again = base({ targetMessage: reported });
    expect(await apps.get("Report message").execute(again)).toMatchObject({ key: "reportAlreadyOpen" });
  });

  it("refuses own and bot messages, and servers with no report channel", async () => {
    const own = base({ targetMessage: { ...reported, author: { id: "500000000000000001", bot: false } } });
    expect(await apps.get("Report message").execute(own)).toMatchObject({ key: "reportOwnMessage" });
    const bot = base({ targetMessage: { ...reported, author: { id: BOT_ID, bot: true } } });
    expect(await apps.get("Report message").execute(bot)).toMatchObject({ key: "reportBotMessage" });
    await guildSettings.clear(GUILD_ID, Setting.MOD_LOG_CHANNEL);
    expect(await apps.get("Report message").execute(base({ targetMessage: reported }))).toMatchObject({ key: "reportNoChannel" });
  });

  it("forgets a report it couldn't post", async () => {
    modLog.send.mockRejectedValueOnce(new Error("Missing Access"));
    expect(await apps.get("Report message").componentPrefixes[REPORT_FORM_PREFIX].handle(submit())).toMatchObject({ status: Status.FAILED });
    expect(reports.openForMessage(GUILD_ID, "m1")).toBeUndefined();
  });

  it("lets staff delete the message once, and not other members", async () => {
    await apps.get("Report message").componentPrefixes[REPORT_FORM_PREFIX].handle(submit());
    const handle = apps.get("Report message").componentPrefixes[REPORT_ACTION_PREFIX].handle;

    const member = base({ customId: `${REPORT_ACTION_PREFIX}1:delete` });
    expect(await handle(member)).toMatchObject({ key: "reportStaffOnly" });
    expect(reported.delete).not.toHaveBeenCalled();

    const staff = base({ customId: `${REPORT_ACTION_PREFIX}1:delete`, user: { id: MOD_ID }, member: fakeMember(MOD_ID, { position: 10 }), memberPermissions: { has: () => true } });
    expect(await handle(staff)).toMatchObject({ status: Status.SUCCESS });
    expect(reported.delete).toHaveBeenCalledTimes(1);
    const updated = staff.update.mock.calls[0][0];
    expect(updated.components).toEqual([]);
    expect(updated.embeds[0].toJSON().fields.at(-1).value).toBe(`message deleted by <@${MOD_ID}>`);
    expect(reports.get(1).status).toBe(ReportStatus.DELETED);

    const twice = base({ customId: `${REPORT_ACTION_PREFIX}1:dismiss`, user: { id: MOD_ID }, member: fakeMember(MOD_ID, { position: 10 }), memberPermissions: { has: () => true } });
    expect(await handle(twice)).toMatchObject({ key: "reportAlreadyHandled" });
  });

  it("times the author out for 10 minutes and opens a case", async () => {
    await apps.get("Report message").componentPrefixes[REPORT_FORM_PREFIX].handle(submit());
    const staff = base({ customId: `${REPORT_ACTION_PREFIX}1:timeout`, user: { id: MOD_ID }, member: fakeMember(MOD_ID, { position: 10 }), memberPermissions: { has: (bit) => bit === PermissionFlagsBits.ModerateMembers } });
    expect(await apps.get("Report message").componentPrefixes[REPORT_ACTION_PREFIX].handle(staff)).toMatchObject({ status: Status.SUCCESS });
    expect(reportedMember.timeout).toHaveBeenCalledWith(10 * 60 * 1000, expect.stringContaining("report #1"));
    expect(store.getCase(GUILD_ID, 1).action).toBe(CaseAction.TIMEOUT);
    expect(reports.get(1).status).toBe(ReportStatus.TIMED_OUT);
  });

  it("shows moderation history to moderators only", async () => {
    const target = { id: TARGET_ID, tag: "target", username: "target", displayAvatarURL: () => undefined };
    const member = base({ targetUser: target });
    expect(await apps.get("Moderation history").execute(member)).toMatchObject({ key: "modNoPermission" });
    const staff = base({ targetUser: target, memberPermissions: { has: () => true } });
    expect(await apps.get("Moderation history").execute(staff)).toMatchObject({ key: "modlogsNone" });
  });
});
