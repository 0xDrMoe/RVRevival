// How many AI requests each server made each month, so the monthly limit
// holds across restarts, and the dashboard can show what's used.

import { openDatabase } from "../storage/database.js";

// "2026-11" for a time, in UTC.
export const monthOf = (at) => new Date(at).toISOString().slice(0, 7);

export class AiUsageStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      get: db.prepare("SELECT * FROM ai_usage WHERE guild_id = ? AND month = ?"),
      add: db.prepare(`
        INSERT INTO ai_usage (guild_id, month, requests, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT (guild_id, month) DO UPDATE SET
          requests = requests + 1,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens`),
    };
  }

  // This month's use: { month, requests, inputTokens, outputTokens }.
  get(guildId, at = Date.now()) {
    const month = monthOf(at);
    const row = this.#statements.get.get(guildId, month);
    return { month, requests: row?.requests ?? 0, inputTokens: row?.input_tokens ?? 0, outputTokens: row?.output_tokens ?? 0 };
  }

  record(guildId, { inputTokens = 0, outputTokens = 0 } = {}, at = Date.now()) {
    this.#statements.add.run(guildId, monthOf(at), inputTokens, outputTokens);
  }
}
