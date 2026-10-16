// Stores moderation cases in the bot's SQLite database (see storage/database.js).
// Every server numbers its cases 1, 2, 3… and a number is never reused, even
// after a case is deleted.

import { closeDatabase, inTransaction, openDatabase } from "../storage/database.js";

// What a case records.
export const CaseAction = Object.freeze({
  BAN: "ban",
  SOFTBAN: "softban",
  UNBAN: "unban",
  KICK: "kick",
  TIMEOUT: "timeout",
  UNTIMEOUT: "untimeout",
  WARN: "warn",
  NOTE: "note",
});

function toCase(row) {
  if (!row) {
    return undefined;
  }
  return {
    guildId: row.guild_id,
    number: row.case_number,
    action: row.action,
    userId: row.user_id,
    userTag: row.user_tag ?? undefined,
    moderatorId: row.moderator_id,
    moderatorTag: row.moderator_tag ?? undefined,
    reason: row.reason ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    pendingUnban: row.pending_unban === 1,
    dmSent: row.dm_sent === null ? undefined : row.dm_sent === 1,
    logChannelId: row.log_channel_id ?? undefined,
    logMessageId: row.log_message_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}

const orNull = (value) => (value === undefined ? null : value);

export class CaseStore {
  #db;
  #ownsDatabase;
  #statements;

  // `database` is an open database (shared with the settings), or a file path
  // to open. Without one, cases live in memory (tests).
  constructor(database = ":memory:") {
    this.#ownsDatabase = typeof database === "string";
    this.#db = this.#ownsDatabase ? openDatabase(database) : database;
    this.#statements = this.#prepare();
  }

  #prepare() {
    const db = this.#db;
    return {
      nextNumber: db.prepare(`
        INSERT INTO guild_counters (guild_id, last_case) VALUES (?, 1)
        ON CONFLICT (guild_id) DO UPDATE SET last_case = last_case + 1
        RETURNING last_case`),
      insert: db.prepare(`
        INSERT INTO cases (guild_id, case_number, action, user_id, user_tag, moderator_id, moderator_tag,
                           reason, duration_ms, expires_at, pending_unban, dm_sent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: db.prepare("SELECT * FROM cases WHERE guild_id = ? AND case_number = ?"),
      listForUser: db.prepare(
        "SELECT * FROM cases WHERE guild_id = ? AND user_id = ? ORDER BY case_number DESC LIMIT ?",
      ),
      // For the dashboard: newest first, optionally one member or one action,
      // starting below case `before`. NULL filters match everything.
      search: db.prepare(`
        SELECT * FROM cases
        WHERE guild_id = :guildId
          AND (:userId IS NULL OR user_id = :userId)
          AND (:action IS NULL OR action = :action)
          AND case_number < :before
        ORDER BY case_number DESC LIMIT :limit`),
      countForGuild: db.prepare("SELECT action, COUNT(*) AS total FROM cases WHERE guild_id = ? GROUP BY action"),
      countForUser: db.prepare(
        "SELECT action, COUNT(*) AS total FROM cases WHERE guild_id = ? AND user_id = ? GROUP BY action",
      ),
      deleteForUser: db.prepare("DELETE FROM cases WHERE guild_id = ? AND user_id = ? AND action = ?"),
      updateReason: db.prepare(
        "UPDATE cases SET reason = ?, updated_at = ? WHERE guild_id = ? AND case_number = ?",
      ),
      setDmSent: db.prepare("UPDATE cases SET dm_sent = ? WHERE guild_id = ? AND case_number = ?"),
      setLogMessage: db.prepare(
        "UPDATE cases SET log_channel_id = ?, log_message_id = ? WHERE guild_id = ? AND case_number = ?",
      ),
      delete: db.prepare("DELETE FROM cases WHERE guild_id = ? AND case_number = ?"),
      dueUnbans: db.prepare(
        "SELECT * FROM cases WHERE pending_unban = 1 AND expires_at <= ? ORDER BY expires_at LIMIT ?",
      ),
      clearPendingUnbans: db.prepare(
        "UPDATE cases SET pending_unban = 0 WHERE guild_id = ? AND user_id = ? AND pending_unban = 1",
      ),
    };
  }

  // Records a case and returns it with its new number.
  createCase({
    guildId,
    action,
    userId,
    userTag,
    moderatorId,
    moderatorTag,
    reason,
    durationMs,
    expiresAt,
    pendingUnban = false,
    dmSent,
    createdAt = Date.now(),
  }) {
    if (!Object.values(CaseAction).includes(action)) {
      throw new Error(`Unknown case action "${action}"`);
    }
    const number = inTransaction(this.#db, () => {
      const { last_case: next } = this.#statements.nextNumber.get(guildId);
      this.#statements.insert.run(
        guildId,
        next,
        action,
        userId,
        orNull(userTag),
        moderatorId,
        orNull(moderatorTag),
        orNull(reason),
        orNull(durationMs),
        orNull(expiresAt),
        pendingUnban ? 1 : 0,
        dmSent === undefined ? null : dmSent ? 1 : 0,
        createdAt,
      );
      return next;
    });
    return this.getCase(guildId, number);
  }

  getCase(guildId, number) {
    return toCase(this.#statements.get.get(guildId, number));
  }

  // The member's most recent cases, newest first.
  listCases(guildId, userId, limit = 25) {
    return this.#statements.listForUser.all(guildId, userId, limit).map(toCase);
  }

  // { ban: 1, warn: 3, … } for one member.
  countCases(guildId, userId) {
    return Object.fromEntries(this.#statements.countForUser.all(guildId, userId).map((row) => [row.action, row.total]));
  }

  // A page of a server's cases, newest first. `before` is the lowest case
  // number of the previous page.
  searchCases(guildId, { userId, action, before, limit = 50 } = {}) {
    return this.#statements.search
      .all({
        guildId,
        userId: userId ?? null,
        action: action ?? null,
        before: before ?? Number.MAX_SAFE_INTEGER,
        limit,
      })
      .map(toCase);
  }

  // { ban: 4, warn: 12, … } for the whole server.
  countGuildCases(guildId) {
    return Object.fromEntries(this.#statements.countForGuild.all(guildId).map((row) => [row.action, row.total]));
  }

  // The updated case, or undefined if it doesn't exist.
  updateReason(guildId, number, reason, updatedAt = Date.now()) {
    const { changes } = this.#statements.updateReason.run(orNull(reason), updatedAt, guildId, number);
    return changes > 0 ? this.getCase(guildId, number) : undefined;
  }

  setDmSent(guildId, number, dmSent) {
    this.#statements.setDmSent.run(dmSent ? 1 : 0, guildId, number);
  }

  // Remembers where the case was posted, so a reason edit can update the post.
  setLogMessage(guildId, number, channelId, messageId) {
    this.#statements.setLogMessage.run(channelId, messageId, guildId, number);
  }

  // Whether a case was deleted.
  deleteCase(guildId, number) {
    return this.#statements.delete.run(guildId, number).changes > 0;
  }

  // Deletes all of a member's cases of one kind (/clearwarns). Returns how many.
  deleteCasesOfUser(guildId, userId, action) {
    return Number(this.#statements.deleteForUser.run(guildId, userId, action).changes);
  }

  // Temporary bans whose time is up, oldest first.
  dueUnbans(now = Date.now(), limit = 50) {
    return this.#statements.dueUnbans.all(now, limit).map(toCase);
  }

  // Stops waiting to unban this member (they were unbanned, or the timer did it).
  clearPendingUnbans(guildId, userId) {
    return this.#statements.clearPendingUnbans.run(guildId, userId).changes;
  }

  // Closes the database if this store opened it.
  close() {
    if (this.#ownsDatabase) {
      closeDatabase(this.#db);
    }
  }
}
