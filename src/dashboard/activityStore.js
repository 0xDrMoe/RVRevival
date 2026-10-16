// Stores what people changed on the dashboard, for the Activity page.

import { openDatabase } from "../storage/database.js";

// Older entries are dropped once a server has more than this.
export const ACTIVITY_KEEP = 500;
export const ACTIVITY_PAGE = 50;

function toEntry(row) {
  let lines = [];
  try {
    const parsed = JSON.parse(row.lines);
    lines = Array.isArray(parsed) ? parsed.filter((line) => typeof line === "string") : [];
  } catch {
    // A damaged row still shows its summary.
  }
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    summary: row.summary,
    lines,
    createdAt: row.created_at,
  };
}

export class ActivityStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO dashboard_activity (guild_id, user_id, user_name, summary, lines, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING *`),
      prune: db.prepare(`
        DELETE FROM dashboard_activity WHERE guild_id = ? AND id <= (
          SELECT id FROM dashboard_activity WHERE guild_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
        )`),
      page: db.prepare("SELECT * FROM dashboard_activity WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?"),
      deleteGuild: db.prepare("DELETE FROM dashboard_activity WHERE guild_id = ?"),
    };
  }

  add({ guildId, userId, userName, summary, lines = [], createdAt = Date.now() }) {
    const row = this.#statements.insert.get(
      guildId,
      userId,
      String(userName ?? "").slice(0, 100),
      String(summary).slice(0, 500),
      JSON.stringify(lines.map((line) => String(line).slice(0, 1000)).slice(0, 50)),
      createdAt,
    );
    this.#statements.prune.run(guildId, guildId, ACTIVITY_KEEP);
    return toEntry(row);
  }

  // Newest first. `before` is the id to page back from; `next` is set while
  // older entries remain.
  page(guildId, { before, limit = ACTIVITY_PAGE } = {}) {
    const start = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const rows = this.#statements.page.all(guildId, start, limit + 1);
    const entries = rows.slice(0, limit).map(toEntry);
    return { entries, next: rows.length > limit ? entries.at(-1).id : null };
  }

  deleteGuild(guildId) {
    this.#statements.deleteGuild.run(guildId);
  }
}
