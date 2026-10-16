import { describe, expect, it } from "vitest";
import { ACTIVITY_KEEP, ActivityStore } from "../src/dashboard/activityStore.js";

const GUILD = "1";

describe("dashboard activity store", () => {
  it("pages newest first", () => {
    const activity = new ActivityStore();
    for (let index = 0; index < 5; index += 1) {
      activity.add({ guildId: GUILD, userId: "9", userName: "Moe", summary: `change ${index}`, lines: [`line ${index}`] });
    }
    activity.add({ guildId: "2", userId: "9", userName: "Moe", summary: "other server" });

    const first = activity.page(GUILD, { limit: 3 });
    expect(first.entries.map((entry) => entry.summary)).toEqual(["change 4", "change 3", "change 2"]);
    expect(first.entries[0]).toMatchObject({ userId: "9", userName: "Moe", lines: ["line 4"] });
    expect(first.next).toBe(first.entries[2].id);

    const second = activity.page(GUILD, { before: first.next, limit: 3 });
    expect(second.entries.map((entry) => entry.summary)).toEqual(["change 1", "change 0"]);
    expect(second.next).toBeNull();
  });

  it("keeps only the newest entries per server", () => {
    const activity = new ActivityStore();
    for (let index = 0; index < ACTIVITY_KEEP + 5; index += 1) {
      activity.add({ guildId: GUILD, userId: "9", userName: "Moe", summary: `change ${index}` });
    }
    const all = activity.page(GUILD, { limit: ACTIVITY_KEEP + 10 });
    expect(all.entries).toHaveLength(ACTIVITY_KEEP);
    expect(all.entries.at(-1).summary).toBe("change 5");
  });

  it("cuts very long text", () => {
    const activity = new ActivityStore();
    const entry = activity.add({ guildId: GUILD, userId: "9", userName: "Moe", summary: "x".repeat(900), lines: Array(80).fill("y") });
    expect(entry.summary).toHaveLength(500);
    expect(entry.lines).toHaveLength(50);
  });
});
