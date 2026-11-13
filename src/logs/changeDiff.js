// What changed between two versions of a setting, as a few short lines for a
// log entry: only the parts that changed, never the whole value twice.
//
//   Bans: none → #bans
//   Rules › Spam › Action: `delete` → `timeout`
//   Roles: added @Mods, removed @Helpers
//   Custom commands: added `rules`
//   and 4 more changes
//
// Values are walked the same way for every setting: objects key by key, lists
// of plain values as added and removed, and lists of objects matched by their
// name (or trigger, label, ID…) so an edit to one entry names that entry.

const SNOWFLAKE = /^\d{17,20}$/;
// Most lines one change is shown with; the rest are counted.
export const MAX_CHANGE_LINES = 6;
// Most items listed in one "added …" line.
const MAX_LISTED = 5;
// Longest text shown for one value.
const MAX_TEXT = 60;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isEmpty = (value) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
const isPlain = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);

function same(a, b) {
  // Unset, empty and off all mean "nothing here".
  const nothing = (value) => isEmpty(value) || value === false;
  if (nothing(a) && nothing(b)) {
    return true;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// Keys that name an entry in a list, best first.
const NAME_KEYS = ["name", "trigger", "label", "title", "command", "key", "id", "level", "count", "emoji", "channelId", "roleId"];

// Whether every item has its own `key` (a string or number no other item has).
function namesBy(items, key) {
  const values = items.map((item) => item?.[key]);
  return values.every((value) => typeof value === "string" || typeof value === "number") && new Set(values).size === values.length;
}

// "camelCase" -> "Camel case", "3" -> "#4".
export function humanize(key) {
  const text = String(key);
  if (/^\d+$/.test(text) && text.length < 6) {
    return `#${Number(text) + 1}`;
  }
  if (text.startsWith("/")) {
    return text;
  }
  const words = text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\bIds?\b/g, "")
    .trim()
    .toLowerCase();
  const named = words.replace(/\b(xp|dm|url|id)\b/g, (word) => word.toUpperCase());
  return named ? `${named.charAt(0).toUpperCase()}${named.slice(1)}` : text;
}

function cut(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1).trimEnd()}…` : flat;
}

// Formats values for a line. `mention(id, key)` turns an ID into a mention.
function formatter(mention) {
  const format = (value, key) => {
    if (isEmpty(value)) {
      return "none";
    }
    if (typeof value === "boolean") {
      return value ? "on" : "off";
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (typeof value === "string") {
      if (SNOWFLAKE.test(value)) {
        return mention(value, key);
      }
      // Short single words (an action, a mode) read best as code.
      return /^[\w.:+-]{1,30}$/.test(value) ? `\`${value}\`` : `"${cut(value).replace(/"/g, "'")}"`;
    }
    if (Array.isArray(value)) {
      return listOf(value.map((item) => (isPlain(item) ? format(item, key) : entryName(item, mention))));
    }
    return entryName(value, mention);
  };
  return format;
}

