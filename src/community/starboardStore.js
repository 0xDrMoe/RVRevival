// Remembers which messages are on the starboard (/starboard) and which
// starboard post shows each one, in the bot's SQLite database.

import { openDatabase } from "../storage/database.js";

function toPost(row) {
  return row
    ? {
        messageId: row.message_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        starMessageId: row.star_message_id ?? null,
        stars: row.stars,
        removed: row.removed === 1,
      }
    : undefined;
}

export class StarboardStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      get: db.prepare("SELECT * FROM starboard_posts WHERE message_id = ?"),
      byStarMessage: db.prepare("SELECT * FROM starboard_posts WHERE star_message_id = ?"),
      save: db.prepare(`
        INSERT INTO starboard_posts (message_id, guild_id, channel_id, star_message_id, stars)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (message_id) DO UPDATE SET star_message_id = excluded.star_message_id, stars = excluded.stars`),
      markRemoved: db.prepare("UPDATE starboard_posts SET removed = 1, star_message_id = NULL WHERE message_id = ?"),
      delete: db.prepare("DELETE FROM starboard_posts WHERE message_id = ?"),
    };
  }

  // The starboard entry for an original message.
  get(messageId) {
    return toPost(this.#statements.get.get(messageId));
  }

  // The starboard entry shown by a post in the starboard channel.
  byStarMessage(starMessageId) {
    return toPost(this.#statements.byStarMessage.get(starMessageId));
  }

  save({ messageId, guildId, channelId, starMessageId, stars }) {
    this.#statements.save.run(messageId, guildId, channelId, starMessageId, stars);
  }

  // Staff deleted the starboard post: the message never goes back on the board.
  markRemoved(messageId) {
    this.#statements.markRemoved.run(messageId);
  }

  delete(messageId) {
    this.#statements.delete.run(messageId);
  }
}
