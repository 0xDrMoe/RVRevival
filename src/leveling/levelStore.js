// Stores each member's XP (data/bot.db, table member_xp). Levels are worked
// out from the XP (leveling/config.js), so changing the formula never needs a
// migration.

import { openDatabase, inTransaction } from "../storage/database.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Daily XP older than this is deleted; the monthly board needs 30 days.
export const KEEP_DAYS = 35;
// Leaderboard periods: all time, or the XP earned in the last 7 or 30 days.
export const Period = Object.freeze({ ALL: "all", WEEK: "week", MONTH: "month" });
export const PERIODS = Object.values(Period);
const PERIOD_DAYS = { week: 7, month: 30 };

export const dayNumber = (time) => Math.floor(time / DAY_MS);
// The first day counted for a period ending today (inclusive), or undefined for all time.
export const periodStart = (period, now = Date.now()) => (PERIOD_DAYS[period] ? dayNumber(now) - PERIOD_DAYS[period] + 1 : undefined);

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
  #db;
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#db = db;
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
      // Adds XP without the message cooldown or count (voice XP).
      add: db.prepare(`
        INSERT INTO member_xp (guild_id, user_id, user_tag, xp) VALUES (:guildId, :userId, :userTag, :amount)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, user_tag = COALESCE(excluded.user_tag, user_tag)
        RETURNING xp`),
      set: db.prepare(`
        INSERT INTO member_xp (guild_id, user_id, user_tag, xp) VALUES (?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, user_tag = COALESCE(excluded.user_tag, user_tag)`),
      delete: db.prepare("DELETE FROM member_xp WHERE guild_id = ? AND user_id = ?"),
      top: db.prepare("SELECT * FROM member_xp WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?"),
      ahead: db.prepare("SELECT COUNT(*) AS total FROM member_xp WHERE guild_id = ? AND xp > ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM member_xp WHERE guild_id = ? AND xp > 0"),
      daily: db.prepare(`
        INSERT INTO xp_daily (guild_id, user_id, day, xp) VALUES (?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id, day) DO UPDATE SET xp = xp + excluded.xp`),
      deleteDaily: db.prepare("DELETE FROM xp_daily WHERE guild_id = ? AND user_id = ?"),
      topSince: db.prepare(`
        SELECT d.user_id, SUM(d.xp) AS gained, m.user_tag, m.xp, m.messages
        FROM xp_daily d LEFT JOIN member_xp m ON m.guild_id = d.guild_id AND m.user_id = d.user_id
        WHERE d.guild_id = ? AND d.day >= ?
        GROUP BY d.user_id HAVING gained > 0
        ORDER BY gained DESC, d.user_id LIMIT ? OFFSET ?`),
      gainedSince: db.prepare("SELECT COALESCE(SUM(xp), 0) AS gained FROM xp_daily WHERE guild_id = ? AND user_id = ? AND day >= ?"),
      aheadSince: db.prepare(`
        SELECT COUNT(*) AS total FROM (
          SELECT SUM(xp) AS gained FROM xp_daily WHERE guild_id = ? AND day >= ? GROUP BY user_id HAVING gained > ?
        )`),
      countSince: db.prepare("SELECT COUNT(DISTINCT user_id) AS total FROM xp_daily WHERE guild_id = ? AND day >= ? AND xp > 0"),
      prune: db.prepare("DELETE FROM xp_daily WHERE day < ?"),
    };
  }

  get(guildId, userId) {
    return toEntry(this.#statements.get.get(guildId, userId));
  }

  // Gives the member `amount` XP for a message, unless they already got some
  // within `cooldownMs`. Returns { before, after } XP, or undefined on cooldown.
  award({ guildId, userId, userTag = null, amount, now = Date.now(), cooldownMs }) {
    return inTransaction(this.#db, () => {
      const row = this.#statements.award.get({ guildId, userId, userTag, amount, now, cutoff: now - cooldownMs });
      if (!row) {
        return undefined;
      }
      this.#statements.daily.run(guildId, userId, dayNumber(now), amount);
      const after = Number(row.xp);
      return { before: after - amount, after };
    });
  }

  // Gives the member `amount` XP, with no cooldown. Returns { before, after } XP.
  addXp({ guildId, userId, userTag = null, amount, now = Date.now() }) {
    return inTransaction(this.#db, () => {
      const after = Number(this.#statements.add.get({ guildId, userId, userTag, amount }).xp);
      this.#statements.daily.run(guildId, userId, dayNumber(now), amount);
      return { before: after - amount, after };
    });
  }

  setXp(guildId, userId, xp, userTag = null) {
    this.#statements.set.run(guildId, userId, userTag, Math.max(0, Math.floor(xp)));
  }

  reset(guildId, userId) {
    this.#statements.deleteDaily.run(guildId, userId);
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

  // The most XP earned since `sinceDay` (see periodStart): [{ userId, userTag, gained, xp, messages }].
  topSince(guildId, sinceDay, { limit = 10, offset = 0 } = {}) {
    return this.#statements.topSince.all(guildId, sinceDay, limit, offset).map((row) => ({
      guildId,
      userId: row.user_id,
      userTag: row.user_tag ?? null,
      gained: Number(row.gained),
      xp: Number(row.xp ?? 0),
      messages: Number(row.messages ?? 0),
    }));
  }

  // The member's place on the board since `sinceDay`, or undefined with no XP then.
  rankSince(guildId, userId, sinceDay) {
    const gained = Number(this.#statements.gainedSince.get(guildId, userId, sinceDay).gained);
    if (gained <= 0) {
      return undefined;
    }
    return Number(this.#statements.aheadSince.get(guildId, sinceDay, gained).total) + 1;
  }

  // How many members earned XP since `sinceDay`.
  countSince(guildId, sinceDay) {
    return Number(this.#statements.countSince.get(guildId, sinceDay).total);
  }

  // Deletes daily XP older than KEEP_DAYS.
  prune(now = Date.now()) {
    return this.#statements.prune.run(dayNumber(now) - KEEP_DAYS).changes;
  }
}
