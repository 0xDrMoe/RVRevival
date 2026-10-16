// Stores support tickets (/tickets) in the bot's SQLite database. Each ticket
// is a private thread; the row remembers who opened it, why, and how it ended.

import { inTransaction, openDatabase } from "../storage/database.js";

function toTicket(row) {
  return row
    ? {
        id: row.id,
        guildId: row.guild_id,
        number: row.number,
        userId: row.user_id,
        threadId: row.thread_id ?? null,
        subject: row.subject,
        createdAt: row.created_at,
        closedAt: row.closed_at ?? null,
        closedBy: row.closed_by ?? null,
        closeReason: row.close_reason ?? null,
      }
    : undefined;
}

export class TicketStore {
  #db;
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      nextNumber: this.#db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tickets WHERE guild_id = ?"),
      insert: this.#db.prepare(`
        INSERT INTO tickets (guild_id, number, user_id, subject, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *`),
      get: this.#db.prepare("SELECT * FROM tickets WHERE id = ?"),
      openForUser: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND closed_at IS NULL"),
      byThread: this.#db.prepare("SELECT * FROM tickets WHERE thread_id = ?"),
      listOpen: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND closed_at IS NULL ORDER BY number"),
      countOpen: this.#db.prepare("SELECT COUNT(*) AS total FROM tickets WHERE guild_id = ? AND closed_at IS NULL"),
      setThread: this.#db.prepare("UPDATE tickets SET thread_id = ? WHERE id = ?"),
      close: this.#db.prepare(`
        UPDATE tickets SET closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL RETURNING *`),
      delete: this.#db.prepare("DELETE FROM tickets WHERE id = ?"),
      listForUser: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? ORDER BY number DESC LIMIT ?"),
    };
  }

  // Opens a ticket for the member, or returns undefined if they already have
  // one open. Checked and saved together, so two clicks can't open two.
  open({ guildId, userId, subject, createdAt = Date.now() }) {
    return inTransaction(this.#db, () => {
      if (this.#statements.openForUser.get(guildId, userId)) {
        return undefined;
      }
      const { next } = this.#statements.nextNumber.get(guildId);
      return toTicket(this.#statements.insert.get(guildId, next, userId, subject, createdAt));
    });
  }

  get(id) {
    return toTicket(this.#statements.get.get(id));
  }

  openForUser(guildId, userId) {
    return toTicket(this.#statements.openForUser.get(guildId, userId));
  }

  byThread(threadId) {
    return toTicket(this.#statements.byThread.get(threadId));
  }

  listOpen(guildId) {
    return this.#statements.listOpen.all(guildId).map(toTicket);
  }

  countOpen(guildId) {
    return Number(this.#statements.countOpen.get(guildId).total);
  }

  // A member's newest tickets, open or closed.
  listForUser(guildId, userId, limit = 20) {
    return this.#statements.listForUser.all(guildId, userId, limit).map(toTicket);
  }

  setThread(id, threadId) {
    this.#statements.setThread.run(threadId, id);
  }

  // Closes an open ticket. Returns the closed ticket, or undefined if it was
  // already closed (so it's only announced once).
  close(id, { closedBy = null, reason = null, closedAt = Date.now() } = {}) {
    return toTicket(this.#statements.close.get(closedAt, closedBy, reason, id));
  }

  // For a ticket whose thread couldn't be made.
  delete(id) {
    this.#statements.delete.run(id);
  }
}
