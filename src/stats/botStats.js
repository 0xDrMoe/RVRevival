// Bot-wide numbers for the dashboard's public landing page (data/bot.db):
// how many slash commands have run, when the bot last started, its last
// heartbeat (so the page can tell whether it's online), its Discord ping and
// how long it was online in each hour (for the 30-day uptime). Nothing here is
// about one server or one person.

import { openDatabase } from "../storage/database.js";

// How often the bot writes its heartbeat, and how old one can be before the
// landing page calls the bot offline.
export const HEARTBEAT_MS = 60_000;
export const OFFLINE_AFTER_MS = 3 * HEARTBEAT_MS;

// The uptime covers today and the 29 days before it (UTC days), one bar a day.
export const UPTIME_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const COMMANDS_RUN = "commands_run";
const STARTED_AT = "started_at";
const HEARTBEAT_AT = "heartbeat_at";
const PING_MS = "ping_ms";
// When uptime tracking began, so days before it show as "no data" rather than down.
const TRACKED_SINCE = "uptime_since";

// 99.96 → 99.9: rounding down so the page never claims more uptime than there was.
const floorTo = (value, digits) => Math.floor(value * 10 ** digits) / 10 ** digits;

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
      setOnce: db.prepare("INSERT INTO bot_stats (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING"),
      get: db.prepare("SELECT value FROM bot_stats WHERE name = ?"),
      all: db.prepare("SELECT name, value FROM bot_stats"),
      addOnline: db.prepare(
        "INSERT INTO bot_uptime (hour, online_ms) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET online_ms = online_ms + excluded.online_ms",
      ),
      onlineSince: db.prepare("SELECT hour, online_ms FROM bot_uptime WHERE hour >= ?"),
      prune: db.prepare("DELETE FROM bot_uptime WHERE hour < ?"),
      cases: db.prepare("SELECT COUNT(*) AS total FROM cases"),
      tickets: db.prepare("SELECT COUNT(*) AS total FROM tickets"),
    };
  }

  countCommand() {
    this.#statements.add.run(COMMANDS_RUN, 1);
  }

  // The bot connected to Discord. Also counts as a heartbeat, but the time
  // since the last one isn't counted as online: the bot was down in between.
  started(at = Date.now()) {
    this.#statements.setOnce.run(TRACKED_SINCE, at);
    this.#statements.set.run(STARTED_AT, at);
    this.#statements.set.run(HEARTBEAT_AT, at);
  }

  // Counts the time since the last heartbeat as online, unless the gap was so
  // long the page already showed the bot as offline. `ping` is the Discord
  // gateway ping in ms; discord.js reports -1 before the first one.
  heartbeat(at = Date.now(), ping = undefined) {
    const last = this.#statements.get.get(HEARTBEAT_AT)?.value;
    const gap = last === undefined ? 0 : at - last;
    if (gap > 0 && gap <= OFFLINE_AFTER_MS) {
      // A gap is at most a few minutes, so it spans at most one hour boundary.
      const hour = Math.floor(at / HOUR_MS);
      const inThisHour = Math.min(gap, at - hour * HOUR_MS);
      this.#statements.addOnline.run(hour, inThisHour);
      if (gap > inThisHour) {
        this.#statements.addOnline.run(hour - 1, gap - inThisHour);
      }
    }
    this.#statements.set.run(HEARTBEAT_AT, at);
    if (Number.isFinite(ping) && ping >= 0) {
      this.#statements.set.run(PING_MS, Math.round(ping));
    }
    // Keep one spare day so the window's first day is always complete.
    this.#statements.prune.run(Math.floor((at - (UPTIME_DAYS + 1) * DAY_MS) / HOUR_MS));
  }

  // { commandsRun, cases, tickets, online, upSince, ping, uptime }. `upSince`
  // is when the bot started and `ping` its last Discord ping, both null while
  // it's offline. `uptime` is { percent, days }: the share of the tracked time
  // in the last UPTIME_DAYS days the bot was online, and one percent a day,
  // oldest first (null for days before tracking began). `percent` is null
  // until there is anything to measure.
  totals(now = Date.now()) {
    const values = Object.fromEntries(this.#statements.all.all().map(({ name, value }) => [name, value]));
    const online = values[HEARTBEAT_AT] !== undefined && now - values[HEARTBEAT_AT] <= OFFLINE_AFTER_MS;
    return {
      commandsRun: values[COMMANDS_RUN] ?? 0,
      cases: this.#statements.cases.get().total,
      tickets: this.#statements.tickets.get().total,
      online,
      upSince: online ? (values[STARTED_AT] ?? null) : null,
      ping: online ? (values[PING_MS] ?? null) : null,
      uptime: this.#uptime(now, values[TRACKED_SINCE], online ? values[HEARTBEAT_AT] : now),
    };
  }

  // `end` is where the measured time stops: the last heartbeat while the bot is
  // online (the time since then isn't counted yet either way), else now.
  #uptime(now, trackedSince, end) {
    const firstDay = Math.floor(now / DAY_MS) - (UPTIME_DAYS - 1);
    if (trackedSince === undefined) {
      return { percent: null, days: Array(UPTIME_DAYS).fill(null) };
    }
    const onlineByDay = new Map();
    for (const { hour, online_ms: ms } of this.#statements.onlineSince.all(firstDay * 24)) {
      const day = Math.floor(hour / 24);
      onlineByDay.set(day, (onlineByDay.get(day) ?? 0) + ms);
    }

    let totalOnline = 0;
    let totalTracked = 0;
    const days = Array.from({ length: UPTIME_DAYS }, (_, index) => {
      const day = firstDay + index;
      const tracked = Math.min((day + 1) * DAY_MS, end) - Math.max(day * DAY_MS, trackedSince);
      if (tracked <= 0) {
        return null;
      }
      const dayOnline = Math.min(onlineByDay.get(day) ?? 0, tracked);
      totalOnline += dayOnline;
      totalTracked += tracked;
      return floorTo((dayOnline / tracked) * 100, 1);
    });
    return { percent: totalTracked > 0 ? floorTo((totalOnline / totalTracked) * 100, 2) : null, days };
  }
}
