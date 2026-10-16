// Stores reminders (/remind) in the bot's SQLite database until they're sent.

import { openDatabase } from "../storage/database.js";

function toReminder(row) {
  return row
    ? {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        userId: row.user_id,
        text: row.text,
        private: row.private === 1,
        createdAt: row.created_at,
        dueAt: row.due_at,
      }
    : undefined;
}

export class ReminderStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO reminders (guild_id, channel_id, user_id, text, private, created_at, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      due: db.prepare("SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT ?"),
      listForUser: db.prepare("SELECT * FROM reminders WHERE guild_id = ? AND user_id = ? ORDER BY due_at"),
      countForUser: db.prepare("SELECT COUNT(*) AS total FROM reminders WHERE guild_id = ? AND user_id = ?"),
      deleteForUser: db.prepare("DELETE FROM reminders WHERE id = ? AND guild_id = ? AND user_id = ?"),
      delete: db.prepare("DELETE FROM reminders WHERE id = ?"),
    };
  }

  add({ guildId, channelId, userId, text, private: isPrivate = false, createdAt, dueAt }) {
    return toReminder(
      this.#statements.insert.get(guildId, channelId, userId, text, isPrivate ? 1 : 0, createdAt, dueAt),
    );
  }

  // Reminders whose time has come, oldest first.
  due(now, limit = 100) {
    return this.#statements.due.all(now, limit).map(toReminder);
  }

  listForUser(guildId, userId) {
    return this.#statements.listForUser.all(guildId, userId).map(toReminder);
  }

  countForUser(guildId, userId) {
    return this.#statements.countForUser.get(guildId, userId).total;
  }

  // Deletes one of a member's own reminders. Returns whether it existed.
  deleteForUser(id, guildId, userId) {
    return this.#statements.deleteForUser.run(id, guildId, userId).changes > 0;
  }

  delete(id) {
    this.#statements.delete.run(id);
  }
}
