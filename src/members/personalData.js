// A member's own data, for /mydata: what the bot keeps about them that they
// chose to give it (reminders, highlight words, AFK, birthdays, playlists,
// role pick preferences) or that's about them personally (who invited them,
// being the last to count), in every server, and deleting all of it.
//
// Server records (moderation cases, tickets, XP, logs) belong to the server's
// staff and aren't listed here; the Privacy Policy explains how to ask for those.

import { inTransaction, openDatabase } from "../storage/database.js";

// The order /mydata lists them in. Each key has a "myData_<key>" translation.
export const PERSONAL_DATA = [
  {
    key: "reminders",
    count: "SELECT COUNT(*) AS total FROM reminders WHERE user_id = ? AND delivered_at IS NULL",
    remove: ["DELETE FROM reminders WHERE user_id = ?"],
  },
  {
    key: "highlights",
    count: "SELECT COUNT(*) AS total FROM highlights WHERE user_id = ?",
    remove: ["DELETE FROM highlights WHERE user_id = ?"],
    guilds: "SELECT DISTINCT guild_id FROM highlights WHERE user_id = ?",
  },
  { key: "afk", count: "SELECT COUNT(*) AS total FROM afk WHERE user_id = ?", remove: ["DELETE FROM afk WHERE user_id = ?"] },
  { key: "birthdays", count: "SELECT COUNT(*) AS total FROM birthdays WHERE user_id = ?", remove: ["DELETE FROM birthdays WHERE user_id = ?"] },
  { key: "playlists", count: "SELECT COUNT(*) AS total FROM music_playlists WHERE user_id = ?", remove: ["DELETE FROM music_playlists WHERE user_id = ?"] },
  { key: "rolePicks", count: "SELECT COUNT(*) AS total FROM role_confirm_prefs WHERE user_id = ?", remove: ["DELETE FROM role_confirm_prefs WHERE user_id = ?"] },
  {
    key: "invites",
    count: "SELECT COUNT(*) AS total FROM invite_joins WHERE user_id = ?1 OR inviter_id = ?1",
    // The people they invited stay counted, with no known inviter.
    remove: ["DELETE FROM invite_joins WHERE user_id = ?", "UPDATE invite_joins SET inviter_id = NULL WHERE inviter_id = ?"],
  },
  {
    key: "counting",
    count: "SELECT COUNT(*) AS total FROM counting_state WHERE last_user_id = ?",
    remove: ["UPDATE counting_state SET last_user_id = NULL WHERE last_user_id = ?"],
  },
];

// Options:
//   database   the bot's database (or a file name)
//   onDeleted  ({ userId, highlightGuildIds }) after a delete, so caches can catch up
export function createPersonalData({ database = ":memory:", onDeleted = () => {} } = {}) {
  const db = typeof database === "string" ? openDatabase(database) : database;
  const statements = PERSONAL_DATA.map((entry) => ({
    key: entry.key,
    count: db.prepare(entry.count),
    remove: entry.remove.map((sql) => db.prepare(sql)),
    guilds: entry.guilds ? db.prepare(entry.guilds) : null,
  }));
  const highlightGuilds = statements.find((entry) => entry.key === "highlights").guilds;

  return {
    // [{ key, count }] for every kind, in PERSONAL_DATA order.
    summary(userId) {
      return statements.map((entry) => ({ key: entry.key, count: Number(entry.count.get(userId).total) }));
    },

    // Deletes everything in one transaction. Returns how many records went.
    deleteAll(userId) {
      const highlightGuildIds = highlightGuilds.all(userId).map((row) => row.guild_id);
      const removed = inTransaction(db, () =>
        statements.reduce((total, entry) => total + entry.remove.reduce((sum, statement) => sum + Number(statement.run(userId).changes), 0), 0),
      );
      onDeleted({ userId, highlightGuildIds });
      return removed;
    },
  };
}
