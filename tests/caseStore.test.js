import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";

const GUILD = "900000000000000001";
const OTHER_GUILD = "900000000000000002";
const USER = "300000000000000001";
const MOD = "300000000000000009";

const newCase = (overrides = {}) => ({
  guildId: GUILD,
  action: CaseAction.WARN,
  userId: USER,
  userTag: "member",
  moderatorId: MOD,
  moderatorTag: "mod",
  reason: "spam",
  createdAt: 1_000,
  ...overrides,
});

describe("CaseStore", () => {
  let store;

  beforeEach(() => {
    store = new CaseStore();
  });

  afterEach(() => store.close());

  it("numbers cases per server, starting at 1", () => {
    expect(store.createCase(newCase()).number).toBe(1);
    expect(store.createCase(newCase()).number).toBe(2);
    expect(store.createCase(newCase({ guildId: OTHER_GUILD })).number).toBe(1);
  });

  it("never reuses a deleted case's number", () => {
    store.createCase(newCase());
    store.createCase(newCase());
    expect(store.deleteCase(GUILD, 2)).toBe(true);
    expect(store.deleteCase(GUILD, 2)).toBe(false);
    expect(store.createCase(newCase()).number).toBe(3);
  });

  it("returns what was stored", () => {
    const created = store.createCase(
      newCase({ action: CaseAction.BAN, durationMs: 60_000, expiresAt: 61_000, pendingUnban: true, dmSent: false }),
    );
    expect(created).toEqual({
      guildId: GUILD,
      number: 1,
      action: CaseAction.BAN,
      userId: USER,
      userTag: "member",
      moderatorId: MOD,
      moderatorTag: "mod",
      reason: "spam",
      durationMs: 60_000,
      expiresAt: 61_000,
      pendingUnban: true,
      dmSent: false,
      logChannelId: undefined,
      logMessageId: undefined,
      createdAt: 1_000,
      updatedAt: undefined,
    });
    expect(store.getCase(GUILD, 1)).toEqual(created);
    expect(store.getCase(GUILD, 2)).toBeUndefined();
  });

  it("refuses unknown actions", () => {
    expect(() => store.createCase(newCase({ action: "nuke" }))).toThrow(/Unknown case action/);
  });

  it("lists and counts a member's cases, newest first", () => {
    store.createCase(newCase());
    store.createCase(newCase({ action: CaseAction.KICK }));
    store.createCase(newCase({ userId: "300000000000000002" }));
    store.createCase(newCase());

    expect(store.listCases(GUILD, USER).map((entry) => entry.number)).toEqual([4, 2, 1]);
    expect(store.listCases(GUILD, USER, 2).map((entry) => entry.number)).toEqual([4, 2]);
    expect(store.countCases(GUILD, USER)).toEqual({ warn: 2, kick: 1 });
    expect(store.countCases(OTHER_GUILD, USER)).toEqual({});
  });

  it("updates a reason and remembers the log message", () => {
    store.createCase(newCase());
    const updated = store.updateReason(GUILD, 1, "new reason", 5_000);
    expect(updated).toMatchObject({ reason: "new reason", updatedAt: 5_000 });
    expect(store.updateReason(GUILD, 99, "x")).toBeUndefined();

    store.setLogMessage(GUILD, 1, "800000000000000001", "700000000000000001");
    expect(store.getCase(GUILD, 1)).toMatchObject({ logChannelId: "800000000000000001", logMessageId: "700000000000000001" });
  });

  it("finds temporary bans that are due, and forgets them once lifted", () => {
    store.createCase(newCase({ action: CaseAction.BAN, expiresAt: 10_000, pendingUnban: true }));
    store.createCase(newCase({ action: CaseAction.BAN, userId: "300000000000000002", expiresAt: 50_000, pendingUnban: true }));
    store.createCase(newCase({ action: CaseAction.BAN, userId: "300000000000000003" }));

    expect(store.dueUnbans(20_000).map((entry) => entry.number)).toEqual([1]);
    expect(store.clearPendingUnbans(GUILD, USER)).toBe(1);
    expect(store.dueUnbans(20_000)).toEqual([]);
    expect(store.dueUnbans(60_000).map((entry) => entry.number)).toEqual([2]);
  });
});

describe("CaseStore on disk", () => {
  let directory;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "case-store-"));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("keeps cases and numbering across restarts", () => {
    const file = join(directory, "nested", "bot.db");
    const first = new CaseStore(file);
    first.createCase(newCase());
    first.close();

    const second = new CaseStore(file);
    expect(second.getCase(GUILD, 1)).toMatchObject({ reason: "spam" });
    expect(second.createCase(newCase()).number).toBe(2);
    second.close();
  });
});
