import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_MEMBER, MemberEvent, MemberEventStore } from "../src/members/memberEventStore.js";

const GUILD_ID = "900000000000000001";
const USER_ID = "300000000000000001";

describe("member events", () => {
  it("lists joins and leaves newest first, per server", () => {
    const store = new MemberEventStore();
    store.record(GUILD_ID, USER_ID, MemberEvent.JOIN, 100);
    store.record(GUILD_ID, USER_ID, MemberEvent.LEAVE, 200);
    store.record("900000000000000002", USER_ID, MemberEvent.JOIN, 300);
    expect(store.list(GUILD_ID, USER_ID)).toEqual([
      { kind: "leave", at: 200 },
      { kind: "join", at: 100 },
    ]);
    expect(store.countJoins(GUILD_ID, USER_ID)).toBe(1);
  });

  it("keeps only the newest events for each member", () => {
    const store = new MemberEventStore();
    for (let at = 1; at <= MAX_EVENTS_PER_MEMBER + 5; at += 1) {
      store.record(GUILD_ID, USER_ID, MemberEvent.JOIN, at);
    }
    const events = store.list(GUILD_ID, USER_ID);
    expect(events).toHaveLength(MAX_EVENTS_PER_MEMBER);
    expect(events.at(-1).at).toBe(6);
  });

  it("refuses unknown kinds", () => {
    expect(() => new MemberEventStore().record(GUILD_ID, USER_ID, "rename")).toThrow();
  });
});
