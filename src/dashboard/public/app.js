// The dashboard page. Plain JavaScript, no build step. Pages are picked by the
// part of the address after "#":
//
//   #/                     your servers
//   #/g/<id>/overview      a server's numbers at a glance, and which features are on
//   #/g/<id>/activity      every change made on the dashboard (?before=)
//   #/g/<id>/cases         moderation cases (?q=&action=&user=&moderator=&from=&to=)
//   #/g/<id>/members       find a member (?q=), or one member's history (?user=)
//   #/g/<id>/tickets       support tickets (?status=&user=), or one ticket's transcript (?ticket=)
//   #/g/<id>/automod       automod rules, punishments and exemptions
//   #/g/<id>/antinuke      anti-nuke limits, punishment and trusted people (owner only)
//   #/g/<id>/raid          the new-account gate, join alerts and a running lockdown
//   #/g/<id>/welcome       welcome and leave messages
//   #/g/<id>/roles         autoroles and role panels
//   #/g/<id>/starboard     the starboard
//   #/g/<id>/birthdays     birthday greetings and role
//   #/g/<id>/levels        leveling: XP, level-up messages, reward roles, the leaderboard (?page=)
//   #/g/<id>/country       the /country channel
//   #/g/<id>/tags          custom commands (saved answers for /tag)
//   #/g/<id>/responders    auto-responders
//   #/g/<id>/scheduled     scheduled messages
//   #/g/<id>/moderation    staff and mod roles, the mod log
//   #/g/<id>/logging       log channels, events and ignored channels
//   #/g/<id>/access        roles: who can open the dashboard, and every role
//
// Everything shown comes from the JSON API in ../app.js. Text from Discord
// (names, reasons) is always set as text, never as HTML.

const LANGUAGES = { en: "English", es: "Español", de: "Deutsch", fr: "Français", pt: "Português", it: "Italiano", ar: "العربية" };
const LOG_EVENTS = ["messageEdit", "messageDelete", "bulkDelete", "memberJoin", "memberLeave", "memberUpdate"];
const CASE_ACTIONS = ["ban", "softban", "unban", "kick", "timeout", "untimeout", "warn", "note"];
const AUTOMOD_RULES = ["bannedWords", "invites", "links", "mentions", "spam", "duplicates", "caps"];
const AUTOMOD_ACTIONS = ["delete", "warn", "timeout"];
const ESCALATION_ACTIONS = ["timeout", "kick", "ban"];
// The numbers each rule uses: where they live in the automod settings, and their range.
const AUTOMOD_NUMBERS = {
  mentions: [{ path: "rules.mentions.limit", key: "amMentionsLimit", min: 2, max: 50 }],
  spam: [
    { path: "rules.spam.messages", key: "amSpamMessages", min: 3, max: 20 },
    { path: "rules.spam.seconds", key: "amSpamSeconds", min: 2, max: 60 },
  ],
  duplicates: [{ path: "rules.duplicates.count", key: "amDuplicatesCount", min: 2, max: 10 }],
  caps: [
    { path: "rules.caps.percent", key: "amCapsPercent", min: 50, max: 100 },
    { path: "rules.caps.minLength", key: "amCapsMinLength", min: 5, max: 200 },
  ],
};
const MAX_MESSAGE_LENGTH = 1000;
// Leveling limits, the same as src/leveling/config.js.
const MAX_LEVEL = 500;
const MAX_LEVEL_REWARDS = 25;
const MAX_LEVEL_MESSAGE_LENGTH = 500;
const LEVEL_ANNOUNCE = ["here", "channel", "dm", "off"];
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 2000;
const MAX_AUTOROLES = 10;
// Auto-responders (community/autoResponders.js).
const MAX_RESPONDERS = 25;
const MAX_TRIGGER_LENGTH = 60;
const RESPONDER_MATCHES = ["contains", "word", "exact", "starts"];
// Scheduled messages (scheduled/scheduler.js). The repeat choices on the page.
const MAX_SCHEDULED_LENGTH = 2000;
const HOUR_MS = 60 * 60 * 1000;
const REPEATS = [
  { key: "scheduledRepeat_none", ms: null },
  { key: "scheduledRepeat_hour", ms: HOUR_MS },
  { key: "scheduledRepeat_6h", ms: 6 * HOUR_MS },
  { key: "scheduledRepeat_day", ms: 24 * HOUR_MS },
  { key: "scheduledRepeat_week", ms: 7 * 24 * HOUR_MS },
  { key: "scheduledRepeat_2weeks", ms: 14 * 24 * HOUR_MS },
  { key: "scheduledRepeat_30days", ms: 30 * 24 * HOUR_MS },
];
// The starboard's limits and defaults (community/starboard.js).
const STARBOARD_DEFAULTS = { threshold: 3, emoji: "⭐" };
const MAX_STARBOARD_THRESHOLD = 50;
// Administrator and Manage Server: roles the bot won't give new members.
const AUTOROLE_FORBIDDEN = (1n << 3n) | (1n << 5n);
// Moderator permissions: roles with any of them can't be the birthday role.
const BIRTHDAY_ROLE_FORBIDDEN = [3n, 5n, 28n, 4n, 13n, 29n, 27n, 30n, 33n, 34n, 2n, 1n, 40n, 17n, 7n].reduce((bits, bit) => bits | (1n << bit), 0n);
const MAX_BIRTHDAY_MESSAGE_LENGTH = 1000;
// Leveling XP boosts (leveling/config.js).
const MAX_MULTIPLIER = 5;
const MAX_ROLE_MULTIPLIERS = 10;
const CHANNEL = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, FORUM: 15 };
const DAY_MS = 24 * 60 * 60 * 1000;

// Look and feel, remembered per browser.
const THEMES = ["auto", "light", "dark"];
const ACCENTS = ["blurple", "violet", "pink", "orange", "gold", "green", "cyan", "red"];
const DENSITIES = ["comfortable", "compact"];
const DEFAULT_APPEARANCE = { theme: "auto", accent: "blurple", density: "comfortable" };

// The pages of one server, in sidebar groups. `manage` pages need Manage
// Server; the others are also open to dashboard roles. `on` says whether the
// feature is switched on, for the dot in the sidebar and the overview.
const NAV = [
  {
    group: "general",
    pages: [
      { id: "overview", icon: "home", tone: "blue" },
      { id: "activity", icon: "activity", tone: "purple", manage: true },
    ],
  },
  {
    group: "moderation",
    pages: [
      { id: "cases", icon: "folder", tone: "pink" },
      { id: "members", icon: "users", tone: "purple" },
      { id: "tickets", icon: "ticket", tone: "cyan" },
    ],
  },
  {
    group: "protection",
    pages: [
      { id: "automod", icon: "bot", tone: "blue", manage: true, on: (s) => Boolean(s.automod?.enabled) },
      { id: "antinuke", icon: "shieldCheck", tone: "purple", manage: true, on: (s) => Boolean(s.antiNuke?.enabled) },
      { id: "raid", icon: "shield", tone: "red", manage: true, on: (s) => Boolean(s.joinGate?.minAgeDays || s.joinGate?.alertJoins) },
    ],
  },
  {
    group: "community",
    pages: [
      { id: "welcome", icon: "userPlus", tone: "pink", manage: true, on: (s) => Boolean(s.welcomeChannelId || s.welcomeDm || s.leaveChannelId) },
      { id: "roles", icon: "layers", tone: "green", manage: true, on: (s) => Boolean(s.rolePersist?.enabled) || (s.autoroleIds ?? []).length > 0 || (s.rolePanels ?? []).length > 0 },
      { id: "starboard", icon: "star", tone: "amber", manage: true, on: (s) => Boolean(s.starboard?.channelId) },
      { id: "birthdays", icon: "cake", tone: "pink", manage: true, on: (s) => Boolean(s.birthdays) },
      { id: "levels", icon: "trophy", tone: "green", manage: true, on: (s) => Boolean(s.leveling?.enabled) },
      { id: "country", icon: "globe", tone: "cyan", manage: true, on: (s) => Boolean(s.countryChannelId) },
    ],
  },
  {
    group: "messages",
    pages: [
      { id: "tags", icon: "tag", tone: "amber", manage: true, on: (s) => (s.tags ?? []).length > 0 },
      { id: "responders", icon: "repeat", tone: "cyan", manage: true, on: (s) => (s.autoResponders ?? []).length > 0 },
      { id: "scheduled", icon: "calendar", tone: "blue", manage: true },
    ],
  },
  {
    group: "settings",
    pages: [
      { id: "moderation", icon: "sliders", tone: "red", manage: true },
      { id: "logging", icon: "list", tone: "amber", manage: true, on: (s) => Boolean(s.logsChannelId || s.serverLogChannelId) },
      { id: "access", icon: "key", tone: "purple", manage: true },
    ],
  },
];
const PAGES = NAV.flatMap((section) => section.pages.map((page) => ({ ...page, group: section.group })));
// Addresses from older versions of the dashboard.
const PAGE_ALIASES = { settings: "moderation", community: "welcome" };

// Icons: the inside of a 24×24 stroked SVG. Fixed markup, never built from data.
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 3.5a4 4 0 0 1 0 9"/><path d="M22 21a7 7 0 0 0-5-6.7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
  ticket: '<path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6z"/><path d="M14 6v2M14 11v2M14 16v2"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3" r="1"/><path d="M9 13v1M15 13v1M2 13v3M22 13v3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  shieldCheck: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  cake: '<path d="M4 21h16"/><path d="M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/><path d="M5 16c2 1.5 3.5 1.5 5 0s3.5-1.5 5 0 3.5 1.5 4 0"/><path d="M12 12V8"/>',
  trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  palette: '<path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3-3.5 3H15a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 21z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15.5" cy="8" r="1"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  eyeOff: '<path d="m3 3 18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  gavel: '<path d="m14 13-8.5 8.5a2.1 2.1 0 0 1-3-3L11 10"/><path d="m16 16 6-6M8 8l6-6M9 7l8 8M21 11l-8-8"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v9h14v-9"/><path d="M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5M12 8s1.5-5 4-5a2.5 2.5 0 0 1 0 5"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/>',
  barChart: '<path d="M12 20V10M18 20V4M6 20v-4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  userX: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="m17 8 5 5M22 8l-5 5"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
};

// Permission bits shown as badges on the roles page. Administrator includes
// all the others, so it's shown alone.
const ADMINISTRATOR = 3n;
const PERMISSIONS = [
  { key: "permManageServer", bit: 5n },
  { key: "permManageRoles", bit: 28n },
  { key: "permManageChannels", bit: 4n },
  { key: "permBan", bit: 2n },
  { key: "permKick", bit: 1n },
  { key: "permTimeout", bit: 40n },
  { key: "permManageMessages", bit: 13n },
];

const state = {
  language: "en",
  strings: {},
  english: {},
  me: null,
  guild: null,
  appearance: { ...DEFAULT_APPEARANCE },
  // Set while a settings page has unsaved changes.
  unsaved: false,
  // The address of the page shown, to go back to if leaving is cancelled.
  lastHash: location.hash,
  // The last server loaded, reused for a few seconds so moving between pages is instant.
  cache: null,
  // The sidebar and content area of the server shown, kept between its pages.
  shell: null,
};
// How long a loaded server is reused before asking again.
const GUILD_CACHE_MS = 15_000;
const main = document.getElementById("main");

// --- Storage -------------------------------------------------------------------

// Private windows may refuse storage; choices then just aren't remembered.
function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered.
  }
}

function recall(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

// --- Text --------------------------------------------------------------------

function t(key, values = {}) {
  const text = state.strings[key] ?? state.english[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

async function loadLanguage(language) {
  const load = async (code) => (await fetch(`locales/${code}.json`)).json();
  state.english = Object.keys(state.english).length > 0 ? state.english : await load("en");
  state.strings = language === "en" ? state.english : await load(language);
  state.language = language;
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  remember("language", language);
}

function preferredLanguage() {
  const saved = recall("language");
  const browser = (navigator.language ?? "en").slice(0, 2).toLowerCase();
  return [saved, browser].find((code) => code && code in LANGUAGES) ?? "en";
}

const formatNumber = (value) => new Intl.NumberFormat(state.language).format(value);
const formatDate = (ms) =>
  new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
const formatDay = (ms) => new Intl.DateTimeFormat(state.language, { month: "short", day: "numeric" }).format(new Date(ms));

// "2 hr", "3 days" for case durations.
function formatDuration(ms) {
  const units = [
    ["day", DAY_MS],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const [unit, size] = units.find(([, length]) => ms >= length) ?? units.at(-1);
  return new Intl.NumberFormat(state.language, { style: "unit", unit, unitDisplay: "short" }).format(Math.round(ms / size));
}

// --- Building the page ---------------------------------------------------------

// h("button", { class: "primary", onclick }, "Save") → <button class="primary">Save</button>
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (name.startsWith("on")) {
      element.addEventListener(name.slice(2), value);
    } else if (name in element && name !== "list") {
      element[name] = value;
    } else {
      element.setAttribute(name, value === true ? "" : value);
    }
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// The same for SVG elements (the activity chart).
function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children.flat().filter(Boolean));
  return element;
}

function show(...children) {
  if (!(children.length === 1 && children[0] === state.shell?.element)) {
    document.body.classList.remove("in-guild");
  }
  if (children.length === 1 && main.firstChild === children[0] && main.childElementCount === 1) {
    return;
  }
  main.replaceChildren(...children);
}

let toastTimer;
function toast(message, kind = "ok") {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 4000);
}

const avatarUrl = (user) =>
  user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
const iconUrl = (guild) => (guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null);
const initials = (name) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 3);

function guildIcon(guild, size = "md") {
  const url = iconUrl(guild);
  return url
    ? h("img", { class: `guild-icon ${size}`, src: url, alt: "" })
    : h("span", { class: `guild-icon ${size} placeholder`, "aria-hidden": "true" }, initials(guild.name));
}

// One of eight colorful gradients, always the same for a server.
const bannerFor = (id) => `banner-${Number(BigInt(id) % 8n)}`;

// A small dot in the role's color (gray for roles without one).
function roleDot(role) {
  const dot = h("span", { class: "role-dot", "aria-hidden": "true" });
  if (role.color) {
    dot.style.setProperty("--role-color", `#${role.color.toString(16).padStart(6, "0")}`);
  }
  return dot;
}

// A meter or progress bar filled to `fraction` (0 to 1).
function fillBar(className, fraction) {
  const fill = h("span", { class: className });
  fill.style.setProperty("--fill", `${Math.round(fraction * 1000) / 10}%`);
  return fill;
}

// An icon from ICONS as an inline SVG.
function icon(name, className = "icon") {
  const element = svg("svg", {
    class: className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  });
  element.innerHTML = ICONS[name] ?? ICONS.sparkles;
  return element;
}

// A colored square with an icon in it, for cards and page headers.
const iconChip = (name, tone, size = "") => h("span", { class: `chip-icon tone-${tone} ${size}`.trim(), "aria-hidden": "true" }, icon(name));

// The title of a page: its icon, name and what it's for. `extra` goes on the right (a status, buttons).
function hero(title, intro, tone, { iconName, extra } = {}) {
  return h(
    "header",
    { class: "hero" },
    iconName ? iconChip(iconName, tone, "lg") : null,
    h("div", { class: "hero-text" }, h("h1", {}, title), intro ? h("p", {}, intro) : null),
    extra ? h("div", { class: "hero-extra" }, extra) : null,
  );
}

// The header of a server page, from its entry in NAV.
function pageHero(pageId, intro, data, extra) {
  const page = PAGES.find((entry) => entry.id === pageId);
  const on = page?.on && data?.settings ? page.on(data.settings) : undefined;
  const status = on === undefined ? null : h("span", { class: `status ${on ? "on" : "off"}` }, t(on ? "featureOn" : "featureOff"));
  return hero(t(`page_${pageId}`), intro, page?.tone ?? "blue", { iconName: page?.icon, extra: [status, extra].filter(Boolean) });
}

function card(title, iconName, tone, ...children) {
  return h("section", { class: "card" }, h("h2", { class: "card-title" }, iconChip(iconName, tone), title), ...children);
}

// A number tile with a label, linking somewhere when `href` is given.
function tile(iconName, tone, value, label, sub, href) {
  return h(
    href ? "a" : "div",
    { class: `stat card tone-${tone}`, href },
    h("span", { class: "stat-head" }, h("span", { class: "stat-label" }, label), iconChip(iconName, tone, "sm")),
    h("span", { class: "stat-value" }, value),
    sub ? h("span", { class: "stat-sub" }, sub) : null,
  );
}

