// What Discord, Slack, X and other apps show when someone posts a transcript
// link. Their link readers never log in, so without this they followed the
// login redirect to Discord's sign-in page and showed Discord's own preview.
//
// A link reader gets a small page with only head tags. How much it says
// depends on the link:
//   - Links the bot and the dashboard hand out carry a key (?k=…), a signature
//     of the server and ticket number made with DASHBOARD_SESSION_SECRET.
//     With a valid key the preview gives a short rundown of the ticket: who
//     opened and closed it, its category and subject, the close reason, how
//     many messages and when. Never any message text.
//   - Without a key (an old link, or someone guessing numbers) it only says
//     that this is a ticket transcript behind the login.
// Anyone can send a link reader's user agent, so the keyed rundown is what a
// person holding the link sees in any chat app, and nothing more.

import { createHmac, timingSafeEqual } from "node:crypto";
import { formatDay } from "./render.js";

export const PREVIEW_KEY_PARAM = "k";
// 16 bytes of HMAC-SHA256, base64url.
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const KEY_LABEL = "rabble transcript link preview v1";

// Apps that read a link to show its preview. Search engines are not here:
// they get the login redirect, and the page is noindex anyway.
// A person whose in-app browser is mistaken for one still gets in: the
// preview page links to the login, and a logged-in visit gets the transcript.
const PREVIEW_AGENTS =
  /Discordbot|Twitterbot|Slackbot|Slack-ImgProxy|facebookexternalhit|Facebot|TelegramBot|WhatsApp\/|LinkedInBot|SkypeUriPreview|MicrosoftPreview|redditbot|Embedly|Iframely|Mastodon\/|Bluesky|Cardyb|Pleroma|Misskey|vkShare|Google-PageRenderer/i;

export const isLinkPreviewAgent = (userAgent) => typeof userAgent === "string" && PREVIEW_AGENTS.test(userAgent);

export const isKeyShaped = (key) => typeof key === "string" && KEY_PATTERN.test(key);

// The key for one ticket's transcript link, or null without a secret.
export function transcriptKey(secret, guildId, number) {
  if (!secret) {
    return null;
  }
  // A key of its own, so these signatures can never stand in for a session or a backup signature.
  const signingKey = createHmac("sha256", secret).update(KEY_LABEL).digest();
  return createHmac("sha256", signingKey).update(`${guildId}/${number}`).digest().subarray(0, 16).toString("base64url");
}

export function checkTranscriptKey(secret, guildId, number, key) {
  if (!secret || !isKeyShaped(key)) {
    return false;
  }
  const expected = Buffer.from(transcriptKey(secret, guildId, number));
  const given = Buffer.from(key);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// "/transcripts/<guild>/<number>", with its key when there is a secret.
export function transcriptPath(guildId, number, secret = null) {
  const key = transcriptKey(secret, guildId, number);
  return `/transcripts/${guildId}/${number}${key ? `?${PREVIEW_KEY_PARAM}=${key}` : ""}`;
}

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// One line of text, at most `max` characters, cut at a word.
function clip(text, max) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Discord's preview shows about 350 characters of the description.
const MAX_DESCRIPTION = 340;
const MAX_TITLE = 100;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The preview's title and lines. `ticket` and `names` only for a keyed link.
export function transcriptPreview({ number, guildName = null, ticket = null, names = {} }) {
  const where = guildName ? clip(guildName, 60) : null;
  if (!ticket) {
    return {
      title: `Ticket #${number} transcript${where ? ` · ${where}` : ""}`,
      description: "A saved support ticket conversation. Only the server's staff can read it: log in with Discord to open it on the Rabble dashboard.",
    };
  }
  const name = (id, fallback) => (id && names[id] ? clip(names[id], 40) : fallback);
  const lines = [];
  if (ticket.subject) {
    lines.push(`📝 ${clip(ticket.subject, 120)}`);
  }
  lines.push(
    [`Opened by ${name(ticket.userId, "a member")}`, ticket.createdAt ? formatDay(ticket.createdAt) : null, ticket.categoryLabel ? clip(ticket.categoryLabel, 40) : null]
      .filter(Boolean)
      .join(" · "),
  );
  if (ticket.closedAt) {
    const closer = ticket.closedBy ? name(ticket.closedBy, "staff") : "automatically";
    lines.push([`Closed ${ticket.closedBy ? "by " : ""}${closer}`, formatDay(ticket.closedAt), ticket.closeReason ? `Reason: ${clip(ticket.closeReason, 100)}` : null].filter(Boolean).join(" · "));
  } else {
    lines.push("Still open");
  }
  const extras = [
    Number.isInteger(ticket.messageCount) ? plural(ticket.messageCount, "message") : null,
    ticket.claimedBy ? `Claimed by ${name(ticket.claimedBy, "staff")}` : null,
    ticket.rating ? `Rated ${ticket.rating}/5` : null,
  ].filter(Boolean);
  if (extras.length > 0) {
    lines.push(extras.join(" · "));
  }
  // Drop whole lines from the end rather than cutting one off, then clip if one line alone is too long.
  while (lines.length > 1 && lines.join("\n").length > MAX_DESCRIPTION) {
    lines.pop();
  }
  const text = lines.join("\n");
  return {
    title: clip(`Ticket #${number} transcript${where ? ` · ${where}` : ""}`, MAX_TITLE),
    // One line per part (Discord keeps the line breaks).
    description: text.length <= MAX_DESCRIPTION ? text : clip(text, MAX_DESCRIPTION),
  };
}

// The page a link reader gets: head tags and a line for anyone who opens it
// with a link reader's user agent.
// `path` is the transcript's address, `loginPath` where its link goes.
export function transcriptPreviewPage({ baseUrl, path, loginPath, preview, imageUrl = null, color = "#7c5cff" }) {
  const { description } = preview;
  const image = imageUrl ?? `${baseUrl}/og-image.jpg`;
  const named = (name, content) => `<meta name="${name}" content="${escapeHtml(content)}" />`;
  const property = (name, content) => `<meta property="${name}" content="${escapeHtml(content)}" />`;
  const url = `${baseUrl}${path}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(preview.title)}</title>
    ${[
      named("description", description),
      named("robots", "noindex, nofollow"),
      named("theme-color", color),
      property("og:type", "website"),
      property("og:site_name", "Rabble"),
      property("og:title", preview.title),
      property("og:description", description),
      property("og:url", url),
      property("og:image", image),
      named("twitter:card", "summary"),
      named("twitter:title", preview.title),
      named("twitter:description", description),
      named("twitter:image", image),
    ].join("\n    ")}
  </head>
  <body>
    <p>${escapeHtml(preview.title)}. <a href="${escapeHtml(loginPath)}">Log in with Discord to read it.</a></p>
  </body>
</html>
`;
}
