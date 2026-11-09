// How often each slash command and right-click app is used in each server, per
// day, for the dashboard's "Top commands" card. Only counts are kept: never
// who ran a command. Days older than KEEP_DAYS are deleted.

import { openDatabase } from "../storage/database.js";

export const KEEP_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (time) => Math.floor(time / DAY_MS);

// "/tickets claim" for a slash command, "Report message" for a right-click app.
export function commandUsageName(interaction) {
  if (!interaction.isChatInputCommand?.()) {
    return interaction.commandName;
  }
  const group = interaction.options?.getSubcommandGroup?.(false);
  const sub = interaction.options?.getSubcommand?.(false);
  return ["/" + interaction.commandName, group, sub].filter(Boolean).join(" ");
}

export class CommandUsageStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      count: db.prepare(`
        INSERT INTO command_usage (guild_id, command, day, uses) VALUES (?, ?, ?, 1)
        ON CONFLICT (guild_id, day, command) DO UPDATE SET uses = uses + 1`),
      top: db.prepare(`
        SELECT command, SUM(uses) AS uses FROM command_usage
        WHERE guild_id = ? AND day >= ? GROUP BY command ORDER BY uses DESC, command LIMIT ?`),
      total: db.prepare("SELECT COALESCE(SUM(uses), 0) AS uses FROM command_usage WHERE guild_id = ? AND day >= ?"),
      prune: db.prepare("DELETE FROM command_usage WHERE day < ?"),
    };
  }

  count(guildId, command, now = Date.now()) {
    this.#statements.count.run(guildId, String(command).slice(0, 100), dayOf(now));
  }

  // The most used commands in the last `days` days (today included):
  // { total, top: [{ command, uses }] }.
  top(guildId, { days = 30, limit = 8, now = Date.now() } = {}) {
    const since = dayOf(now) - days + 1;
    return {
      total: Number(this.#statements.total.get(guildId, since).uses),
      top: this.#statements.top.all(guildId, since, limit).map((row) => ({ command: row.command, uses: Number(row.uses) })),
    };
  }

  prune(now = Date.now()) {
    return this.#statements.prune.run(dayOf(now) - KEEP_DAYS).changes;
  }
}
