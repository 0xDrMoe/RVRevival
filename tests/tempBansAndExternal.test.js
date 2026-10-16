import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentIds } from "../src/logs/recentIds.js";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";
import { createExternalActionRecorder } from "../src/moderation/externalActions.js";
import { createModerationService } from "../src/moderation/moderationService.js";
import { createTempBanScheduler } from "../src/moderation/tempBans.js";
import { fakeLogger } from "./helpers/fakes.js";
import { BOT_ID, GUILD_ID, MOD_ID, TARGET_ID, fakeGuild, fakeMember, fakeUser } from "./helpers/moderationFakes.js";

const NOW = 1_700_000_000_000;

describe("temporary bans", () => {
  let store;
  let guild;
  let client;
  let moderation;
  let botActions;
  let scheduler;
  let logger;

  beforeEach(() => {
    store = new CaseStore();
    guild = fakeGuild();
    client = { user: fakeUser(BOT_ID, { tag: "bot" }), guilds: { cache: new Map([[GUILD_ID, guild]]) } };
    botActions = new RecentIds();
    logger = fakeLogger();
    moderation = createModerationService({ store, logger, botActions, now: () => NOW });
    scheduler = createTempBanScheduler({ client, moderation, botActions, logger, now: () => NOW });
  });

  afterEach(() => store.close());

  const tempBan = (expiresAt, userId = TARGET_ID) =>
    store.createCase({ guildId: GUILD_ID, action: CaseAction.BAN, userId, userTag: "member", moderatorId: MOD_ID, expiresAt, pendingUnban: true });

  it("lifts bans that have ended and records an Unban case by the bot", async () => {
    guild.banned.add(TARGET_ID);
    tempBan(NOW - 1);
    tempBan(NOW + 60_000, "300000000000000021");

    await scheduler.sweep();

    expect(guild.members.unban).toHaveBeenCalledTimes(1);
    expect(guild.members.unban).toHaveBeenCalledWith(TARGET_ID, "Temporary ban from case 1 ended");
    expect(store.getCase(GUILD_ID, 3)).toMatchObject({ action: CaseAction.UNBAN, moderatorId: BOT_ID, userTag: "member" });
    expect(store.dueUnbans(NOW)).toEqual([]);
    expect(botActions.has(`${GUILD_ID}:${TARGET_ID}:unban`)).toBe(true);
  });

  it("forgets a ban someone already lifted, without a case", async () => {
    tempBan(NOW - 1);
    await scheduler.sweep();
    expect(store.dueUnbans(NOW)).toEqual([]);
    expect(store.getCase(GUILD_ID, 2)).toBeUndefined();
  });

  it("keeps trying when the bot lacks Ban Members, warning once", async () => {
    tempBan(NOW - 1);
    guild.members.unban.mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    await scheduler.sweep();
    await scheduler.sweep();
    expect(store.dueUnbans(NOW)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("actions done outside the bot", () => {
  let store;
  let guild;
  let botActions;
  let recorder;

  function auditEntry(overrides = {}) {
    return {
      targetId: TARGET_ID,
      executorId: MOD_ID,
      executor: fakeUser(MOD_ID, { tag: "mod" }),
      reason: "raiding",
      createdTimestamp: NOW - 1000,
      changes: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new CaseStore();
    const bot = fakeMember(BOT_ID, { position: 50, permissions: [PermissionFlagsBits.ViewAuditLog] });
    guild = fakeGuild({ bot });
    guild.client = { user: { id: BOT_ID } };
    guild.fetchAuditLogs = vi.fn(async () => ({ entries: [auditEntry()] }));
    botActions = new RecentIds();
    const moderation = createModerationService({ store, logger: fakeLogger(), now: () => NOW });
    recorder = createExternalActionRecorder({ moderation, botActions, logger: fakeLogger(), sleep: async () => {}, now: () => NOW });
  });

  afterEach(() => store.close());

  it("records a ban with the moderator and reason from the audit log", async () => {
    const moderationCase = await recorder.onBan({ guild, user: fakeUser(TARGET_ID) });
    expect(guild.fetchAuditLogs).toHaveBeenCalledWith({ type: AuditLogEvent.MemberBanAdd, limit: 10 });
    expect(moderationCase).toMatchObject({ action: CaseAction.BAN, moderatorId: MOD_ID, moderatorTag: "mod", reason: "raiding" });
  });

  it("skips what the bot did itself", async () => {
    botActions.add(`${GUILD_ID}:${TARGET_ID}:ban`);
    expect(await recorder.onBan({ guild, user: fakeUser(TARGET_ID) })).toBeUndefined();

    guild.fetchAuditLogs.mockResolvedValue({ entries: [auditEntry({ executorId: BOT_ID })] });
    expect(await recorder.onUnban({ guild, user: fakeUser(TARGET_ID) })).toBeUndefined();
    expect(store.getCase(GUILD_ID, 1)).toBeUndefined();
  });

  it("records an unknown moderator without audit log access", async () => {
    guild.members.me = fakeMember(BOT_ID, { position: 50 });
    const moderationCase = await recorder.onBan({ guild, user: fakeUser(TARGET_ID) });
    expect(moderationCase).toMatchObject({ moderatorId: "0", reason: undefined });
    expect(guild.fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("only turns kicks into cases, not members leaving", async () => {
    guild.fetchAuditLogs.mockResolvedValue({ entries: [] });
    expect(await recorder.onMemberRemove({ ...fakeMember(TARGET_ID), guild })).toBeUndefined();

    guild.fetchAuditLogs.mockResolvedValue({ entries: [auditEntry()] });
    expect(await recorder.onMemberRemove({ ...fakeMember(TARGET_ID), guild })).toMatchObject({ action: CaseAction.KICK });
  });

  it("ignores audit log entries about someone else or from long ago", async () => {
    guild.fetchAuditLogs.mockResolvedValue({
      entries: [auditEntry({ targetId: "300000000000000077" }), auditEntry({ createdTimestamp: NOW - 120_000 })],
    });
    expect(await recorder.onMemberRemove({ ...fakeMember(TARGET_ID), guild })).toBeUndefined();
  });

  it("records timeouts set and removed by hand", async () => {
    const change = [{ key: "communication_disabled_until" }];
    guild.fetchAuditLogs.mockResolvedValue({ entries: [auditEntry({ changes: change })] });
    const before = { ...fakeMember(TARGET_ID), guild, partial: false };
    const after = { ...fakeMember(TARGET_ID, { timedOutUntil: NOW + 600_000 }), guild };
    expect(await recorder.onMemberUpdate(before, after)).toMatchObject({
      action: CaseAction.TIMEOUT,
      durationMs: 600_000,
      expiresAt: NOW + 600_000,
    });
    expect(await recorder.onMemberUpdate({ ...after, partial: false }, { ...before })).toMatchObject({ action: CaseAction.UNTIMEOUT });
  });

  it("ignores member updates that don't touch timeouts", async () => {
    const member = { ...fakeMember(TARGET_ID), guild, partial: false };
    expect(await recorder.onMemberUpdate(member, { ...member })).toBeUndefined();
    expect(guild.fetchAuditLogs).not.toHaveBeenCalled();
  });

  it("stops waiting on a temporary ban lifted by hand", async () => {
    store.createCase({ guildId: GUILD_ID, action: CaseAction.BAN, userId: TARGET_ID, moderatorId: MOD_ID, expiresAt: NOW, pendingUnban: true });
    await recorder.onUnban({ guild, user: fakeUser(TARGET_ID) });
    expect(store.dueUnbans(NOW)).toEqual([]);
  });
});