// Grey blocks where a page will appear, while it loads.
const skeleton = () =>
  h(
    "div",
    { class: "skeleton", "aria-busy": "true", "aria-label": t("loading") },
    h("span", { class: "sk sk-title" }),
    h("span", { class: "sk sk-line" }),
    h("span", { class: "sk sk-card" }),
    h("span", { class: "sk sk-card short" }),
  );

function field(labelKey, helpKey, control) {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, t(labelKey)),
    control,
    helpKey ? h("span", { class: "help" }, t(helpKey)) : null,
  );
}

// --- Look and feel ---------------------------------------------------------------

function applyAppearance() {
  const root = document.documentElement;
  const { theme, accent, density } = state.appearance;
  if (theme === "auto") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  root.dataset.accent = accent;
  root.dataset.density = density;
}

function loadAppearance() {
  const saved = recall("appearance") ?? {};
  state.appearance = {
    theme: THEMES.includes(saved.theme) ? saved.theme : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULT_APPEARANCE.accent,
    density: DENSITIES.includes(saved.density) ? saved.density : DEFAULT_APPEARANCE.density,
  };
  applyAppearance();
}

function setAppearance(change) {
  Object.assign(state.appearance, change);
  applyAppearance();
  remember("appearance", state.appearance);
}

// Buttons where exactly one is pressed.
function pickOne(buttons, pressed) {
  buttons.forEach((button) => button.setAttribute("aria-pressed", String(button === pressed)));
}

function segmented(label, options, current, onPick) {
  const buttons = options.map(({ value, text }) =>
    h(
      "button",
      {
        type: "button",
        class: "segment",
        "aria-pressed": String(value === current),
        onclick: (event) => {
          pickOne(buttons, event.currentTarget);
          onPick(value);
        },
      },
      text,
    ),
  );
  return h("div", { class: "segmented", role: "group", "aria-label": label }, buttons);
}

function openAppearance() {
  const swatches = ACCENTS.map((accent) =>
    h("button", {
      type: "button",
      class: `swatch accent-${accent}`,
      title: t(`accent_${accent}`),
      "aria-label": t(`accent_${accent}`),
      "aria-pressed": String(accent === state.appearance.accent),
      onclick: (event) => {
        pickOne(swatches, event.currentTarget);
        setAppearance({ accent });
      },
    }),
  );
  const dialog = h(
    "dialog",
    { class: "card appearance" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, t("appearanceTitle")),
      h("p", { class: "help" }, t("appearanceHelp")),
      h("h3", {}, t("appearanceTheme")),
      segmented(
        t("appearanceTheme"),
        THEMES.map((value) => ({ value, text: t(`theme_${value}`) })),
        state.appearance.theme,
        (theme) => setAppearance({ theme }),
      ),
      h("h3", {}, t("appearanceAccent")),
      h("div", { class: "swatches" }, swatches),
      h("h3", {}, t("appearanceDensity")),
      segmented(
        t("appearanceDensity"),
        DENSITIES.map((value) => ({ value, text: t(`density_${value}`) })),
        state.appearance.density,
        (density) => setAppearance({ density }),
      ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            class: "ghost",
            onclick: () => {
              setAppearance({ ...DEFAULT_APPEARANCE });
              dialog.close();
            },
          },
          t("appearanceReset"),
        ),
        h("button", { class: "primary", value: "done" }, t("done")),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// --- Talking to the server -----------------------------------------------------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.me = null;
    state.shell = null;
    renderChrome();
    showLogin();
    throw new ApiError(401, data);
  }
  if (!response.ok) {
    throw new ApiError(response.status, data);
  }
  return data;
}

// Shows a friendly message for anything that went wrong, except a logged-out session.
function failed(error) {
  if (error instanceof ApiError && error.status === 401) {
    return;
  }
  const messages = { 403: t("errorForbidden"), 404: t("errorNotFound"), 429: t("errorTooFast") };
  const message = error instanceof ApiError && error.body?.message ? error.body.message : messages[error.status];
  toast(message ?? t("errorGeneric"), "error");
}

// --- Account -----------------------------------------------------------------

// The language menu. Changing it redraws everything in the new language.
function languageSelect() {
  return h(
    "select",
    {
      class: "language",
      "aria-label": t("language"),
      onchange: async (event) => {
        await loadLanguage(event.currentTarget.value);
        state.shell = null;
        renderChrome();
        route();
      },
    },
    Object.entries(LANGUAGES).map(([code, name]) => h("option", { value: code, selected: code === state.language }, name)),
  );
}

// The account button in the top bar and its menu: appearance, language, log out.
// Logged out, only the language menu is shown.
function renderAccount() {
  const account = document.getElementById("account");
  if (!state.me) {
    account.replaceChildren(languageSelect());
    return;
  }
  const { user } = state.me;
  const url = avatarUrl(user);
  const avatar = () =>
    url
      ? h("img", { class: "avatar", src: url, alt: "" })
      : h("span", { class: "avatar placeholder", "aria-hidden": "true" }, initials(user.username).slice(0, 2));
  const menu = h(
    "div",
    { class: "menu", role: "menu", hidden: true },
    h("div", { class: "menu-user" }, avatar(), h("strong", {}, user.username)),
    h(
      "button",
      { class: "menu-item", type: "button", role: "menuitem", onclick: () => (closeMenus(), openAppearance()) },
      icon("palette"),
      t("appearanceTitle"),
    ),
    h("label", { class: "menu-item" }, icon("globe"), languageSelect()),
    h("button", { class: "menu-item danger-text", type: "button", role: "menuitem", onclick: logout }, icon("logout"), t("logout")),
  );
  const button = h(
    "button",
    {
      class: "account-button",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": t("accountMenu"),
      onclick: (event) => {
        event.stopPropagation();
        const open = menu.hidden;
        closeMenus();
        menu.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
      },
    },
    avatar(),
    h("span", { class: "account-name" }, user.username),
    icon("chevronDown", "icon small"),
  );
  account.replaceChildren(h("div", { class: "account" }, button, menu));
}

// Closes any open dropdown (account menu, server switcher).
function closeMenus() {
  document.querySelectorAll(".menu").forEach((menu) => (menu.hidden = true));
  document.querySelectorAll("[aria-haspopup][aria-expanded=true]").forEach((button) => button.setAttribute("aria-expanded", "false"));
}

// The top bar: the menu button (phones), the search button and the account.
function renderChrome() {
  const toggle = document.getElementById("menuToggle");
  toggle.replaceChildren(icon("menu"));
  toggle.setAttribute("aria-label", t("menu"));
  const search = document.getElementById("searchButton");
  search.replaceChildren(icon("search"), h("span", { class: "search-label" }, t("searchButton")), h("kbd", {}, isMac() ? "⌘K" : "Ctrl K"));
  search.setAttribute("aria-label", t("searchButton"));
  search.hidden = !state.me;
  renderAccount();
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform ?? "");

async function logout() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  state.me = null;
  state.cache = null;
  state.shell = null;
  renderChrome();
  location.hash = "#/";
  showLogin();
}

function showLogin() {
  const failedLogin = new URLSearchParams(location.hash.split("?")[1] ?? "").get("login") === "failed";
  show(
    h(
      "section",
      { class: "login card" },
      h("div", { class: "login-art" }, h("img", { src: "favicon.svg", alt: "", width: 72, height: 72 })),
      h("h1", {}, t("loginTitle")),
      h("p", { class: "muted" }, t("loginIntro")),
      failedLogin ? h("p", { class: "error-text" }, t("loginFailed")) : null,
      h("a", { class: "button primary big", href: "/auth/login" }, t("loginButton")),
    ),
  );
}

// --- Servers -----------------------------------------------------------------

async function showServers({ refresh = false } = {}) {
  state.me = await api(`/api/me${refresh ? "?refresh=1" : ""}`);
  renderChrome();
  const ready = state.me.guilds.filter((guild) => guild.botPresent);
  const invitable = state.me.guilds.filter((guild) => !guild.botPresent);

  const serverCard = (guild, { href, banner, badge, extra = {} }) =>
    h(
      "a",
      { class: `server card${guild.botPresent ? "" : " faded"}`, href, "data-name": guild.name.toLowerCase(), ...extra },
      h("span", { class: `server-banner ${banner}` }),
      h("span", { class: "server-body" }, guildIcon(guild), h("span", { class: "server-name" }, guild.name), badge),
    );
  const readyCards = ready.map((guild) =>
    serverCard(guild, {
      href: `#/g/${guild.id}/overview`,
      banner: bannerFor(guild.id),
      badge: h(
        "span",
        { class: `badge ${guild.access === "manage" ? "badge-accent" : "badge-pink"}` },
        t(guild.access === "manage" ? "accessManage" : "accessCases"),
      ),
    }),
  );
  const inviteCards = invitable.map((guild) =>
    serverCard(guild, {
      href: `${state.me.inviteUrl}&guild_id=${guild.id}`,
      banner: "banner-muted",
      badge: h("span", { class: "badge" }, icon("plus", "icon small"), t("serversInvite")),
      extra: { target: "_blank", rel: "noopener" },
    }),
  );

  const cards = [...readyCards, ...inviteCards];
  const noMatch = h("p", { class: "muted empty", hidden: true }, t("serversNoMatch"));
  const search = h("input", {
    type: "search",
    class: "grow",
    placeholder: t("serversSearch"),
    "aria-label": t("serversSearch"),
    oninput: () => {
      const text = search.value.trim().toLowerCase();
      cards.forEach((element) => (element.hidden = text !== "" && !element.dataset.name.includes(text)));
      noMatch.hidden = cards.length === 0 || cards.some((element) => !element.hidden);
    },
  });

  show(
    hero(t("serversWelcome", { name: state.me.user.username }), t("serversIntro"), "accent", { iconName: "layers" }),
    h(
      "div",
      { class: "toolbar" },
      search,
      h(
        "button",
        { class: "ghost", type: "button", onclick: () => showServers({ refresh: true }).catch(failed) },
        icon("refresh", "icon small"), t("serversRefresh"),
      ),
    ),
    noMatch,
    readyCards.length > 0 ? h("div", { class: "server-grid" }, readyCards) : h("p", { class: "muted empty" }, t("serversNone")),
    inviteCards.length > 0 ? h("h2", { class: "section-title" }, t("serversWithoutBot")) : null,
    inviteCards.length > 0 ? h("div", { class: "server-grid" }, inviteCards) : null,
  );
}

// --- One server ----------------------------------------------------------------

async function loadGuild(guildId, { fresh = false } = {}) {
  if (!state.me) {
    state.me = await api("/api/me");
    renderChrome();
  }
  const cached = state.cache;
  if (!fresh && cached?.guildId === guildId && Date.now() - cached.at < GUILD_CACHE_MS) {
    state.guild = cached.data;
    return cached.data;
  }
  state.guild = await api(`/api/guilds/${guildId}`);
  state.cache = { guildId, data: state.guild, at: Date.now() };
  return state.guild;
}

const canManageGuild = (data) => data.access === "manage";

// The server for a settings page, or undefined (after moving on to the
// overview) for someone who only has a dashboard role. Settings pages always
// ask the server again, so they never show stale values.
async function loadManagedGuild(guildId) {
  const data = await loadGuild(guildId, { fresh: true });
  if (!canManageGuild(data)) {
    location.replace(`#/g/${guildId}/overview`);
    return undefined;
  }
  return data;
}

const visiblePages = (data) => PAGES.filter((page) => !page.manage || canManageGuild(data));

// The server switcher at the top of the sidebar: this server, and a menu of the others.
function guildSwitcher(data) {
  const { guild } = data;
  const others = (state.me?.guilds ?? []).filter((entry) => entry.botPresent && entry.id !== guild.id);
  const counts = [
    guild.memberCount === null ? null : t("membersCount", { count: formatNumber(guild.memberCount) }),
    guild.onlineCount === null ? null : t("onlineCount", { count: formatNumber(guild.onlineCount) }),
  ].filter(Boolean);
  const menu = h(
    "div",
    { class: "menu switcher-menu", role: "menu", hidden: true },
    others.map((entry) =>
      h("a", { class: "menu-item", role: "menuitem", href: `#/g/${entry.id}/overview` }, guildIcon(entry, "xs"), h("span", { class: "grow" }, entry.name)),
    ),
    others.length > 0 ? h("hr") : null,
    h("a", { class: "menu-item", role: "menuitem", href: "#/" }, icon("layers"), t("allServers")),
  );
  const button = h(
    "button",
    {
      class: "switcher",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: t("switchServer"),
      onclick: (event) => {
        event.stopPropagation();
        const open = menu.hidden;
        closeMenus();
        menu.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
      },
    },
    guildIcon(guild, "sm"),
    h("span", { class: "switcher-text" }, h("strong", {}, guild.name), h("span", { class: "muted" }, counts.join(" · "))),
    icon("chevronDown", "icon small"),
  );
  return h("div", { class: "switcher-wrap" }, button, menu);
}

// The sidebar's links, grouped, with a dot on features that are switched on.
function navLinks(data, pageId) {
  const pages = visiblePages(data);
  return NAV.map((section) => {
    const links = section.pages
      .filter((page) => pages.some((entry) => entry.id === page.id))
      .map((page) => {
        const on = page.on && data.settings ? page.on(data.settings) : undefined;
        return h(
          "a",
          {
            class: `nav-link${page.id === pageId ? " active" : ""}`,
            href: `#/g/${data.guild.id}/${page.id}`,
            "data-page": page.id,
            "aria-current": page.id === pageId ? "page" : undefined,
          },
          h("span", { class: `nav-icon tone-${page.tone}` }, icon(page.icon)),
          h("span", { class: "grow" }, t(`page_${page.id}`)),
          on ? h("span", { class: "nav-dot", title: t("featureOn") }) : null,
        );
      });
    return links.length > 0 ? h("div", { class: "nav-section" }, h("span", { class: "nav-heading" }, t(`navGroup_${section.group}`)), links) : null;
  });
}

// The server's sidebar and the page next to it. The sidebar is kept while
// moving between this server's pages; only the content is replaced.
function guildLayout(data, pageId, ...content) {
  const key = `${data.guild.id}:${data.access}:${state.language}`;
  if (!state.shell || state.shell.key !== key || !state.shell.element.isConnected) {
    const nav = h("nav", { class: "nav", "aria-label": data.guild.name });
    const contentArea = h("div", { class: "content" });
    const sidebar = h(
      "aside",
      { class: "sidebar", id: "sidebar" },
      guildSwitcher(data),
      nav,
      canManageGuild(data) ? null : h("p", { class: "help sidebar-note" }, t("casesOnlyNote")),
    );
    const element = h(
      "div",
      { class: "guild-layout" },
      sidebar,
      h("button", { class: "nav-scrim", type: "button", "aria-label": t("closeMenu"), onclick: () => document.body.classList.remove("nav-open") }),
      contentArea,
    );
    state.shell = { key, element, nav, contentArea, guildId: data.guild.id };
  }
  state.shell.nav.replaceChildren(...navLinks(data, pageId).filter(Boolean));
  state.shell.contentArea.replaceChildren(...content.flat().filter(Boolean));
  document.body.classList.add("in-guild");
  document.body.classList.remove("nav-open");
  return state.shell.element;
}

// --- Search (Ctrl+K) -------------------------------------------------------------

// Lowercase, without accents, for matching what's typed.
const searchable = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Everything the search box can jump to: this server's pages, then the servers.
function searchItems() {
  const items = [];
  const data = state.guild && state.shell?.guildId === state.guild.guild.id ? state.guild : null;
  if (data) {
    for (const page of visiblePages(data)) {
      const intro = t(`${page.id}Intro`);
      items.push({
        kind: "page",
        icon: page.icon,
        tone: page.tone,
        title: t(`page_${page.id}`),
        sub: t(`navGroup_${page.group}`),
        text: searchable(`${t(`page_${page.id}`)} ${t(`navGroup_${page.group}`)} ${intro === `${page.id}Intro` ? "" : intro} ${t(`search_${page.id}`)}`),
        href: `#/g/${data.guild.id}/${page.id}`,
      });
    }
  }
  for (const guild of (state.me?.guilds ?? []).filter((entry) => entry.botPresent)) {
    items.push({ kind: "server", guild, title: guild.name, sub: t("searchServers"), text: searchable(guild.name), href: `#/g/${guild.id}/overview` });
  }
  return items;
}

