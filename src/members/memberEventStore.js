// Remembers when members joined and left a server (data/bot.db), so the
// dashboard can show someone's history, including rejoins.

import { openDatabase } from "../storage/database.js";

export const MemberEvent = Object.freeze({ JOIN: "join", LEAVE: "leave" });

// The newest events kept per member; older ones are dropped as new ones come in.
export const MAX_EVENTS_PER_MEMBER = 50;

export class MemberEventStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: db.prepare("INSERT INTO member_events (guild_id, user_id, kind, at) VALUES (?, ?, ?, ?)"),
      trim: db.prepare(`
        DELETE FROM member_events WHERE guild_id = ? AND user_id = ? AND id NOT IN (
          SELECT id FROM member_events WHERE guild_id = ? AND user_id = ? ORDER BY at DESC, id DESC LIMIT ?)`),
      list: db.prepare("SELECT kind, at FROM member_events WHERE guild_id = ? AND user_id = ? ORDER BY at DESC, id DESC LIMIT ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM member_events WHERE guild_id = ? AND user_id = ? AND kind = ?"),
    };
  }

  record(guildId, userId, kind, at = Date.now()) {
    if (!Object.values(MemberEvent).includes(kind)) {
      throw new Error(`Unknown member event: ${kind}`);
    }
    this.#statements.insert.run(guildId, userId, kind, at);
    this.#statements.trim.run(guildId, userId, guildId, userId, MAX_EVENTS_PER_MEMBER);
  }

  // [{ kind, at }], newest first.
  list(guildId, userId, limit = MAX_EVENTS_PER_MEMBER) {
    return this.#statements.list.all(guildId, userId, limit).map(({ kind, at }) => ({ kind, at }));
  }

  // How many times the member joined.
  countJoins(guildId, userId) {
    return Number(this.#statements.count.get(guildId, userId, MemberEvent.JOIN).total);
  }
}
