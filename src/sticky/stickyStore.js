// Sticky messages (/sticky and the dashboard's Sticky messages page) in
// data/bot.db, table stickies. One per channel.

import { openDatabase } from "../storage/database.js";

export const MAX_STICKIES = 10;
export const MAX_STICKY_LENGTH = 1500;

const toSticky = (row) =>
  row
    ? { channelId: row.channel_id, guildId: row.guild_id, content: row.content, messageId: row.message_id ?? null, createdBy: row.created_by, updatedAt: row.updated_at }
    : undefined;

export class StickyStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      set: db.prepare(`
        INSERT INTO stickies (channel_id, guild_id, content, message_id, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (channel_id) DO UPDATE SET content = excluded.content, message_id = excluded.message_id, created_by = excluded.created_by, updated_at = excluded.updated_at`),
      get: db.prepare("SELECT * FROM stickies WHERE channel_id = ?"),
      list: db.prepare("SELECT * FROM stickies WHERE guild_id = ? ORDER BY updated_at"),
      count: db.prepare("SELECT COUNT(*) AS total FROM stickies WHERE guild_id = ?"),
      posted: db.prepare("UPDATE stickies SET message_id = ? WHERE channel_id = ?"),
      delete: db.prepare("DELETE FROM stickies WHERE channel_id = ? RETURNING *"),
    };
  }

  set({ channelId, guildId, content, messageId = null, createdBy, updatedAt = Date.now() }) {
    this.#statements.set.run(channelId, guildId, content, messageId, createdBy, updatedAt);
    return this.get(channelId);
  }

  get(channelId) {
    return toSticky(this.#statements.get.get(channelId));
  }

  list(guildId) {
    return this.#statements.list.all(guildId).map(toSticky);
  }

  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }

  posted(channelId, messageId) {
    this.#statements.posted.run(messageId, channelId);
  }

  // The removed sticky, or undefined.
  delete(channelId) {
    return toSticky(this.#statements.delete.get(channelId));
  }
}
