import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanEmoji } from "../src/community/rolePanels.js";
import { emojiMatches } from "../src/community/starboard.js";
import { EMOJI_GROUPS } from "../src/dashboard/public/emojiData.js";

const english = JSON.parse(readFileSync(new URL("../src/dashboard/public/locales/en.json", import.meta.url), "utf8"));
const entries = EMOJI_GROUPS.flatMap((group) =>
  group.emojis.split("|").map((entry) => {
    const space = entry.indexOf(" ");
    return { group: group.id, value: entry.slice(0, space), name: entry.slice(space + 1) };
  }),
);

describe("the dashboard's emoji picker data", () => {
  it("has the nine standard groups, each with a name on the page", () => {
    expect(EMOJI_GROUPS.map((group) => group.id)).toEqual(["smileys", "people", "nature", "food", "travel", "activities", "objects", "symbols", "flags"]);
    for (const group of EMOJI_GROUPS) {
      expect(english, group.id).toHaveProperty(`emojiGroup_${group.id}`);
    }
  });

  it("only offers emojis the bot accepts, each once and with a name", () => {
    expect(entries.length).toBeGreaterThan(1500);
    for (const entry of entries) {
      expect(cleanEmoji(entry.value), entry.name).toBe(entry.value);
      expect(entry.name.trim(), entry.value).not.toBe("");
    }
    expect(new Set(entries.map((entry) => entry.value)).size).toBe(entries.length);
  });

  it("includes the starboard's default star, and a picked emoji matches Discord's reaction", () => {
    const star = entries.find((entry) => entry.name === "star");
    expect(star.value).toBe("⭐");
    // Discord sends some reactions without the variation selector the picker keeps.
    const heart = entries.find((entry) => entry.name === "red heart");
    expect(emojiMatches(heart.value, { id: null, name: "❤" })).toBe(true);
  });
});
