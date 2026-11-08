// How the ticket panel looks and what new tickets start with, set on the
// dashboard's Tickets page and saved as Setting.TICKET_PANEL:
//
//   the panel's embed    title, description, colour, author, image, thumbnail, footer
//   how members pick     "buttons" (one per category) or "menu" (a dropdown)
//   the single button    its label, emoji and style, when there are no categories
//   every new ticket     the intro message, the thread name and whether staff are pinged
//
// Categories (tickets/categories.js) can override the intro, the thread name
// and the ping. Everything left empty uses the built-in text.

import { BUTTON_STYLES, isButtonEmoji } from "./categories.js";

export { BUTTON_STYLES };
export const LAYOUTS = ["buttons", "menu"];

// Discord's embed limits, and ours for the intro and the thread name.
export const PANEL_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  authorName: 256,
  footer: 2048,
  url: 2000,
  // All of the embed's text together.
  total: 6000,
  menuPlaceholder: 150,
  buttonLabel: 80,
  intro: 1500,
  nameFormat: 90,
});

// What a template can say: the opener, the ticket number, the staff role, the
// category and the server.
export const TICKET_PLACEHOLDERS = ["{user}", "{username}", "{number}", "{staff}", "{category}", "{server}"];
export const DEFAULT_NAME_FORMAT = "🎫 {number} · {user}";

const DEFAULT_LOOK = Object.freeze({
  title: null,
  description: null,
  color: null,
  authorName: null,
  authorIconUrl: null,
  imageUrl: null,
  thumbnailUrl: null,
  footer: null,
  layout: "buttons",
  menuPlaceholder: null,
  buttonLabel: null,
  buttonEmoji: null,
  buttonStyle: "primary",
  intro: null,
  nameFormat: null,
  pingStaff: true,
});

export class InvalidPanel extends Error {
  name = "InvalidPanel";
}

const text = (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "");
const oneLine = (value) => text(value).replace(/\s+/g, " ");
const isColor = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff;

// A web link Discord can show an image from, or "" when it isn't one.
export function imageUrl(value) {
  const trimmed = text(value);
  if (!trimmed || trimmed.length > PANEL_LIMITS.url) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : "";
  } catch {
    return "";
  }
}

// Reads a look, calling `problem(message)` for each part that's wrong and
// using the default for it. Shared by normalizeLook (which ignores problems)
// and checkLook (which throws on the first one).
function readLook(value, problem) {
  const look = { ...DEFAULT_LOOK };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      problem("Send the ticket panel as an object.");
    }
    return look;
  }
  const limited = (key, max, what, clean = text) => {
    const cleaned = clean(value[key]);
    if (cleaned.length > max) {
      problem(`The ${what} is at most ${max} characters.`);
    } else if (cleaned) {
      look[key] = cleaned;
    }
  };
  const link = (key, what) => {
    if (!text(value[key])) {
      return;
    }
    const url = imageUrl(value[key]);
    if (url) {
      look[key] = url;
    } else {
      problem(`The ${what} must be a full link starting with https://.`);
    }
  };
  const choice = (key, choices, what) => {
    if (value[key] === undefined || value[key] === null) {
      return;
    }
    if (choices.includes(value[key])) {
      look[key] = value[key];
    } else {
      problem(`Unknown ${what}.`);
    }
  };

  limited("title", PANEL_LIMITS.title, "panel title", oneLine);
  limited("description", PANEL_LIMITS.description, "panel text");
  limited("authorName", PANEL_LIMITS.authorName, "author name", oneLine);
  limited("footer", PANEL_LIMITS.footer, "footer", oneLine);
  link("authorIconUrl", "author icon");
  link("imageUrl", "image");
  link("thumbnailUrl", "thumbnail");
  if (value.color !== undefined && value.color !== null) {
    if (isColor(value.color)) {
      look.color = value.color;
    } else {
      problem("Pick a colour.");
    }
  }
  choice("layout", LAYOUTS, "layout");
  limited("menuPlaceholder", PANEL_LIMITS.menuPlaceholder, "dropdown text", oneLine);
  limited("buttonLabel", PANEL_LIMITS.buttonLabel, "button label", oneLine);
  if (value.buttonEmoji !== undefined && value.buttonEmoji !== null && value.buttonEmoji !== "") {
    if (isButtonEmoji(value.buttonEmoji)) {
      look.buttonEmoji = value.buttonEmoji;
    } else {
      problem("The button's emoji must be one emoji, like 🎫, or a server emoji like <:name:123…>.");
    }
  }
  choice("buttonStyle", BUTTON_STYLES, "button style");
  limited("intro", PANEL_LIMITS.intro, "intro message");
  limited("nameFormat", PANEL_LIMITS.nameFormat, "thread name", oneLine);
  if (value.pingStaff !== undefined && value.pingStaff !== null) {
    if (typeof value.pingStaff === "boolean") {
      look.pingStaff = value.pingStaff;
    } else {
      problem("Ping staff must be on or off.");
    }
  }
  const total = [look.title, look.description, look.authorName, look.footer].join("").length;
  if (total > PANEL_LIMITS.total) {
    problem(`The panel's text is ${total} characters; Discord allows ${PANEL_LIMITS.total} in one embed.`);
  }
  return look;
}

// The saved look with every part filled in (broken parts use the default). Never throws.
export const normalizeLook = (saved) => readLook(saved, () => {});

export const isDefaultLook = (look) => Object.entries(DEFAULT_LOOK).every(([key, value]) => look[key] === value);

// Checks dashboard input. Returns what to save: null when it's all defaults.
export function checkLook(value) {
  const look = readLook(value, (message) => {
    throw new InvalidPanel(message);
  });
  return isDefaultLook(look) ? null : look;
}

// "title "Support" · menu · intro set", for log entries.
export function describeLook(saved) {
  const look = normalizeLook(saved);
  return (
    [
      look.title ? `title "${look.title.length > 40 ? `${look.title.slice(0, 40)}…` : look.title}"` : "default title",
      look.layout === "menu" ? "dropdown" : "buttons",
      look.imageUrl || look.thumbnailUrl ? "images" : null,
      look.intro ? "own intro" : null,
      look.nameFormat ? `threads "${look.nameFormat}"` : null,
      look.pingStaff ? null : "no staff ping",
    ]
      .filter(Boolean)
      .join(" · ")
  );
}

// Fills {user}, {number}… in a template. Unknown placeholders stay as they are.
export function fillTemplate(template, values) {
  return template.replace(/\{(user|username|number|staff|category|server)\}/g, (match, key) => values[key] ?? match);
}

// A thread's name from a format, within Discord's 100 characters. Falls back
// to the default when the format comes out empty.
export function formatThreadName(format, values) {
  const name = fillTemplate(format || DEFAULT_NAME_FORMAT, values).replace(/\s+/g, " ").trim().slice(0, 100);
  return name || fillTemplate(DEFAULT_NAME_FORMAT, values).slice(0, 100);
}
