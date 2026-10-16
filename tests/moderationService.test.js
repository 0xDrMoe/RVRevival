import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";
import { auditReason, createModerationService } from "../src/moderation/moderationService.js";
import { buildCaseEmbed, createModLog } from "../src/moderation/modLog.js";
import { createLogChannelPoster } from "../src/logs/logChannel.js";
import { RecentIds } from "../src/logs/recentIds.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";
import { GUILD_ID, MOD_ID, TARGET_ID, fakeGuild, fakeMember, fakeUser } from "./helpers/moderationFakes.js";

const NOW = 1_700_000_000_000;
const MOD_LOG_ID = "800000000000000005";
const LOGS_ID = "800000000000000006";

function fakeChannel(id) {
  const sent = [];
  return {
    id,
    sent,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(async (payload) => {
      const message = { id: `9000000000000000${sent.length}`, channelId: id, payload, edit: vi.fn(async () => {}) };
      sent.push(message);
      return message;
    }),
    messages: { fetch: vi.fn(async (messageId) => sent.find((message) => message.id === messageId)) },
  };
}

describe("moderation service", () => {
  let store;
  let guild;
  let settings;
  let modLogChannel;
  let botActions;
  let moderation;
  const moderator = fakeUser(MOD_ID, { tag: "mod" });

  beforeEach(async () => {
    store = new CaseStore();
    guild = fakeGuild();
    settings = new GuildSettings();
    modLogChannel = fakeChannel(MOD_LOG_ID);
    guild.channels.cache.set(MOD_LOG_ID, modLogChannel);
    await settings.set(GUILD_ID, Setting.MOD_LOG_CHANNEL, MOD_LOG_ID);
    const poster = createLogChannelPoster({ guildSettings: settings, logger: fakeLogger() });
    botActions = new RecentIds();
    moderation = createModerationService({
      store,
      modLog: createModLog({ poster, store }),
      logger: fakeLogger(),
      botActions,
      now: () => NOW,
    });
  });

  afterEach(() => store.close());

  it("DMs a member before banning them, records the case and posts it", async () => {
    const member = fakeMember(TARGET_ID);
    const order = [];
    member.user.send.mockImplementation(async () => order.push("dm"));
    guild.members.ban.mockImplementation(async () => order.push("ban"));

    const moderationCase = await moderation.ban({ guild, user: member.user, member, moderator, reason: "cheating", deleteMessageSeconds: 3600 });

    expect(order).toEqual(["dm", "ban"]);
    expect(guild.members.ban).toHaveBeenCalledWith(TARGET_ID, { reason: "cheating (by mod)", deleteMessageSeconds: 3600 });
    expect(moderationCase).toMatchObject({ number: 1, action: CaseAction.BAN, reason: "cheating", dmSent: true, pendingUnban: false });
    expect(member.user.send.mock.calls[0][0].content).toBe("You have been banned from **Rumbleverse \\*Revival\\***.\nReason: cheating");
    expect(modLogChannel.send).toHaveBeenCalledTimes(1);
    expect(moderationCase.logMessageId).toBe(modLogChannel.sent[0].id);
    expect(botActions.has(`${GUILD_ID}:${TARGET_ID}:ban`)).toBe(true);
  });

  it("records a temporary ban as waiting to be lifted", async () => {
    const user = fakeUser(TARGET_ID);
    const moderationCase = await moderation.ban({ guild, user, member: null, moderator, durationMs: 60_000 });
    expect(user.send).not.toHaveBeenCalled();
    expect(moderationCase).toMatchObject({ expiresAt: NOW + 60_000, durationMs: 60_000, pendingUnban: true, dmSent: undefined });
    expect(store.dueUnbans(NOW + 60_000)).toHaveLength(1);
  });

  it("still acts when the member's DMs are closed", async () => {
    const member = fakeMember(TARGET_ID, { dmFails: true });
    const moderationCase = await moderation.kick({ guild, member, moderator, reason: "" });
    expect(member.kick).toHaveBeenCalledWith("No reason given (by mod)");
    expect(moderationCase).toMatchObject({ action: CaseAction.KICK, dmSent: false, reason: undefined });
  });

  it("times out, then DMs", async () => {
    const member = fakeMember(TARGET_ID);
    const moderationCase = await moderation.timeout({ guild, member, moderator, reason: "spam", durationMs: 600_000 });
    expect(member.timeout).toHaveBeenCalledWith(600_000, "spam (by mod)");
    expect(member.user.send.mock.calls[0][0].content).toContain("timed out");
    expect(moderationCase).toMatchObject({ action: CaseAction.TIMEOUT, expiresAt: NOW + 600_000 });
  });

  it("removes a timeout", async () => {
    const member = fakeMember(TARGET_ID);
    const moderationCase = await moderation.untimeout({ guild, member, moderator });
    expect(member.timeout).toHaveBeenCalledWith(null, "No reason given (by mod)");
    expect(moderationCase.action).toBe(CaseAction.UNTIMEOUT);
  });

  it("warns without touching Discord", async () => {
    const member = fakeMember(TARGET_ID);
    const moderationCase = await moderation.warn({ guild, member, moderator, reason: "be nice" });
    expect(moderationCase).toMatchObject({ action: CaseAction.WARN, reason: "be nice", dmSent: true });
    expect(member.user.send.mock.calls[0][0].content).toBe("You have received a warning in **Rumbleverse \\*Revival\\***.\nReason: be nice");
  });

  it("unbans and stops waiting for a temporary ban to end", async () => {
    const user = fakeUser(TARGET_ID);
    await moderation.ban({ guild, user, member: null, moderator, durationMs: 60_000 });
    const moderationCase = await moderation.unban({ guild, user, moderator, reason: "appeal" });
    expect(moderationCase).toMatchObject({ number: 2, action: CaseAction.UNBAN });
    expect(store.dueUnbans(NOW + 60_000)).toEqual([]);
  });

  it("doesn't record a case when Discord refuses", async () => {
    const member = fakeMember(TARGET_ID);
    member.kick.mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    await expect(moderation.kick({ guild, member, moderator })).rejects.toThrow("Missing Permissions");
    expect(store.getCase(GUILD_ID, 1)).toBeUndefined();
  });

  it("edits a case's reason and its mod-log post", async () => {
    const member = fakeMember(TARGET_ID);
    await moderation.warn({ guild, member, moderator, reason: "old" });
    const updated = await moderation.updateReason(guild, 1, "new");
    expect(updated.reason).toBe("new");
    const [post] = modLogChannel.sent;
    expect(post.edit).toHaveBeenCalledTimes(1);
    const embed = post.edit.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields.find((field) => field.name === "Reason").value).toBe("new");
    expect(embed.footer.text).toContain("reason edited");
    expect(await moderation.updateReason(guild, 42, "x")).toBeUndefined();
  });

  it("posts cases in the logs channel when there's no mod-log channel", async () => {
    await settings.clear(GUILD_ID, Setting.MOD_LOG_CHANNEL);
    const logs = fakeChannel(LOGS_ID);
    guild.channels.cache.set(LOGS_ID, logs);
    await settings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);
    await moderation.warn({ guild, member: fakeMember(TARGET_ID), moderator, reason: "x" });
    expect(logs.send).toHaveBeenCalledTimes(1);
  });
});