function openSearch() {
  if (!state.me || document.querySelector("dialog.search")) {
    return;
  }
  const items = searchItems();
  let shown = [];
  let selected = 0;
  const input = h("input", { type: "search", class: "search-input", placeholder: t("searchPlaceholder"), "aria-label": t("searchPlaceholder"), autocomplete: "off" });
  const list = h("ul", { class: "search-results", role: "listbox" });
  const go = (item) => {
    dialog.close();
    location.hash = item.href;
  };
  const paint = () => {
    list.replaceChildren(
      ...shown.map((item, index) =>
        h(
          "li",
          {
            role: "option",
            class: index === selected ? "selected" : "",
            "aria-selected": String(index === selected),
            onclick: () => go(item),
            onmousemove: () => {
              if (selected !== index) {
                selected = index;
                paint();
              }
            },
          },
          item.kind === "server" ? guildIcon(item.guild, "xs") : iconChip(item.icon, item.tone, "sm"),
          h("span", { class: "grow" }, h("strong", {}, item.title), h("span", { class: "muted" }, item.sub)),
          index === selected ? icon("chevronRight", "icon small") : null,
        ),
      ),
    );
    if (shown.length === 0) {
      list.append(h("li", { class: "muted empty" }, t("searchNoResults")));
    }
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  };
  const filter = () => {
    const words = searchable(input.value).split(/\s+/).filter(Boolean);
    shown = items.filter((item) => words.every((word) => item.text.includes(word))).slice(0, 30);
    selected = 0;
    paint();
  };
  input.addEventListener("input", filter);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected = shown.length === 0 ? 0 : (selected + step + shown.length) % shown.length;
      paint();
    } else if (event.key === "Enter" && shown[selected]) {
      event.preventDefault();
      go(shown[selected]);
    }
  });
  const dialog = h(
    "dialog",
    { class: "search", onclick: (event) => event.target === dialog && dialog.close() },
    h("div", { class: "search-box" }, icon("search"), input, h("kbd", {}, "Esc")),
    list,
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  filter();
  input.focus();
}

// Ctrl+K (⌘K on a Mac) or "/" opens the search; "/" is ignored while typing.
function onShortcut(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "") || document.activeElement?.isContentEditable;
  if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    openSearch();
  } else if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    openSearch();
  } else if (event.key === "Escape") {
    closeMenus();
    document.body.classList.remove("nav-open");
  }
}

// A <select> of roles or channels, with "Not set" first. A saved value that
// isn't in the list (a deleted channel) stays selected, so saving doesn't clear it.
function picker({ id, options, value, emptyLabel }) {
  const missing = value && !options.some((option) => option.id === value);
  return h(
    "select",
    { id },
    h("option", { value: "" }, emptyLabel),
    missing ? h("option", { value, selected: true }, t("unknownOption", { id: value })) : null,
    options.map((option) => h("option", { value: option.id, selected: option.id === value }, option.label)),
  );
}

const channelLabel = (channel, channels) => {
  const parent = channels.find((other) => other.id === channel.parentId);
  const prefix = channel.type === CHANNEL.CATEGORY ? "▸ " : channel.type === CHANNEL.VOICE ? "🔊 " : "#";
  return parent ? `${prefix}${channel.name} (${parent.name})` : `${prefix}${channel.name}`;
};

const roleOptions = (data) =>
  data.roles.map((role) => ({ id: role.id, label: role.managed ? `@${role.name} (${t("botRole")})` : `@${role.name}` }));
const postableChannels = (data) =>
  data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

// Checkboxes with a filter box, a "ticked only" switch and a count.
function checkList({ name, items, checked, filterKey }) {
  const ticked = new Set(checked);
  const boxes = items.map((item) =>
    h(
      "label",
      { class: "check", "data-name": item.label.toLowerCase() },
      h("input", { type: "checkbox", name, value: item.id, checked: ticked.has(item.id) }),
      item.dot ?? null,
      h("span", {}, item.label),
    ),
  );
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted empty", hidden: true }, t("nothingMatches"));
  const onlyTicked = h("input", { type: "checkbox" });
  const filter = h("input", { type: "search", class: "grow", placeholder: t(filterKey), "aria-label": t(filterKey) });
  const update = () => {
    const text = filter.value.trim().toLowerCase();
    let shown = 0;
    let selected = 0;
    boxes.forEach((box) => {
      const isChecked = box.querySelector("input").checked;
      box.hidden = (text !== "" && !box.dataset.name.includes(text)) || (onlyTicked.checked && !isChecked);
      shown += box.hidden ? 0 : 1;
      selected += isChecked ? 1 : 0;
    });
    count.textContent = t("selectedCount", { count: selected });
    empty.hidden = shown > 0;
  };
  filter.addEventListener("input", update);
  const element = h(
    "div",
    { class: "check-list", onchange: update },
    h("div", { class: "toolbar" }, filter, h("label", { class: "switch" }, onlyTicked, h("span", {}, t("onlyTicked"))), count),
    h("div", { class: "checks scroll" }, boxes, empty),
  );
  update();
  return element;
}

// --- Settings pages -----------------------------------------------------------

// Compares values the way the server stores them: empty lists are "not set",
// and neither list order nor key order matters.
function normalized(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${value.map(normalized).sort().join(",")}]` : "null";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${normalized(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// A settings page: cards of controls, and a save bar that appears when
// something changed. `fields` maps each setting to a function reading its
// value from the form. `after` goes below the form (it isn't saved).
function settingsPage({ data, pageId, intro, cards, fields, after = null }) {
  const guildId = data.guild.id;
  const saved = { ...data.settings };
  const changes = () =>
    Object.fromEntries(
      Object.entries(fields)
        .map(([key, read]) => [key, read(form)])
        .filter(([key, value]) => normalized(value) !== normalized(saved[key])),
    );

  const saveButton = h("button", { class: "primary", type: "submit" }, t("save"));
  const saveBar = h(
    "div",
    { class: "save-bar", hidden: true, role: "status" },
    h("span", { class: "grow" }, t("unsavedChanges")),
    h(
      "button",
      {
        class: "ghost",
        type: "button",
        onclick: () => {
          state.unsaved = false;
          route();
        },
      },
      t("reset"),
    ),
    saveButton,
  );
  const refresh = () => {
    state.unsaved = Object.keys(changes()).length > 0;
    saveBar.hidden = !state.unsaved;
  };
  const form = h(
    "form",
    {
      class: "settings",
      oninput: refresh,
      onchange: refresh,
      onsubmit: async (event) => {
        event.preventDefault();
        const pending = changes();
        if (Object.keys(pending).length === 0) {
          toast(t("noChanges"));
          return;
        }
        saveButton.disabled = true;
        try {
          const result = await api(`/api/guilds/${guildId}/settings`, { method: "PUT", body: pending });
          Object.keys(saved).forEach((key) => delete saved[key]);
          Object.assign(saved, result.settings);
          data.settings = result.settings;
          state.cache = { guildId, data, at: Date.now() };
          toast(t("saved"));
          refresh();
          // The sidebar dots and the page's on/off badge follow what was saved.
          state.shell?.nav.replaceChildren(...navLinks(data, pageId).filter(Boolean));
          header.replaceWith((header = pageHero(pageId, intro, data)));
        } catch (error) {
          failed(error);
        } finally {
          saveButton.disabled = false;
        }
      },
    },
    cards,
    saveBar,
  );
  let header = pageHero(pageId, intro, data);
  show(guildLayout(data, pageId, header, form, after));
}

const selectValue = (id) => (form) => form.querySelector(`#${id}`).value || null;
const checkedList = (name) => (form) => {
  const ids = [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((box) => box.value);
  return ids.length > 0 ? ids : null;
};

// The raid settings on the Moderation page, or null when both are off.
function readJoinGate(form) {
  const number = (id) => {
    const text = form.querySelector(`#${id}`).value.trim();
    return text === "" ? null : Number(text);
  };
  const minAgeDays = number("gateMinAge");
  const alertJoins = number("gateAlertJoins");
  if (minAgeDays === null && alertJoins === null) {
    return null;
  }
  return { minAgeDays, action: form.querySelector("#gateAction").value, alertJoins };
}

async function showModeration(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const roles = roleOptions(data);
  const rolePicker = (key) => picker({ id: key, options: roles, value: data.settings[key], emptyLabel: t("notSet") });
  settingsPage({
    data,
    pageId: "moderation",
    intro: t("moderationIntro"),
    cards: [
      card(
        t("sectionRoles"),
        "shield",
        "red",
        field("staffRole", "staffRoleHelp", rolePicker("staffRoleId")),
        field("modRole", "modRoleHelp", rolePicker("modRoleId")),
      ),
      card(t("sectionQuarantine"), "lock", "amber", field("quarantineRole", "quarantineRoleHelp", rolePicker("quarantineRoleId"))),
      card(
        t("sectionModLog"),
        "list",
        "blue",
        field(
          "modLogChannel",
          "modLogChannelHelp",
          picker({
            id: "modLogChannelId",
            options: postableChannels(data),
            value: data.settings.modLogChannelId,
            emptyLabel: t("useLogsChannel"),
          }),
        ),
      ),
    ],
    fields: {
      staffRoleId: selectValue("staffRoleId"),
      modRoleId: selectValue("modRoleId"),
      quarantineRoleId: selectValue("quarantineRoleId"),
      modLogChannelId: selectValue("modLogChannelId"),
    },
  });
}

async function showRaid(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const gate = data.settings.joinGate ?? {};
  const lockdown = data.settings.lockdown;
  settingsPage({
    data,
    pageId: "raid",
    intro: t("raidIntro"),
    cards: [
      lockdown
        ? h(
            "p",
            { class: "tip danger" },
            icon("alert"),
            h("span", {}, t("raidLockdownActive", { date: formatDate(lockdown.startedAt), count: lockdown.channels?.length ?? 0 })),
          )
        : null,
      card(
        t("raidGateTitle"),
        "userX",
        "red",
        h("p", { class: "help" }, t("raidGateHelp")),
        h(
          "div",
          { class: "rule-body" },
          field("gateMinAge", "gateMinAgeHelp", h("input", { id: "gateMinAge", type: "number", min: 1, max: 365, step: 1, placeholder: t("off"), value: gate.minAgeDays ?? "" })),
          field(
            "gateAction",
            null,
            h(
              "select",
              { id: "gateAction" },
              ["kick", "alert"].map((action) => h("option", { value: action, selected: (gate.action ?? "kick") === action }, t(`gateAction_${action}`))),
            ),
          ),
        ),
      ),
      card(
        t("raidAlertTitle"),
        "bell",
        "amber",
        field("gateAlertJoins", "gateAlertJoinsHelp", h("input", { id: "gateAlertJoins", type: "number", min: 3, max: 100, step: 1, placeholder: t("off"), value: gate.alertJoins ?? "" })),
      ),
      card(t("raidLockdownTitle"), "lock", "gray", h("p", { class: "help" }, t("raidLockdownHelp"))),
    ],
    fields: { joinGate: readJoinGate },
  });
}

// --- Anti-nuke ------------------------------------------------------------------

const NUKE_ACTIONS = ["channelDelete", "channelCreate", "roleDelete", "ban", "kick", "webhookCreate"];
const NUKE_ACTION_ICONS = { channelDelete: "hash", channelCreate: "plus", roleDelete: "layers", ban: "gavel", kick: "userX", webhookCreate: "zap" };
const MAX_TRUSTED = 25;

// One trusted person: their user ID and, once known, their name.
function trustedRow(userId, names, onRemove) {
  const name = h("span", { class: "muted trusted-name" }, userId && names[userId] ? names[userId] : "");
  const row = h(
    "div",
    { class: "reward-row" },
    icon("user"),
    h("input", {
      class: "trusted-id grow",
      type: "text",
      inputmode: "numeric",
      pattern: "\\d{17,20}",
      required: true,
      placeholder: t("antinukeUserId"),
      value: userId ?? "",
      "aria-label": t("antinukeUserId"),
    }),
    name,
    h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
  );
  return row;
}

function readAntiNuke(form) {
  const number = (action) => Number(form.querySelector(`[data-limit="${action}"]`).value);
  return {
    enabled: form.querySelector("#antinukeEnabled").checked,
    punishment: form.querySelector("#antinukePunishment").value,
    limits: Object.fromEntries(NUKE_ACTIONS.map((action) => [action, number(action)])),
    trustedUserIds: [...new Set([...form.querySelectorAll(".trusted-id")].map((input) => input.value.trim()).filter(Boolean))],
  };
}

async function showAntiNuke(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const config = data.settings.antiNuke;
  const owner = data.isOwner;
  const trusted = editableList({
    items: config.trustedUserIds,
    max: MAX_TRUSTED,
    makeRow: (userId, remove) => trustedRow(userId, data.people ?? {}, remove),
    focus: ".trusted-id",
    emptyKey: "antinukeNoTrusted",
    addKey: "antinukeAddTrusted",
  });
  const cards = [
    owner ? null : h("p", { class: "tip" }, icon("lock"), h("span", {}, t("antinukeOwnerOnly"))),
    card(
      t("antinukeMaster"),
      "shieldCheck",
      "purple",
      h(
        "label",
        { class: "switch-card" },
        h("span", { class: "switch-text" }, h("strong", {}, t("antinukeMaster")), h("span", { class: "help" }, t("antinukeMasterHelp"))),
        h("span", { class: "switch" }, h("input", { id: "antinukeEnabled", type: "checkbox", role: "switch", checked: config.enabled, "aria-label": t("antinukeMaster") })),
      ),
      field(
        "antinukePunishment",
        "antinukePunishmentHelp",
        h(
          "select",
          { id: "antinukePunishment" },
          ["strip", "kick", "ban"].map((value) => h("option", { value, selected: config.punishment === value }, t(`antinukePunishment_${value}`))),
        ),
      ),
    ),
    card(
      t("antinukeLimits"),
      "alert",
      "red",
      h("p", { class: "help" }, t("antinukeLimitsHelp")),
      h(
        "div",
        { class: "limit-grid" },
        NUKE_ACTIONS.map((action) =>
          h(
            "label",
            { class: "limit" },
            iconChip(NUKE_ACTION_ICONS[action], "red", "sm"),
            h("span", { class: "grow" }, t(`antinukeAction_${action}`)),
            h("input", { type: "number", min: 2, max: 50, step: 1, required: true, value: config.limits[action], "data-limit": action, "aria-label": t(`antinukeAction_${action}`) }),
          ),
        ),
      ),
    ),
    card(
      t("antinukeTrusted"),
      "users",
      "green",
      h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("antinukeTrustedHelp")), trusted.count, trusted.addButton),
      trusted.empty,
      trusted.list,
    ),
  ];
  settingsPage({ data, pageId: "antinuke", intro: t("antinukeIntro"), cards, fields: { antiNuke: readAntiNuke } });
  if (!owner) {
    document.querySelectorAll(".content form.settings :is(input, select, button)").forEach((control) => {
      control.disabled = true;
    });
  }
}

async function showLogging(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const postable = postableChannels(data);
  const channelPicker = (key) => picker({ id: key, options: postable, value: data.settings[key], emptyLabel: t("notSet") });

  const disabled = new Set(data.settings.disabledLogEvents ?? []);
  const eventSwitches = LOG_EVENTS.map((event) =>
    h(
      "label",
      { class: "switch-card" },
      h(
        "span",
        { class: "switch-text" },
        h("strong", {}, t(`logEvent_${event}`)),
        h("span", { class: "help" }, t(`logEventHelp_${event}`)),
      ),
      h(
        "span",
        { class: "switch" },
        h("input", { type: "checkbox", name: "logEvent", value: event, checked: !disabled.has(event), role: "switch" }),
      ),
    ),
  );
  const setAll = (on) => () => {
    eventSwitches.forEach((element) => (element.querySelector("input").checked = on));
    eventSwitches[0].dispatchEvent(new Event("change", { bubbles: true }));
  };

  const ignorable = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

  settingsPage({
    data,
    pageId: "logging",
    intro: t("loggingIntro"),
    cards: [
      card(
        t("sectionChannels"),
        "hash",
        "amber",
        field("logsChannel", "logsChannelHelp", channelPicker("logsChannelId")),
        field("serverLogChannel", "serverLogChannelHelp", channelPicker("serverLogChannelId")),
      ),
      card(
        t("sectionServerLog"),
        "zap",
        "purple",
        h(
          "div",
          { class: "toolbar" },
          h("p", { class: "help grow" }, t("logEventsHelp")),
          h("button", { class: "ghost small", type: "button", onclick: setAll(true) }, t("allOn")),
          h("button", { class: "ghost small", type: "button", onclick: setAll(false) }, t("allOff")),
        ),
        h("div", { class: "switch-grid" }, eventSwitches),
      ),
      card(
        t("ignoredChannels"),
        "eyeOff",
        "gray",
        h("p", { class: "help" }, t("ignoredChannelsHelp")),
        checkList({ name: "ignore", items: ignorable, checked: data.settings.logIgnoredChannels ?? [], filterKey: "filterChannels" }),
      ),
    ],
    fields: {
      logsChannelId: selectValue("logsChannelId"),
      serverLogChannelId: selectValue("serverLogChannelId"),
      disabledLogEvents: (form) => {
        const off = [...form.querySelectorAll('input[name="logEvent"]')].filter((box) => !box.checked).map((box) => box.value);
        return off.length > 0 ? off : null;
      },
      logIgnoredChannels: checkedList("ignore"),
    },
  });
}

