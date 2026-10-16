// Followed feeds (/feed and the dashboard's Feeds page) in data/bot.db, table
// feeds. `seen` holds the newest item IDs already posted (or there when the
// feed was added), so restarts never post anything twice.

import { openDatabase } from "../storage/database.js";

export const MAX_FEEDS = 10;
export const SEEN_KEEP = 100;

function parseSeen(text) {
  try {
    const ids = JSON.parse(text);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const toFeed = (row) =>
  row
    ? {
        id: row.id,
        guildId: row.guild_id,
        kind: row.kind,
        source: row.source,
        url: row.url,
        name: row.name,
        channelId: row.channel_id,
        roleId: row.role_id ?? null,
        message: row.message ?? null,
        seen: parseSeen(row.seen),
        createdBy: row.created_by,
        createdAt: row.created_at,
        checkedAt: row.checked_at ?? null,
        postedAt: row.posted_at ?? null,
        lastError: row.last_error ?? null,
        failures: row.failures,
      }
    : undefined;

export class FeedStore {
  #db;
  #statements;

  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: this.#db.prepare(`
        INSERT INTO feeds (guild_id, kind, source, url, name, channel_id, role_id, message, seen, created_by, created_at, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      get: this.#db.prepare("SELECT * FROM feeds WHERE id = ?"),
      list: this.#db.prepare("SELECT * FROM feeds WHERE guild_id = ? ORDER BY id"),
      count: this.#db.prepare("SELECT COUNT(*) AS total FROM feeds WHERE guild_id = ?"),
      byUrl: this.#db.prepare("SELECT * FROM feeds WHERE guild_id = ? AND url = ? AND channel_id = ?"),
      due: this.#db.prepare("SELECT * FROM feeds WHERE checked_at IS NULL OR checked_at <= ? ORDER BY checked_at LIMIT ?"),
      checked: this.#db.prepare("UPDATE feeds SET seen = ?, checked_at = ?, posted_at = COALESCE(?, posted_at), last_error = NULL, failures = 0 WHERE id = ?"),
      failed: this.#db.prepare("UPDATE feeds SET checked_at = ?, last_error = ?, failures = failures + 1 WHERE id = ?"),
      delete: this.#db.prepare("DELETE FROM feeds WHERE guild_id = ? AND id = ?"),
      deleteGuild: this.#db.prepare("DELETE FROM feeds WHERE guild_id = ?"),
    };
  }

  add({ guildId, kind, source, url, name, channelId, roleId = null, message = null, seen = [], createdBy, createdAt = Date.now() }) {
    return toFeed(
      this.#statements.insert.get(guildId, kind, source, url, name, channelId, roleId, message, JSON.stringify(seen.slice(0, SEEN_KEEP)), createdBy, createdAt, createdAt),
    );
  }

  get(id) {
    return toFeed(this.#statements.get.get(id));
  }

  list(guildId) {
    return this.#statements.list.all(guildId).map(toFeed);
  }

  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }

  // The same feed already posting in the same channel.
  find(guildId, url, channelId) {
    return toFeed(this.#statements.byUrl.get(guildId, url, channelId));
  }

  // Feeds last checked at or before `before`, the longest-waiting first.
  due(before, limit = 25) {
    return this.#statements.due.all(before, limit).map(toFeed);
  }

  checked(id, { seen, checkedAt = Date.now(), postedAt = null }) {
    this.#statements.checked.run(JSON.stringify(seen.slice(0, SEEN_KEEP)), checkedAt, postedAt, id);
  }

  failed(id, { error, checkedAt = Date.now() }) {
    this.#statements.failed.run(checkedAt, String(error).slice(0, 300), id);
  }

  delete(guildId, id) {
    return this.#statements.delete.run(guildId, id).changes > 0;
  }
}
