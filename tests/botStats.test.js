import { describe, expect, it } from "vitest";
import { BotStatsStore, OFFLINE_AFTER_MS } from "../src/stats/botStats.js";

describe("bot stats", () => {
  it("starts at zero and offline", () => {
    expect(new BotStatsStore().totals()).toEqual({ commandsRun: 0, cases: 0, tickets: 0, online: false, upSince: null });
  });

  it("counts commands", () => {
    const stats = new BotStatsStore();
    stats.countCommand();
    stats.countCommand();
    stats.countCommand();
    expect(stats.totals().commandsRun).toBe(3);
  });

  it("is online while the heartbeat is fresh, up since the last start", () => {
    const stats = new BotStatsStore();
    stats.started(1_000);
    stats.heartbeat(1_000 + OFFLINE_AFTER_MS);
    expect(stats.totals(1_000 + OFFLINE_AFTER_MS)).toMatchObject({ online: true, upSince: 1_000 });
    expect(stats.totals(1_000 + 2 * OFFLINE_AFTER_MS + 1)).toMatchObject({ online: false, upSince: null });
  });

  it("restarts the uptime when the bot starts again", () => {
    const stats = new BotStatsStore();
    stats.started(1_000);
    stats.started(5_000);
    expect(stats.totals(5_000).upSince).toBe(5_000);
  });
});