// --- Automod ---------------------------------------------------------------------

// "https://www.YouTube.com/x" -> "youtube.com", the way the bot saves websites.
const cleanSite = (text) =>
  text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
const lines = (text) => [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];

// An on/off switch whose checkbox is read into the automod settings at `path`.
function automodSwitch(path, checked, label) {
  return h(
    "span",
    { class: "switch" },
    h("input", { type: "checkbox", role: "switch", checked, "data-path": path, "data-kind": "bool", "aria-label": label }),
  );
}

function automodNumber({ path, key, min, max }, config) {
  const value = path.split(".").reduce((object, part) => object[part], config);
  return field(key, null, h("input", { type: "number", min, max, step: 1, required: true, value, "data-path": path, "data-kind": "int" }));
}

function automodSelect(path, options, value, labelPrefix) {
  return h(
    "select",
    { "data-path": path, "data-kind": "text" },
    options.map((option) => h("option", { value: option, selected: option === value }, t(`${labelPrefix}${option}`))),
  );
}

// One rule: its switch, what it does, and its own settings.
function automodRule(rule, config) {
  const settings = config.rules[rule];
  const extra = [];
  if (rule === "bannedWords") {
    extra.push(
      h(
        "label",
        { class: "field wide" },
        h("span", { class: "field-label" }, t("amWords")),
        h("textarea", { rows: 4, "data-path": "rules.bannedWords.words", "data-kind": "words", spellcheck: false }, settings.words.join("\n")),
        h("span", { class: "help" }, t("amWordsHelp")),
      ),
    );
  }
  if (rule === "links") {
    extra.push(
      h(
        "label",
        { class: "field wide" },
        h("span", { class: "field-label" }, t("amSites")),
        h("textarea", { rows: 3, "data-path": "rules.links.allowedDomains", "data-kind": "sites", spellcheck: false }, settings.allowedDomains.join("\n")),
        h("span", { class: "help" }, t("amSitesHelp")),
      ),
    );
  }
  return h(
    "div",
    { class: "rule" },
    h(
      "label",
      { class: "rule-head" },
      h("span", { class: "switch-text" }, h("strong", {}, t(`amRule_${rule}`)), h("span", { class: "help" }, t(`amRuleHelp_${rule}`))),
      automodSwitch(`rules.${rule}.enabled`, settings.enabled, t(`amRule_${rule}`)),
    ),
    h(
      "div",
      { class: "rule-body" },
      field("amAction", null, automodSelect(`rules.${rule}.action`, AUTOMOD_ACTIONS, settings.action, "amAction_")),
      (AUTOMOD_NUMBERS[rule] ?? []).map((number) => automodNumber(number, config)),
      extra,
    ),
  );
}

// Reads the whole automod settings back from the page.
function readAutomod(form, saved) {
  const config = structuredClone(saved);
  for (const input of form.querySelectorAll("[data-path]")) {
    const parts = input.dataset.path.split(".");
    const parent = parts.slice(0, -1).reduce((object, part) => object[part], config);
    const kind = input.dataset.kind;
    parent[parts.at(-1)] =
      kind === "bool"
        ? input.checked
        : kind === "int"
          ? Number.parseInt(input.value, 10)
          : kind === "words"
            ? lines(input.value.toLowerCase().replace(/[ \t]+/g, " "))
            : kind === "sites"
              ? [...new Set(lines(input.value.replace(/[,\s]+/g, "\n")).map(cleanSite).filter(Boolean))]
              : input.value;
  }
  config.exemptRoleIds = [...form.querySelectorAll('input[name="amRole"]:checked')].map((box) => box.value);
  config.exemptChannelIds = [...form.querySelectorAll('input[name="amChannel"]:checked')].map((box) => box.value);
  return config;
}

async function showAutomod(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const config = data.settings.automod;
  const roles = data.roles.filter((role) => !role.managed).map((role) => ({ id: role.id, label: role.name, dot: roleDot(role) }));
  const channels = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

  settingsPage({
    data,
    pageId: "automod",
    intro: t("automodIntro"),
    cards: [
      card(
        t("amMaster"),
        "bot",
        "blue",
        h(
          "label",
          { class: "switch-card" },
          h("span", { class: "switch-text" }, h("strong", {}, t("amMaster")), h("span", { class: "help" }, t("amMasterHelp"))),
          automodSwitch("enabled", config.enabled, t("amMaster")),
        ),
        h("p", { class: "help" }, t("amAlwaysExempt")),
      ),
      card(
        t("amRulesTitle"),
        "sparkles",
        "pink",
        h("p", { class: "help" }, t("amRulesHelp")),
        h("div", { class: "rules" }, AUTOMOD_RULES.map((rule) => automodRule(rule, config))),
      ),
      card(
        t("amPunishTitle"),
        "gavel",
        "red",
        h(
          "div",
          { class: "rule-body" },
          field(
            "amTimeoutMinutes",
            "amTimeoutMinutesHelp",
            h("input", { type: "number", min: 1, max: 40320, step: 1, required: true, value: config.timeoutMinutes, "data-path": "timeoutMinutes", "data-kind": "int" }),
          ),
          field(
            "amEscalationWarnings",
            "amEscalationWarningsHelp",
            h("input", { type: "number", min: 0, max: 20, step: 1, required: true, value: config.escalation.warnings, "data-path": "escalation.warnings", "data-kind": "int" }),
          ),
          field("amEscalationAction", null, automodSelect("escalation.action", ESCALATION_ACTIONS, config.escalation.action, "amEscalation_")),
          field(
            "amEscalationMinutes",
            null,
            h("input", { type: "number", min: 1, max: 40320, step: 1, required: true, value: config.escalation.timeoutMinutes, "data-path": "escalation.timeoutMinutes", "data-kind": "int" }),
          ),
        ),
      ),
      card(
        t("amExemptRoles"),
        "tag",
        "purple",
        h("p", { class: "help" }, t("amExemptRolesHelp")),
        checkList({ name: "amRole", items: roles, checked: config.exemptRoleIds, filterKey: "filterRoles" }),
      ),
      card(
        t("amExemptChannels"),
        "eyeOff",
        "gray",
        h("p", { class: "help" }, t("amExemptChannelsHelp")),
        checkList({ name: "amChannel", items: channels, checked: config.exemptChannelIds, filterKey: "filterChannels" }),
      ),
    ],
    fields: { automod: (form) => readAutomod(form, data.settings.automod) },
  });
}

// --- Community -------------------------------------------------------------------

// A message box with a character count. Empty means the default (or off, for the DM).
function messageBox(id, value, placeholder, max = MAX_MESSAGE_LENGTH) {
  const count = h("span", { class: "char-count" });
  const box = h("textarea", { id, rows: 3, maxLength: max, placeholder: placeholder ?? "" }, value ?? "");
  const update = () => {
    count.textContent = `${box.value.length}/${max}`;
  };
  box.addEventListener("input", update);
  update();
  return h("span", { class: "message-box" }, box, count);
}

const textValue = (id) => (form) => form.querySelector(`#${id}`).value.replace(/\r\n?/g, "\n").trim() || null;

// The server's role panels, read-only: they're made with /rolepanel in Discord.
function rolePanelList(data) {
  const panels = Array.isArray(data.settings.rolePanels) ? data.settings.rolePanels : [];
  if (panels.length === 0) {
    return h("p", { class: "muted" }, t("rolePanelsNone"));
  }
  const roleName = (id) => data.roles.find((role) => role.id === id)?.name ?? t("unknownOption", { id });
  const channelName = (id) => {
    const channel = data.channels.find((entry) => entry.id === id);
    return channel ? `#${channel.name}` : t("unknownOption", { id });
  };
  return h(
    "ul",
    { class: "panel-list" },
    panels.map((panel) =>
      h(
        "li",
        {},
        h(
          "div",
          { class: "toolbar" },
          h("strong", { class: "grow" }, `#${panel.id} ${panel.title}`),
          h("span", { class: "badge" }, t(`rolePanelMode_${panel.mode === "unique" ? "unique" : "toggle"}`)),
          h("span", { class: "muted" }, channelName(panel.channelId)),
        ),
        h(
          "div",
          { class: "badges" },
          panel.roles.length > 0
            ? panel.roles.map((entry) => h("span", { class: "badge" }, `${entry.emoji ? `${entry.emoji} ` : ""}@${roleName(entry.roleId)}`))
            : h("span", { class: "muted" }, t("rolePanelsEmpty")),
        ),
      ),
    ),
  );
}

// The starboard settings on the Community page, or null when no channel is picked (off).
function readStarboard(form) {
  const channelId = form.querySelector("#starboardChannelId").value;
  if (!channelId) {
    return null;
  }
  return {
    channelId,
    threshold: Number(form.querySelector("#starboardThreshold").value),
    emoji: form.querySelector("#starboardEmoji").value.trim(),
  };
}

// The birthday settings on the Community page, or null when neither a channel nor a role is picked (off).
function readBirthdays(form) {
  const channelId = form.querySelector("#birthdayChannelId").value || null;
  const roleId = form.querySelector("#birthdayRoleId").value || null;
  if (!channelId && !roleId) {
    return null;
  }
  return {
    channelId,
    roleId,
    message: form.querySelector("#birthdayMessage").value.replace(/\r\n?/g, "\n").trim() || null,
    timezone: form.querySelector("#birthdayTimezone").value.trim() || "UTC",
  };
}

function birthdayCard(data, postable, defaults) {
  const saved = data.settings.birthdays ?? {};
  const roles = data.roles
    .filter((role) => role.id !== data.guild.id && !role.managed && (BigInt(role.permissions ?? 0) & BIRTHDAY_ROLE_FORBIDDEN) === 0n)
    .map((role) => ({ id: role.id, label: `@${role.name}` }));
  const zones = h("datalist", { id: "birthdayZones" }, ["UTC", ...Intl.supportedValuesOf("timeZone")].map((zone) => h("option", { value: zone })));
  return card(
    t("sectionBirthdays"),
    "cake",
    "pink",
    h(
      "div",
      { class: "rule-body" },
      field("birthdayChannel", "birthdayChannelHelp", picker({ id: "birthdayChannelId", options: postable, value: saved.channelId, emptyLabel: t("communityOff") })),
      field("birthdayRole", "birthdayRoleHelp", picker({ id: "birthdayRoleId", options: roles, value: saved.roleId, emptyLabel: t("communityOff") })),
      field(
        "birthdayTimezone",
        "birthdayTimezoneHelp",
        h("input", {
          id: "birthdayTimezone",
          list: "birthdayZones",
          maxLength: 64,
          spellcheck: false,
          value: saved.timezone ?? "UTC",
          placeholder: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      ),
    ),
    zones,
    field("birthdayMessage", "birthdayMessageHelp", messageBox("birthdayMessage", saved.message, defaults.birthdayMessage, MAX_BIRTHDAY_MESSAGE_LENGTH)),
  );
}

// The channels the bot can post in, with "Off" first, for community pickers.
const offPicker = (data, id, value) => picker({ id, options: postableChannels(data), value, emptyLabel: t("communityOff") });

async function showWelcome(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const { settings } = data;
  const defaults = data.communityDefaults ?? {};
  settingsPage({
    data,
    pageId: "welcome",
    intro: t("welcomeIntro"),
    cards: [
      card(
        t("sectionWelcome"),
        "userPlus",
        "pink",
        field("welcomeChannel", "welcomeChannelHelp", offPicker(data, "welcomeChannelId", settings.welcomeChannelId)),
        field("welcomeMessage", "messagePlaceholdersHelp", messageBox("welcomeMessage", settings.welcomeMessage, defaults.welcomeMessage)),
      ),
      card(t("welcomeDm"), "message", "blue", field("welcomeDm", "welcomeDmHelp", messageBox("welcomeDm", settings.welcomeDm, t("welcomeDmPlaceholder")))),
      card(
        t("sectionLeave"),
        "logout",
        "gray",
        field("leaveChannel", "leaveChannelHelp", offPicker(data, "leaveChannelId", settings.leaveChannelId)),
        field("leaveMessage", "messagePlaceholdersHelp", messageBox("leaveMessage", settings.leaveMessage, defaults.leaveMessage)),
      ),
    ],
    fields: {
      welcomeChannelId: selectValue("welcomeChannelId"),
      welcomeMessage: textValue("welcomeMessage"),
      welcomeDm: textValue("welcomeDm"),
      leaveChannelId: selectValue("leaveChannelId"),
      leaveMessage: textValue("leaveMessage"),
    },
  });
}

// Role persistence on the Autoroles page, or null when it's off with nothing ignored.
function readRolePersist(form) {
  const enabled = form.querySelector("#persistEnabled").checked;
  const ignoredRoleIds = checkedList("persistIgnore")(form) ?? [];
  return enabled || ignoredRoleIds.length > 0 ? { enabled, ignoredRoleIds } : null;
}

async function showRoles(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const persist = data.settings.rolePersist ?? {};
  const givable = data.roles
    .filter((role) => !role.managed && (BigInt(role.permissions ?? 0) & AUTOROLE_FORBIDDEN) === 0n)
    .map((role) => ({ id: role.id, label: `@${role.name}`, dot: roleDot(role) }));
  settingsPage({
    data,
    pageId: "roles",
    intro: t("rolesIntro"),
    cards: [
      data.guild.community ? h("p", { class: "tip" }, icon("sparkles"), h("span", {}, t("onboardingTip"))) : null,
      card(
        t("sectionAutoroles"),
        "gift",
        "green",
        h("p", { class: "help" }, t("autorolesHelp", { max: MAX_AUTOROLES })),
        checkList({ name: "autorole", items: givable, checked: data.settings.autoroleIds ?? [], filterKey: "filterRoles" }),
      ),
      card(
        t("sectionPersist"),
        "refresh",
        "purple",
        h(
          "label",
          { class: "switch-card" },
          h("span", { class: "switch-text" }, h("strong", {}, t("persistEnabled")), h("span", { class: "help" }, t("persistHelp"))),
          h("span", { class: "switch" }, h("input", { id: "persistEnabled", type: "checkbox", role: "switch", checked: Boolean(persist.enabled), "aria-label": t("persistEnabled") })),
        ),
        h("p", { class: "help" }, t("persistIgnoreHelp")),
        checkList({
          name: "persistIgnore",
          items: data.roles.filter((role) => !role.managed).map((role) => ({ id: role.id, label: `@${role.name}`, dot: roleDot(role) })),
          checked: persist.ignoredRoleIds ?? [],
          filterKey: "filterRoles",
        }),
      ),
    ],
    fields: { autoroleIds: checkedList("autorole"), rolePersist: readRolePersist },
    after: card(t("sectionRolePanels"), "layers", "blue", h("p", { class: "help" }, t("rolePanelsHelp")), rolePanelList(data)),
  });
}

async function showStarboard(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const starboard = data.settings.starboard ?? {};
  settingsPage({
    data,
    pageId: "starboard",
    intro: t("starboardHelp"),
    cards: [
      card(
        t("sectionStarboard"),
        "star",
        "amber",
        field("starboardChannel", "starboardChannelHelp", offPicker(data, "starboardChannelId", starboard.channelId)),
        h(
          "div",
          { class: "rule-body" },
          field(
            "starboardThreshold",
            "starboardThresholdHelp",
            h("input", {
              id: "starboardThreshold",
              type: "number",
              min: 1,
              max: MAX_STARBOARD_THRESHOLD,
              step: 1,
              value: starboard.threshold ?? STARBOARD_DEFAULTS.threshold,
            }),
          ),
          field("starboardEmoji", "starboardEmojiHelp", h("input", { id: "starboardEmoji", maxLength: 64, value: starboard.emoji ?? STARBOARD_DEFAULTS.emoji })),
        ),
      ),
    ],
    fields: { starboard: readStarboard },
  });
}

async function showBirthdays(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  settingsPage({
    data,
    pageId: "birthdays",
    intro: t("birthdaysHelp"),
    cards: [birthdayCard(data, postableChannels(data), data.communityDefaults ?? {})],
    fields: { birthdays: readBirthdays },
  });
}

// --- Custom commands ---------------------------------------------------------------

// "Download Link" -> "download-link", the way the bot saves tag names; "" if invalid.
function cleanTagName(text) {
  const name = text.trim().toLowerCase().replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return /^[\p{Ll}\p{Lo}\p{N}-]{1,32}$/u.test(name) ? name : "";
}

// One custom command: its name, its text and a remove button.
function tagRow(tag, onRemove) {
  const row = h(
    "div",
    { class: "tag-row" },
    h(
      "div",
      { class: "toolbar" },
      h("span", { class: "tag-slash", "aria-hidden": "true" }, "/tag"),
      h("input", {
        class: "grow tag-name",
        value: tag.name,
        maxLength: 32,
        placeholder: t("tagNamePlaceholder"),
        "aria-label": t("tagName"),
        spellcheck: false,
      }),
      h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
    ),
    h("textarea", { class: "tag-content", rows: 3, maxLength: MAX_TAG_LENGTH, placeholder: t("tagContentPlaceholder"), "aria-label": t("tagContent") }, tag.content),
  );
  return row;
}

// The custom commands on the page, as the bot saves them. Rows left completely
// empty are ignored; a row with a bad name is sent as typed so the server explains.
function readTags(form) {
  const tags = [...form.querySelectorAll(".tag-row")]
    .map((row) => ({
      typed: row.querySelector(".tag-name").value,
      content: row.querySelector(".tag-content").value.replace(/\r\n?/g, "\n").trim(),
    }))
    .filter((tag) => tag.typed.trim() || tag.content)
    .map((tag) => ({ name: cleanTagName(tag.typed) || tag.typed, content: tag.content }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return tags.length > 0 ? tags : null;
}

// One auto-responder: trigger, how it matches, where, the reply and a remove button.
function responderRow(responder, channels, onRemove) {
  const row = h(
    "div",
    { class: "tag-row responder-row" },
    h(
      "div",
      { class: "toolbar" },
      h("input", {
        class: "grow responder-trigger",
        value: responder.trigger,
        maxLength: MAX_TRIGGER_LENGTH,
        placeholder: t("responderTriggerPlaceholder"),
        "aria-label": t("responderTrigger"),
        spellcheck: false,
      }),
      h(
        "select",
        { class: "responder-match", "aria-label": t("responderMatch") },
        RESPONDER_MATCHES.map((match) => h("option", { value: match, selected: match === (responder.match ?? "contains") }, t(`responderMatch_${match}`))),
      ),
      h("span", { class: "responder-channel" }, picker({ id: undefined, options: channels, value: responder.channelId ?? "", emptyLabel: t("responderEverywhere") })),
      h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
    ),
    h(
      "textarea",
      { class: "responder-reply", rows: 3, maxLength: MAX_TAG_LENGTH, placeholder: t("responderReplyPlaceholder"), "aria-label": t("responderReply") },
      responder.reply,
    ),
  );
  return row;
}

// The auto-responders on the page, as the bot saves them (triggers lowercased,
// spaces collapsed). Empty rows are ignored; bad ones are sent so the server explains.
function readResponders(form) {
  const responders = [...form.querySelectorAll(".responder-row")]
    .map((row) => ({
      trigger: row.querySelector(".responder-trigger").value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
      match: row.querySelector(".responder-match").value,
      reply: row.querySelector(".responder-reply").value.replace(/\r\n?/g, "\n").trim(),
      channelId: row.querySelector(".responder-channel select").value || null,
    }))
    .filter((responder) => responder.trigger || responder.reply)
    .sort((a, b) => a.trigger.localeCompare(b.trigger));
  return responders.length > 0 ? responders : null;
}

// An editable list with a count and an Add button, for custom commands and auto-responders.
function editableList({ items, max, makeRow, focus, emptyKey, addKey }) {
  const list = h("div", { class: "tag-list" });
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted" }, t(emptyKey));
  const update = () => {
    const rows = list.children.length;
    count.textContent = t("tagsCount", { count: rows, max });
    empty.hidden = rows > 0;
    addButton.disabled = rows >= max;
  };
  const remove = (row) => {
    row.remove();
    update();
    list.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const addButton = h(
    "button",
    {
      class: "primary small",
      type: "button",
      onclick: () => {
        const row = makeRow(null, remove);
        list.append(row);
        update();
        row.querySelector(focus).focus();
      },
    },
    t(addKey),
  );
  items.forEach((item) => list.append(makeRow(item, remove)));
  update();
  return { list, count, empty, addButton };
}

async function showTags(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const tags = editableList({
    items: data.settings.tags ?? [],
    max: MAX_TAGS,
    makeRow: (tag, remove) => tagRow(tag ?? { name: "", content: "" }, remove),
    focus: ".tag-name",
    emptyKey: "tagsNone",
    addKey: "tagAdd",
  });
  settingsPage({
    data,
    pageId: "tags",
    intro: t("tagsIntro"),
    cards: [
      card(
        t("sectionTags"),
        "tag",
        "amber",
        h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("tagsHelp")), tags.count, tags.addButton),
        tags.empty,
        tags.list,
      ),
    ],
    fields: { tags: readTags },
  });
}

async function showResponders(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const responderChannels = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));
  const responders = editableList({
    items: data.settings.autoResponders ?? [],
    max: MAX_RESPONDERS,
    makeRow: (responder, remove) => responderRow(responder ?? { trigger: "", match: "contains", reply: "", channelId: null }, responderChannels, remove),
    focus: ".responder-trigger",
    emptyKey: "respondersNone",
    addKey: "responderAdd",
  });

  settingsPage({
    data,
    pageId: "responders",
    intro: t("respondersIntro"),
    cards: [
      card(
        t("sectionResponders"),
        "repeat",
        "cyan",
        h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("respondersHelp")), responders.count, responders.addButton),
        responders.empty,
        responders.list,
      ),
    ],
    fields: { autoResponders: readResponders },
  });
}

