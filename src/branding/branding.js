// Per-server branding: how the bot looks in one server.
//
// The bot's nickname, avatar and banner in a server are Discord's own
// per-server profile (PATCH /guilds/:id/members/@me), set from the dashboard's
// Branding page. Discord keeps the images; only the embed colour is saved
// here, under Setting.BRANDING, as { color }.
//
// The embed colour is used by the embeds members see from day to day (role
// panels, the ticket panel and ticket threads, /rank and /leaderboard). Logs,
// cases, the starboard and giveaways keep their own colours, because there the
// colour means something (a ban is red, a giveaway is gold).
//
// The app's own name and icon still show in the slash command list, on the
// APP badge and in DMs: Discord has no per-server version of those.

import { Setting } from "../settings/guildSettings.js";

export const MAX_NICKNAME = 32;
// After the dashboard shrinks it: an avatar is at most 512×512 and a banner
// 960×384, so 2 MB is plenty.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const IMAGE_TYPES = {
  png: (bytes) => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  gif: (bytes) => bytes.length > 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")),
  webp: (bytes) => bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};
const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export class InvalidBranding extends Error {
  name = "InvalidBranding";
}

const isColor = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff;

// The saved branding with anything unusable dropped.
export function normalizeBranding(saved) {
  return { color: isColor(saved?.color) ? saved.color : null };
}

export const brandingOf = (guildSettings, guildId) => normalizeBranding(guildSettings?.get(guildId, Setting.BRANDING));

// The server's embed colour, or `fallback` when it hasn't picked one.
export const accentColor = (guildSettings, guildId, fallback) => brandingOf(guildSettings, guildId).color ?? fallback;

// Checks an image the dashboard sent as a data: URL. Returns it unchanged
// (Discord takes data: URLs as is), or throws InvalidBranding.
export function checkImage(value, label) {
  const match = typeof value === "string" ? DATA_URL.exec(value) : null;
  if (!match) {
    throw new InvalidBranding(`The ${label} must be a PNG, JPEG, GIF or WebP image.`);
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new InvalidBranding(`The ${label} is too big. Use an image under 2 MB.`);
  }
  if (!IMAGE_TYPES[match[1]](bytes)) {
    throw new InvalidBranding(`The ${label} isn't a real ${match[1].toUpperCase()} image.`);
  }
  return value;
}

// Text that's empty after trimming means "back to the default".
function optionalText(value, max, label) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new InvalidBranding(`The ${label} must be text.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new InvalidBranding(`The ${label} can be at most ${max} characters.`);
  }
  return text || null;
}

// Turns a change from the dashboard into Discord's request body (only what
// changed) and the new saved branding. Keys left out stay as they are; null
// puts that part back to the bot's default.
//   change   { nickname, avatar, banner, color }, each optional
//   current  the saved branding (normalizeBranding)
export function planBrandingChange(change, current) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new InvalidBranding("Nothing to change.");
  }
  const profile = {};
  const saved = { ...current };
  if (change.nickname !== undefined) {
    profile.nick = optionalText(change.nickname, MAX_NICKNAME, "nickname");
  }
  for (const part of ["avatar", "banner"]) {
    if (change[part] !== undefined) {
      profile[part] = change[part] === null ? null : checkImage(change[part], part);
    }
  }
  if (change.color !== undefined) {
    if (change.color !== null && !isColor(change.color)) {
      throw new InvalidBranding("The embed colour must be a colour like #7c5cff.");
    }
    saved.color = change.color;
  }
  if (Object.keys(profile).length === 0 && saved.color === current.color) {
    throw new InvalidBranding("Nothing to change.");
  }
  return { profile, saved };
}
