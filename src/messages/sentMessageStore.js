// Messages posted from the dashboard's embed builder (data/bot.db, table
// sent_messages), so staff can find and edit them again. Newest 100 per server.

import { inTransaction, openDatabase } from "../storage/database.js";

export const SENT_KEEP = 100;

const toSent = (row) =>
  row
    ? {
        guildId: row.guild_id,
        channelId: row.channel_id,
        messageId: row.message_id,
        summary: row.summary,
        sentBy: row.sent_by,
        sentAt: row.sent_at,
        editedBy: row.edited_by ?? null,
        editedAt: row.edited_at ?? null,
      }
    : undefined;

export class SentMessageStore {
  #db;
  #statements;

  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: this.#db.prepare(`
        INSERT INTO sent_messages (guild_id, channel_id, message_id, summary, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, message_id) DO UPDATE SET summary = excluded.summary`),
      edited: this.#db.prepare("UPDATE sent_messages SET summary = ?, edited_by = ?, edited_at = ? WHERE guild_id = ? AND message_id = ?"),
      list: this.#db.prepare("SELECT * FROM sent_messages WHERE guild_id = ? ORDER BY sent_at DESC LIMIT ?"),
      get: this.#db.prepare("SELECT * FROM sent_messages WHERE guild_id = ? AND message_id = ?"),
      prune: this.#db.prepare(`
        DELETE FROM sent_messages WHERE guild_id = ? AND message_id NOT IN (
          SELECT message_id FROM sent_messages WHERE guild_id = ? ORDER BY sent_at DESC LIMIT ?)`),
      delete: this.#db.prepare("DELETE FROM sent_messages WHERE guild_id = ? AND message_id = ?"),
    };
  }

  add({ guildId, channelId, messageId, summary, sentBy, sentAt = Date.now() }) {
    inTransaction(this.#db, () => {
      this.#statements.insert.run(guildId, channelId, messageId, summary, sentBy, sentAt);
      this.#statements.prune.run(guildId, guildId, SENT_KEEP);
    });
    return this.get(guildId, messageId);
  }

  // Returns false if the message wasn't sent from the dashboard.
  edited(guildId, messageId, { summary, editedBy, editedAt = Date.now() }) {
    return this.#statements.edited.run(summary, editedBy, editedAt, guildId, messageId).changes > 0;
  }

  get(guildId, messageId) {
    return toSent(this.#statements.get.get(guildId, messageId));
  }

  list(guildId, limit = 25) {
    return this.#statements.list.all(guildId, limit).map(toSent);
  }

  delete(guildId, messageId) {
    this.#statements.delete.run(guildId, messageId);
  }
}