// --- Scheduled messages -------------------------------------------------------------

// "Every day", or "Every 3 days" for an interval set with /schedule.
function repeatLabel(ms) {
  const preset = REPEATS.find((repeat) => repeat.ms === ms);
  return preset ? t(preset.key) : t("scheduledEvery", { every: formatDuration(ms) });
}

// A <input type="datetime-local"> value, in the browser's time zone.
function localDateTime(ms) {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function scheduledRow(guildId, message, channels, onDeleted) {
  const channel = channels.find((entry) => entry.id === message.channelId);
  const remove = h("button", { class: "ghost small", type: "button" }, t("scheduledDelete"));
  remove.addEventListener("click", async () => {
    if (!confirm(t("scheduledDeleteConfirm", { number: message.id }))) {
      return;
    }
    remove.disabled = true;
    try {
      await api(`/api/guilds/${guildId}/scheduled/${message.id}`, { method: "DELETE" });
      toast(t("scheduledDeleted"));
      onDeleted();
    } catch (error) {
      remove.disabled = false;
      failed(error);
    }
  });
  return h(
    "li",
    { class: "scheduled-row" },
    h(
      "div",
      { class: "toolbar" },
      h("strong", {}, `#${message.id}`),
      h("span", { class: "pill" }, channel ? channelLabel(channel, channels) : t("unknownOption", { id: message.channelId })),
      h("span", { class: "muted grow" }, `${formatDate(message.nextAt)}${message.intervalMs ? ` · ${repeatLabel(message.intervalMs)}` : ""}`),
      remove,
    ),
    h("p", { class: "scheduled-content" }, message.content),
    h(
      "p",
      { class: "help" },
      t(message.allowMentions ? "scheduledByPings" : "scheduledBy", { name: message.createdByName ?? message.createdBy }),
    ),
  );
}

async function showScheduled(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const channels = postableChannels(data);
  const list = h("ul", { class: "scheduled-list" });
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted" }, t("scheduledNone"));
  const channel = picker({ id: "scheduledChannel", options: channels, value: "", emptyLabel: t("scheduledPickChannel") });
  channel.required = true;
  const when = h("input", { id: "scheduledAt", type: "datetime-local", required: true, value: localDateTime(Date.now() + HOUR_MS) });
  const repeat = h(
    "select",
    { id: "scheduledRepeat" },
    REPEATS.map((entry, index) => h("option", { value: String(index) }, t(entry.key))),
  );
  const content = h("textarea", {
    id: "scheduledContent",
    rows: 4,
    required: true,
    maxLength: MAX_SCHEDULED_LENGTH,
    placeholder: t("scheduledContentPlaceholder"),
  });
  const submit = h("button", { class: "primary", type: "submit" }, t("scheduledAdd"));

  const load = async () => {
    const result = await api(`/api/guilds/${guildId}/scheduled`);
    list.replaceChildren(...result.messages.map((message) => scheduledRow(guildId, message, data.channels, () => load().catch(failed))));
    count.textContent = t("tagsCount", { count: result.messages.length, max: result.max });
    empty.hidden = result.messages.length > 0;
    submit.disabled = result.messages.length >= result.max;
  };

  const form = h(
    "form",
    {
      class: "scheduled-form",
      onsubmit: async (event) => {
        event.preventDefault();
        const at = new Date(when.value).getTime();
        if (!Number.isFinite(at) || at <= Date.now()) {
          toast(t("scheduledPast"));
          return;
        }
        submit.disabled = true;
        try {
          await api(`/api/guilds/${guildId}/scheduled`, {
            method: "POST",
            body: { channelId: channel.value, content: content.value, at, intervalMs: REPEATS[Number(repeat.value)].ms },
          });
          content.value = "";
          toast(t("scheduledAdded"));
          await load();
        } catch (error) {
          failed(error);
        } finally {
          submit.disabled = false;
        }
      },
    },
    h(
      "div",
      { class: "grid-2" },
      field("scheduledChannel", null, channel),
      field("scheduledWhen", "scheduledWhenHelp", when),
      field("scheduledRepeat", null, repeat),
    ),
    field("scheduledContent", "scheduledContentHelp", content),
    h("div", { class: "toolbar scheduled-actions" }, submit),
  );

  show(
    guildLayout(
      data,
      "scheduled",
      pageHero("scheduled", t("scheduledIntro"), data),
      card(t("scheduledNew"), "edit", "blue", form),
      card(t("scheduledUpcoming"), "calendar", "blue", h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("scheduledHelp")), count), empty, list),
    ),
  );
  await load();
}

// --- Leveling ------------------------------------------------------------------------

// One reward: a level, a role and a remove button.
function rewardRow(reward, roles, onRemove) {
  const row = h(
    "div",
    { class: "reward-row" },
    h("span", { class: "muted" }, t("levelsRewardAt")),
    h("input", {
      class: "reward-level",
      type: "number",
      min: 1,
      max: MAX_LEVEL,
      step: 1,
      required: true,
      value: reward.level ?? "",
      "aria-label": t("levelsRewardLevel"),
    }),
    h(
      "span",
      { class: "reward-role grow" },
      picker({ id: undefined, options: roles, value: reward.roleId ?? "", emptyLabel: t("levelsRewardPickRole") }),
    ),
    h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
  );
  return row;
}

// One role XP boost: a role, a multiplier and a remove button.
function boostRow(boost, roles, onRemove) {
  const row = h(
    "div",
    { class: "boost-row" },
    h("span", { class: "grow" }, picker({ id: undefined, options: roles, value: boost.roleId ?? "", emptyLabel: t("levelsRewardPickRole") })),
    h("span", { class: "muted", "aria-hidden": "true" }, "×"),
    h("input", {
      class: "boost-multiplier",
      type: "number",
      min: 1.1,
      max: MAX_MULTIPLIER,
      step: 0.1,
      required: true,
      value: boost.multiplier ?? 2,
      "aria-label": t("levelsBoostMultiplier"),
    }),
    h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
  );
  return row;
}

// Reads the leveling settings back from the page. Bad rows are sent as typed so the server explains.
function readLeveling(form, saved) {
  const announce = form.querySelector("#levelsAnnounce").value;
  return {
    ...saved,
    enabled: form.querySelector("#levelsEnabled").checked,
    announce,
    announceChannelId: announce === "channel" ? form.querySelector("#levelsChannel").value || null : null,
    message: form.querySelector("#levelsMessage").value.replace(/\r\n?/g, "\n").trim() || null,
    stackRewards: form.querySelector("#levelsStack").checked,
    rewards: [...form.querySelectorAll(".reward-row")]
      .map((row) => ({ level: Number(row.querySelector(".reward-level").value), roleId: row.querySelector("select").value }))
      .filter((reward) => reward.level || reward.roleId)
      .sort((a, b) => a.level - b.level),
    noXpChannelIds: [...form.querySelectorAll('input[name="noXpChannel"]:checked')].map((box) => box.value),
    noXpRoleIds: [...form.querySelectorAll('input[name="noXpRole"]:checked')].map((box) => box.value),
    voiceXp: form.querySelector("#levelsVoice").checked,
    boosterMultiplier: Number(form.querySelector("#levelsBooster").value) || 1,
    roleMultipliers: [...form.querySelectorAll(".boost-row")]
      .map((row) => ({ roleId: row.querySelector("select").value, multiplier: Number(row.querySelector(".boost-multiplier").value) }))
      .filter((boost) => boost.roleId)
      .sort((a, b) => b.multiplier - a.multiplier),
  };
}

// The XP leaderboard, a page at a time, below the settings.
async function leaderboardCard(guildId, page) {
  const board = await api(`/api/guilds/${guildId}/levels?page=${page}`);
  const pages = Math.max(1, Math.ceil(board.total / board.pageSize));
  const go = (next) => `#/g/${guildId}/levels${next > 1 ? `?page=${next}` : ""}`;
  const rows =
    board.entries.length === 0
      ? h("p", { class: "muted empty" }, t("levelsBoardEmpty"))
      : h(
          "ol",
          { class: "leaderboard" },
          board.entries.map((entry) =>
            h(
              "li",
              {},
              h("span", { class: `rank rank-${entry.rank}` }, formatNumber(entry.rank)),
              h(
                "a",
                { class: "board-name grow", href: memberLink(guildId, entry.userId) },
                h("strong", {}, entry.userTag ?? entry.userId),
                h("span", { class: "muted" }, t("levelsBoardSub", { xp: formatNumber(entry.xp), messages: formatNumber(entry.messages) })),
              ),
              h("span", { class: "progress board-progress", title: `${formatNumber(entry.current)} / ${formatNumber(entry.needed)} XP` }, fillBar("progress-fill", entry.current / entry.needed)),
              h("span", { class: "badge badge-green" }, t("levelsLevel", { level: entry.level })),
            ),
          ),
        );
  return card(
    t("levelsBoard"),
    "trophy",
    "amber",
    h("p", { class: "help" }, t("levelsBoardHelp", { count: formatNumber(board.total) })),
    rows,
    pages > 1
      ? h(
          "div",
          { class: "toolbar pager" },
          board.page > 1 ? h("a", { class: "button ghost small", href: go(board.page - 1) }, icon("chevronLeft", "icon small"), t("levelsPrev")) : null,
          h("span", { class: "muted grow center" }, t("levelsPageOf", { page: board.page, pages })),
          board.page < pages ? h("a", { class: "button ghost small", href: go(board.page + 1) }, t("levelsNext"), icon("chevronRight", "icon small")) : null,
        )
      : null,
  );
}

