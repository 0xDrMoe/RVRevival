import { describe, expect, it } from "vitest";
import { AppealStatus, AppealStore } from "../src/appeals/appealStore.js";
import { appealQuestions, checkAppeals, DEFAULT_COOLDOWN_DAYS, InvalidAppeals, normalizeAppeals } from "../src/appeals/config.js";

const GUILD_ID = "900000000000000001";
const OTHER_GUILD_ID = "900000000000000002";
const USER_ID = "300000000000000001";
const MOD_ID = "300000000000000002";
const CHANNEL_ID = "800000000000000001";

describe("appeal store", () => {
  it("numbers appeals per server and lists them newest first", () => {
    const store = new AppealStore();
    const first = store.add({ guildId: GUILD_ID, userId: USER_ID, banReason: "spam", answers: [{ question: null, answer: "sorry" }], createdAt: 1 });
    store.add({ guildId: GUILD_ID, userId: MOD_ID, answers: [{ question: "Why?", answer: "mistake" }], createdAt: 2 });
    const other = store.add({ guildId: OTHER_GUILD_ID, userId: USER_ID, answers: [], createdAt: 3 });
    expect(first).toMatchObject({ number: 1, status: AppealStatus.OPEN, banReason: "spam", answers: [{ question: null, answer: "sorry" }] });
    expect(other.number).toBe(1);
    expect(store.list(GUILD_ID).map((appeal) => appeal.number)).toEqual([2, 1]);
    expect(store.list(GUILD_ID, { limit: 1, offset: 1 }).map((appeal) => appeal.number)).toEqual([1]);
    expect(store.countOpen(GUILD_ID)).toBe(2);
    expect(store.latestFor(GUILD_ID, USER_ID).number).toBe(1);
  });

  it("decides an appeal only once", () => {
    const store = new AppealStore();
    store.add({ guildId: GUILD_ID, userId: USER_ID, answers: [] });
    const decided = store.decide(GUILD_ID, 1, { status: AppealStatus.DENIED, decidedBy: MOD_ID, reason: "no", decidedAt: 50 });
    expect(decided).toMatchObject({ status: "denied", decidedBy: MOD_ID, decisionReason: "no", decidedAt: 50 });
    expect(store.decide(GUILD_ID, 1, { status: AppealStatus.ACCEPTED, decidedBy: MOD_ID })).toBeUndefined();
    expect(store.list(GUILD_ID, { status: "open" })).toEqual([]);
    expect(store.list(GUILD_ID, { status: "denied" })).toHaveLength(1);
    expect(() => store.decide(GUILD_ID, 1, { status: "open", decidedBy: MOD_ID })).toThrow();
  });
});

describe("appeal settings", () => {
  const isChannel = (id) => id === CHANNEL_ID;
  const valid = { enabled: true, channelId: CHANNEL_ID, questions: ["  Why were   you banned? "], cooldownDays: 7 };

  it("fills in defaults for anything missing", () => {
    expect(normalizeAppeals(undefined)).toEqual({ enabled: false, channelId: null, questions: [], cooldownDays: DEFAULT_COOLDOWN_DAYS });
    expect(normalizeAppeals({ enabled: true, cooldownDays: -1, questions: ["", "ok", 3] })).toMatchObject({ enabled: true, questions: ["ok"], cooldownDays: DEFAULT_COOLDOWN_DAYS });
  });

  it("checks dashboard input", () => {
    expect(checkAppeals(valid, { isChannel })).toEqual({ ...valid, questions: ["Why were you banned?"] });
    expect(checkAppeals({ enabled: false, channelId: null, questions: [], cooldownDays: 30 }, { isChannel })).toBeNull();
    const bad = [
      { ...valid, enabled: "yes" },
      { ...valid, channelId: "800000000000000009" },
      { ...valid, questions: ["a", "b", "c", "d", "e", "f"] },
      { ...valid, questions: ["x".repeat(201)] },
      { ...valid, questions: ["   "] },
      { ...valid, cooldownDays: 366 },
      { ...valid, cooldownDays: 1.5 },
    ];
    for (const value of bad) {
      expect(() => checkAppeals(value, { isChannel })).toThrow(InvalidAppeals);
    }
  });

  it("asks one general question when the server set none", () => {
    expect(appealQuestions(normalizeAppeals({}))).toEqual([null]);
    expect(appealQuestions(normalizeAppeals({ questions: ["A?", "B?"] }))).toEqual(["A?", "B?"]);
  });
});