describe("auditReason", () => {
  it("names the moderator and stays within Discord's limit", () => {
    expect(auditReason({ tag: "mod" }, "spam")).toBe("spam (by mod)");
    expect(auditReason({ tag: "mod" }, "x".repeat(600))).toHaveLength(512);
  });
});

describe("buildCaseEmbed", () => {
  const base = {
    guildId: GUILD_ID,
    number: 7,
    action: CaseAction.BAN,
    userId: TARGET_ID,
    userTag: "member_",
    moderatorId: MOD_ID,
    moderatorTag: "mod",
    createdAt: NOW,
  };

  it("shows a temporary ban with its end", () => {
    const embed = buildCaseEmbed({ ...base, durationMs: 86_400_000, expiresAt: NOW + 86_400_000, dmSent: true }).toJSON();
    expect(embed.title).toBe("Case 7 · Temporary ban");
    expect(embed.fields.map((field) => field.name)).toEqual(["Member", "Moderator", "Duration", "Reason", "DM"]);
    expect(embed.fields[0].value).toBe(`<@${TARGET_ID}> (member\\_)`);
    expect(embed.fields[2].value).toBe(`1d, until <t:${(NOW + 86_400_000) / 1000}:f>`);
    expect(embed.fields[3].value).toBe("*No reason given*");
  });

  it("translates for /case view", () => {
    const embed = buildCaseEmbed({ ...base, action: CaseAction.WARN, reason: "x" }, "de").toJSON();
    expect(embed.title).toBe("Fall 7 · Verwarnung");
  });

  it("shows an unknown moderator without a broken mention", () => {
    const embed = buildCaseEmbed({ ...base, moderatorId: "0", moderatorTag: "Unknown" }).toJSON();
    expect(embed.fields[1].value).toBe("Unknown");
  });
});