async function showLevels(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const page = Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1);
  const config = data.settings.leveling;
  const defaults = data.communityDefaults ?? {};
  // Reward roles: the bot never hands out bot roles or Administrator / Manage Server.
  const givable = data.roles
    .filter((role) => !role.managed && (BigInt(role.permissions ?? 0) & AUTOROLE_FORBIDDEN) === 0n)
    .map((role) => ({ id: role.id, label: `@${role.name}` }));
  const roles = data.roles.filter((role) => !role.managed).map((role) => ({ id: role.id, label: role.name, dot: roleDot(role) }));
  const channels = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

  const channelField = field(
    "levelsChannel",
    null,
    picker({ id: "levelsChannel", options: postableChannels(data), value: config.announceChannelId, emptyLabel: t("levelsPickChannel") }),
  );
  const announce = h(
    "select",
    { id: "levelsAnnounce" },
    LEVEL_ANNOUNCE.map((mode) => h("option", { value: mode, selected: mode === config.announce }, t(`levelsAnnounce_${mode}`))),
  );
  const showChannel = () => {
    channelField.hidden = announce.value !== "channel";
  };
  announce.addEventListener("change", showChannel);
  showChannel();

  const list = h("div", { class: "reward-list" });
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted" }, t("levelsRewardsNone"));
  const update = () => {
    const rows = list.querySelectorAll(".reward-row").length;
    count.textContent = t("tagsCount", { count: rows, max: MAX_LEVEL_REWARDS });
    empty.hidden = rows > 0;
    addButton.disabled = rows >= MAX_LEVEL_REWARDS;
  };
  const remove = (row) => {
    row.remove();
    update();
    list.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const addButton = h(
    "button",
    {
      class: "primary small",
      type: "button",
      onclick: () => {
        const row = rewardRow({}, givable, remove);
        list.append(row);
        update();
        row.querySelector(".reward-level").focus();
      },
    },
    t("levelsRewardAdd"),
  );
  config.rewards.forEach((reward) => list.append(rewardRow(reward, givable, remove)));
  update();

  const toggle = (id, checked, labelKey, helpKey) =>
    h(
      "label",
      { class: "switch-card" },
      h("span", { class: "switch-text" }, h("strong", {}, t(labelKey)), h("span", { class: "help" }, t(helpKey))),
      h("span", { class: "switch" }, h("input", { id, type: "checkbox", role: "switch", checked, "aria-label": t(labelKey) })),
    );

  const boosts = editableList({
    items: config.roleMultipliers ?? [],
    max: MAX_ROLE_MULTIPLIERS,
    makeRow: (boost, removeBoost) => boostRow(boost ?? {}, roles.map((role) => ({ id: role.id, label: `@${role.label}` })), removeBoost),
    focus: "select",
    emptyKey: "levelsBoostsNone",
    addKey: "levelsBoostAdd",
  });

  const board = await leaderboardCard(guildId, page).catch((error) => {
    failed(error);
    return null;
  });

  settingsPage({
    data,
    pageId: "levels",
    intro: t("levelsIntro"),
    cards: [
      card(t("levelsMaster"), "trophy", "green", toggle("levelsEnabled", config.enabled, "levelsMaster", "levelsMasterHelp"), h("p", { class: "help" }, t("levelsHowXp"))),
      card(
        t("levelsAnnounceTitle"),
        "sparkles",
        "pink",
        h("div", { class: "rule-body" }, field("levelsAnnounce", null, announce), channelField),
        field(
          "levelsMessage",
          "levelsMessageHelp",
          messageBox("levelsMessage", config.message, defaults.levelUpMessage, MAX_LEVEL_MESSAGE_LENGTH),
        ),
      ),
      card(
        t("levelsRewardsTitle"),
        "gift",
        "amber",
        h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("levelsRewardsHelp")), count, addButton),
        empty,
        list,
        toggle("levelsStack", config.stackRewards, "levelsStack", "levelsStackHelp"),
      ),
      card(
        t("levelsExtrasTitle"),
        "mic",
        "purple",
        toggle("levelsVoice", config.voiceXp ?? false, "levelsVoice", "levelsVoiceHelp"),
        field(
          "levelsBooster",
          "levelsBoosterHelp",
          h("input", { id: "levelsBooster", type: "number", min: 1, max: MAX_MULTIPLIER, step: 0.1, required: true, value: config.boosterMultiplier ?? 1 }),
        ),
        h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("levelsBoostsHelp")), boosts.count, boosts.addButton),
        boosts.empty,
        boosts.list,
      ),
      card(
        t("levelsNoXpChannels"),
        "eyeOff",
        "gray",
        h("p", { class: "help" }, t("levelsNoXpChannelsHelp")),
        checkList({ name: "noXpChannel", items: channels, checked: config.noXpChannelIds, filterKey: "filterChannels" }),
      ),
      card(
        t("levelsNoXpRoles"),
        "tag",
        "purple",
        h("p", { class: "help" }, t("levelsNoXpRolesHelp")),
        checkList({ name: "noXpRole", items: roles, checked: config.noXpRoleIds, filterKey: "filterRoles" }),
      ),
    ],
    fields: { leveling: (form) => readLeveling(form, data.settings.leveling) },
    after: board,
  });
}

async function showCountry(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  settingsPage({
    data,
    pageId: "country",
    intro: t("countryIntro"),
    cards: [
      card(
        t("countryChannel"),
        "globe",
        "green",
        field(
          "countryChannel",
          "countryChannelHelp",
          picker({
            id: "countryChannelId",
            options: postableChannels(data),
            value: data.settings.countryChannelId,
            emptyLabel: t("anyChannel"),
          }),
        ),
      ),
    ],
    fields: { countryChannelId: selectValue("countryChannelId") },
  });
}

const hasPermission = (role, bit) => (BigInt(role.permissions) & (1n << bit)) !== 0n;

// Every role in a table, with a name filter and a kind filter.
function rolesTable(data) {
  const { settings } = data;
  const usedAs = (role) =>
    [
      role.id === settings.staffRoleId ? "usedStaff" : null,
      role.id === settings.modRoleId ? "usedMod" : null,
      (settings.dashboardRoleIds ?? []).includes(role.id) ? "usedDashboard" : null,
    ].filter(Boolean);

  const rows = data.roles.map((role) => {
    const admin = hasPermission(role, ADMINISTRATOR);
    const powers = admin ? [] : PERMISSIONS.filter((permission) => hasPermission(role, permission.bit));
    const used = usedAs(role);
    const row = h(
      "tr",
      {},
      h("td", { class: "role-name" }, roleDot(role), h("span", {}, role.emoji ? `${role.emoji} ${role.name}` : role.name)),
      h(
        "td",
        {},
        h(
          "div",
          { class: "badges" },
          role.managed ? h("span", { class: "badge badge-cyan" }, t("botRole")) : null,
          role.hoist ? h("span", { class: "badge" }, t("roleHoisted")) : null,
          admin ? h("span", { class: "badge badge-red" }, t("permAdmin")) : null,
          powers.map((permission) => h("span", { class: "badge badge-amber" }, t(permission.key))),
          !admin && powers.length === 0 && !role.managed ? h("span", { class: "muted" }, "—") : null,
        ),
      ),
      h("td", {}, h("div", { class: "badges" }, used.map((key) => h("span", { class: "badge badge-accent" }, t(key))))),
    );
    row.dataset.name = role.name.toLowerCase();
    row.dataset.kinds = [admin || powers.length > 0 ? "power" : "", role.managed ? "bot" : "", used.length > 0 ? "used" : ""].join(" ");
    return row;
  });

  const empty = h("tr", { hidden: true }, h("td", { colspan: 3, class: "muted empty" }, t("nothingMatches")));
  const shownCount = h("span", { class: "count-pill" });
  const search = h("input", { type: "search", class: "grow", placeholder: t("filterRoles"), "aria-label": t("filterRoles") });
  const kind = h(
    "select",
    { "aria-label": t("roleKind"), class: "auto" },
    ["all", "power", "bot", "used"].map((value) => h("option", { value }, t(`roleKind_${value}`))),
  );
  const filterRoles = () => {
    const text = search.value.trim().toLowerCase();
    let shown = 0;
    rows.forEach((row) => {
      row.hidden =
        (text !== "" && !row.dataset.name.includes(text)) ||
        (kind.value !== "all" && !row.dataset.kinds.split(" ").includes(kind.value));
      shown += row.hidden ? 0 : 1;
    });
    empty.hidden = shown > 0;
    shownCount.textContent = t("rolesShown", { shown, total: rows.length });
  };
  search.addEventListener("input", filterRoles);
  kind.addEventListener("change", filterRoles);
  filterRoles();

  return card(
    t("allRoles"),
    "tag",
    "blue",
    h("p", { class: "help" }, t("allRolesHelp")),
    h("div", { class: "toolbar" }, search, kind, shownCount),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "table roles" },
        h("thead", {}, h("tr", {}, ["roleColumn", "rolePowers", "roleUsedAs"].map((key) => h("th", { scope: "col" }, t(key))))),
        h("tbody", {}, rows, empty),
      ),
    ),
  );
}

async function showAccess(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const dashboardRoles = data.roles
    .filter((role) => !role.managed)
    .map((role) => ({ id: role.id, label: role.name, dot: roleDot(role) }));
  settingsPage({
    data,
    pageId: "access",
    intro: t("accessIntro"),
    cards: [
      card(
        t("dashboardAccess"),
        "key",
        "purple",
        h("p", { class: "help" }, t("dashboardAccessHelp")),
        checkList({ name: "dashboardRole", items: dashboardRoles, checked: data.settings.dashboardRoleIds ?? [], filterKey: "filterRoles" }),
      ),
    ],
    fields: { dashboardRoleIds: checkedList("dashboardRole") },
    after: rolesTable(data),
  });
}

// --- Overview ----------------------------------------------------------------

async function showOverview(guildId) {
  const [data, stats] = await Promise.all([
    loadGuild(guildId),
    api(`/api/guilds/${guildId}/stats?tz=${new Date().getTimezoneOffset()}`),
  ]);
  const { guild } = data;
  const casesLink = (params = {}) => {
    const query = new URLSearchParams(params);
    return `#/g/${guildId}/cases${query.size > 0 ? `?${query}` : ""}`;
  };

  const total = Object.values(stats.caseCounts).reduce((sum, count) => sum + count, 0);
  const casesSince = (firstDay) =>
    stats.perDay.filter((entry) => entry.day >= firstDay).reduce((sum, entry) => sum + entry.total, 0);
  const tiles = h(
    "div",
    { class: "stats" },
    tile(
      "users",
      "blue",
      guild.memberCount === null ? "—" : formatNumber(guild.memberCount),
      t("statMembers"),
      guild.onlineCount === null ? null : t("onlineCount", { count: formatNumber(guild.onlineCount) }),
    ),
    tile("folder", "pink", formatNumber(total), t("statCases"), null, casesLink()),
    tile("calendar", "amber", formatNumber(casesSince(stats.days - 7)), t("statWeek")),
    tile("calendar", "green", formatNumber(casesSince(0)), t("statMonth")),
    tile("clock", "red", formatNumber(stats.runningTempBans), t("statTempBans"), null, casesLink({ action: "ban" })),
  );

  // Cases per day, stacked by action. The legend chips show or hide actions.
  const hiddenActions = new Set();
  const chartBox = h("div", { class: "chart" });
  const drawChart = () => {
    const days = Array.from({ length: stats.days }, () => ({}));
    stats.perDay.forEach(({ day, action, total: count }) => {
      if (!hiddenActions.has(action) && days[day]) {
        days[day][action] = count;
      }
    });
    const totals = days.map((day) => Object.values(day).reduce((sum, count) => sum + count, 0));
    const max = Math.max(1, ...totals);
    const width = 10;
    const height = 100;
    const bars = days.map((day, index) => {
      let y = height;
      const actions = CASE_ACTIONS.filter((action) => day[action]);
      const segments = actions.map((action) => {
        const size = (day[action] / max) * (height - 4);
        y -= size;
        return svg("rect", {
          x: index * width + 1.5,
          y: y.toFixed(2),
          width: width - 3,
          height: size.toFixed(2),
          rx: 1.5,
          class: `seg act-${action}`,
        });
      });
      const summary =
        totals[index] === 0
          ? t("chartNoCases")
          : actions.map((action) => `${t(`action_${action}`)}: ${day[action]}`).join(", ");
      return svg(
        "g",
        { class: "bar" },
        svg("title", {}, `${formatDay(stats.dayStarts[index])} · ${summary}`),
        svg("rect", { x: index * width, y: 0, width, height, class: "bar-hit" }),
        segments,
      );
    });
    const grid = [0.25, 0.5, 0.75].map((fraction) =>
      svg("line", { x1: 0, x2: stats.days * width, y1: height * fraction, y2: height * fraction, class: "grid" }),
    );
    chartBox.replaceChildren(
      h("span", { class: "chart-max" }, formatNumber(max)),
      svg(
        "svg",
        { viewBox: `0 0 ${stats.days * width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": t("chartTitle") },
        grid,
        bars,
      ),
      h(
        "div",
        { class: "chart-axis" },
        h("span", {}, formatDay(stats.dayStarts[0])),
        h("span", {}, formatDay(stats.dayStarts[Math.floor(stats.days / 2)])),
        h("span", {}, t("today")),
      ),
    );
  };
  const chartActions = CASE_ACTIONS.filter((action) => stats.perDay.some((entry) => entry.action === action));
  const legend = h(
    "div",
    { class: "legend" },
    chartActions.map((action) =>
      h(
        "button",
        {
          type: "button",
          class: `legend-chip act-${action}`,
          "aria-pressed": "true",
          onclick: (event) => {
            const wasHidden = hiddenActions.has(action);
            if (wasHidden) {
              hiddenActions.delete(action);
            } else {
              hiddenActions.add(action);
            }
            event.currentTarget.setAttribute("aria-pressed", String(wasHidden));
            drawChart();
          },
        },
        h("span", { class: "legend-dot" }),
        t(`action_${action}`),
      ),
    ),
  );
  drawChart();

  // All-time cases per action.
  const maxCount = Math.max(1, ...Object.values(stats.caseCounts));
  const breakdown = CASE_ACTIONS.filter((action) => stats.caseCounts[action]).map((action) =>
    h(
      "a",
      { class: "meter-row", href: casesLink({ action }) },
      h("span", { class: "meter-label" }, t(`action_${action}`)),
      h("span", { class: "meter" }, fillBar(`meter-fill act-${action}`, stats.caseCounts[action] / maxCount)),
      h("span", { class: "meter-value" }, formatNumber(stats.caseCounts[action])),
    ),
  );

  const leaderboard = (people, param) =>
    people.length === 0
      ? h("p", { class: "muted empty" }, t("nothingYet"))
      : h(
          "ol",
          { class: "leaders" },
          people.map((somebody, index) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: param === "user" ? memberLink(guildId, somebody.id) : casesLink({ [param]: somebody.id }) },
                h("span", { class: `rank rank-${index + 1}` }, String(index + 1)),
                h("span", { class: "leader-name" }, somebody.tag ?? somebody.id),
                h("span", { class: "count-pill" }, formatNumber(somebody.total)),
              ),
            ),
          ),
        );

  const recent =
    stats.recent.length === 0
      ? h("p", { class: "muted empty" }, t("noCases"))
      : h(
          "ul",
          { class: "recent" },
          stats.recent.map((entry) =>
            h(
              "li",
              {},
              actionPill(entry),
              h(
                "span",
                { class: "recent-text" },
                h("strong", {}, entry.userTag ?? entry.userId),
                h("span", { class: "muted" }, entry.reason ?? t("noReason")),
              ),
              h("span", { class: "muted recent-date" }, `#${entry.number} · ${formatDay(entry.createdAt)}`),
            ),
          ),
        );

  show(
    guildLayout(
      data,
      "overview",
      hero(t("overviewTitle", { name: guild.name }), t(canManageGuild(data) ? "overviewIntro" : "overviewIntroCases"), "blue", { iconName: "home" }),
      tiles,
      canManageGuild(data) ? featuresCard(data) : null,
      canManageGuild(data) ? setupCard(data) : null,
      card(t("chartTitle"), "chart", "pink", legend, chartBox),
      h(
        "div",
        { class: "grid-2" },
        card(
          t("byAction"),
          "barChart",
          "amber",
          breakdown.length > 0 ? h("div", { class: "meters" }, breakdown) : h("p", { class: "muted empty" }, t("nothingYet")),
        ),
        card(t("recentCases"), "clock", "blue", recent, h("a", { class: "button ghost small", href: casesLink() }, t("allCases"))),
        card(t("topModerators"), "trophy", "green", leaderboard(stats.topModerators, "moderator")),
        card(t("topMembers"), "alert", "red", leaderboard(stats.topMembers, "user")),
      ),
    ),
  );
}

// Every feature with an on/off state, linking to its page.
function featuresCard(data) {
  const features = PAGES.filter((page) => page.on);
  const onCount = features.filter((page) => page.on(data.settings)).length;
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "toolbar" },
      h("h2", { class: "card-title grow" }, iconChip("zap", "purple"), t("featuresTitle")),
      h("span", { class: "count-pill" }, t("featuresOn", { count: onCount, total: features.length })),
    ),
    h(
      "div",
      { class: "feature-grid" },
      features.map((page) => {
        const on = page.on(data.settings);
        return h(
          "a",
          { class: `feature${on ? " on" : ""}`, href: `#/g/${data.guild.id}/${page.id}` },
          iconChip(page.icon, page.tone, "sm"),
          h("span", { class: "grow" }, t(`page_${page.id}`)),
          h("span", { class: `status ${on ? "on" : "off"}` }, t(on ? "featureOn" : "featureOff")),
        );
      }),
    ),
  );
}

