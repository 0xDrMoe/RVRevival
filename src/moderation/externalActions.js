// Records bans, unbans, kicks and timeouts done outside the bot (right-click >
// Ban in Discord, another bot…) as cases, so the mod log and /modlogs show
// everything. The moderator and reason come from the server's audit log, which
// needs the View Audit Log permission; without it the moderator shows as unknown.
// Kicks can only be told apart from members leaving through the audit log.

import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import { CaseAction } from "./caseStore.js";

// Discord writes the audit log entry a moment after sending the event.
const AUDIT_LOG_DELAY_MS = 1500;
// Entries older than this belong to an earlier action.
const AUDIT_LOG_MAX_AGE_MS = 30_000;

export const UNKNOWN_MODERATOR = Object.freeze({ id: "0", tag: "Unknown (the bot can't read the audit log)" });

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Options:
//   moderation   the moderation service (see moderationService.js)
//   botActions   what the bot did itself (RecentIds), which is already recorded
//   logger
//   sleep, now   replaceable in tests
export function createExternalActionRecorder({ moderation, botActions, logger, sleep = sleepFor, now = Date.now }) {
  const isOwnAction = (guild, userId, action) => Boolean(botActions?.has(`${guild.id}:${userId}:${action}`));

  // The newest matching audit log entry about `targetId`, undefined if there's
  // none or the bot can't read the audit log.
  async function findAuditEntry(guild, type, targetId, matches = () => true) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      return undefined;
    }
    await sleep(AUDIT_LOG_DELAY_MS);
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 10 });
      return logs.entries.find(
        (entry) =>
          entry.targetId === targetId && now() - entry.createdTimestamp < AUDIT_LOG_MAX_AGE_MS && matches(entry),
      );
    } catch (error) {
      logger.warn("Couldn't read the audit log", { guildId: guild.id, error });
      return undefined;
    }
  }

  // Records the case unless the bot did it itself (by command or temporary ban).
  async function record(guild, entry, details) {
    const botId = guild.client?.user?.id ?? guild.members.me?.id;
    if (entry?.executorId && entry.executorId === botId) {
      return undefined;
    }
    const moderator = entry?.executor ?? (entry?.executorId ? { id: entry.executorId } : UNKNOWN_MODERATOR);
    return moderation.recordCase({ guild, moderator, reason: entry?.reason ?? undefined, ...details });
  }

  return {
    async onBan(ban) {
      const { guild, user } = ban;
      if (isOwnAction(guild, user.id, CaseAction.BAN)) {
        return undefined;
      }
      const entry = await findAuditEntry(guild, AuditLogEvent.MemberBanAdd, user.id);
      return record(guild, entry, { action: CaseAction.BAN, user });
    },

    async onUnban(ban) {
      const { guild, user } = ban;
      // A temporary ban no longer needs lifting, whoever unbanned them.
      moderation.store.clearPendingUnbans(guild.id, user.id);
      if (isOwnAction(guild, user.id, CaseAction.UNBAN)) {
        return undefined;
      }
      const entry = await findAuditEntry(guild, AuditLogEvent.MemberBanRemove, user.id);
      return record(guild, entry, { action: CaseAction.UNBAN, user });
    },

    // Called for every member who leaves; only kicks become cases.
    async onMemberRemove(member) {
      const { guild, user } = member;
      if (!user || isOwnAction(guild, user.id, CaseAction.KICK)) {
        return undefined;
      }
      const entry = await findAuditEntry(guild, AuditLogEvent.MemberKick, user.id);
      return entry ? record(guild, entry, { action: CaseAction.KICK, user }) : undefined;
    },

    // Called for every member update; only timeout changes become cases.
    async onMemberUpdate(oldMember, newMember) {
      if (oldMember.partial) {
        return undefined;
      }
      const before = oldMember.communicationDisabledUntilTimestamp ?? 0;
      const after = newMember.communicationDisabledUntilTimestamp ?? 0;
      if (before === after) {
        return undefined;
      }
      const timedOut = after > now();
      // A timeout that had already run out being cleared isn't worth a case.
      if (!timedOut && before <= now()) {
        return undefined;
      }
      const { guild, user } = newMember;
      const action = timedOut ? CaseAction.TIMEOUT : CaseAction.UNTIMEOUT;
      if (isOwnAction(guild, user.id, action)) {
        return undefined;
      }
      const entry = await findAuditEntry(guild, AuditLogEvent.MemberUpdate, user.id, (candidate) =>
        candidate.changes?.some((change) => change.key === "communication_disabled_until"),
      );
      const details = timedOut ? { durationMs: after - now(), expiresAt: after } : {};
      return record(guild, entry, { action, user, ...details });
    },
  };
}
