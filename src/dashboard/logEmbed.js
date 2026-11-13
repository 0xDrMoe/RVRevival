// How a dashboard change looks in the server's logs channel:
//
//   [avatar] Moe · on the dashboard
//   Settings changed                       (links to the Activity page)
//   ┌ Log channels per log type ┐  ┌ Automod ┐
//   │ Bans: none → #bans        │  │ Spam › Action: delete → timeout │
//   Changed on the dashboard · User ID 123 · today at 21:43
//
// Only what changed is shown, a few lines per setting (settingsRules.js
// describeChange), so even a big change stays short.

import { splitSummary } from "../logs/logEntry.js";

// Discord's limits for one embed.
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const MAX_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_TOTAL = 6000;
// Settings shown as fields; any more are counted on the last one.
const MAX_SECTIONS = 12;

export const DASHBOARD_LOG_COLOR = 0x7c5cff;

function avatarUrl(session) {
  if (session.avatar) {
    return `https://cdn.discordapp.com/avatars/${session.userId}/${session.avatar}.png?size=64`;
  }
  try {
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(session.userId) >> 22n) % 6n)}.png`;
  } catch {
    return undefined;
  }
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// Options:
//   session       who did it ({ userId, username, avatar })
//   summary       "**What happened** and where"
//   lines         detail lines (the description, when there are no sections)
//   sections      [{ label, lines }], one field per setting
//   notes         lines shown above the fields
//   activityUrl   the server's Activity page, linked from the title
export function buildDashboardLogEmbed({ session, summary, lines = [], sections, notes = [], activityUrl, now = new Date() }) {
  const { title, rest } = splitSummary(summary);
  const description = [rest, ...(sections ? notes : lines)].filter(Boolean).join("\n");
  const embed = {
    color: DASHBOARD_LOG_COLOR,
    author: { name: clip(`${session.username} · on the dashboard`, MAX_FIELD_NAME), ...(avatarUrl(session) ? { icon_url: avatarUrl(session) } : {}) },
    title: clip(title, MAX_TITLE),
    footer: { text: `User ID ${session.userId}` },
    timestamp: now.toISOString(),
  };
  if (activityUrl && /^https?:\/\//.test(activityUrl)) {
    embed.url = activityUrl;
  }
  if (description) {
    embed.description = clip(description, MAX_DESCRIPTION);
  }
  if (sections?.length > 0) {
    const shown = sections.slice(0, Math.min(MAX_SECTIONS, MAX_FIELDS));
    const hidden = sections.length - shown.length;
    embed.fields = shown.map((section) => ({
      name: clip(section.label, MAX_FIELD_NAME),
      value: clip(section.lines.join("\n") || "updated", MAX_FIELD_VALUE),
    }));
    if (hidden > 0) {
      embed.fields.push({ name: "More", value: `${hidden} more setting${hidden === 1 ? "" : "s"} changed. See the Activity page.` });
    }
    // Keeps the whole embed within Discord's total, dropping fields from the end.
    const size = () => [embed.author.name, embed.title, embed.description ?? "", embed.footer.text, ...embed.fields.flatMap((field) => [field.name, field.value])].join("").length;
    while (embed.fields.length > 1 && size() > MAX_TOTAL) {
      embed.fields.pop();
    }
  }
  return embed;
}
