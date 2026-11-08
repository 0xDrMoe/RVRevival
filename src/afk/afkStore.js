// Members who are away (/afk) in data/bot.db, table afk.

import { openDatabase } from "../storage/database.js";

// What the bot did to the member's nickname: nothing, put "[AFK] " in front of
// their nickname, or gave them "[AFK] <display name>" when they had none.
export const NicknameChange = Object.freeze({ NONE: 0, PREFIXED: 1, ADDED: 2 });

const toAfk = (row) =>
  row ? { guildId: row.guild_id, userId: row.user_id, message: row.message ?? null, since: row.since, nickname: row.nickname } : undefined;

export class AfkStore {
  #statements;
  // "<server>:<member>" for everyone away, so the check on every chat message
  // (are they back? is someone they mention away?) needs no database query or
  // write. Only the bot writes this table, through this store.
  #away = new Set();

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      keys: db.prepare("SELECT guild_id, user_id FROM afk"),
      set: db.prepare(`
        INSERT INTO afk (guild_id, user_id, message, since, nickname) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET message = excluded.message, since = excluded.since, nickname = excluded.nickname`),
      get: db.prepare("SELECT * FROM afk WHERE guild_id = ? AND user_id = ?"),
      delete: db.prepare("DELETE FROM afk WHERE guild_id = ? AND user_id = ? RETURNING *"),
      count: db.prepare("SELECT COUNT(*) AS total FROM afk WHERE guild_id = ?"),
    };
    for (const row of this.#statements.keys.all()) {
      this.#away.add(`${row.guild_id}:${row.user_id}`);
    }
  }

  // `nickname`: NicknameChange.
  set({ guildId, userId, message = null, since = Date.now(), nickname = NicknameChange.NONE }) {
    this.#statements.set.run(guildId, userId, message, since, nickname);
    this.#away.add(`${guildId}:${userId}`);
  }

  get(guildId, userId) {
    if (!this.#away.has(`${guildId}:${userId}`)) {
      return undefined;
    }
    return toAfk(this.#statements.get.get(guildId, userId));
  }

  // The removed entry, or undefined if they weren't away.
  delete(guildId, userId) {
    if (!this.#away.delete(`${guildId}:${userId}`)) {
      return undefined;
    }
    return toAfk(this.#statements.delete.get(guildId, userId));
  }

  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }
}
