// Highlight words (/highlight) in data/bot.db, table highlights.

import { openDatabase } from "../storage/database.js";

export const MAX_HIGHLIGHTS = 10;
export const MIN_WORD_LENGTH = 2;
export const MAX_WORD_LENGTH = 50;

export class HighlightStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      add: db.prepare("INSERT OR IGNORE INTO highlights (guild_id, user_id, word) VALUES (?, ?, ?)"),
      remove: db.prepare("DELETE FROM highlights WHERE guild_id = ? AND user_id = ? AND word = ?"),
      clear: db.prepare("DELETE FROM highlights WHERE guild_id = ? AND user_id = ?"),
      words: db.prepare("SELECT word FROM highlights WHERE guild_id = ? AND user_id = ? ORDER BY word"),
      guild: db.prepare("SELECT user_id, word FROM highlights WHERE guild_id = ?"),
    };
  }

  // Whether it was new.
  add(guildId, userId, word) {
    return this.#statements.add.run(guildId, userId, word).changes > 0;
  }

  remove(guildId, userId, word) {
    return this.#statements.remove.run(guildId, userId, word).changes > 0;
  }

  clear(guildId, userId) {
    return this.#statements.clear.run(guildId, userId).changes;
  }

  words(guildId, userId) {
    return this.#statements.words.all(guildId, userId).map((row) => row.word);
  }

  // Every word on the server: [{ userId, word }].
  forGuild(guildId) {
    return this.#statements.guild.all(guildId).map((row) => ({ userId: row.user_id, word: row.word }));
  }
}
