// Quote cards: the picture the Make it a quote app and /quote post. The
// member's avatar fills the left side and fades into the card, the quote sits
// centred on the right with "- Name" and @username under it, and a small mark
// in the corner says which quote it is.
//
// The card is SVG turned into a PNG by images/renderer.js with the fonts in
// src/quotes/fonts, so it looks the same on every server. Characters a font
// can't draw (emoji, Chinese, Arabic...) are left out of the picture; the
// quote's full text is always in the message too.

import { readFile } from "node:fs/promises";
import { readFontMetrics } from "../colors/fontMetrics.js";
import { escapeXml, renderPng } from "../images/renderer.js";
import { FONTS, normalizeStyle, THEMES } from "./style.js";

export const CARD = Object.freeze({
  width: 1200,
  height: 630,
  // The avatar is a square as tall as the card; the fade starts part way in.
  fadeFrom: 300,
  textLeft: 650,
  textRight: 1150,
  top: 70,
  bottom: 70,
  sizes: [64, 58, 52, 46, 42, 38, 34, 30, 27, 24],
  lineHeight: 1.3,
  nameSize: 30,
  usernameSize: 22,
  markSize: 18,
});

// Avatars bigger than this aren't drawn (Discord's are far smaller).
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 5000;

const fontFile = (name) => new URL(`./fonts/${name}`, import.meta.url);
const fontCache = new Map();

// One font file and its metrics, read once.
function loadFont(name) {
  if (!fontCache.has(name)) {
    const loading = readFile(fontFile(name)).then((bytes) => ({ bytes, metrics: readFontMetrics(bytes) }));
    loading.catch(() => fontCache.delete(name));
    fontCache.set(name, loading);
  }
  return fontCache.get(name);
}

// The files one card needs: the quote's weight, the regular weight and the
// italic (or regular) for the name.
async function fontsFor(style) {
  const font = FONTS[style.font];
  const quoteFile = style.bold && font.bold ? font.bold : font.regular;
  const [quote, regular, italic] = await Promise.all([loadFont(quoteFile), loadFont(font.regular), loadFont(font.italic ?? font.regular)]);
  return { family: font.family, quote, regular, italic, hasBold: Boolean(font.bold), hasItalic: Boolean(font.italic) };
}

