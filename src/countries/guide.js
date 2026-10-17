// The country guide's own wording and colour, chosen on the dashboard's Country
// page (Setting.COUNTRY_GUIDE). Every part is optional: a part left empty
// shows the bot's built-in text, translated. The buttons under the guide are
// never configurable, so members' picks always work.

// Discord's embed limits, kept lower where the bot adds its own lines.
export const GUIDE_LIMITS = Object.freeze({
  title: 256,
  intro: 1000,
  stepsTitle: 256,
  steps: 1000,
  notesTitle: 256,
  // The bot adds up to two notes of its own (/country and the channel rule)
  // under these, and a field holds 1024 characters.
  notes: 600,
});
export const GUIDE_TEXT_PARTS = Object.keys(GUIDE_LIMITS);
export const DEFAULT_GUIDE_COLOR = 0x5865f2;

export class InvalidGuide extends Error {
  name = "InvalidGuide";
}

// The saved guide with every part present (null where it isn't set).
export function normalizeGuide(saved) {
  const guide = saved && typeof saved === "object" ? saved : {};
  return {
    ...Object.fromEntries(GUIDE_TEXT_PARTS.map((part) => [part, typeof guide[part] === "string" && guide[part] ? guide[part] : null])),
    color: Number.isInteger(guide.color) ? guide.color : null,
  };
}

// Checks a guide from the dashboard. Returns what to save, or null when
// nothing differs from the built-in guide. Throws InvalidGuide.
export function checkGuide(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidGuide("Send the guide as an object.");
  }
  const unknown = Object.keys(value).find((key) => key !== "color" && !GUIDE_TEXT_PARTS.includes(key));
  if (unknown) {
    throw new InvalidGuide(`The guide has no "${unknown}" part. Its buttons can't be changed.`);
  }
  const guide = {};
  for (const part of GUIDE_TEXT_PARTS) {
    const text = value[part];
    if (text === undefined || text === null) {
      continue;
    }
    if (typeof text !== "string") {
      throw new InvalidGuide("Send the guide's text as text.");
    }
    const cleaned = text.replace(/\r\n?/g, "\n").trim();
    if (cleaned.length > GUIDE_LIMITS[part]) {
      throw new InvalidGuide(`Keep each part of the guide under ${GUIDE_LIMITS[part]} characters.`);
    }
    if (cleaned) {
      guide[part] = cleaned;
    }
  }
  if (value.color !== undefined && value.color !== null) {
    if (!Number.isInteger(value.color) || value.color < 0 || value.color > 0xffffff) {
      throw new InvalidGuide("Pick a colour for the guide.");
    }
    if (value.color !== DEFAULT_GUIDE_COLOR) {
      guide.color = value.color;
    }
  }
  return Object.keys(guide).length > 0 ? guide : null;
}

// For the logs channel: which parts are customised.
export function describeGuide(value) {
  const guide = normalizeGuide(value);
  const custom = GUIDE_TEXT_PARTS.filter((part) => guide[part] !== null);
  const color = guide.color === null ? null : `colour #${guide.color.toString(16).padStart(6, "0")}`;
  const parts = [custom.length > 0 ? `custom ${custom.join(", ")}` : null, color].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "built-in";
}
