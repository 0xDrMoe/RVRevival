// Writes src/dashboard/public/emojiData.js, the standard emojis for the
// dashboard's emoji picker, from the unicode-emoji-json package (MIT,
// https://github.com/muan/unicode-emoji-json).
//
//   npm pack unicode-emoji-json && tar xzf unicode-emoji-json-*.tgz
//   node tools/buildEmojiData.js package/data-by-group.json
//
// Only emojis Discord can show (up to MAX_EMOJI_VERSION) and that the bot
// accepts as one emoji (cleanEmoji) are kept. Skin tones are left out.

import { readFileSync, writeFileSync } from "node:fs";
import { cleanEmoji } from "../src/community/rolePanels.js";

const MAX_EMOJI_VERSION = 15.0;
// The package's group names, and the ids the dashboard translates (emojiGroup_<id>).
const GROUPS = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "nature",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
};

const source = process.argv[2];
if (!source) {
  console.error("Usage: node tools/buildEmojiData.js <path to data-by-group.json>");
  process.exit(1);
}

const skipped = [];
const groups = JSON.parse(readFileSync(source, "utf8"))
  .filter((group) => group.name in GROUPS)
  .map((group) => ({
    id: GROUPS[group.name],
    emojis: group.emojis
      .filter((entry) => Number(entry.emoji_version) <= MAX_EMOJI_VERSION)
      .filter((entry) => cleanEmoji(entry.emoji) === entry.emoji || (skipped.push(entry.name), false))
      .map((entry) => `${entry.emoji} ${entry.name.replace(/[|]/g, " ")}`),
  }));

const lines = [
  "// The standard emojis for the dashboard's emoji picker, by group. Each entry is",
  '// "<emoji> <name>", joined with "|". Made by tools/buildEmojiData.js from',
  "// unicode-emoji-json (MIT, https://github.com/muan/unicode-emoji-json); don't edit by hand.",
  "",
  "export const EMOJI_GROUPS = [",
  ...groups.map((group) => `  { id: ${JSON.stringify(group.id)}, emojis: ${JSON.stringify(group.emojis.join("|"))} },`),
  "];",
  "",
];
writeFileSync(new URL("../src/dashboard/public/emojiData.js", import.meta.url), lines.join("\n"));
const total = groups.reduce((sum, group) => sum + group.emojis.length, 0);
console.log(`Wrote ${total} emojis in ${groups.length} groups.${skipped.length ? ` Skipped: ${skipped.join(", ")}` : ""}`);