// --- Text ---------------------------------------------------------------------

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// A message's text as it reads in Discord, without its markup: mentions as
// names, custom emoji as :name:, spoilers hidden, formatting marks removed.
// `names` = { user(id), role(id), channel(id) } returning a name or undefined.
export function readableText(content, names = {}) {
  return String(content ?? "")
    .replace(/\|\|[\s\S]*?\|\|/g, "[spoiler]")
    .replace(/<@!?(\d{17,20})>/g, (_, id) => `@${names.user?.(id) ?? "unknown"}`)
    .replace(/<@&(\d{17,20})>/g, (_, id) => `@${names.role?.(id) ?? "role"}`)
    .replace(/<#(\d{17,20})>/g, (_, id) => `#${names.channel?.(id) ?? "channel"}`)
    .replace(/<a?:(\w{2,32}):\d{17,20}>/g, ":$1:")
    .replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_, seconds) => DATE.format(new Date(Number(seconds) * 1000)))
    .replace(/<\/([\w -]{1,100}):\d{17,20}>/g, "/$1")
    .replace(/^(?:#{1,3}|-#|>{1,3})\s+/gm, "")
    .replace(/```\w*\n?/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_\n]*\S|\S)[*_](?=\s|$|[.,!?])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Only the characters the font can draw, with spacing tidied.
export function drawable(text, metrics) {
  return [...text]
    .filter((char) => char === "\n" || metrics.has(char))
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// Splits text into lines no wider than `maxWidth` at `size`. Words too long
// for a line are broken between characters.
export function wrapText(text, metrics, size, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ").filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (metrics.width(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      // A word wider than the line on its own: break it up.
      let piece = "";
      for (const char of word) {
        if (metrics.width(piece + char, size) > maxWidth && piece) {
          lines.push(piece);
          piece = "";
        }
        piece += char;
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}

// The biggest size the quote fits at, its lines, and whether it had to be cut.
export function fitQuote(text, metrics, layout = CARD) {
  const width = layout.textRight - layout.textLeft;
  const room = layout.height - layout.top - layout.bottom - 110;
  for (const size of layout.sizes) {
    const lines = wrapText(text, metrics, size, width);
    if (lines.length * size * layout.lineHeight <= room) {
      return { size, lines, cut: false };
    }
  }
  const size = layout.sizes.at(-1);
  const max = Math.max(1, Math.floor(room / (size * layout.lineHeight)));
  const lines = wrapText(text, metrics, size, width).slice(0, max);
  let last = lines[max - 1] ?? "";
  while (last && metrics.width(`${last}…`, size) > width) {
    last = [...last].slice(0, -1).join("");
  }
  lines[max - 1] = `${last.trimEnd()}…`;
  return { size, lines, cut: true };
}

// One line cut to fit `width`, ending in "…" when cut.
function fitLine(text, metrics, size, width) {
  if (metrics.width(text, size) <= width) {
    return text;
  }
  const chars = [...text];
  while (chars.length > 1 && metrics.width(`${chars.join("")}…`, size) > width) {
    chars.pop();
  }
  return `${chars.join("").trimEnd()}…`;
}

// --- The picture ----------------------------------------------------------------

// The SVG for a card. `quote` = { text, name, username, mark }, already
// readable (see readableText); `avatar` = { type, base64 } or null; `fonts`
// from fontsFor. `cutout` leaves the avatar's square see-through (no avatar,
// only the fade over it), for the GIF (quotes/gif.js) to lay over a moving
// avatar. Exported for tests.
export function buildCardSvg({ quote, avatar, style: rawStyle, fonts, layout = CARD, cutout = false }) {
  const style = normalizeStyle(rawStyle);
  const colors = THEMES[style.theme][style.light ? "light" : "dark"];
  const { width, height } = layout;
  const textWidth = layout.textRight - layout.textLeft;
  const center = Math.round((layout.textLeft + layout.textRight) / 2);
  const text = drawable(quote.text, fonts.quote.metrics) || "…";
  const fit = fitQuote(text, fonts.quote.metrics, layout);
  const lineGap = Math.round(fit.size * layout.lineHeight);
  const name = fitLine(`- ${drawable(quote.name, fonts.italic.metrics) || drawable(quote.username, fonts.italic.metrics) || "?"}`, fonts.italic.metrics, layout.nameSize, textWidth);
  const username = quote.username ? fitLine(`@${drawable(quote.username, fonts.regular.metrics)}`, fonts.regular.metrics, layout.usernameSize, textWidth) : "";
  // The quote and the lines under it, centred as one block.
  const blockHeight = fit.lines.length * lineGap + 24 + layout.nameSize + (username ? 10 + layout.usernameSize : 0);
  let y = Math.round((height - blockHeight) / 2 + fit.size * 0.9);
  const quoteLines = fit.lines.map((line) => {
    const element = `<text x="${center}" y="${y}">${escapeXml(line)}</text>`;
    y += lineGap;
    return element;
  });
  const nameY = y - lineGap + Math.round(fit.size * 0.3) + 24 + layout.nameSize;
  const usernameY = nameY + 10 + layout.usernameSize;
  const avatarSize = height;
  const portrait = avatar
    ? `<image x="0" y="0" width="${avatarSize}" height="${avatarSize}" preserveAspectRatio="xMidYMid slice" ${style.color ? "" : 'filter="url(#grey)" '}xlink:href="data:${avatar.type};base64,${avatar.base64}"/>`
    : `<rect x="0" y="0" width="${avatarSize}" height="${avatarSize}" fill="${colors.muted}" opacity="0.35"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    '<filter id="grey" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter>',
    `<linearGradient id="fade" x1="${layout.fadeFrom}" y1="0" x2="${avatarSize}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${colors.background}" stop-opacity="0"/><stop offset="1" stop-color="${colors.background}" stop-opacity="1"/></linearGradient>`,
    "</defs>",
    cutout ? `<rect x="${avatarSize}" width="${width - avatarSize}" height="${height}" fill="${colors.background}"/>` : `<rect width="${width}" height="${height}" fill="${colors.background}"/>`,
    cutout ? "" : portrait,
    `<rect x="0" y="0" width="${avatarSize}" height="${height}" fill="url(#fade)"/>`,
    `<g font-family="${escapeXml(fonts.family)}" text-anchor="middle">`,
    `<g fill="${colors.text}" font-size="${fit.size}" font-weight="${style.bold && fonts.hasBold ? 700 : 400}">${quoteLines.join("")}</g>`,
    `<text x="${center}" y="${nameY}" fill="${colors.text}" font-size="${layout.nameSize}" font-style="${fonts.hasItalic ? "italic" : "normal"}">${escapeXml(name)}</text>`,
    username ? `<text x="${center}" y="${usernameY}" fill="${colors.muted}" font-size="${layout.usernameSize}">${escapeXml(username)}</text>` : "",
    "</g>",
    quote.mark
      ? `<text x="${width - 24}" y="${height - 22}" text-anchor="end" font-family="${escapeXml(FONTS.sans.family)}" font-size="${layout.markSize}" fill="${colors.muted}" opacity="0.8">${escapeXml(drawable(quote.mark, fonts.regular.metrics))}</text>`
      : "",
    "</svg>",
  ].join("");
}

// Downloads an avatar for the card: { type, base64 }, or null when it can't be
// had (the card then shows a plain panel). Only Discord's CDN is fetched.
export async function fetchAvatar(url, { fetchImpl = fetch, types = ["image/png", "image/jpeg"], maxBytes = MAX_AVATAR_BYTES } = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname)) {
      return null;
    }
    const response = await fetchImpl(parsed, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS), redirect: "error" });
    const type = response.headers.get("content-type")?.split(";")[0].trim();
    if (!response.ok || !types.includes(type)) {
      return null;
    }
    const length = Number(response.headers.get("content-length"));
    if (length > maxBytes) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length <= maxBytes ? { type, bytes, base64: bytes.toString("base64") } : null;
  } catch {
    return null;
  }
}

// The card as a PNG Buffer. `quote` = { text, name, username, mark, avatarUrl }.
// With `cutout`, the avatar's square is left see-through (see buildCardSvg).
export async function renderQuoteCard(quote, rawStyle, { fetchImpl, cutout = false } = {}) {
  const style = normalizeStyle(rawStyle);
  const [fonts, avatar] = await Promise.all([fontsFor(style), quote.avatarUrl && !cutout ? fetchAvatar(quote.avatarUrl, { fetchImpl }) : null]);
  const svg = buildCardSvg({ quote, avatar, style, fonts, cutout });
  const files = [...new Set([fonts.quote, fonts.regular, fonts.italic, await loadFont(FONTS.sans.regular)])].map((font) => font.bytes);
  return renderPng(svg, { fonts: files, defaultFontFamily: fonts.family });
}

// For tests: the fonts a style uses, with their metrics.
export const cardFonts = (style) => fontsFor(normalizeStyle(style));
