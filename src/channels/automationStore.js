// Channel automation state in data/bot.db: counting channels (table
// counting_state) and the next DISBOARD bump reminder per server (table
// bump_reminders). See channels/automation.js.

import { openDatabase } from "../storage/database.js";

export class AutomationStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      counting: db.prepare("SELECT count, last_user_id, best FROM counting_state WHERE channel_id = ?"),
      setCounting: db.prepare(`
        INSERT INTO counting_state (channel_id, guild_id, count, last_user_id, best, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (channel_id) DO UPDATE SET count = excluded.count, last_user_id = excluded.last_user_id, best = excluded.best, updated_at = excluded.updated_at`),
      setBump: db.prepare(`
        INSERT INTO bump_reminders (guild_id, channel_id, due_at) VALUES (?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id, due_at = excluded.due_at`),
      dueBumps: db.prepare("SELECT guild_id, channel_id, due_at FROM bump_reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50"),
      bump: db.prepare("SELECT channel_id, due_at FROM bump_reminders WHERE guild_id = ?"),
      clearBump: db.prepare("DELETE FROM bump_reminders WHERE guild_id = ?"),
      forgetUser: db.prepare("UPDATE counting_state SET last_user_id = NULL WHERE last_user_id = ?"),
    };
  }

  // { count, lastUserId, best }, or undefined for a channel that never counted.
  counting(channelId) {
    const row = this.#statements.counting.get(channelId);
    return row ? { count: Number(row.count), lastUserId: row.last_user_id ?? null, best: Number(row.best) } : undefined;
  }

  setCounting(channelId, guildId, { count, lastUserId, best }, at = Date.now()) {
    this.#statements.setCounting.run(channelId, guildId, count, lastUserId, best, at);
  }

  setBump(guildId, channelId, dueAt) {
    this.#statements.setBump.run(guildId, channelId, dueAt);
  }

  // { channelId, dueAt } of the server's next reminder, or undefined.
  bump(guildId) {
    const row = this.#statements.bump.get(guildId);
    return row ? { channelId: row.channel_id, dueAt: Number(row.due_at) } : undefined;
  }

  dueBumps(now) {
    return this.#statements.dueBumps.all(now).map((row) => ({ guildId: row.guild_id, channelId: row.channel_id, dueAt: Number(row.due_at) }));
  }

  clearBump(guildId) {
    this.#statements.clearBump.run(guildId);
  }

  // Forgets who counted last, for /mydata delete.
  forgetUser(userId) {
    return Number(this.#statements.forgetUser.run(userId).changes);
  }
}
