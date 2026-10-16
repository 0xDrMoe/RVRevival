// Temporary roles (/temprole) in the bot's SQLite database: who has which
// role until when.

import { openDatabase } from "../storage/database.js";

const toTempRole = (row) =>
  row
    ? {
        id: row.id,
        guildId: row.guild_id,
        userId: row.user_id,
        roleId: row.role_id,
        expiresAt: row.expires_at,
        moderatorId: row.moderator_id,
        reason: row.reason ?? null,
        createdAt: row.created_at,
      }
    : undefined;

export class TempRoleStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      upsert: db.prepare(`
        INSERT INTO temp_roles (guild_id, user_id, role_id, expires_at, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET
          expires_at = excluded.expires_at, moderator_id = excluded.moderator_id, reason = excluded.reason
        RETURNING *`),
      get: db.prepare("SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?"),
      list: db.prepare("SELECT * FROM temp_roles WHERE guild_id = ? ORDER BY expires_at LIMIT ?"),
      listForUser: db.prepare("SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? ORDER BY expires_at"),
      count: db.prepare("SELECT COUNT(*) AS total FROM temp_roles WHERE guild_id = ?"),
      due: db.prepare("SELECT * FROM temp_roles WHERE expires_at <= ? ORDER BY expires_at LIMIT ?"),
      delete: db.prepare("DELETE FROM temp_roles WHERE id = ?"),
      deleteFor: db.prepare("DELETE FROM temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?"),
      deleteRole: db.prepare("DELETE FROM temp_roles WHERE guild_id = ? AND role_id = ?"),
    };
  }

  // Adds a temporary role, or moves the end of an existing one.
  set({ guildId, userId, roleId, expiresAt, moderatorId, reason = null, createdAt = Date.now() }) {
    return toTempRole(this.#statements.upsert.get(guildId, userId, roleId, expiresAt, moderatorId, reason, createdAt));
  }

  get(guildId, userId, roleId) {
    return toTempRole(this.#statements.get.get(guildId, userId, roleId));
  }

  // Soonest first.
  list(guildId, limit = 100) {
    return this.#statements.list.all(guildId, limit).map(toTempRole);
  }

  listForUser(guildId, userId) {
    return this.#statements.listForUser.all(guildId, userId).map(toTempRole);
  }

  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }

  due(now = Date.now(), limit = 50) {
    return this.#statements.due.all(now, limit).map(toTempRole);
  }

  delete(id) {
    return this.#statements.delete.run(id).changes > 0;
  }

  deleteFor(guildId, userId, roleId) {
    return this.#statements.deleteFor.run(guildId, userId, roleId).changes > 0;
  }

  // A deleted role: nothing left to take away.
  deleteRole(guildId, roleId) {
    return Number(this.#statements.deleteRole.run(guildId, roleId).changes);
  }
}
