// Reads and writes short durations like "10m", "2h", "1d12h" or "1w".

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const PART = /(\d+)\s*([smhdw])/gy;

// Milliseconds, or undefined if `text` isn't a duration. Units can be combined
// ("1h30m"); a bare number means minutes.
export function parseDuration(text) {
  const input = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!input) {
    return undefined;
  }
  if (/^\d+$/.test(input)) {
    const minutes = Number(input);
    return minutes > 0 ? minutes * UNIT_MS.m : undefined;
  }

  let total = 0;
  let consumed = 0;
  for (const match of input.matchAll(PART)) {
    total += Number(match[1]) * UNIT_MS[match[2]];
    consumed += match[0].length;
  }
  if (consumed !== input.length || total <= 0 || !Number.isSafeInteger(total)) {
    return undefined;
  }
  return total;
}

// "1d 2h 5m": the two largest non-zero units, which is precise enough for people.
export function formatDuration(ms) {
  const parts = [];
  let left = Math.max(0, Math.round(ms / 1000)) * 1000;
  for (const unit of ["w", "d", "h", "m", "s"]) {
    const amount = Math.floor(left / UNIT_MS[unit]);
    if (amount > 0) {
      parts.push(`${amount}${unit}`);
      left -= amount * UNIT_MS[unit];
    }
  }
  return parts.slice(0, 2).join(" ") || "0s";
}

export const DAY_MS = UNIT_MS.d;