// What's set up and what isn't, with links to fix it. Hidden once everything is done.
function setupCard(data) {
  const { settings, guild } = data;
  const steps = [
    { key: "setupLogs", done: Boolean(settings.logsChannelId), page: "logging" },
    { key: "setupServerLog", done: Boolean(settings.serverLogChannelId), page: "logging" },
    { key: "setupModLog", done: Boolean(settings.modLogChannelId || settings.logsChannelId), page: "moderation" },
    { key: "setupModRole", done: Boolean(settings.modRoleId), page: "moderation" },
    { key: "setupCountry", done: Boolean(settings.countryChannelId), page: "country" },
    { key: "setupDashboard", done: (settings.dashboardRoleIds ?? []).length > 0, page: "access" },
    { key: "setupAutomod", done: Boolean(settings.automod?.enabled), page: "automod" },
    { key: "setupWelcome", done: Boolean(settings.welcomeChannelId), page: "welcome" },
  ];
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) {
    return null;
  }
  return h(
    "section",
    { class: "card setup" },
    h(
      "div",
      { class: "toolbar" },
      h("h2", { class: "card-title grow" }, iconChip("check", "green"), t("setupTitle")),
      h("span", { class: "count-pill" }, t("setupProgress", { done, total: steps.length })),
    ),
    h("div", { class: "progress" }, fillBar("progress-fill", done / steps.length)),
    h(
      "ul",
      { class: "steps" },
      steps.map((step) =>
        h(
          "li",
          { class: step.done ? "done" : "" },
          h("span", { class: "step-mark", "aria-hidden": "true" }, step.done ? icon("check", "icon tiny") : null),
          h("span", { class: "grow" }, t(step.key)),
          step.done
            ? h("span", { class: "muted" }, t("setupDone"))
            : h("a", { class: "button ghost small", href: `#/g/${guild.id}/${step.page}` }, t("setupFix")),
        ),
      ),
    ),
  );
}

// --- Cases -------------------------------------------------------------------

const actionLabel = (entry) =>
  entry.action === "ban" && entry.durationMs ? t("action_tempban") : t(`action_${entry.action}`);
const actionPill = (entry) => h("span", { class: `pill act-${entry.action}` }, actionLabel(entry));

// "2026-10-16" → when that day starts in the viewer's time zone.
function dayToMs(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : undefined;
}

function nextDay(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

const NO_FILTERS = { q: "", actions: [], user: "", moderator: "", from: "", to: "" };

// The filters as the address shows them (dates as days).
function filtersToHash(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.actions.length > 0) params.set("action", filters.actions.join(","));
  for (const key of ["user", "moderator", "from", "to"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return params;
}

// The filters as the API wants them (dates as times; "to" includes that day).
function filtersToApi(filters, { before } = {}) {
  const params = filtersToHash({ ...filters, from: "", to: "" });
  const from = dayToMs(filters.from);
  const to = dayToMs(filters.to);
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(nextDay(to)));
  if (before) params.set("before", String(before));
  return params;
}

async function showCases(guildId) {
  const data = await loadGuild(guildId);
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const filters = {
    q: query.get("q") ?? "",
    actions: (query.get("action") ?? "").split(",").filter((action) => CASE_ACTIONS.includes(action)),
    user: query.get("user") ?? "",
    moderator: query.get("moderator") ?? "",
    from: query.get("from") ?? "",
    to: query.get("to") ?? "",
  };
  // Changing the address reloads the list.
  const apply = (next) => {
    const params = filtersToHash(next);
    location.hash = `#/g/${guildId}/cases${params.size > 0 ? `?${params}` : ""}`;
  };

  const rows = h("tbody");
  const more = h("button", { class: "ghost", type: "button", hidden: true }, t("loadMore"));
  const resultCount = h("span", { class: "count-pill" });
  let nextBefore = null;

  async function loadPage() {
    const page = await api(`/api/guilds/${guildId}/cases?${filtersToApi(filters, { before: nextBefore })}`);
    rows.append(...page.cases.map((entry) => caseRow(guildId, entry, filters, apply)));
    if (rows.childElementCount === 0) {
      rows.append(h("tr", {}, h("td", { colspan: 7, class: "muted empty" }, t("noCases"))));
    }
    if (page.total !== null) {
      resultCount.textContent = t("casesFound", { count: formatNumber(page.total) });
    }
    nextBefore = page.nextBefore;
    more.hidden = !nextBefore;
  }
  more.addEventListener("click", () => loadPage().catch(failed));

  // The filter panel.
  const textInput = h("input", {
    type: "search",
    class: "grow",
    placeholder: t("filterText"),
    value: filters.q,
    "aria-label": t("filterText"),
    maxLength: 100,
  });
  const actionChips = CASE_ACTIONS.map((action) =>
    h(
      "button",
      {
        type: "button",
        class: `legend-chip act-${action}`,
        "aria-pressed": String(filters.actions.includes(action)),
        "data-action": action,
        onclick: (event) => {
          const chip = event.currentTarget;
          chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
        },
      },
      h("span", { class: "legend-dot" }),
      t(`action_${action}`),
    ),
  );
  const idInput = (value, key) =>
    h("input", { type: "search", inputmode: "numeric", pattern: "\\d{17,20}", placeholder: t("pasteId"), value, "aria-label": t(key) });
  const userInput = idInput(filters.user, "filterUser");
  const moderatorInput = idInput(filters.moderator, "filterModerator");
  const fromInput = h("input", { type: "date", value: filters.from });
  const toInput = h("input", { type: "date", value: filters.to });

  const filterForm = h(
    "form",
    {
      class: "card filter-panel",
      onsubmit: (event) => {
        event.preventDefault();
        apply({
          q: textInput.value.trim(),
          actions: actionChips.filter((chip) => chip.getAttribute("aria-pressed") === "true").map((chip) => chip.dataset.action),
          user: userInput.value.trim(),
          moderator: moderatorInput.value.trim(),
          from: fromInput.value,
          to: toInput.value,
        });
      },
    },
    h("div", { class: "toolbar" }, textInput, h("button", { class: "primary", type: "submit" }, icon("search", "icon small"), t("search"))),
    h("div", { class: "legend" }, actionChips),
    h(
      "details",
      { class: "more-filters", open: Boolean(filters.user || filters.moderator || filters.from || filters.to) },
      h("summary", {}, t("moreFilters")),
      h(
        "div",
        { class: "filter-grid" },
        field("filterUser", null, userInput),
        field("filterModerator", null, moderatorInput),
        field("filterFrom", null, fromInput),
        field("filterTo", null, toInput),
      ),
    ),
  );

  // A chip for each filter in use; clicking one removes it.
  const activeChips = [
    filters.q ? [`“${filters.q}”`, { q: "" }] : null,
    ...filters.actions.map((action) => [t(`action_${action}`), { actions: filters.actions.filter((other) => other !== action) }]),
    filters.user ? [`${t("filterUser")}: ${filters.user}`, { user: "" }] : null,
    filters.moderator ? [`${t("filterModerator")}: ${filters.moderator}`, { moderator: "" }] : null,
    filters.from ? [`${t("filterFrom")}: ${filters.from}`, { from: "" }] : null,
    filters.to ? [`${t("filterTo")}: ${filters.to}`, { to: "" }] : null,
  ].filter(Boolean);
  const active = h(
    "div",
    { class: "active-filters" },
    resultCount,
    activeChips.map(([label, change]) =>
      h(
        "button",
        { type: "button", class: "filter-chip", title: t("removeFilter"), onclick: () => apply({ ...filters, ...change }) },
        label,
        icon("x", "icon tiny"),
      ),
    ),
    activeChips.length > 1
      ? h("button", { type: "button", class: "link-button", onclick: () => apply(NO_FILTERS) }, t("clearFilters"))
      : null,
    h(
      "a",
      {
        class: "button ghost small push-end",
        href: `/api/guilds/${guildId}/cases/export?${filtersToApi(filters)}`,
        download: `cases-${guildId}.csv`,
      },
      icon("download", "icon small"), t("exportCsv"),
    ),
  );

  show(
    guildLayout(
      data,
      "cases",
      pageHero("cases", t("casesIntro"), data),
      filterForm,
      active,
      h(
        "div",
        { class: "card table-wrap flush" },
        h(
          "table",
          { class: "table cases" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ["caseNumber", "caseAction", "caseUser", "caseModerator", "caseReason", "caseDate", ""].map((key) =>
                h("th", { scope: "col" }, key ? t(key) : ""),
              ),
            ),
          ),
          rows,
        ),
      ),
      h("div", { class: "actions" }, more),
    ),
  );
  await loadPage();
}

// A name with its user ID underneath; clicking it shows only their cases.
// ID "0" is an unknown moderator.
function person(id, tag, onPick) {
  if (id === "0") {
    return h("span", {}, tag ?? t("unknown"));
  }
  return h(
    "button",
    { type: "button", class: "person-button", title: t("showTheirCases"), onclick: onPick },
    h("span", { class: "name" }, tag ?? id),
    tag ? h("span", { class: "id" }, id) : null,
  );
}

function caseRow(guildId, entry, filters, apply) {
  const reasonCell = h("td", { class: "reason" }, entry.reason ?? h("em", { class: "muted" }, t("noReason")));
  const duration = entry.durationMs ? h("span", { class: "duration" }, icon("clock", "icon tiny"), formatDuration(entry.durationMs)) : null;
  const row = h(
    "tr",
    { class: `act-row act-${entry.action}` },
    h("td", { class: "number" }, `#${entry.number}`),
    h("td", {}, h("div", { class: "action-cell" }, actionPill(entry), duration)),
    h(
      "td",
      { class: "person" },
      person(entry.userId, entry.userTag, () => apply({ ...filters, user: entry.userId })),
      h("a", { class: "history-link", href: memberLink(guildId, entry.userId) }, t("memberHistory")),
    ),
    h(
      "td",
      { class: "person" },
      person(entry.moderatorId, entry.moderatorTag, () => apply({ ...filters, moderator: entry.moderatorId })),
    ),
    reasonCell,
    h("td", { class: "date" }, formatDate(entry.createdAt)),
    h(
      "td",
      {},
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "ghost small", type: "button", onclick: () => editReason(guildId, entry, reasonCell) }, t("editReason")),
        h("button", { class: "danger small", type: "button", onclick: () => deleteCase(guildId, entry, row) }, t("delete")),
      ),
    ),
  );
  return row;
}

function editReason(guildId, entry, cell) {
  const input = h("textarea", { maxLength: 512, rows: 3 }, entry.reason ?? "");
  const dialog = h(
    "dialog",
    { class: "card" },
    h(
      "form",
      {
        method: "dialog",
        onsubmit: async (event) => {
          if (event.submitter?.value !== "save") {
            return;
          }
          event.preventDefault();
          try {
            const result = await api(`/api/guilds/${guildId}/cases/${entry.number}`, {
              method: "PATCH",
              body: { reason: input.value },
            });
            Object.assign(entry, result.case);
            cell.replaceChildren(entry.reason ?? h("em", { class: "muted" }, t("noReason")));
            toast(t("reasonSaved", { number: entry.number }));
            dialog.close();
          } catch (error) {
            failed(error);
          }
        },
      },
      h("h2", {}, t("editReasonTitle", { number: entry.number })),
      input,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "ghost", value: "cancel" }, t("cancel")),
        h("button", { class: "primary", value: "save" }, t("save")),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

async function deleteCase(guildId, entry, row) {
  if (!confirm(t("deleteConfirm", { number: entry.number }))) {
    return;
  }
  try {
    await api(`/api/guilds/${guildId}/cases/${entry.number}`, { method: "DELETE" });
    row.remove();
    toast(t("caseDeleted", { number: entry.number }));
  } catch (error) {
    failed(error);
  }
}

// --- Members -----------------------------------------------------------------

const memberLink = (guildId, userId) => `#/g/${guildId}/members?user=${userId}`;
// Accounts younger than this get a warning, like the server log's join message.
const NEW_ACCOUNT_DAYS = 7;

// Someone's avatar, or their initials when they have none.
function personAvatar(user, size = "md") {
  const url = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
  const name = user.displayName ?? user.username ?? "?";
  return url
    ? h("img", { class: `member-avatar ${size}`, src: url, alt: "" })
    : h("span", { class: `member-avatar ${size} placeholder`, "aria-hidden": "true" }, initials(name).slice(0, 2));
}

// "3 days ago", "2 years ago".
function formatAgo(ms) {
  const units = [
    ["year", 365 * DAY_MS],
    ["month", 30 * DAY_MS],
    ["day", DAY_MS],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const elapsed = Date.now() - ms;
  const [unit, size] = units.find(([, length]) => elapsed >= length) ?? units.at(-1);
  return new Intl.RelativeTimeFormat(state.language, { numeric: "auto" }).format(-Math.floor(elapsed / size), unit);
}

async function showMembers(guildId) {
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const userId = query.get("user");
  if (userId && /^\d{17,20}$/.test(userId)) {
    return showMemberHistory(guildId, userId);
  }
  const data = await loadGuild(guildId);
  const text = (query.get("q") ?? "").trim();
  const input = h("input", {
    type: "search",
    class: "grow",
    placeholder: t("memberSearchPlaceholder"),
    value: text,
    "aria-label": t("memberSearchPlaceholder"),
    maxLength: 32,
  });
  const results = h("div", { class: "member-results" });
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: (event) => {
        event.preventDefault();
        const next = input.value.trim();
        if (/^\d{17,20}$/.test(next)) {
          location.hash = memberLink(guildId, next);
        } else {
          location.hash = `#/g/${guildId}/members${next ? `?q=${encodeURIComponent(next)}` : ""}`;
        }
      },
    },
    h("div", { class: "toolbar" }, input, h("button", { class: "primary", type: "submit" }, icon("search", "icon small"), t("search"))),
    h("p", { class: "help" }, t("memberSearchHelp")),
  );
  show(guildLayout(data, "members", pageHero("members", t("membersIntro"), data), form, results));
  input.focus();
  if (!text) {
    return;
  }
  const { members } = await api(`/api/guilds/${guildId}/members?q=${encodeURIComponent(text)}`);
  results.replaceChildren(
    members.length === 0
      ? h("p", { class: "muted empty" }, t("memberSearchNone"))
      : h(
          "ul",
          { class: "card member-list flush" },
          members.map((member) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: memberLink(guildId, member.id) },
                personAvatar(member),
                h(
                  "span",
                  { class: "member-names" },
                  h("strong", {}, member.displayName),
                  h("span", { class: "muted" }, `@${member.username} · ${member.id}`),
                ),
                member.bot ? h("span", { class: "badge badge-accent" }, t("memberBot")) : null,
                member.inServer ? null : h("span", { class: "badge" }, t("memberNotInServer")),
              ),
            ),
          ),
        ),
  );
}

