import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../src/utils/duration.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["10m", 10 * MINUTE],
    ["2h", 2 * HOUR],
    ["1d", DAY],
    ["1w", 7 * DAY],
    ["1h30m", HOUR + 30 * MINUTE],
    ["1d 12h", DAY + 12 * HOUR],
    ["2H", 2 * HOUR],
    ["15", 15 * MINUTE],
  ])("reads %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "  ", "abc", "10x", "1h foo", "0m", "0", "-5m", "1.5h", undefined, null])("rejects %s", (text) => {
    expect(parseDuration(text)).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("shows the two largest units", () => {
    expect(formatDuration(DAY + 2 * HOUR + 5 * MINUTE)).toBe("1d 2h");
    expect(formatDuration(90 * MINUTE)).toBe("1h 30m");
    expect(formatDuration(14 * DAY)).toBe("2w");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
  });
});
