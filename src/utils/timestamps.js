// Turns what someone types ("2h", "in 3 days", "2026-12-24 18:00", "18:30",
// a Unix time) into a moment, for /timestamp. Dates and times without a zone
// are read in `timeZone` (an IANA name like "Europe/Berlin", UTC by default).

import { parseDuration } from "./duration.js";

// Discord's timestamp styles, in the order /timestamp lists them.
export const TIMESTAMP_STYLES = ["t", "T", "d", "D", "f", "F", "R"];
// Discord shows timestamps between these years sensibly.
const MIN_MS = Date.UTC(1970, 0, 1);
const MAX_MS = Date.UTC(9999, 11, 31);

const DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i;
const TIME_ONLY = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i;

// How far `timeZone` is ahead of UTC at `ms`, in ms.
function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The UTC ms of a wall-clock time in `timeZone`, or undefined for an
// impossible date (Feb 30).
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = "UTC") {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  // Twice, so a time near a daylight-saving change lands on the right side.
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone);
  return result;
}

// The wall-clock date in `timeZone` at `ms`: { year, month, day }.
function dateIn(ms, timeZone) {
  const shifted = new Date(ms + zoneOffset(ms, timeZone));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

// The moment `text` means, in ms, or undefined when it can't be read.
export function parseMoment(text, { timeZone = "UTC", now = Date.now() } = {}) {
  let input = String(text ?? "").trim();
  if (!input) {
    return undefined;
  }
  let moment;
  if (/^\d{9,11}$/.test(input)) {
    moment = Number(input) * 1000;
  } else if (/^\d{12,14}$/.test(input)) {
    moment = Number(input);
  } else if (DATE_TIME.test(input)) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = DATE_TIME.exec(input);
    moment = zonedToUtc({ year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second) }, timeZone);
  } else if (TIME_ONLY.test(input)) {
    const [, rawHour, minute, meridiem] = TIME_ONLY.exec(input);
    let hour = Number(rawHour);
    if (meridiem) {
      if (hour < 1 || hour > 12) {
        return undefined;
      }
      hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
    }
    moment = zonedToUtc({ ...dateIn(now, timeZone), hour, minute: Number(minute) }, timeZone);
  } else {
    input = input.toLowerCase();
    const ago = /\bago$/.test(input);
    const words = input.replace(/^in\s+/, "").replace(/\s*ago$/, "")
      .replace(/\b(\d+)\s*(seconds?|secs?)\b/g, "$1s")
      .replace(/\b(\d+)\s*(minutes?|mins?)\b/g, "$1m")
      .replace(/\b(\d+)\s*(hours?|hrs?)\b/g, "$1h")
      .replace(/\b(\d+)\s*(days?)\b/g, "$1d")
      .replace(/\b(\d+)\s*(weeks?)\b/g, "$1w")
      .replace(/\b(and|,)\b|,/g, " ");
    const delay = /^\d+$/.test(words.trim()) ? undefined : parseDuration(words);
    moment = delay === undefined ? undefined : now + (ago ? -delay : delay);
  }
  return moment !== undefined && Number.isFinite(moment) && moment >= MIN_MS && moment <= MAX_MS ? moment : undefined;
}

export const discordTimestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
