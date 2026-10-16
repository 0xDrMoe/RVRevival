// Stores giveaways (/giveaway) and their entries in the bot's SQLite database.

import { inTransaction, openDatabase } from "../storage/database.js";

function parseIds(text) {
  try {
    const ids = JSON.parse(text);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toGiveaway(row) {
  return row
    ? {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        messageId: row.message_id ?? null,
        hostId: row.host_id,
        prize: row.prize,
        winnerCount: row.winner_count,
        requiredRoleId: row.required_role_id ?? null,
        createdAt: row.created_at,
        endsAt: row.ends_at,
        endedAt: row.ended_at ?? null,
        winnerIds: parseIds(row.winner_ids),
      }
    : undefined;
}

export class GiveawayStore {
  #db;
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#db = db;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO giveaways (guild_id, channel_id, host_id, prize, winner_count, required_role_id, created_at, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      setMessage: db.prepare("UPDATE giveaways SET message_id = ? WHERE id = ?"),
      get: db.prepare("SELECT * FROM giveaways WHERE id = ?"),
      running: db.prepare("SELECT * FROM giveaways WHERE guild_id = ? AND ended_at IS NULL ORDER BY ends_at"),
      ended: db.prepare("SELECT * FROM giveaways WHERE guild_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 25"),
      due: db.prepare("SELECT * FROM giveaways WHERE ended_at IS NULL AND ends_at <= ? ORDER BY ends_at LIMIT ?"),
      markEnded: db.prepare("UPDATE giveaways SET ended_at = ?, winner_ids = ? WHERE id = ? AND ended_at IS NULL"),
      setWinners: db.prepare("UPDATE giveaways SET winner_ids = ? WHERE id = ?"),
      delete: db.prepare("DELETE FROM giveaways WHERE id = ?"),
      deleteEntries: db.prepare("DELETE FROM giveaway_entries WHERE giveaway_id = ?"),
      oldEnded: db.prepare("SELECT id FROM giveaways WHERE ended_at IS NOT NULL AND ended_at < ?"),
      addEntry: db.prepare("INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)"),
      removeEntry: db.prepare("DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?"),
      entries: db.prepare("SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?"),
      countEntries: db.prepare("SELECT COUNT(*) AS total FROM giveaway_entries WHERE giveaway_id = ?"),
    };
  }

  create({ guildId, channelId, hostId, prize, winnerCount, requiredRoleId = null, createdAt, endsAt }) {
    return toGiveaway(
      this.#statements.insert.get(guildId, channelId, hostId, prize, winnerCount, requiredRoleId, createdAt, endsAt),
    );
  }

  setMessage(id, messageId) {
    this.#statements.setMessage.run(messageId, id);
  }

  get(id) {
    return toGiveaway(this.#statements.get.get(id));
  }

  // A server's giveaways that haven't ended, ending soonest first.
  running(guildId) {
    return this.#statements.running.all(guildId).map(toGiveaway);
  }

  // A server's latest ended giveaways, newest first (for /giveaway reroll).
  ended(guildId) {
    return this.#statements.ended.all(guildId).map(toGiveaway);
  }

  // Giveaways whose time is up but that haven't been ended yet.
  due(now, limit = 50) {
    return this.#statements.due.all(now, limit).map(toGiveaway);
  }

  // Marks a giveaway ended with its winners. Returns false if it had already
  // ended, so two callers can't both announce it.
  markEnded(id, endedAt, winnerIds) {
    return this.#statements.markEnded.run(endedAt, JSON.stringify(winnerIds), id).changes > 0;
  }

  setWinners(id, winnerIds) {
    this.#statements.setWinners.run(JSON.stringify(winnerIds), id);
  }

  delete(id) {
    inTransaction(this.#db, () => {
      this.#statements.deleteEntries.run(id);
      this.#statements.delete.run(id);
    });
  }

  // Forgets giveaways that ended before `before`. Returns how many.
  deleteEndedBefore(before) {
    const ids = this.#statements.oldEnded.all(before).map((row) => row.id);
    for (const id of ids) {
      this.delete(id);
    }
    return ids.length;
  }

  // Enters the member, or takes them out if they'd entered. Returns whether
  // they're in now.
  toggleEntry(id, userId) {
    if (this.#statements.addEntry.run(id, userId).changes > 0) {
      return true;
    }
    this.#statements.removeEntry.run(id, userId);
    return false;
  }

  entries(id) {
    return this.#statements.entries.all(id).map((row) => row.user_id);
  }

  countEntries(id) {
    return this.#statements.countEntries.get(id).total;
  }
}
