// New colors before they are made: the dashboard wizard's checks, shared by
// its preview and the routes that create the roles. Pure, no Discord calls.

import { cleanColorName, hexToInt, MAX_COLORS, nameTaken, parseColor } from "./colors.js";
import { PACKS } from "./packs.js";

// How many colors one wizard run can add.
export const MAX_DRAFTS = 25;

// The name of the pack colour closest to `hex` ("#e53935" -> "Red").
export function nearestName(hex) {
  const target = hexToInt(hex);
  const distance = (other) => {
    const value = hexToInt(other);
    return ((target >> 16) - (value >> 16)) ** 2 + (((target >> 8) & 255) - ((value >> 8) & 255)) ** 2 + ((target & 255) - (value & 255)) ** 2;
  };
  return Object.values(PACKS)
    .flat()
    .reduce((best, entry) => (distance(entry[1]) < distance(best[1]) ? entry : best))[0];
}

// Pasted lines -> [{ line, name, hex, hex2 }] as typed (not yet checked).
// A line is "Name #hex [#hex2]", "#hex [#hex2] Name" or just "#hex"; hex
// codes may lack the "#", and "Name, #hex" works too. Empty lines are skipped.
export function parseColorLines(text) {
  const HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  return String(text ?? "")
    .split(/\r?\n/)
    .map((raw, index) => ({ raw: raw.trim(), line: index + 1 }))
    .filter(({ raw }) => raw.length > 0)
    .map(({ raw, line }) => {
      const words = raw.split(/[\s,;]+/).filter(Boolean);
      const codes = words.filter((word) => word.startsWith("#") || (HEX.test(word) && /\d/.test(word)));
      const name = words.filter((word) => !codes.includes(word)).join(" ");
      return { line, name, hex: codes[0] ?? "", hex2: codes[1] ?? null, extra: codes.length > 2 };
    });
}

// Checks new colors against the list. `entries` are { name, hex, hex2 } as
// typed (name may be empty: it's named after the closest pack colour).
// Returns { colors: [{ name, hex, hex2 }], problems: [{ index, problem, name? }] }
// where problem is "hex", "hex2", "gradient", "extra", "name-taken",
// "duplicate" or "full". Only `colors` would be made.
export function checkNewColors(list, entries, { gradients = false } = {}) {
  const colors = [];
  const problems = [];
  const room = Math.max(0, MAX_COLORS - list.length);
  const taken = (name) => nameTaken(list, name) || colors.some((color) => color.name.toLowerCase() === name.toLowerCase());
  (Array.isArray(entries) ? entries.slice(0, MAX_DRAFTS) : []).forEach((entry, index) => {
    const hex = parseColor(entry?.hex);
    const hex2 = entry?.hex2 ? parseColor(entry.hex2) : null;
    if (entry?.extra) {
      return problems.push({ index, problem: "extra" });
    }
    if (!hex) {
      return problems.push({ index, problem: "hex" });
    }
    if (entry?.hex2 && !hex2) {
      return problems.push({ index, problem: "hex2" });
    }
    if (hex2 && !gradients) {
      return problems.push({ index, problem: "gradient" });
    }
    let name = cleanColorName(entry?.name);
    if (!name) {
      // An automatic name gets a number when it's already used: "Red 2".
      const base = nearestName(hex);
      name = base;
      for (let number = 2; taken(name); number += 1) {
        name = `${base} ${number}`;
      }
    } else if (taken(name)) {
      return problems.push({ index, problem: nameTaken(list, name) ? "name-taken" : "duplicate", name });
    }
    if (colors.length >= room) {
      return problems.push({ index, problem: "full" });
    }
    colors.push({ name, hex, hex2: hex2 && hex2 !== hex ? hex2 : null });
  });
  return { colors, problems };
}

// `list` with `added` put in at `position` (1 = the top; anything past the end,
// or none, adds them at the end).
export function insertColors(list, added, position) {
  const at = Number.isInteger(position) && position >= 1 ? Math.min(position - 1, list.length) : list.length;
  return [...list.slice(0, at), ...added, ...list.slice(at)];
}
