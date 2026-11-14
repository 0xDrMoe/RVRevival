import { describe, expect, it } from "vitest";
import { AUTOMOD_RULES, checkAutomod, defaultAutomod, withPath } from "../src/automod/config.js";
import {
  applyPreset,
  AUTOMOD_PRESETS,
  CUSTOM_PRESET,
  matchingPreset,
  RECOMMENDED_PRESET,
} from "../src/dashboard/public/automodPresets.js";

const ROLE_ID = "700000000000000001";
const CHANNEL_ID = "800000000000000001";
const server = { isRole: (id) => id === ROLE_ID, isChannel: (id) => id === CHANNEL_ID };

describe("automod presets", () => {
  it("recommends one of them", () => {
    expect(AUTOMOD_PRESETS).toContain(RECOMMENDED_PRESET);
  });

  it.each(AUTOMOD_PRESETS)("%s is a valid automod setting that sets every rule", (preset) => {
    const config = applyPreset({ ...defaultAutomod(), enabled: true }, preset);
    expect(Object.keys(config.rules)).toEqual(AUTOMOD_RULES);
    expect(checkAutomod(config, server)).toEqual(config);
    expect(matchingPreset(config)).toBe(preset);
  });

  it("keeps the word list, websites, exemptions and main switch, and resets rule extras", () => {
    let config = { ...defaultAutomod(), enabled: false, exemptRoleIds: [ROLE_ID], exemptChannelIds: [CHANNEL_ID] };
    config = withPath(config, ["rules", "bannedWords", "words"], ["noob"]);
    config = withPath(config, ["rules", "links", "allowedDomains"], ["youtube.com"]);
    config = withPath(config, ["rules", "spam", "exemptRoleIds"], [ROLE_ID]);
    config = withPath(config, ["rules", "spam", "notify"], false);
    const result = applyPreset(config, "strict");
    expect(result.enabled).toBe(false);
    expect(result.rules.bannedWords.words).toEqual(["noob"]);
    expect(result.rules.links.allowedDomains).toEqual(["youtube.com"]);
    expect(result.exemptRoleIds).toEqual([ROLE_ID]);
    expect(result.exemptChannelIds).toEqual([CHANNEL_ID]);
    expect(result.rules.spam).toMatchObject({ exemptRoleIds: [], notify: true, timeoutMinutes: null });
    expect(config.rules.spam.notify).toBe(false); // the original is untouched
  });

  it("calls anything else custom", () => {
    expect(matchingPreset(defaultAutomod())).toBe(CUSTOM_PRESET);
    const balanced = applyPreset(defaultAutomod(), "balanced");
    expect(matchingPreset(withPath(balanced, ["rules", "caps", "enabled"], true))).toBe(CUSTOM_PRESET);
    expect(matchingPreset(withPath(balanced, ["rules", "spam", "timeoutMinutes"], 5))).toBe(CUSTOM_PRESET);
    expect(matchingPreset(withPath(balanced, ["rules", "invites", "exemptChannelIds"], [CHANNEL_ID]))).toBe(CUSTOM_PRESET);
    expect(matchingPreset(withPath(balanced, ["timeoutMinutes"], 11))).toBe(CUSTOM_PRESET);
  });

  it("refuses an unknown preset", () => {
    expect(() => applyPreset(defaultAutomod(), "nuclear")).toThrow();
  });
});
