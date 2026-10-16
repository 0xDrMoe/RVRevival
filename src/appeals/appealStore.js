// Ban appeals (data/bot.db, table ban_appeals), numbered per server.

import { inTransaction, openDatabase } from "../storage/database.js";

export const AppealStatus = Object.freeze({ OPEN: "open", ACCEPTED: "accepted", DENIED: "denied" });
export const APPEAL_STATUSES = Object.values(AppealStatus);

function parseAnswers(text) {
  try {
    const answers = JSON.parse(text);
    return Array.isArray(answers) ? answers.filter((entry) => entry && typeof entry.answer === "string") : [];
  } catch {
    return [];
  }
}

const toAppeal = (row) =>
  row
    ? {
        guildId: row.guild_id,
        number: row.number,
        userId: row.user_id,
        userTag: row.user_tag ?? null,
        banReason: row.ban_reason ?? null,
        answers: parseAnswers(row.answers),
        status: row.status,
        createdAt: row.created_at,
        decidedAt: row.decided_at ?? null,
        decidedBy: row.decided_by ?? null,
        decisionReason: row.decision_reason ?? null,
      }
    : undefined;

export class AppealStore {
  #db;
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      next: this.#db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM ban_appeals WHERE guild_id = ?"),
      insert: this.#db.prepare(`
        INSERT INTO ban_appeals (guild_id, number, user_id, user_tag, ban_reason, answers, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?) RETURNING *`),
      get: this.#db.prepare("SELECT * FROM ban_appeals WHERE guild_id = ? AND number = ?"),
      latestFor: this.#db.prepare("SELECT * FROM ban_appeals WHERE guild_id = ? AND user_id = ? ORDER BY number DESC LIMIT 1"),
      list: this.#db.prepare("SELECT * FROM ban_appeals WHERE guild_id = ? ORDER BY number DESC LIMIT ? OFFSET ?"),
      listByStatus: this.#db.prepare("SELECT * FROM ban_appeals WHERE guild_id = ? AND status = ? ORDER BY number DESC LIMIT ? OFFSET ?"),
      countOpen: this.#db.prepare("SELECT COUNT(*) AS total FROM ban_appeals WHERE guild_id = ? AND status = 'open'"),
      decide: this.#db.prepare(`
        UPDATE ban_appeals SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?
        WHERE guild_id = ? AND number = ? AND status = 'open' RETURNING *`),
    };
  }

  add({ guildId, userId, userTag = null, banReason = null, answers, createdAt = Date.now() }) {
    return inTransaction(this.#db, () => {
      const { next } = this.#statements.next.get(guildId);
      return toAppeal(this.#statements.insert.get(guildId, next, userId, userTag, banReason, JSON.stringify(answers), createdAt));
    });
  }

  get(guildId, number) {
    return toAppeal(this.#statements.get.get(guildId, number));
  }

  latestFor(guildId, userId) {
    return toAppeal(this.#statements.latestFor.get(guildId, userId));
  }

  // Newest first; `status` narrows it down.
  list(guildId, { status, limit = 25, offset = 0 } = {}) {
    const rows = status ? this.#statements.listByStatus.all(guildId, status, limit, offset) : this.#statements.list.all(guildId, limit, offset);
    return rows.map(toAppeal);
  }

  countOpen(guildId) {
    return Number(this.#statements.countOpen.get(guildId).total);
  }

  // Accepts or denies an open appeal. Returns it, or undefined if it wasn't open
  // (someone else decided first).
  decide(guildId, number, { status, decidedBy, reason = null, decidedAt = Date.now() }) {
    if (status !== AppealStatus.ACCEPTED && status !== AppealStatus.DENIED) {
      throw new Error(`Unknown decision "${status}"`);
    }
    return toAppeal(this.#statements.decide.get(status, decidedAt, decidedBy, reason, guildId, number));
  }
}
