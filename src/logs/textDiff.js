// Word-level differences between two texts, for the "Changes" line of an
// edited message in the server log: removed words are struck through and
// added words are bold, so a one-word fix in a long message is easy to spot.

import { escapeMarkdown } from "discord.js";

// Texts longer than this (in words) aren't compared; the comparison takes
// time and memory that grow with the product of both lengths.
const MAX_TOKENS = 600;
// Unchanged words kept on each side of a change; longer stretches become "…".
const CONTEXT = 4;

const tokens = (text) => text.match(/\s+|[^\s]+/g) ?? [];

// [{ type: "same" | "removed" | "added", text }], or null when either text is
// too long to compare.
export function diffWords(before, after) {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return null;
  }
  // Longest common subsequence, filled from the end.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j] ? lcs[(i + 1) * cols + j + 1] + 1 : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const parts = [];
  const push = (type, text) => {
    const last = parts.at(-1);
    if (last?.type === type) {
      last.text += text;
    } else {
      parts.push({ type, text });
    }
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      push("removed", a[i++]);
    } else {
      push("added", b[j++]);
    }
  }
  while (i < a.length) {
    push("removed", a[i++]);
  }
  while (j < b.length) {
    push("added", b[j++]);
  }
  return parts;
}

// Markdown wrapping a changed stretch, keeping its outer spaces outside so
// Discord still renders it (`** word**` isn't bold).
function wrap(text, marker) {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const [, lead, body, trail] = match;
  return body ? `${lead}${marker}${escapeMarkdown(body.replace(/\s+/g, " "))}${marker}${trail}` : text;
}

// The changes as one line of Discord markdown, at most `max` characters, or
// undefined when there's nothing worth showing (no change, too long to compare,
// or everything changed).
export function describeEdit(before, after, max = 1000) {
  if (typeof before !== "string" || typeof after !== "string" || before === after) {
    return undefined;
  }
  const parts = diffWords(before, after);
  if (!parts || !parts.some((part) => part.type === "same" && part.text.trim())) {
    return undefined;
  }
  const shown = parts.map((part, index) => {
    if (part.type === "removed") {
      return wrap(part.text, "~~");
    }
    if (part.type === "added") {
      return wrap(part.text, "**");
    }
    // Unchanged words: keep a few next to each change.
    const words = tokens(part.text.replace(/\s+/g, " "));
    const keepStart = index > 0 ? CONTEXT * 2 : 0;
    const keepEnd = index < parts.length - 1 ? CONTEXT * 2 : 0;
    if (words.length <= keepStart + keepEnd + 2) {
      return escapeMarkdown(words.join(""));
    }
    const start = escapeMarkdown(words.slice(0, keepStart).join(""));
    const end = escapeMarkdown(words.slice(words.length - keepEnd).join(""));
    return `${start ? `${start.trimEnd()} ` : ""}…${end ? ` ${end.trimStart()}` : ""}`;
  });
  // "~~old~~ **new**": a replaced word reads as two, not one glued together.
  let text = shown
    .map((piece, index) => (parts[index].type === "removed" && parts[index + 1]?.type === "added" ? `${piece} ` : piece))
    .join("")
    .trim();
  if (text.length > max) {
    text = `${text.slice(0, max - 1)}…`;
  }
  return text || undefined;
}