async function showMemberHistory(guildId, userId) {
  const [data, history] = await Promise.all([loadGuild(guildId), api(`/api/guilds/${guildId}/members/${userId}`)]);
  const { user, member } = history;
  const casesLink = `#/g/${guildId}/cases?user=${userId}`;
  const accountAgeDays = (Date.now() - user.createdAt) / DAY_MS;

  // Where they stand right now.
  const status = [];
  if (member) {
    status.push(h("span", { class: "badge badge-cyan" }, t("memberInServer")));
  } else if (history.banned) {
    status.push(h("span", { class: "badge badge-red" }, t("memberBanned")));
  } else {
    status.push(h("span", { class: "badge" }, t("memberNotInServer")));
  }
  if (history.tempBanEndsAt) {
    status.push(h("span", { class: "badge badge-red" }, t("memberTempBanEnds", { date: formatDate(history.tempBanEndsAt) })));
  }
  if (member?.timedOutUntil) {
    status.push(h("span", { class: "badge badge-amber" }, t("memberTimedOutUntil", { date: formatDate(member.timedOutUntil) })));
  }
  for (const entry of history.tempRoles ?? []) {
    status.push(
      h("span", { class: "badge badge-accent" }, icon("clock", "icon tiny"), t("memberTempRole", { role: `@${entry.roleName ?? entry.roleId}`, date: formatDate(entry.expiresAt) })),
    );
  }
  if (history.quarantine) {
    status.push(h("span", { class: "badge badge-amber" }, icon("lock", "icon tiny"), t("memberQuarantined", { date: formatDate(history.quarantine.since) })));
  }
  if (user.bot) {
    status.push(h("span", { class: "badge badge-accent" }, t("memberBot")));
  }
  if (accountAgeDays < NEW_ACCOUNT_DAYS) {
    status.push(h("span", { class: "badge badge-amber" }, icon("alert", "icon tiny"), t("memberNewAccount")));
  }

  const header = h(
    "section",
    { class: "card member-header" },
    personAvatar(user, "lg"),
    h(
      "div",
      { class: "member-names" },
      h("h1", {}, user.displayName ?? user.id),
      h("span", { class: "muted" }, [user.username ? `@${user.username}` : null, user.id].filter(Boolean).join(" · ")),
      h("div", { class: "badges" }, status),
    ),
    h(
      "button",
      {
        class: "ghost small push-end",
        type: "button",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(user.id);
            toast(t("memberIdCopied"));
          } catch {
            toast(user.id);
          }
        },
      },
      icon("copy", "icon small"), t("memberCopyId"),
    ),
  );

  const totalCases = Object.values(history.caseCounts).reduce((sum, count) => sum + count, 0);
  const tiles = h(
    "div",
    { class: "stats" },
    tile("cake", "blue", formatAgo(user.createdAt), t("memberAccountCreated"), formatDate(user.createdAt)),
    tile(
      "userPlus",
      "green",
      member?.joinedAt ? formatAgo(member.joinedAt) : "—",
      t("memberJoinedServer"),
      member?.joinedAt ? formatDate(member.joinedAt) : t("memberNotInServer"),
    ),
    tile("repeat", "amber", formatNumber(history.joins), t("memberTimesJoined"), t("memberTimesJoinedSub")),
    tile("folder", "pink", formatNumber(totalCases), t("statCases"), null, totalCases > 0 ? casesLink : undefined),
    history.level
      ? tile(
          "trophy",
          "purple",
          t("levelsLevel", { level: history.level.level }),
          t("memberLevel"),
          t("memberLevelSub", { rank: formatNumber(history.level.rank), xp: formatNumber(history.level.xp) }),
          canManageGuild(data) ? `#/g/${guildId}/levels` : undefined,
        )
      : null,
  );

  const summary = CASE_ACTIONS.filter((action) => history.caseCounts[action]).map((action) =>
    h("span", { class: `pill act-${action}` }, `${t(`action_${action}`)} · ${formatNumber(history.caseCounts[action])}`),
  );
  const caseList =
    history.cases.length === 0
      ? h("p", { class: "muted empty" }, t("memberNoCases"))
      : h(
          "ul",
          { class: "timeline" },
          history.cases.map((entry) =>
            h(
              "li",
              { class: `act-${entry.action}` },
              h("span", { class: "timeline-dot", "aria-hidden": "true" }),
              h(
                "div",
                { class: "timeline-body" },
                h(
                  "div",
                  { class: "timeline-head" },
                  actionPill(entry),
                  entry.durationMs ? h("span", { class: "duration" }, icon("clock", "icon tiny"), formatDuration(entry.durationMs)) : null,
                  h("span", { class: "muted" }, `#${entry.number} · ${formatDate(entry.createdAt)}`),
                ),
                h("p", { class: "timeline-reason" }, entry.reason ?? h("em", { class: "muted" }, t("noReason"))),
                h(
                  "span",
                  { class: "muted timeline-by" },
                  t("memberCaseBy", { name: entry.moderatorId === "0" ? t("unknown") : (entry.moderatorTag ?? entry.moderatorId) }),
                ),
              ),
            ),
          ),
        );

  const roles =
    member && member.roles.length > 0
      ? h(
          "div",
          { class: "role-chips" },
          member.roles.map((role) => h("span", { class: "role-chip" }, roleDot(role), role.name)),
        )
      : h("p", { class: "muted empty" }, t(member ? "memberNoRoles" : "memberNotInServer"));

  const events =
    history.events.length === 0
      ? h("p", { class: "muted empty" }, t("memberNoEvents"))
      : h(
          "ul",
          { class: "recent" },
          history.events.map((event) =>
            h(
              "li",
              {},
              h("span", { class: `badge ${event.kind === "join" ? "badge-cyan" : ""}` }, t(`memberEvent_${event.kind}`)),
              h("span", { class: "recent-text" }, formatDate(event.at)),
              h("span", { class: "muted recent-date" }, formatAgo(event.at)),
            ),
          ),
        );

  const ticketList =
    history.tickets.length === 0
      ? h("p", { class: "muted empty" }, t("memberNoTickets"))
      : h(
          "ul",
          { class: "recent" },
          history.tickets.map((ticket) =>
            h(
              "li",
              {},
              h("span", { class: `badge ${ticket.closedAt ? "" : "badge-cyan"}` }, t(ticket.closedAt ? "memberTicketClosed" : "memberTicketOpen")),
              h(
                "span",
                { class: "recent-text" },
                h("a", { href: ticketLink(guildId, ticket.number) }, `#${ticket.number}`),
                h("span", { class: "muted" }, ticket.subject),
              ),
              h("span", { class: "muted recent-date" }, formatDay(ticket.createdAt)),
            ),
          ),
        );

  show(
    guildLayout(
      data,
      "members",
      h("a", { class: "back", href: `#/g/${guildId}/members` }, t("memberBackToSearch")),
      header,
      history.banned?.reason ? h("p", { class: "tip danger" }, t("memberBanReason", { reason: history.banned.reason })) : null,
      history.quarantine
        ? h(
            "p",
            { class: "tip" },
            icon("lock"),
            h(
              "span",
              {},
              t("memberQuarantineInfo", { count: history.quarantine.roleIds.length }),
              history.quarantine.reason ? ` ${t("memberQuarantineReason", { reason: history.quarantine.reason })}` : "",
            ),
          )
        : null,
      tiles,
      h(
        "div",
        { class: "grid-2 member-grid" },
        card(
          t("memberCases"),
          "folder",
          "pink",
          summary.length > 0 ? h("div", { class: "badges member-summary" }, summary) : null,
          caseList,
          totalCases > history.cases.length ? h("p", { class: "help" }, t("memberMoreCases", { count: formatNumber(history.cases.length) })) : null,
          totalCases > 0 ? h("a", { class: "button ghost small", href: casesLink }, t("memberOpenInCases")) : null,
        ),
        h(
          "div",
          { class: "stack" },
          card(t("memberRoles"), "layers", "purple", roles),
          card(t("memberTickets"), "ticket", "blue", ticketList),
          card(t("memberJoinsLeaves"), "logout", "green", events, h("p", { class: "help" }, t("memberJoinsLeavesHelp"))),
        ),
      ),
    ),
  );
}

// --- Tickets -----------------------------------------------------------------------

const ticketLink = (guildId, number) => `#/g/${guildId}/tickets?ticket=${number}`;
const TICKET_STATUSES = ["open", "closed", "all"];

function ticketBadge(ticket) {
  return h("span", { class: `badge ${ticket.closedAt ? "" : "badge-cyan"}` }, t(ticket.closedAt ? "memberTicketClosed" : "memberTicketOpen"));
}

// A person on a ticket: their name (or ID), linking to their history.
const ticketPerson = (guildId, id, name) => (id ? h("a", { href: memberLink(guildId, id) }, name ?? id) : h("span", { class: "muted" }, "—"));

function ticketRow(guildId, ticket) {
  return h(
    "li",
    {},
    h(
      "a",
      { class: "ticket-row", href: ticketLink(guildId, ticket.number) },
      h("strong", { class: "ticket-number" }, `#${ticket.number}`),
      h(
        "span",
        { class: "ticket-main" },
        h("span", { class: "ticket-subject" }, ticket.subject),
        h(
          "span",
          { class: "muted" },
          [ticket.userName ?? ticket.userId, formatDate(ticket.createdAt), ticket.hasTranscript ? t("ticketsMessages", { count: formatNumber(ticket.messageCount ?? 0) }) : null]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
      ticketBadge(ticket),
    ),
  );
}

async function showTicketList(guildId, data, query) {
  const status = TICKET_STATUSES.includes(query.get("status")) ? query.get("status") : "all";
  const userId = /^\d{17,20}$/.test(query.get("user") ?? "") ? query.get("user") : "";
  const go = (changes) => {
    const next = new URLSearchParams({ status, user: userId, ...changes });
    [...next.entries()].forEach(([key, value]) => (value === "" || (key === "status" && value === "all")) && next.delete(key));
    location.hash = `#/g/${guildId}/tickets${next.size > 0 ? `?${next}` : ""}`;
  };
  const userInput = h("input", {
    type: "search",
    class: "grow",
    value: userId,
    inputMode: "numeric",
    placeholder: t("ticketsUserPlaceholder"),
    "aria-label": t("ticketsUserPlaceholder"),
  });
  const filters = h(
    "form",
    {
      class: "card toolbar ticket-filters",
      onsubmit: (event) => {
        event.preventDefault();
        go({ user: userInput.value.trim() });
      },
    },
    segmented(
      t("ticketsStatus"),
      TICKET_STATUSES.map((value) => ({ value, text: t(`ticketsStatus_${value}`) })),
      status,
      (value) => go({ status: value }),
    ),
    userInput,
    h("button", { class: "primary", type: "submit" }, icon("search", "icon small"), t("search")),
  );
  const list = h("ul", { class: "ticket-list" });
  const more = h("button", { class: "ghost", type: "button", hidden: true }, t("loadMore"));
  const summary = h("p", { class: "help" });
  const empty = h("p", { class: "muted empty", hidden: true }, t("ticketsNone"));
  let before = null;
  const load = async () => {
    more.disabled = true;
    const params = new URLSearchParams({ status });
    if (userId) {
      params.set("user", userId);
    }
    if (before) {
      params.set("before", before);
    }
    const page = await api(`/api/guilds/${guildId}/tickets?${params}`);
    list.append(...page.tickets.map((ticket) => ticketRow(guildId, ticket)));
    summary.textContent = t(page.panel ? "ticketsSummary" : "ticketsSummaryNoPanel", { count: formatNumber(page.openCount) });
    empty.hidden = list.children.length > 0;
    before = page.next;
    more.hidden = !page.next;
    more.disabled = false;
  };
  more.addEventListener("click", () => load().catch(failed));
  show(
    guildLayout(
      data,
      "tickets",
      pageHero("tickets", t("ticketsIntro"), data),
      filters,
      card(t("page_tickets"), "ticket", "cyan", summary, empty, list, h("div", { class: "center" }, more)),
    ),
  );
  await load();
}

async function showTicket(guildId, data, number) {
  const { ticket, transcript } = await api(`/api/guilds/${guildId}/tickets/${number}`);
  const facts = [
    [t("ticketsOpenedBy"), ticketPerson(guildId, ticket.userId, ticket.userName)],
    [t("ticketsOpened"), formatDate(ticket.createdAt)],
    ticket.closedAt ? [t("ticketsClosedBy"), ticketPerson(guildId, ticket.closedBy, ticket.closedByName)] : null,
    ticket.closedAt ? [t("ticketsClosed"), formatDate(ticket.closedAt)] : null,
    ticket.closeReason ? [t("ticketsReason"), ticket.closeReason] : null,
  ].filter(Boolean);
  const actions = h(
    "div",
    { class: "toolbar" },
    ticket.threadId
      ? h("a", { class: "button ghost small", href: `https://discord.com/channels/${guildId}/${ticket.threadId}`, target: "_blank", rel: "noopener" }, icon("external", "icon small"), t("ticketsOpenThread"))
      : null,
    transcript !== null ? h("a", { class: "button ghost small", href: `/api/guilds/${guildId}/tickets/${number}?download=1` }, icon("download", "icon small"), t("ticketsDownload")) : null,
  );
  show(
    guildLayout(
      data,
      "tickets",
      h("a", { class: "back", href: `#/g/${guildId}/tickets` }, t("ticketsBack")),
      h(
        "section",
        { class: "card" },
        h("div", { class: "toolbar" }, h("h1", { class: "grow ticket-title" }, `#${ticket.number}`), ticketBadge(ticket)),
        h("p", { class: "ticket-subject-full" }, ticket.subject),
        h("dl", { class: "facts" }, facts.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])),
        actions,
      ),
      card(
        t("ticketsTranscript"),
        "file",
        "blue",
        transcript === null
          ? h("p", { class: "muted" }, t(ticket.closedAt ? "ticketsNoTranscript" : "ticketsTranscriptLater"))
          : h("pre", { class: "transcript" }, transcript),
      ),
    ),
  );
}

async function showTickets(guildId) {
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const data = await loadGuild(guildId);
  const number = Number.parseInt(query.get("ticket") ?? "", 10);
  return Number.isInteger(number) && number > 0 ? showTicket(guildId, data, number) : showTicketList(guildId, data, query);
}

// --- Activity ----------------------------------------------------------------------

// A line of a dashboard change: **bold** as bold, and channel and role mentions as names.
function activityText(text, data) {
  const named = text
    .replace(/<#(\d{17,20})>/g, (mention, id) => {
      const channel = data.channels.find((entry) => entry.id === id);
      return channel ? `#${channel.name}` : mention;
    })
    .replace(/<@&(\d{17,20})>/g, (mention, id) => {
      const role = data.roles.find((entry) => entry.id === id);
      return role ? `@${role.name}` : mention;
    });
  return named.split(/\*\*(.+?)\*\*/g).map((part, index) => (index % 2 === 1 ? h("strong", {}, part) : part));
}

function activityRow(entry, data) {
  return h(
    "li",
    { class: "activity-row" },
    h("span", { class: "avatar placeholder", "aria-hidden": "true" }, initials(entry.userName ?? "?").slice(0, 2)),
    h(
      "div",
      { class: "activity-body" },
      h(
        "div",
        { class: "activity-head" },
        h("a", { href: memberLink(data.guild.id, entry.userId) }, entry.userName ?? entry.userId),
        h("span", { class: "muted", title: formatDate(entry.createdAt) }, formatAgo(entry.createdAt)),
      ),
      h("p", { class: "activity-summary" }, activityText(entry.summary, data)),
      entry.lines.length > 0 ? h("ul", { class: "activity-lines" }, entry.lines.map((line) => h("li", {}, activityText(line, data)))) : null,
    ),
  );
}

async function showActivity(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const list = h("ul", { class: "activity" });
  const empty = h("p", { class: "muted empty", hidden: true }, t("activityNone"));
  const more = h("button", { class: "ghost", type: "button", hidden: true }, t("loadMore"));
  let before = null;
  const load = async () => {
    more.disabled = true;
    const page = await api(`/api/guilds/${guildId}/activity${before ? `?before=${before}` : ""}`);
    list.append(...page.entries.map((entry) => activityRow(entry, data)));
    empty.hidden = list.children.length > 0;
    before = page.next;
    more.hidden = !page.next;
    more.disabled = false;
  };
  more.addEventListener("click", () => load().catch(failed));
  show(guildLayout(data, "activity", pageHero("activity", t("activityIntro"), data), h("section", { class: "card" }, empty, list, h("div", { class: "center" }, more))));
  await load();
}

// --- Routing -----------------------------------------------------------------

const SHOW_PAGE = {
  overview: showOverview,
  activity: showActivity,
  antinuke: showAntiNuke,
  cases: showCases,
  members: showMembers,
  tickets: showTickets,
  automod: showAutomod,
  raid: showRaid,
  welcome: showWelcome,
  roles: showRoles,
  starboard: showStarboard,
  birthdays: showBirthdays,
  levels: showLevels,
  country: showCountry,
  tags: showTags,
  responders: showResponders,
  scheduled: showScheduled,
  moderation: showModeration,
  logging: showLogging,
  access: showAccess,
};

async function route() {
  const [path] = location.hash.replace(/^#/, "").split("?");
  const match = path.match(/^\/g\/(\d{17,20})(?:\/(\w+))?$/);
  state.unsaved = false;
  state.lastHash = location.hash;
  closeMenus();
  const pageId = match && (PAGE_ALIASES[match[2]] ?? match[2] ?? "overview");
  if (match && PAGE_ALIASES[match[2]]) {
    history.replaceState(null, "", `#/g/${match[1]}/${pageId}`);
    state.lastHash = location.hash;
  }
  // Moving between pages of the same server keeps the sidebar and shows placeholders.
  if (match && state.shell?.guildId === match[1] && state.shell.element.isConnected) {
    state.shell.contentArea.replaceChildren(skeleton());
    state.shell.nav.querySelectorAll(".nav-link").forEach((link) => {
      link.classList.toggle("active", link.dataset.page === pageId);
      link.toggleAttribute("aria-current", link.dataset.page === pageId);
    });
    document.body.classList.remove("nav-open");
  } else {
    show(skeleton());
  }
  window.scrollTo({ top: 0 });
  try {
    if (match && SHOW_PAGE[pageId]) {
      await SHOW_PAGE[pageId](match[1]);
    } else {
      await showServers();
    }
  } catch (error) {
    failed(error);
    if (!(error instanceof ApiError && error.status === 401) && match) {
      show(h("p", { class: "muted empty" }, t("errorGeneric")), h("a", { class: "button ghost", href: "#/" }, t("backToServers")));
    }
  }
}

// Asks before leaving a settings page with unsaved changes.
function onHashChange() {
  if (state.unsaved && !confirm(t("leaveUnsaved"))) {
    history.replaceState(null, "", state.lastHash || "#/");
    return;
  }
  route();
}

async function start() {
  loadAppearance();
  await loadLanguage(preferredLanguage());
  renderChrome();
  document.getElementById("searchButton").addEventListener("click", openSearch);
  document.getElementById("menuToggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  document.addEventListener("keydown", onShortcut);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu")) {
      closeMenus();
    }
  });
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("beforeunload", (event) => {
    if (state.unsaved) {
      event.preventDefault();
    }
  });
  route();
}

start();
