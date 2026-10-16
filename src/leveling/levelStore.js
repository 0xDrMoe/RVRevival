// Stores each member's XP (data/bot.db, table member_xp). Levels are worked
// out from the XP (leveling/config.js), so changing the formula never needs a
// migration.

import { openDatabase } from "../storage/database.js";

function toEntry(row) {
  return row
    ? {
        guildId: row.guild_id,
        userId: row.user_id,
        userTag: row.user_tag ?? null,
        xp: Number(row.xp),
        messages: Number(row.messages),
        lastXpAt: Number(row.last_xp_at),
      }
    : undefined;
}

export class LevelStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      get: db.prepare("SELECT * FROM member_xp WHERE guild_id = ? AND user_id = ?"),
      // Adds XP unless the member earned some within the cooldown. No row back means "on cooldown".
      award: db.prepare(`
        INSERT INTO member_xp (guild_id, user_id, user_tag, xp, messages, last_xp_at)
        VALUES (:guildId, :userId, :userTag, :amount, 1, :now)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET
          xp = xp + excluded.xp, messages = messages + 1, last_xp_at = excluded.last_xp_at, user_tag = excluded.user_tag
        WHERE member_xp.last_xp_at <= :cutoff
        RETURNING xp`),
      set: db.prepare(`
        INSERT INTO member_xp (guild_id, user_id, user_tag, xp) VALUES (?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, user_tag = COALESCE(excluded.user_tag, user_tag)`),
      delete: db.prepare("DELETE FROM member_xp WHERE guild_id = ? AND user_id = ?"),
      top: db.prepare("SELECT * FROM member_xp WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?"),
      ahead: db.prepare("SELECT COUNT(*) AS total FROM member_xp WHERE guild_id = ? AND xp > ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM member_xp WHERE guild_id = ? AND xp > 0"),
    };
  }

  get(guildId, userId) {
    return toEntry(this.#statements.get.get(guildId, userId));
  }

  // Gives the member `amount` XP for a message, unless they already got some
  // within `cooldownMs`. Returns { before, after } XP, or undefined on cooldown.
  award({ guildId, userId, userTag = null, amount, now = Date.now(), cooldownMs }) {
    const row = this.#statements.award.get({ guildId, userId, userTag, amount, now, cutoff: now - cooldownMs });
    if (!row) {
      return undefined;
    }
    const after = Number(row.xp);
    return { before: after - amount, after };
  }

  setXp(guildId, userId, xp, userTag = null) {
    this.#statements.set.run(guildId, userId, userTag, Math.max(0, Math.floor(xp)));
  }

  reset(guildId, userId) {
    return this.#statements.delete.run(guildId, userId).changes > 0;
  }

  // The highest XP first.
  top(guildId, { limit = 10, offset = 0 } = {}) {
    return this.#statements.top.all(guildId, limit, offset).map(toEntry);
  }

  // The member's place on the leaderboard (1 = first), or undefined with no XP.
  rank(guildId, userId) {
    const entry = this.get(guildId, userId);
    if (!entry || entry.xp <= 0) {
      return undefined;
    }
    return Number(this.#statements.ahead.get(guildId, entry.xp).total) + 1;
  }

  // How many members have any XP.
  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }
}
