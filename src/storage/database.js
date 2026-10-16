// The bot's SQLite database (data/bot.db), using Node's built-in node:sqlite
// module, so there's no database server or native package to install. It holds
// moderation cases, per-server settings and dashboard logins. The bot and the
// dashboard each open it; WAL mode lets them read and write at the same time.
//
// The schema is upgraded in place on startup: each entry in MIGRATIONS moves
// the database up one version (stored in PRAGMA user_version). Never edit a
// released migration; add a new one instead.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const DEFAULT_DATABASE_FILE = fileURLToPath(new URL("../../data/bot.db", import.meta.url));

const MIGRATIONS = [
  // 1: moderation cases.
  `
  CREATE TABLE guild_counters (
    guild_id  TEXT PRIMARY KEY,
    last_case INTEGER NOT NULL
  );
  CREATE TABLE cases (
    guild_id       TEXT    NOT NULL,
    case_number    INTEGER NOT NULL,
    action         TEXT    NOT NULL,
    user_id        TEXT    NOT NULL,
    user_tag       TEXT,
    moderator_id   TEXT    NOT NULL,
    moderator_tag  TEXT,
    reason         TEXT,
    duration_ms    INTEGER,
    expires_at     INTEGER,
    pending_unban  INTEGER NOT NULL DEFAULT 0,
    dm_sent        INTEGER,
    log_channel_id TEXT,
    log_message_id TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER,
    PRIMARY KEY (guild_id, case_number)
  );
  CREATE INDEX cases_by_user ON cases (guild_id, user_id, case_number);
  CREATE INDEX cases_pending_unban ON cases (expires_at) WHERE pending_unban = 1;
  `,
  // 2: per-server settings, one row per setting, values stored as JSON.
  `
  CREATE TABLE guild_settings (
    guild_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  );
  `,
  // 3: dashboard logins. The session ID is stored hashed and the Discord
  // access token encrypted, so a copy of the database can't be used to log in.
  `
  CREATE TABLE dashboard_sessions (
    id_hash          TEXT    PRIMARY KEY,
    user_id          TEXT    NOT NULL,
    username         TEXT    NOT NULL,
    avatar           TEXT,
    access_token     TEXT    NOT NULL,
    guilds           TEXT,
    guilds_loaded_at INTEGER,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL
  );
  CREATE INDEX dashboard_sessions_expiry ON dashboard_sessions (expires_at);
  `,
  // 4: reminders (/remind). Kept until they're sent, so they survive restarts.
  `
  CREATE TABLE reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    private    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    due_at     INTEGER NOT NULL
  );
  CREATE INDEX reminders_due ON reminders (due_at);
  CREATE INDEX reminders_by_user ON reminders (guild_id, user_id, due_at);
  `,
  // 5: giveaways (/giveaway) and who entered them. Ended giveaways are kept
  // for a while so they can be rerolled.
  `
  CREATE TABLE giveaways (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT    NOT NULL,
    channel_id       TEXT    NOT NULL,
    message_id       TEXT,
    host_id          TEXT    NOT NULL,
    prize            TEXT    NOT NULL,
    winner_count     INTEGER NOT NULL,
    required_role_id TEXT,
    created_at       INTEGER NOT NULL,
    ends_at          INTEGER NOT NULL,
    ended_at         INTEGER,
    winner_ids       TEXT    NOT NULL DEFAULT '[]'
  );
  CREATE INDEX giveaways_due ON giveaways (ended_at, ends_at);
  CREATE INDEX giveaways_by_guild ON giveaways (guild_id, ends_at);
  CREATE TABLE giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    user_id     TEXT    NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  ) WITHOUT ROWID;
  `,
  // 6: the starboard (/starboard): which messages are on it, and where.
  `
  CREATE TABLE starboard_posts (
    message_id      TEXT    PRIMARY KEY,
    guild_id        TEXT    NOT NULL,
    channel_id      TEXT    NOT NULL,
    star_message_id TEXT,
    stars           INTEGER NOT NULL DEFAULT 0,
    removed         INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX starboard_by_star_message ON starboard_posts (star_message_id);
  `,
  // 7: when members joined and left, for their history on the dashboard.
  `
  CREATE TABLE member_events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT    NOT NULL,
    user_id  TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    at       INTEGER NOT NULL
  );
  CREATE INDEX member_events_by_user ON member_events (guild_id, user_id, at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// Runs `work` in a transaction: all of it is saved, or none of it.
export function inTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Opens (or creates) the database and upgrades it to the current schema.
// ":memory:" (the default) keeps everything in memory, for tests.
export function openDatabase(file = ":memory:") {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  // WAL lets another process (the future dashboard) read while the bot writes.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(`data/bot.db was created by a newer version of the bot (schema ${version}). Update the bot.`);
  }
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    inTransaction(db, () => {
      db.exec(MIGRATIONS[next]);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
  return db;
}

export function closeDatabase(db) {
  try {
    db.close();
  } catch {
    // Already closed.
  }
}
