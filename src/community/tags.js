// Custom commands ("tags"): saved answers staff write once and anyone can post
// with /tag, like the download link, how to report a bug or the FAQ. Saved in
// the server's settings (Setting.TAGS) as a list of { name, content }, sorted
// by name. Managed with /tags or on the dashboard's Custom commands page.

import { Setting } from "../settings/guildSettings.js";

export const MAX_TAGS = 50;
export const MAX_TAG_NAME_LENGTH = 32;
export const MAX_TAG_LENGTH = 2000;
// Lowercase letters (any alphabet), digits and dashes, like slash command names.
const TAG_NAME = /^[\p{Ll}\p{Lo}\p{N}-]{1,32}$/u;

// "Download Link" -> "download-link"; undefined if it can't be a tag name.
export function cleanTagName(text) {
  const name = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return TAG_NAME.test(name) ? name : undefined;
}

// What staff typed, ready to save: Windows new lines made plain, trimmed.
export const cleanTagContent = (text) => String(text ?? "").replace(/\r\n?/g, "\n").trim();

// The server's tags, with anything malformed dropped.
export function tagsOf(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TAGS);
  return Array.isArray(saved)
    ? saved.filter((tag) => tag && typeof tag.name === "string" && typeof tag.content === "string")
    : [];
}

export const sortTags = (tags) => [...tags].sort((a, b) => a.name.localeCompare(b.name));
