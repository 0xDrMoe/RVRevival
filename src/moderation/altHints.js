// Flags joins that look like a banned account: the same avatar, or the same
// name once digits, punctuation and case are stripped ("Kaz_99" and "kaz.2"
// both become "kaz"). Only a hint for staff in the join log: nothing is done
// to the member. Each server keeps the look of its newest MAX_LOOKS bans;
// unbanning forgets one.

import { openDatabase } from "../storage/database.js";

export const MAX_LOOKS = 1000;
// Shorter names match too many people to mean anything.
const MIN_NAME_LENGTH = 4;

// "Kaz_99" -> "kaz". Letters of any alphabet are kept. null when too short.
export function nameKey(name) {
  if (typeof name !== "string") {
    return null;
  }
  const key = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "");
  return key.length >= MIN_NAME_LENGTH ? key : null;
}

// The keys a user's names give: username and display name.
const keysOf = (user) => [...new Set([nameKey(user.username), nameKey(user.globalName ?? user.global_name)].filter(Boolean))];

export class AltHints {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      save: db.prepare(`
        INSERT INTO banned_looks (guild_id, user_id, name_key, avatar, banned_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET name_key = excluded.name_key, avatar = excluded.avatar, banned_at = excluded.banned_at`),
      prune: db.prepare(`
        DELETE FROM banned_looks WHERE guild_id = ? AND user_id NOT IN
          (SELECT user_id FROM banned_looks WHERE guild_id = ? ORDER BY banned_at DESC LIMIT ${MAX_LOOKS})`),
      forget: db.prepare("DELETE FROM banned_looks WHERE guild_id = ? AND user_id = ?"),
      byAvatar: db.prepare("SELECT user_id FROM banned_looks WHERE guild_id = ? AND avatar = ? AND user_id <> ? ORDER BY banned_at DESC LIMIT 3"),
      byName: db.prepare("SELECT user_id FROM banned_looks WHERE guild_id = ? AND name_key = ? AND user_id <> ? ORDER BY banned_at DESC LIMIT 3"),
    };
  }

  // Remembers how a banned user looked. Only the first name key is kept (the
  // username, else the display name); look-ups check both of the joiner's.
  banned(guildId, user, at = Date.now()) {
    const [key = null] = keysOf(user);
    this.#statements.save.run(guildId, user.id, key, user.avatar ?? null, at);
    this.#statements.prune.run(guildId, guildId);
  }

  unbanned(guildId, userId) {
    this.#statements.forget.run(guildId, userId);
  }

  // [{ userId, reason: "avatar" | "name" }] for banned accounts this user
  // looks like, newest first, at most 3.
  matches(guildId, user) {
    const found = new Map();
    if (user.avatar) {
      for (const row of this.#statements.byAvatar.all(guildId, user.avatar, user.id)) {
        found.set(row.user_id, "avatar");
      }
    }
    for (const key of keysOf(user)) {
      for (const row of this.#statements.byName.all(guildId, key, user.id)) {
        if (!found.has(row.user_id)) {
          found.set(row.user_id, "name");
        }
      }
    }
    return [...found].slice(0, 3).map(([userId, reason]) => ({ userId, reason }));
  }
}
