// Member growth in data/bot.db: who invited whom (table invite_joins, for
// /invites, see members/inviteStats.js) and the last member-count milestone
// each server celebrated (table milestone_posts, see community/milestones.js).

import { openDatabase } from "../storage/database.js";

export class GrowthStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      recordJoin: db.prepare(`
        INSERT INTO invite_joins (guild_id, user_id, inviter_id, code, joined_at, left_at) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET inviter_id = excluded.inviter_id, code = excluded.code, joined_at = excluded.joined_at, left_at = NULL`),
      recordLeave: db.prepare("UPDATE invite_joins SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL"),
      joinOf: db.prepare("SELECT inviter_id, code, joined_at, left_at FROM invite_joins WHERE guild_id = ? AND user_id = ?"),
      statsFor: db.prepare(`
        SELECT COUNT(*) AS total, COALESCE(SUM(left_at IS NULL), 0) AS here
        FROM invite_joins WHERE guild_id = ? AND inviter_id = ?`),
      top: db.prepare(`
        SELECT inviter_id, COUNT(*) AS total, SUM(left_at IS NULL) AS here
        FROM invite_joins WHERE guild_id = ? AND inviter_id IS NOT NULL
        GROUP BY inviter_id ORDER BY here DESC, total DESC, inviter_id LIMIT ?`),
      milestone: db.prepare("SELECT count FROM milestone_posts WHERE guild_id = ?"),
      setMilestone: db.prepare(`
        INSERT INTO milestone_posts (guild_id, count) VALUES (?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET count = excluded.count`),
    };
  }

  // Remembers how someone joined; a rejoin replaces the old record.
  recordJoin(guildId, userId, { inviterId = null, code = null } = {}, at = Date.now()) {
    this.#statements.recordJoin.run(guildId, userId, inviterId, code, at);
  }

  recordLeave(guildId, userId, at = Date.now()) {
    this.#statements.recordLeave.run(at, guildId, userId);
  }

  // { inviterId, code, joinedAt, leftAt }, or undefined.
  joinOf(guildId, userId) {
    const row = this.#statements.joinOf.get(guildId, userId);
    return row ? { inviterId: row.inviter_id ?? null, code: row.code ?? null, joinedAt: Number(row.joined_at), leftAt: row.left_at === null ? null : Number(row.left_at) } : undefined;
  }

  // How many people a member invited: { total, here, left }.
  statsFor(guildId, inviterId) {
    const row = this.#statements.statsFor.get(guildId, inviterId);
    const total = Number(row.total);
    const here = Number(row.here);
    return { total, here, left: total - here };
  }

  // The best inviters, by people still here: [{ inviterId, total, here, left }].
  top(guildId, limit = 10) {
    return this.#statements.top.all(guildId, limit).map((row) => {
      const total = Number(row.total);
      const here = Number(row.here);
      return { inviterId: row.inviter_id, total, here, left: total - here };
    });
  }

  // The last milestone posted, or undefined before the first.
  milestone(guildId) {
    const row = this.#statements.milestone.get(guildId);
    return row ? Number(row.count) : undefined;
  }

  setMilestone(guildId, count) {
    this.#statements.setMilestone.run(guildId, count);
  }
}
