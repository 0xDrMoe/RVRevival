import { describe, expect, it } from "vitest";
import {
  activeRules,
  AUTOMOD_RULES,
  checkAutomod,
  cleanDomain,
  defaultAutomod,
  InvalidAutomod,
  normalizeAutomod,
  ruleSkips,
  withPath,
} from "../src/automod/config.js";

const ROLE_ID = "700000000000000001";
const CHANNEL_ID = "800000000000000001";
const server = { isRole: (id) => id === ROLE_ID, isChannel: (id) => id === CHANNEL_ID };

describe("normalizeAutomod", () => {
  it("fills in defaults for a missing or broken value", () => {
    expect(normalizeAutomod(undefined)).toEqual(defaultAutomod());
    expect(normalizeAutomod("nonsense")).toEqual(defaultAutomod());
    expect(normalizeAutomod({ enabled: true }).enabled).toBe(true);
    expect(Object.keys(defaultAutomod().rules)).toEqual(AUTOMOD_RULES);
  });

  it("keeps valid values and drops invalid ones", () => {
    const config = normalizeAutomod({
      enabled: true,
      rules: {
        spam: { enabled: true, action: "warn", messages: 9, seconds: 999 },
        bannedWords: { enabled: true, action: "explode", words: ["  Bad  Word ", "bad word", "", 5] },
        links: { allowedDomains: ["https://www.YouTube.com/watch", "not a site"] },
      },
      exemptRoleIds: [ROLE_ID, ROLE_ID, "x"],
      escalation: { warnings: 3, action: "ban" },
    });
    expect(config.rules.spam).toMatchObject({ enabled: true, action: "warn", messages: 9, seconds: 5 });
    expect(config.rules.bannedWords).toMatchObject({ enabled: true, action: "delete", words: ["bad word"] });
    expect(config.rules.links.allowedDomains).toEqual(["youtube.com"]);
    expect(config.exemptRoleIds).toEqual([ROLE_ID]);
    expect(config.escalation).toEqual({ warnings: 3, action: "ban", timeoutMinutes: 60 });
    expect(activeRules(config)).toEqual(["bannedWords", "spam"]);
  });

  it("gives every rule its extras, keeping valid ones and dropping invalid ones", () => {
    expect(defaultAutomod().rules.caps).toMatchObject({ notify: true, timeoutMinutes: null, exemptRoleIds: [], exemptChannelIds: [] });
    const config = normalizeAutomod({
      rules: {
        spam: { enabled: true, action: "log", notify: false, timeoutMinutes: 30, exemptRoleIds: [ROLE_ID, ROLE_ID, "x"], exemptChannelIds: [CHANNEL_ID] },
        caps: { notify: "no", timeoutMinutes: 0, exemptRoleIds: "nope" },
      },
    });
    expect(config.rules.spam).toMatchObject({ action: "log", notify: false, timeoutMinutes: 30, exemptRoleIds: [ROLE_ID], exemptChannelIds: [CHANNEL_ID] });
    expect(config.rules.caps).toMatchObject({ notify: true, timeoutMinutes: null, exemptRoleIds: [] });
  });
});

describe("ruleSkips", () => {
  it("skips a rule for its own roles and channels only", () => {
    const rule = { ...defaultAutomod().rules.links, exemptRoleIds: [ROLE_ID], exemptChannelIds: [CHANNEL_ID] };
    expect(ruleSkips(rule, { channelIds: ["1", CHANNEL_ID], roleIds: new Map() })).toBe(true);
    expect(ruleSkips(rule, { channelIds: ["1"], roleIds: new Map([[ROLE_ID, {}]]) })).toBe(true);
    expect(ruleSkips(rule, { channelIds: ["1"], roleIds: undefined })).toBe(false);
  });
});

describe("checkAutomod", () => {
  const valid = () => ({ ...defaultAutomod(), enabled: true, exemptRoleIds: [ROLE_ID], exemptChannelIds: [CHANNEL_ID] });

  it("accepts a full configuration and returns it cleaned", () => {
    const value = withPath(valid(), ["rules", "links", "allowedDomains"], ["WWW.Twitch.tv"]);
    expect(checkAutomod(value, server).rules.links.allowedDomains).toEqual(["twitch.tv"]);
  });

  it("accepts rules without the newer extras (older pages and backups)", () => {
    const value = valid();
    for (const rule of AUTOMOD_RULES) {
      const { notify, timeoutMinutes, exemptRoleIds, exemptChannelIds, ...rest } = value.rules[rule];
      value.rules[rule] = rest;
    }
    expect(checkAutomod(value, server).rules.spam.notify).toBe(true);
  });

  it("accepts per-rule extras from this server", () => {
    const value = withPath(valid(), ["rules", "caps"], {
      ...valid().rules.caps,
      action: "log",
      notify: false,
      timeoutMinutes: 45,
      exemptRoleIds: [ROLE_ID],
      exemptChannelIds: [CHANNEL_ID],
    });
    expect(checkAutomod(value, server).rules.caps).toMatchObject({ action: "log", notify: false, timeoutMinutes: 45 });
  });

  it.each([
    ["not an object", () => []],
    ["no on/off", () => ({ ...valid(), enabled: "yes" })],
    ["an unknown action", () => withPath(valid(), ["rules", "caps", "action"], "ban")],
    ["a number out of range", () => withPath(valid(), ["rules", "spam", "seconds"], 1)],
    ["a decimal", () => withPath(valid(), ["timeoutMinutes"], 2.5)],
    ["a bad escalation", () => withPath(valid(), ["escalation", "action"], "nuke")],
    ["a too-long word", () => withPath(valid(), ["rules", "bannedWords", "words"], ["x".repeat(61)])],
    ["a bad website", () => withPath(valid(), ["rules", "links", "allowedDomains"], ["no spaces.com x"])],
    ["a foreign role", () => ({ ...valid(), exemptRoleIds: ["700000000000000009"] })],
    ["a foreign channel", () => ({ ...valid(), exemptChannelIds: ["800000000000000009"] })],
    ["a rule notice that isn't on/off", () => withPath(valid(), ["rules", "spam", "notify"], "yes")],
    ["a rule timeout out of range", () => withPath(valid(), ["rules", "spam", "timeoutMinutes"], 0)],
    ["a rule skipping a foreign role", () => withPath(valid(), ["rules", "spam", "exemptRoleIds"], ["700000000000000009"])],
    ["a rule skipping a foreign channel", () => withPath(valid(), ["rules", "spam", "exemptChannelIds"], ["800000000000000009"])],
  ])("refuses %s", (_name, build) => {
    expect(() => checkAutomod(build(), server)).toThrow(InvalidAutomod);
  });
});

describe("cleanDomain", () => {
  it("reduces an address to its website", () => {
    expect(cleanDomain("https://www.example.co.uk:8080/path?q")).toBe("example.co.uk");
    expect(cleanDomain("clips.twitch.tv")).toBe("clips.twitch.tv");
    expect(cleanDomain("localhost")).toBeUndefined();
    expect(cleanDomain("")).toBeUndefined();
  });
});
