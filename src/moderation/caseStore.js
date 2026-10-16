// Stores moderation cases in SQLite (data/bot.db), using Node's built-in
// node:sqlite module, so there's no database server or native package to
// install. Every server numbers its cases 1, 2, 3… and a number is never
// reused, even after a case is deleted.
//
// Without a file path (tests, `npm run register`) the database lives in memory.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const DEFAULT_DATABASE_FILE = fileURLToPath(new URL("../../data/bot.db", import.meta.url));

// What a case records.
export const CaseAction = Object.freeze({
  BAN: "ban",
  UNBAN: "unban",
  KICK: "kick",
  TIMEOUT: "timeout",
  UNTIMEOUT: "untimeout",
  WARN: "warn",
});

// Each entry upgrades the database by one version. Never edit a released
// migration; add a new one instead.
const MIGRATIONS = [
  `
  CREATE TABLE guild_counters (
    guild_id  TEXT PRIMARY KEY,
    last_case INTEGER NOT NULL
  );
  CREATE TABLE cases (
    guild_id       TEXT    NOT NULL,
    case_number    INTEGER NOT NULL,
    action         TEXT    NOT NULL,
    user_id        TEXT    NOT NULL,
    user_tag       TEXT,
    moderator_id   TEXT    NOT NULL,
    moderator_tag  TEXT,
    reason         TEXT,
    duration_ms    INTEGER,
    expires_at     INTEGER,
    pending_unban  INTEGER NOT NULL DEFAULT 0,
    dm_sent        INTEGER,
    log_channel_id TEXT,
    log_message_id TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER,
    PRIMARY KEY (guild_id, case_number)
  );
  CREATE INDEX cases_by_user ON cases (guild_id, user_id, case_number);
  CREATE INDEX cases_pending_unban ON cases (expires_at) WHERE pending_unban = 1;
  `,
];

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
  #statements;

  constructor(file = ":memory:") {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.#db = new DatabaseSync(file);
    // WAL lets another process (the future dashboard) read while the bot writes.
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#migrate();
    this.#statements = this.#prepare();
  }

  #migrate() {
    const { user_version: version } = this.#db.prepare("PRAGMA user_version").get();
    for (let next = version; next < MIGRATIONS.length; next += 1) {
      this.#transaction(() => {
        this.#db.exec(MIGRATIONS[next]);
        this.#db.exec(`PRAGMA user_version = ${next + 1}`);
      });
    }
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
      countForUser: db.prepare(
        "SELECT action, COUNT(*) AS total FROM cases WHERE guild_id = ? AND user_id = ? GROUP BY action",
      ),
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

  #transaction(work) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
    const number = this.#transaction(() => {
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

  // Temporary bans whose time is up, oldest first.
  dueUnbans(now = Date.now(), limit = 50) {
    return this.#statements.dueUnbans.all(now, limit).map(toCase);
  }

  // Stops waiting to unban this member (they were unbanned, or the timer did it).
  clearPendingUnbans(guildId, userId) {
    return this.#statements.clearPendingUnbans.run(guildId, userId).changes;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      // Already closed.
    }
  }
}
