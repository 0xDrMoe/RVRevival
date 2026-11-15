// Color roles: a list of colors members pick from with /color set or a color
// panel, each one a plain Discord role the bot keeps in step. A member has one
// color at a time; picking another swaps the role.
//
// The list is saved in the server's settings (Setting.COLORS), in the order
// members see it (color 1, color 2, ...):
//
//   [{ roleId, name, hex, hex2, made, addedAt }]
//
//   hex      "#rrggbb", the role's colour
//   hex2     "#rrggbb" or null: the second colour of a gradient role (servers
//            with Discord's enhanced role styles, boost level 2)
//   made     true when the bot created the role, so deleting the color also
//            deletes the role. Roles added with /color existing are left alone.
//   addedAt  when it was added (ms), for "sort by date added"
//
// Everything here is plain data: no Discord calls (see colorService.js).

import { Setting } from "../settings/guildSettings.js";

// A message holds 5 rows: 4 menus of 25 colors on a panel, plus its button row.
export const MAX_COLORS = 100;
export const MAX_NAME_LENGTH = 32;
export const MENU_SIZE = 25;

export const SortKind = Object.freeze({
  HUE: "hue",
  SHADE: "shade",
  LUMINANCE: "luminance",
  SATURATION: "saturation",
  NAME: "name",
  ADDED: "added",
});

const SNOWFLAKE = /^\d{17,20}$/;
const HEX = /^#[0-9a-f]{6}$/;

// --- Reading colours ------------------------------------------------------------

// "#ff8800", "ff8800", "#f80", "rgb(255, 136, 0)", "255,136,0" or "255 136 0"
// as "#ff8800", or undefined if it isn't a colour.
export function parseColor(text) {
  const value = String(text ?? "").trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return `#${digits}`;
  }
  const rgb = /^(?:rgb\s*\()?\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/.exec(value);
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.every((part) => part <= 255)) {
      return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return undefined;
}

export const hexToInt = (hex) => Number.parseInt(hex.slice(1), 16);
export const intToHex = (value) => `#${(Number(value) & 0xffffff).toString(16).padStart(6, "0")}`;

export function hexToRgb(hex) {
  const value = hexToInt(hex);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// { h: 0-360, s: 0-1, l: 0-1 }
export function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((part) => part / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    return { h: 0, s: 0, l };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s, l };
}

