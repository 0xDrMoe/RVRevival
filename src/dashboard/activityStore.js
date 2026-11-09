// Stores what people changed on the dashboard, for the Activity page.
// Settings changes also keep what each setting was before and after, so the
// change can be undone while nobody has changed that setting again.

import { openDatabase } from "../storage/database.js";

// Older entries are dropped once a server has more than this.
export const ACTIVITY_KEEP = 500;
export const ACTIVITY_PAGE = 50;
// Bigger undo data (a huge automod config, say) isn't kept.
const MAX_UNDO_BYTES = 64 * 1024;

// { setting: { before, after } } or null.
function parseUndo(text) {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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
    canUndo: Boolean(row.undo) && !row.undone_at,
    undoneAt: row.undone_at ?? null,
  };
}

export class ActivityStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO dashboard_activity (guild_id, user_id, user_name, summary, lines, created_at, undo)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      prune: db.prepare(`
        DELETE FROM dashboard_activity WHERE guild_id = ? AND id <= (
          SELECT id FROM dashboard_activity WHERE guild_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
        )`),
      page: db.prepare(`
        SELECT * FROM dashboard_activity
        WHERE guild_id = :guildId AND id < :before
          AND (:userId IS NULL OR user_id = :userId)
          AND (:text IS NULL OR instr(lower(summary || ' ' || lines), :text) > 0)
        ORDER BY id DESC LIMIT :limit`),
      get: db.prepare("SELECT * FROM dashboard_activity WHERE guild_id = ? AND id = ?"),
      markUndone: db.prepare("UPDATE dashboard_activity SET undone_at = ? WHERE guild_id = ? AND id = ? AND undone_at IS NULL"),
      people: db.prepare(`
        SELECT user_id, user_name FROM dashboard_activity WHERE guild_id = ? AND id IN (
          SELECT MAX(id) FROM dashboard_activity WHERE guild_id = ? GROUP BY user_id
        ) ORDER BY user_name COLLATE NOCASE`),
      deleteGuild: db.prepare("DELETE FROM dashboard_activity WHERE guild_id = ?"),
    };
  }

  add({ guildId, userId, userName, summary, lines = [], createdAt = Date.now(), undo = null }) {
    const undoText = undo && Object.keys(undo).length > 0 ? JSON.stringify(undo) : null;
    const row = this.#statements.insert.get(
      guildId,
      userId,
      String(userName ?? "").slice(0, 100),
      String(summary).slice(0, 500),
      JSON.stringify(lines.map((line) => String(line).slice(0, 1000)).slice(0, 50)),
      createdAt,
      undoText && Buffer.byteLength(undoText) <= MAX_UNDO_BYTES ? undoText : null,
    );
    this.#statements.prune.run(guildId, guildId, ACTIVITY_KEEP);
    return toEntry(row);
  }

  // Newest first. `before` is the id to page back from; `next` is set while
  // older entries remain. Filters: userId (who did it), text (found in the
  // summary or a line, any case).
  page(guildId, { before, limit = ACTIVITY_PAGE, userId = null, text = null } = {}) {
    const start = Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
    const rows = this.#statements.page.all({
      guildId,
      before: start,
      limit: limit + 1,
      userId: userId || null,
      text: text ? String(text).trim().toLowerCase().slice(0, 100) || null : null,
    });
    const entries = rows.slice(0, limit).map(toEntry);
    return { entries, next: rows.length > limit ? entries.at(-1).id : null };
  }

  // One entry with its undo data ({ setting: { before, after } } or null).
  get(guildId, id) {
    const row = this.#statements.get.get(guildId, id);
    return row ? { ...toEntry(row), undo: row.undone_at ? null : parseUndo(row.undo) } : undefined;
  }

  // Returns false if it was already undone.
  markUndone(guildId, id, at = Date.now()) {
    return this.#statements.markUndone.run(at, guildId, id).changes > 0;
  }

  // Everyone with an entry: [{ userId, userName }] by name, with their latest name.
  people(guildId) {
    return this.#statements.people.all(guildId, guildId).map((row) => ({ userId: row.user_id, userName: row.user_name }));
  }

  deleteGuild(guildId) {
    this.#statements.deleteGuild.run(guildId);
  }
}
