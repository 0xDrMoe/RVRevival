// Bot-wide numbers for the dashboard's public landing page (data/bot.db):
// how many slash commands have run, when the bot last started and its last
// heartbeat (so the page can tell whether it's online). Nothing here is about
// one server or one person.

import { openDatabase } from "../storage/database.js";

// How often the bot writes its heartbeat, and how old one can be before the
// landing page calls the bot offline.
export const HEARTBEAT_MS = 60_000;
export const OFFLINE_AFTER_MS = 3 * HEARTBEAT_MS;

const COMMANDS_RUN = "commands_run";
const STARTED_AT = "started_at";
const HEARTBEAT_AT = "heartbeat_at";

export class BotStatsStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      add: db.prepare(
        "INSERT INTO bot_stats (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = value + excluded.value",
      ),
      set: db.prepare("INSERT INTO bot_stats (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value"),
      all: db.prepare("SELECT name, value FROM bot_stats"),
      cases: db.prepare("SELECT COUNT(*) AS total FROM cases"),
      tickets: db.prepare("SELECT COUNT(*) AS total FROM tickets"),
    };
  }

  countCommand() {
    this.#statements.add.run(COMMANDS_RUN, 1);
  }

  // The bot connected to Discord. Also counts as a heartbeat.
  started(at = Date.now()) {
    this.#statements.set.run(STARTED_AT, at);
    this.#statements.set.run(HEARTBEAT_AT, at);
  }

  heartbeat(at = Date.now()) {
    this.#statements.set.run(HEARTBEAT_AT, at);
  }

  // { commandsRun, cases, tickets, online, upSince }. `upSince` is when the
  // bot started, or null while it's offline.
  totals(now = Date.now()) {
    const values = Object.fromEntries(this.#statements.all.all().map(({ name, value }) => [name, value]));
    const online = values[HEARTBEAT_AT] !== undefined && now - values[HEARTBEAT_AT] <= OFFLINE_AFTER_MS;
    return {
      commandsRun: values[COMMANDS_RUN] ?? 0,
      cases: this.#statements.cases.get().total,
      tickets: this.#statements.tickets.get().total,
      online,
      upSince: online ? (values[STARTED_AT] ?? null) : null,
    };
  }
}
