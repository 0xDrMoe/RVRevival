// Stores scheduled messages (/schedule) in the bot's SQLite database.

import { openDatabase } from "../storage/database.js";

function toScheduled(row) {
  return row
    ? {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        content: row.content,
        nextAt: row.next_at,
        intervalMs: row.interval_ms ?? null,
        allowMentions: row.allow_mentions === 1,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }
    : undefined;
}

export class ScheduledMessageStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO scheduled_messages (guild_id, channel_id, content, next_at, interval_ms, allow_mentions, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      get: db.prepare("SELECT * FROM scheduled_messages WHERE id = ? AND guild_id = ?"),
      list: db.prepare("SELECT * FROM scheduled_messages WHERE guild_id = ? ORDER BY next_at, id"),
      count: db.prepare("SELECT COUNT(*) AS total FROM scheduled_messages WHERE guild_id = ?"),
      due: db.prepare("SELECT * FROM scheduled_messages WHERE next_at <= ? ORDER BY next_at LIMIT ?"),
      reschedule: db.prepare("UPDATE scheduled_messages SET next_at = ? WHERE id = ?"),
      delete: db.prepare("DELETE FROM scheduled_messages WHERE id = ?"),
      deleteInGuild: db.prepare("DELETE FROM scheduled_messages WHERE id = ? AND guild_id = ?"),
    };
  }

  add({ guildId, channelId, content, nextAt, intervalMs = null, allowMentions = false, createdBy, createdAt = Date.now() }) {
    return toScheduled(
      this.#statements.insert.get(guildId, channelId, content, nextAt, intervalMs, allowMentions ? 1 : 0, createdBy, createdAt),
    );
  }

  get(guildId, id) {
    return toScheduled(this.#statements.get.get(id, guildId));
  }

  // A server's scheduled messages, next first.
  list(guildId) {
    return this.#statements.list.all(guildId).map(toScheduled);
  }

  count(guildId) {
    return this.#statements.count.get(guildId).total;
  }

  // Messages whose time has come, oldest first.
  due(now, limit = 100) {
    return this.#statements.due.all(now, limit).map(toScheduled);
  }

  reschedule(id, nextAt) {
    this.#statements.reschedule.run(nextAt, id);
  }

  delete(id) {
    this.#statements.delete.run(id);
  }

  // Deletes one of a server's messages. Returns whether it existed.
  deleteInGuild(guildId, id) {
    return this.#statements.deleteInGuild.run(id, guildId).changes > 0;
  }
}
