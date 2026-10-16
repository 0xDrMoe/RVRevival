// Roles the bot took away from someone and may give back later
// (data/bot.db, table saved_roles): a quarantine, or the roles a member had
// when they left (role persistence).

import { openDatabase } from "../storage/database.js";

export const SavedRoles = Object.freeze({ QUARANTINE: "quarantine", LEFT: "left" });

function parseIds(text) {
  try {
    const ids = JSON.parse(text);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const toSaved = (row) =>
  row
    ? {
        guildId: row.guild_id,
        userId: row.user_id,
        kind: row.kind,
        roleIds: parseIds(row.role_ids),
        reason: row.reason ?? null,
        moderatorId: row.moderator_id ?? null,
        savedAt: row.saved_at,
      }
    : undefined;

export class SavedRoleStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      save: db.prepare(`
        INSERT INTO saved_roles (guild_id, user_id, kind, role_ids, reason, moderator_id, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id, kind) DO UPDATE SET
          role_ids = excluded.role_ids, reason = excluded.reason, moderator_id = excluded.moderator_id, saved_at = excluded.saved_at`),
      get: db.prepare("SELECT * FROM saved_roles WHERE guild_id = ? AND user_id = ? AND kind = ?"),
      list: db.prepare("SELECT * FROM saved_roles WHERE guild_id = ? AND kind = ? ORDER BY saved_at DESC LIMIT ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM saved_roles WHERE guild_id = ? AND kind = ?"),
      delete: db.prepare("DELETE FROM saved_roles WHERE guild_id = ? AND user_id = ? AND kind = ?"),
      prune: db.prepare("DELETE FROM saved_roles WHERE kind = ? AND saved_at < ?"),
    };
  }

  save({ guildId, userId, kind, roleIds, reason = null, moderatorId = null, savedAt = Date.now() }) {
    this.#statements.save.run(guildId, userId, kind, JSON.stringify([...new Set(roleIds)]), reason, moderatorId, savedAt);
  }

  get(guildId, userId, kind) {
    return toSaved(this.#statements.get.get(guildId, userId, kind));
  }

  // Newest first.
  list(guildId, kind, limit = 100) {
    return this.#statements.list.all(guildId, kind, limit).map(toSaved);
  }

  count(guildId, kind) {
    return Number(this.#statements.count.get(guildId, kind).total);
  }

  // True if there was something to delete.
  delete(guildId, userId, kind) {
    return this.#statements.delete.run(guildId, userId, kind).changes > 0;
  }

  // Drops everything of `kind` saved before `before`.
  prune(kind, before) {
    return Number(this.#statements.prune.run(kind, before).changes);
  }
}