function listOf(items) {
  const shown = items.slice(0, MAX_LISTED);
  const more = items.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

// How an entry in a list is named in a line: "`rules`", "level 5", "#general".
function entryName(item, mention) {
  if (!isObject(item)) {
    return String(item);
  }
  for (const key of ["name", "trigger", "label", "title", "command", "key"]) {
    if (typeof item[key] === "string" && item[key]) {
      return `\`${cut(item[key])}\``;
    }
  }
  if (typeof item.level === "number") {
    return `level ${item.level}`;
  }
  if (typeof item.count === "number") {
    return String(item.count);
  }
  if (typeof item.channelId === "string") {
    return mention(item.channelId, "channelId");
  }
  if (typeof item.roleId === "string") {
    return mention(item.roleId, "roleId");
  }
  return "an entry";
}

// The changes between `before` and `after` as [{ path: ["Rules", "Spam"], text }].
// Options:
//   mention(id, key)   how an ID is shown (default: by the key's name)
//   label(key, depth)  a better name for a key than humanize() gives, or undefined
export function diffValues(before, after, { mention = mentionByKey, label = () => undefined } = {}) {
  const format = formatter(mention);
  const changes = [];
  const name = (key, depth) => label(key, depth) ?? humanize(key);

  function walk(a, b, path, key) {
    if (same(a, b)) {
      return;
    }
    // An object that wasn't there counts as an empty one, so only what was set is listed.
    if ((isObject(a) || isEmpty(a)) && (isObject(b) || isEmpty(b)) && (isObject(a) || isObject(b))) {
      const left = isObject(a) ? a : {};
      const right = isObject(b) ? b : {};
      const keys = [...new Set([...Object.keys(right), ...Object.keys(left)])];
      for (const next of keys) {
        walk(left[next], right[next], [...path, name(next, path.length)], next);
      }
      return;
    }
    if ((Array.isArray(a) || isEmpty(a)) && (Array.isArray(b) || isEmpty(b))) {
      diffList(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [], path, key);
      return;
    }
    changes.push({ path, text: `${format(a, key)} → ${format(b, key)}` });
  }

  function diffList(a, b, path, key) {
    if ([...a, ...b].every(isPlain)) {
      const added = b.filter((item) => !a.includes(item));
      const removed = a.filter((item) => !b.includes(item));
      const parts = [];
      if (added.length > 0) {
        parts.push(`added ${format(added, key)}`);
      }
      if (removed.length > 0) {
        parts.push(`removed ${format(removed, key)}`);
      }
      changes.push({ path, text: parts.length > 0 ? parts.join(", ") : "order changed" });
      return;
    }
    // Entries are matched by their name (or ID…), else by position.
    const nameKey = [...a, ...b].every(isObject) ? NAME_KEYS.find((key) => namesBy(a, key) && namesBy(b, key)) : undefined;
    const keyOf = nameKey ? (item) => String(item[nameKey]) : (item, index) => String(index);
    const before = new Map(a.map((item, index) => [keyOf(item, index), item]));
    const after = new Map(b.map((item, index) => [keyOf(item, index), item]));
    const added = [...after].filter(([id]) => !before.has(id)).map(([, item]) => item);
    const removed = [...before].filter(([id]) => !after.has(id)).map(([, item]) => item);
    const parts = [];
    if (added.length > 0) {
      parts.push(`added ${listOf(added.map((item) => (isPlain(item) ? format(item, key) : entryName(item, mention))))}`);
    }
    if (removed.length > 0) {
      parts.push(`removed ${listOf(removed.map((item) => (isPlain(item) ? format(item, key) : entryName(item, mention))))}`);
    }
    if (parts.length > 0) {
      changes.push({ path, text: parts.join(", ") });
    }
    for (const [id, item] of after) {
      if (before.has(id)) {
        const old = before.get(id);
        const segment = isObject(item) ? entryName(item, mention).replace(/`/g, "") : name(id, path.length);
        walk(old, item, [...path, segment === "an entry" ? humanize(id) : segment], key);
      }
    }
    if (parts.length === 0 && [...after.keys()].join() !== [...before.keys()].join() && same([...a].sort(), [...b].sort())) {
      changes.push({ path, text: "order changed" });
    }
  }

  walk(before, after, [], undefined);
  return changes;
}

// An ID shown by what its key says it is: channels, roles, else people.
export function mentionByKey(id, key = "") {
  if (/channel|category|parent/i.test(key)) {
    return `<#${id}>`;
  }
  if (/role/i.test(key)) {
    return `<@&${id}>`;
  }
  if (/user|member|owner|moderator/i.test(key)) {
    return `<@${id}>`;
  }
  return `\`${id}\``;
}

// A mention() that knows the server's channels and roles, so IDs under keys
// that don't say what they are (log routes) still show as #channel or @role.
export function serverMention({ channelIds = [], roleIds = [] } = {}) {
  const channels = new Set(channelIds);
  const roles = new Set(roleIds);
  return (id, key) => {
    if (channels.has(id)) {
      return `<#${id}>`;
    }
    if (roles.has(id)) {
      return `<@&${id}>`;
    }
    return mentionByKey(id, key);
  };
}

// Lines for a list of changes, at most `max`: "**Path:** text", or just the
// text when the change is to the whole value. The rest are counted.
export function changeLines(changes, { max = MAX_CHANGE_LINES } = {}) {
  const line = ({ path, text }) => (path.length > 0 ? `**${path.join(" › ")}:** ${text}` : text);
  if (changes.length <= max) {
    return changes.map(line);
  }
  const shown = changes.slice(0, max - 1).map(line);
  const more = changes.length - shown.length;
  return [...shown, `and ${more} more change${more === 1 ? "" : "s"}`];
}
