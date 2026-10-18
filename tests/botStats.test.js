import { describe, expect, it } from "vitest";
import { BotStatsStore, HEARTBEAT_MS, OFFLINE_AFTER_MS, UPTIME_DAYS } from "../src/stats/botStats.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Midnight UTC, so the days line up with the uptime bars.
const MIDNIGHT = Date.UTC(2026, 9, 1);

// Heartbeats every minute from `from` to `to`.
function beat(stats, from, to, ping) {
  for (let at = from + HEARTBEAT_MS; at <= to; at += HEARTBEAT_MS) {
    stats.heartbeat(at, ping);
  }
}

describe("bot stats", () => {
  it("starts at zero and offline", () => {
    expect(new BotStatsStore().totals()).toEqual({
      commandsRun: 0,
      cases: 0,
      tickets: 0,
      online: false,
      upSince: null,
      ping: null,
      uptime: { percent: null, days: Array(UPTIME_DAYS).fill(null) },
    });
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

  it("keeps the last Discord ping while online, ignoring -1 from before the first one", () => {
    const stats = new BotStatsStore();
    stats.started(MIDNIGHT);
    stats.heartbeat(MIDNIGHT + HEARTBEAT_MS, 42.4);
    stats.heartbeat(MIDNIGHT + 2 * HEARTBEAT_MS, -1);
    expect(stats.totals(MIDNIGHT + 2 * HEARTBEAT_MS).ping).toBe(42);
    expect(stats.totals(MIDNIGHT + 2 * HEARTBEAT_MS + OFFLINE_AFTER_MS + 1).ping).toBeNull();
  });

  it("is 100% uptime while the bot has been up the whole time it was tracked", () => {
    const stats = new BotStatsStore();
    stats.started(MIDNIGHT);
    beat(stats, MIDNIGHT, MIDNIGHT + 6 * HOUR);
    const { uptime } = stats.totals(MIDNIGHT + 6 * HOUR + 30_000);
    expect(uptime.percent).toBe(100);
    expect(uptime.days.at(-1)).toBe(100);
    expect(uptime.days.slice(0, -1).every((day) => day === null)).toBe(true);
  });

  it("counts the time the bot was down, rounding down", () => {
    const stats = new BotStatsStore();
    stats.started(MIDNIGHT);
    beat(stats, MIDNIGHT, MIDNIGHT + 20 * HOUR);
    // Down for an hour, then back.
    stats.started(MIDNIGHT + 21 * HOUR);
    beat(stats, MIDNIGHT + 21 * HOUR, MIDNIGHT + DAY);
    const { uptime } = stats.totals(MIDNIGHT + DAY);
    // 23 of 24 hours = 95.833...
    expect(uptime.percent).toBe(95.83);
    expect(uptime.days.at(-2)).toBe(95.8);
    // Today has only just begun, so there is nothing to show yet.
    expect(uptime.days.at(-1)).toBeNull();
  });

  it("counts time since the last heartbeat as down once the bot is offline", () => {
    const stats = new BotStatsStore();
    stats.started(MIDNIGHT);
    beat(stats, MIDNIGHT, MIDNIGHT + 12 * HOUR);
    expect(stats.totals(MIDNIGHT + DAY - 1).uptime.percent).toBe(50);
  });

  it("only looks at the last 30 days and forgets older hours", () => {
    const stats = new BotStatsStore();
    stats.started(MIDNIGHT);
    // Down all of the first day, up for the 30 after it.
    stats.started(MIDNIGHT + DAY);
    for (let day = 1; day <= UPTIME_DAYS; day += 1) {
      beat(stats, MIDNIGHT + day * DAY, MIDNIGHT + (day + 1) * DAY);
    }
    const { uptime } = stats.totals(MIDNIGHT + (UPTIME_DAYS + 1) * DAY - 1);
    expect(uptime.percent).toBe(100);
    expect(uptime.days).toHaveLength(UPTIME_DAYS);
    expect(uptime.days.every((day) => day === 100)).toBe(true);
  });
});
