// Stores reminders (/remind) in the bot's SQLite database. A sent reminder is
// kept for SNOOZE_WINDOW_MS (marked delivered) so its Snooze buttons can set it
// again, then forgotten.

import { openDatabase } from "../storage/database.js";

export const SNOOZE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
      due: db.prepare("SELECT * FROM reminders WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?"),
      listForUser: db.prepare("SELECT * FROM reminders WHERE guild_id = ? AND user_id = ? AND delivered_at IS NULL ORDER BY due_at"),
      countForUser: db.prepare("SELECT COUNT(*) AS total FROM reminders WHERE guild_id = ? AND user_id = ? AND delivered_at IS NULL"),
      deleteForUser: db.prepare("DELETE FROM reminders WHERE id = ? AND guild_id = ? AND user_id = ? AND delivered_at IS NULL"),
      delete: db.prepare("DELETE FROM reminders WHERE id = ?"),
      markDelivered: db.prepare("UPDATE reminders SET delivered_at = ? WHERE id = ?"),
      snooze: db.prepare("UPDATE reminders SET due_at = ?, delivered_at = NULL WHERE id = ? AND user_id = ? AND delivered_at IS NOT NULL AND delivered_at >= ? RETURNING *"),
      forgetDelivered: db.prepare("DELETE FROM reminders WHERE delivered_at IS NOT NULL AND delivered_at < ?"),
      countAllForUser: db.prepare("SELECT COUNT(*) AS total FROM reminders WHERE user_id = ? AND delivered_at IS NULL"),
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

  // Marks a reminder sent; it stays a while so it can be snoozed.
  markDelivered(id, at) {
    this.#statements.markDelivered.run(at, id);
  }

  // Sets a sent reminder again for `dueAt`. Only its owner can, and only
  // within SNOOZE_WINDOW_MS of it being sent. Returns the reminder, or undefined.
  snooze(id, userId, dueAt, now) {
    return toReminder(this.#statements.snooze.get(dueAt, id, userId, now - SNOOZE_WINDOW_MS));
  }

  // Forgets reminders sent before `before`. Returns how many.
  forgetDeliveredBefore(before) {
    return Number(this.#statements.forgetDelivered.run(before).changes);
  }

  // Every server's waiting reminders of one member.
  countAllForUser(userId) {
    return Number(this.#statements.countAllForUser.get(userId).total);
  }
}
