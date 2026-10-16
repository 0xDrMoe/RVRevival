// Stores members' birthdays (/birthday) in the bot's SQLite database: month
// and day only, never the year.

import { openDatabase } from "../storage/database.js";

const toBirthday = (row) =>
  row
    ? {
        guildId: row.guild_id,
        userId: row.user_id,
        month: row.month,
        day: row.day,
        celebratedOn: row.celebrated_on ?? null,
        roleGivenOn: row.role_given_on ?? null,
      }
    : undefined;

export class BirthdayStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      // Changing the date keeps celebrated_on, so moving it to today doesn't announce twice.
      set: db.prepare(`
        INSERT INTO birthdays (guild_id, user_id, month, day, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET month = excluded.month, day = excluded.day`),
      get: db.prepare("SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?"),
      remove: db.prepare("DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?"),
      on: db.prepare("SELECT * FROM birthdays WHERE guild_id = ? AND month = ? AND day = ?"),
      all: db.prepare("SELECT * FROM birthdays WHERE guild_id = ? ORDER BY month, day"),
      count: db.prepare("SELECT COUNT(*) AS total FROM birthdays WHERE guild_id = ?"),
      withRole: db.prepare("SELECT * FROM birthdays WHERE guild_id = ? AND role_given_on IS NOT NULL"),
      celebrated: db.prepare("UPDATE birthdays SET celebrated_on = ? WHERE guild_id = ? AND user_id = ?"),
      roleGiven: db.prepare("UPDATE birthdays SET role_given_on = ? WHERE guild_id = ? AND user_id = ?"),
    };
  }

  set({ guildId, userId, month, day, createdAt = Date.now() }) {
    this.#statements.set.run(guildId, userId, month, day, createdAt);
  }

  get(guildId, userId) {
    return toBirthday(this.#statements.get.get(guildId, userId));
  }

  // Returns whether there was one.
  remove(guildId, userId) {
    return this.#statements.remove.run(guildId, userId).changes > 0;
  }

  on(guildId, month, day) {
    return this.#statements.on.all(guildId, month, day).map(toBirthday);
  }

  // Every birthday in a server, January first.
  all(guildId) {
    return this.#statements.all.all(guildId).map(toBirthday);
  }

  count(guildId) {
    return this.#statements.count.get(guildId).total;
  }

  // Members who still have the birthday role.
  withRole(guildId) {
    return this.#statements.withRole.all(guildId).map(toBirthday);
  }

  markCelebrated(guildId, userId, day) {
    this.#statements.celebrated.run(day, guildId, userId);
  }

  // `day` is the day the role was given, or null once it's taken back.
  markRole(guildId, userId, day) {
    this.#statements.roleGiven.run(day, guildId, userId);
  }
}
