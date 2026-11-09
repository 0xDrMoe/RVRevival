import { describe, expect, it } from "vitest";
import { commandUsageName, CommandUsageStore, KEEP_DAYS } from "../src/stats/commandUsage.js";

const DAY = 24 * 60 * 60 * 1000;

describe("command usage", () => {
  it("names slash commands with their subcommand, and apps by name", () => {
    const slash = (sub, group = null) => ({
      commandName: "tickets",
      isChatInputCommand: () => true,
      options: { getSubcommand: () => sub, getSubcommandGroup: () => group },
    });
    expect(commandUsageName(slash("claim"))).toBe("/tickets claim");
    expect(commandUsageName(slash("add", "rule"))).toBe("/tickets rule add");
    expect(commandUsageName(slash(null))).toBe("/tickets");
    expect(commandUsageName({ commandName: "Report message", isChatInputCommand: () => false })).toBe("Report message");
  });

  it("counts per server for the last 30 days and forgets old days", () => {
    const store = new CommandUsageStore();
    const now = 100 * DAY;
    store.count("g", "/warn", now);
    store.count("g", "/warn", now - 29 * DAY);
    store.count("g", "/ban", now - 30 * DAY);
    store.count("other", "/warn", now);
    expect(store.top("g", { now })).toEqual({ total: 2, top: [{ command: "/warn", uses: 2 }] });
    expect(store.top("g", { now, days: 31 }).total).toBe(3);
    store.count("g", "/old", now - (KEEP_DAYS + 1) * DAY);
    expect(store.prune(now)).toBe(1);
  });
});
