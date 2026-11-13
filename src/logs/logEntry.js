// Builds one server-log embed the same way for every kind of event, following
// the server's log options (logEvents.js): compact entries drop the author
// line, the avatar and the detail lines; IDs in the footer can be hidden.

import { EmbedBuilder } from "discord.js";
import { authorOf } from "./actionLog.js";
import { DEFAULT_LOG_OPTIONS } from "./logEvents.js";

export const LogColor = Object.freeze({
  deleted: 0xed4245,
  edited: 0x3498db,
  joined: 0x57f287,
  left: 0xe67e22,
  changed: 0x9b59b6,
  created: 0x2ecc71,
  voice: 0x1abc9c,
  boost: 0xf47fff,
  pinned: 0xf1c40f,
});

// Description limit, minus room so a cut never lands mid-way through "…".
const MAX_DESCRIPTION = 4096;

// Entry:
//   color
//   title       the first line, like "**Message deleted** in #general"
//   lines       always shown
//   details     left out of compact entries
//   user        the member or user it's about (author line), if any
//   thumbnail   an image URL shown at the side, if any
//   ids         footer parts like "User ID 123", shown when IDs are on
export function buildLogEntry({ color, title, lines = [], details = [], user, thumbnail, ids = [] }, options = DEFAULT_LOG_OPTIONS) {
  const compact = Boolean(options.compact);
  const all = [title, ...lines, ...(compact ? [] : details)].filter((line) => line !== undefined && line !== null && line !== "");
  let description = all.join("\n");
  if (description.length > MAX_DESCRIPTION) {
    description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  }
  const embed = new EmbedBuilder().setColor(color).setDescription(description).setTimestamp();
  if (!compact && user) {
    embed.setAuthor(authorOf(user));
  }
  if (!compact && thumbnail) {
    embed.setThumbnail(thumbnail);
  }
  const footer = options.showIds === false ? [] : ids.filter(Boolean);
  if (footer.length > 0) {
    embed.setFooter({ text: footer.join(" · ").slice(0, 2048) });
  }
  return embed;
}

// "By @someone" (and the reason they gave), from an audit log entry.
export function byLine(entry) {
  if (!entry?.executorId) {
    return undefined;
  }
  const reason = entry.reason ? ` · Reason: ${String(entry.reason).replace(/\s+/g, " ").slice(0, 300)}` : "";
  return `**By:** <@${entry.executorId}>${reason}`;
}

// "3 hours" style length of time, for "spent 2 hours in voice" and "member
// for 3 days". Two largest units at most.
export function formatDuration(ms) {
  const units = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
    ["second", 1000],
  ];
  let left = Math.max(0, Math.floor(ms));
  const parts = [];
  let first = -1;
  for (const [index, [name, size]] of units.entries()) {
    const count = Math.floor(left / size);
    left -= count * size;
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      first = first < 0 ? index : first;
    }
    // The biggest unit and the one right after it, like "2 days 3 hours".
    if (first >= 0 && index > first) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}