// WCAG relative luminance, 0 (black) to 1 (white).
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((part) => {
    const c = part / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A random colour that's neither too dark nor too washed out to read.
export function randomColor(random = Math.random) {
  const h = random() * 360;
  const s = 0.55 + random() * 0.4;
  const l = 0.45 + random() * 0.25;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((part) => Math.round(part * 255).toString(16).padStart(2, "0")).join("")}`;
}

// --- The saved list --------------------------------------------------------------

// A color name: trimmed, one line, inner spaces collapsed, at most
// MAX_NAME_LENGTH characters. Empty when nothing usable is left.
export function cleanColorName(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

function normalizeColor(entry) {
  if (!entry || typeof entry !== "object" || !SNOWFLAKE.test(entry.roleId ?? "")) {
    return undefined;
  }
  const hex = typeof entry.hex === "string" && HEX.test(entry.hex) ? entry.hex : undefined;
  const name = cleanColorName(entry.name);
  if (!hex || !name) {
    return undefined;
  }
  return {
    roleId: entry.roleId,
    name,
    hex,
    hex2: typeof entry.hex2 === "string" && HEX.test(entry.hex2) ? entry.hex2 : null,
    made: entry.made === true,
    addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
  };
}

// The saved list with anything unusable (or a role listed twice) dropped. Never throws.
export function normalizeColors(saved) {
  const seen = new Set();
  const colors = [];
  for (const entry of Array.isArray(saved) ? saved : []) {
    const color = normalizeColor(entry);
    if (color && !seen.has(color.roleId) && colors.length < MAX_COLORS) {
      seen.add(color.roleId);
      colors.push(color);
    }
  }
  return colors;
}

export const colorsOf = (guildSettings, guildId) => normalizeColors(guildSettings?.get(guildId, Setting.COLORS));

export const saveColors = (guildSettings, guildId, colors) =>
  colors.length > 0 ? guildSettings.set(guildId, Setting.COLORS, colors) : guildSettings.clear(guildId, Setting.COLORS);

// The color a member typed: its number in the list ("3" or "#3"), its name,
// or a role mention or ID. Undefined if there's no such color.
export function findColor(colors, query) {
  const text = String(query ?? "").trim();
  if (!text) {
    return undefined;
  }
  const number = /^#?(\d{1,3})\.?$/.exec(text);
  if (number) {
    const index = Number(number[1]) - 1;
    if (index >= 0 && index < colors.length) {
      return colors[index];
    }
  }
  const roleId = /^(?:<@&)?(\d{17,20})>?$/.exec(text)?.[1];
  if (roleId) {
    return colors.find((color) => color.roleId === roleId);
  }
  const name = cleanColorName(text);
  return colors.find((color) => sameName(color.name, name));
}

export const nameTaken = (colors, name, exceptRoleId = null) =>
  colors.some((color) => color.roleId !== exceptRoleId && sameName(color.name, name));

// Autocomplete choices: "3. Gold (#ffd700)" with the number as the value, so
// two colors with similar names can't be mixed up. At most 25.
export function colorChoices(colors, typed) {
  const query = String(typeof typed === "string" ? typed : "").trim().toLowerCase();
  return colors
    .map((color, index) => ({ color, number: index + 1 }))
    .filter(({ color, number }) => !query || color.name.toLowerCase().includes(query) || String(number) === query.replace(/^#/, "") || color.hex.includes(query))
    .slice(0, MENU_SIZE)
    .map(({ color, number }) => ({ name: `${number}. ${color.name} (${color.hex}${color.hex2 ? ` → ${color.hex2}` : ""})`.slice(0, 100), value: String(number) }));
}

// --- Sorting ---------------------------------------------------------------------

// Greys have no real hue, so the hue sorts put them last, dark to light.
const GREY_SATURATION = 0.1;
const isGrey = (hsl) => hsl.s < GREY_SATURATION || hsl.l < 0.06 || hsl.l > 0.96;

const byHue = (a, b) => {
  const [x, y] = [hexToHsl(a.hex), hexToHsl(b.hex)];
  if (isGrey(x) !== isGrey(y)) {
    return isGrey(x) ? 1 : -1;
  }
  if (isGrey(x)) {
    return x.l - y.l;
  }
  return x.h - y.h || x.l - y.l;
};

// Twelve slices of the rainbow, each one dark to light: shades of a colour sit together.
const HUE_SLICES = 12;
const byShade = (a, b) => {
  const [x, y] = [hexToHsl(a.hex), hexToHsl(b.hex)];
  const slice = (hsl) => (isGrey(hsl) ? HUE_SLICES : Math.floor(((hsl.h + 15) % 360) / (360 / HUE_SLICES)));
  return slice(x) - slice(y) || luminance(a.hex) - luminance(b.hex);
};

const SORTS = {
  [SortKind.HUE]: byHue,
  [SortKind.SHADE]: byShade,
  [SortKind.LUMINANCE]: (a, b) => luminance(a.hex) - luminance(b.hex),
  [SortKind.SATURATION]: (a, b) => hexToHsl(a.hex).s - hexToHsl(b.hex).s || luminance(a.hex) - luminance(b.hex),
  [SortKind.NAME]: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  [SortKind.ADDED]: (a, b) => a.addedAt - b.addedAt,
};

// A sorted copy (stable, so equal colors keep their order).
export function sortColors(colors, kind) {
  const compare = SORTS[kind];
  if (!compare) {
    throw new Error(`Unknown sort "${kind}"`);
  }
  return [...colors].sort(compare);
}

// --- Role positions --------------------------------------------------------------
//
// Discord shows the colour of a member's highest coloured role, so color roles
// sit together as one block. These work out the positions to send to Discord
// (PATCH /guilds/:id/roles) from the server's roles ({ id, position }), and
// return only the roles whose position changes.

const byPosition = (roles) => [...roles].sort((a, b) => a.position - b.position || (BigInt(b.id) < BigInt(a.id) ? -1 : 1));

function changedPositions(roles, ordered) {
  const before = new Map(roles.map((role) => [role.id, role.position]));
  // ordered is bottom to top; @everyone stays at 0.
  return ordered
    .map((role, index) => ({ id: role.id, position: index }))
    .filter((entry) => entry.position !== 0 && before.get(entry.id) !== entry.position);
}

// Moves `blockIds` (color 1 first) to sit together right below the role
// `belowId`, keeping every other role's order. `everyoneId` is the server's ID.
export function blockPositions(roles, blockIds, belowId, everyoneId) {
  const block = blockIds.map((id) => roles.find((role) => role.id === id)).filter(Boolean);
  const blockSet = new Set(block.map((role) => role.id));
  const others = byPosition(roles.filter((role) => !blockSet.has(role.id) && role.id !== everyoneId));
  const insertAt = others.findIndex((role) => role.id === belowId);
  if (insertAt === -1 || block.length === 0) {
    return [];
  }
  // Bottom to top: color 1 ends up highest in the block.
  const ordered = [...others.slice(0, insertAt), ...[...block].reverse(), ...others.slice(insertAt)];
  return changedPositions(roles, [{ id: everyoneId, position: 0 }, ...ordered]);
}

// Puts `orderedIds` (color 1 first) into the positions those same roles hold
// now, so the block stays where it is but follows the list's order.
export function reorderPositions(roles, orderedIds) {
  const members = orderedIds.map((id) => roles.find((role) => role.id === id)).filter(Boolean);
  const slots = members.map((role) => role.position).sort((a, b) => b - a);
  const before = new Map(roles.map((role) => [role.id, role.position]));
  return members.map((role, index) => ({ id: role.id, position: slots[index] })).filter((entry) => before.get(entry.id) !== entry.position);
}

// Where the color block goes: the role it sits right below. That's the role
// just above the highest color role there already is (so the block stays
// where admins put it), or the bot's highest role when there are no color
// roles yet or that spot is out of the bot's reach. `colorIds` are the roles
// already in the block, not ones just made.
export function anchorFor(roles, colorIds, botTopRoleId) {
  const all = byPosition(roles);
  const botTop = all.find((role) => role.id === botTopRoleId);
  const colorRoles = all.filter((role) => colorIds.includes(role.id));
  if (colorRoles.length === 0 || !botTop) {
    return botTopRoleId;
  }
  const highest = colorRoles.at(-1);
  const above = all[all.findIndex((role) => role.id === highest.id) + 1];
  if (!above || above.position > botTop.position || (above.position === botTop.position && above.id !== botTop.id)) {
    return botTopRoleId;
  }
  return above.id;
}
