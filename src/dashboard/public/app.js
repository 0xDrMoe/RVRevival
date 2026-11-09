// The dashboard page. Plain JavaScript, no build step. Pages are picked by the
// part of the address after "#":
//
//   #/                     your servers
//   #/g/<id>/overview      a server's numbers at a glance, and which features are on
//   #/g/<id>/guide         how to use the bot and every feature (?part=, or ?topic=)
//   #/g/<id>/activity      every change made on the dashboard (?before=)
//   #/g/<id>/cases         moderation cases (?q=&action=&user=&moderator=&from=&to=)
//   #/g/<id>/members       find a member (?q=), or one member's history (?user=)
//   #/g/<id>/tickets       support tickets (?status=&user=), or one ticket's history and transcript (?ticket=)
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
//   #/g/<id>/access        permissions: premade setups (Simple), or roles, command
//                          rules and log channels per kind (?tab=advanced)
//
// Everything shown comes from the JSON API in ../app.js. Text from Discord
// (names, reasons) is always set as text, never as HTML.

import { GUIDE } from "./guide.js";
import { RESPONDER_TEMPLATES, TAG_TEMPLATES, responderFromTemplate, tagFromTemplate } from "./customCommandTemplates.js";

const LANGUAGES = { en: "English", es: "Español", de: "Deutsch", fr: "Français", pt: "Português", it: "Italiano", ar: "العربية" };
const LOG_EVENTS = ["messageEdit", "messageDelete", "bulkDelete", "memberJoin", "memberLeave", "memberUpdate"];
// What the ticket log records (tickets/ticketLog.js).
const TICKET_EVENTS = ["opened", "closed", "reopened", "memberAdded", "memberRemoved", "renamed", "deleted"];
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
// Moderator permissions (as in permissions/moderatorPermissions.js): roles with
// any of them can't be autoroles, level rewards or the birthday role.
const MODERATOR_PERMISSION_BITS = [3n, 5n, 28n, 4n, 13n, 29n, 27n, 30n, 33n, 34n, 2n, 1n, 40n, 17n, 7n].reduce((bits, bit) => bits | (1n << bit), 0n);
const AUTOROLE_FORBIDDEN = MODERATOR_PERMISSION_BITS;
const BIRTHDAY_ROLE_FORBIDDEN = MODERATOR_PERMISSION_BITS;
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
// "rumble" is the game-style look: chunky headings, bold outlines and comic shadows.
const STYLES = ["clean", "rumble"];
const DEFAULT_APPEARANCE = { theme: "auto", accent: "blurple", density: "comfortable", style: "clean" };

// The pages of one server, in sidebar groups. `manage` pages need Manage
// Server; the others are also open to dashboard roles. `on` says whether the
// feature is switched on, for the dot in the sidebar and the overview.
const NAV = [
  {
    group: "general",
    pages: [
      { id: "overview", icon: "home", tone: "blue" },
      { id: "guide", icon: "book", tone: "green" },
      { id: "activity", icon: "activity", tone: "purple", manage: true },
    ],
  },
  {
    group: "moderation",
    pages: [
      { id: "cases", icon: "folder", tone: "pink" },
      { id: "members", icon: "users", tone: "purple" },
      { id: "tickets", icon: "ticket", tone: "cyan" },
      { id: "appeals", icon: "inbox", tone: "amber", manage: true, on: (s) => Boolean(s.appeals?.enabled) },
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
      { id: "counters", icon: "chart", tone: "blue", manage: true },
    ],
  },
  {
    group: "messages",
    pages: [
      { id: "tags", icon: "tag", tone: "amber", manage: true, on: (s) => (s.tags ?? []).length > 0 },
      { id: "responders", icon: "repeat", tone: "cyan", manage: true, on: (s) => (s.autoResponders ?? []).length > 0 },
      { id: "scheduled", icon: "calendar", tone: "blue", manage: true },
      { id: "embeds", icon: "edit", tone: "purple", manage: true },
      { id: "feeds", icon: "rss", tone: "amber", manage: true },
      { id: "sticky", icon: "pin", tone: "pink", manage: true },
    ],
  },
  {
    group: "settings",
    pages: [
      { id: "moderation", icon: "sliders", tone: "red", manage: true },
      { id: "logging", icon: "list", tone: "amber", manage: true, on: (s) => Boolean(s.logsChannelId || s.serverLogChannelId) },
      { id: "access", icon: "key", tone: "purple", manage: true },
      { id: "branding", icon: "palette", tone: "pink", manage: true },
      { id: "backup", icon: "archive", tone: "cyan", manage: true },
    ],
  },
];
const PAGES = NAV.flatMap((section) => section.pages.map((page) => ({ ...page, group: section.group })));
// Addresses from older versions of the dashboard.
const PAGE_ALIASES = { settings: "moderation", community: "welcome" };

// Icons: the inside of a 24×24 stroked SVG. Fixed markup, never built from data.
const ICONS = {
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-3"/><path d="M9 7h7M9 11h5"/>',
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
  pipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
  palette: '<path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3-3.5 3H15a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 21z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15.5" cy="8" r="1"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
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
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
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
const topnav = document.getElementById("topnav");

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
  // The section links in the top bar belong to the landing page, and search to the dashboard.
  const landing = Boolean(children[0]?.classList?.contains("landing"));
  if (!landing) {
    topnav.hidden = true;
  }
  document.getElementById("searchButton").hidden = landing || !state.me;
  if (!(children.length === 1 && children[0] === state.shell?.element)) {
    document.body.classList.remove("in-guild");
  }
  if (children.length === 1 && main.firstChild === children[0] && main.childElementCount === 1) {
    return;
  }
  main.replaceChildren(...children);
}

let toastTimer;
// Marks a button as waiting on a request: disabled, with aria-busy so the
// progress cursor shows only then. A button that is simply unavailable (at a
// limit, no permission, nothing to save) stays disabled without the spinner.
function setBusy(button, busy) {
  button.disabled = busy;
  if (busy) {
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
}

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
// `lead` replaces the icon (the overview shows the server's own icon); `banner`
// paints the header in one of the server gradients from bannerFor.
function hero(title, intro, tone, { iconName, extra, lead, banner } = {}) {
  return h(
    "header",
    { class: `hero tone-${tone}${banner ? ` hero-banner ${banner}` : ""}` },
    lead ?? (iconName ? iconChip(iconName, tone, "lg") : null),
    h("div", { class: "hero-text" }, h("h1", {}, title), intro ? h("p", {}, intro) : null),
    extra ? h("div", { class: "hero-extra" }, extra) : null,
  );
}

// The header of a server page, from its entry in NAV.
function pageHero(pageId, intro, data, extra) {
  const page = PAGES.find((entry) => entry.id === pageId);
  const on = page?.on && data?.settings ? page.on(data.settings) : undefined;
  const status = on === undefined ? null : h("span", { class: `status ${on ? "on" : "off"}` }, t(on ? "featureOn" : "featureOff"));
  const topic = pageId === "guide" ? undefined : GUIDE_TOPICS.find((entry) => entry.page === pageId);
  const help = topic && data?.guild ? h("a", { class: "button ghost small", href: guideLink(data.guild.id, topic.id) }, icon("book", "icon small"), t("guideHowTo")) : null;
  return hero(t(`page_${pageId}`), intro, page?.tone ?? "blue", { iconName: page?.icon, extra: [status, help, extra].filter(Boolean) });
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
// --- Emoji picker --------------------------------------------------------------------

// A custom emoji as Discord writes it: <:name:id>, or <a:name:id> when animated.
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{17,20})>$/;
const customEmojiCode = (emoji) => `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
const customEmojiUrl = (id, animated) => `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=48`;

// The standard emojis (emojiData.js, about 40 KB), loaded the first time a picker opens.
let standardEmojis;
function loadStandardEmojis() {
  standardEmojis ??= import("./emojiData.js")
    .then(({ EMOJI_GROUPS }) =>
      EMOJI_GROUPS.map((group) => ({
        id: group.id,
        emojis: group.emojis.split("|").map((entry) => {
          const space = entry.indexOf(" ");
          return { value: entry.slice(0, space), name: entry.slice(space + 1) };
        }),
      })),
    )
    .catch((error) => {
      standardEmojis = undefined;
      throw error;
    });
  return standardEmojis;
}

// How an emoji setting looks: a custom emoji as its image, anything else as text.
function emojiGlyph(value) {
  const custom = CUSTOM_EMOJI.exec(value ?? "");
  return custom
    ? h("img", { class: "emoji-img", src: customEmojiUrl(custom[3], custom[1] === "a"), alt: `:${custom[2]}:`, title: `:${custom[2]}:` })
    : h("span", { class: "emoji-char" }, value ?? "");
}

// A text box for one emoji, with a button that opens a picker: this server's
// own emojis first, then the standard ones by group, and a search over both.
// Typing or pasting an emoji still works. `id` is the text box's id, which is
// what the page's save reads. Works inside field()'s <label>.
function emojiInput(data, { id, value = "", placeholder = "", maxLength = 64 }) {
  const serverEmojis = data.emojis ?? [];
  const input = h("input", { id, type: "text", class: "emoji-value", maxLength, value, placeholder, autocomplete: "off", spellcheck: false });
  const shown = h("span", { class: "emoji-shown", "aria-hidden": "true" });
  const trigger = h("button", {
    class: "emoji-trigger",
    type: "button",
    title: t("emojiPickerOpen"),
    "aria-label": t("emojiPickerOpen"),
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
  });
  const search = h("input", { type: "search", class: "emoji-search", placeholder: t("emojiPickerSearch"), "aria-label": t("emojiPickerSearch"), autocomplete: "off" });
  const tabs = h("div", { class: "emoji-tabs", role: "toolbar", "aria-label": t("emojiPickerGroups") });
  const list = h("div", { class: "emoji-list" });
  const hint = h("div", { class: "emoji-hint", "aria-live": "polite" }, t("emojiPickerHint"));
  const panel = h("div", { class: "emoji-picker", role: "dialog", "aria-label": t("emojiPickerOpen"), hidden: true }, search, tabs, list, hint);
  const wrap = h("div", { class: "emoji-input" }, input, trigger, panel);

  const showValue = () => {
    const current = input.value.trim();
    shown.replaceChildren(current ? emojiGlyph(current) : icon("smile", "icon small"));
    trigger.replaceChildren(shown);
  };
  showValue();
  input.addEventListener("input", showValue);

  const pick = (code) => {
    input.value = code;
    // The page's save bar listens for input on the form.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    input.focus();
  };

  const emojiButton = ({ value: code, label, glyph, disabled = false }) =>
    h(
      "button",
      {
        class: "emoji-option",
        type: "button",
        tabindex: "-1",
        title: label,
        "aria-label": label,
        "aria-disabled": disabled ? "true" : undefined,
        "data-code": code,
        onclick: () => (disabled ? null : pick(code)),
        onmouseenter: () => (hint.textContent = label),
        onfocus: () => (hint.textContent = label),
      },
      glyph,
    );

  // The server's emojis and the standard groups as sections; `query` filters by name.
  const render = (groups, query = "") => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (name) => words.every((word) => name.toLowerCase().includes(word));
    const sections = [];
    const server = serverEmojis.filter((emoji) => matches(emoji.name));
    if (!words.length || server.length > 0) {
      sections.push({
        id: "server",
        tab: guildIcon(data.guild, "xs"),
        buttons: server.map((emoji) =>
          emojiButton({
            value: customEmojiCode(emoji),
            label: emoji.available ? `:${emoji.name}:` : `:${emoji.name}: · ${t("emojiPickerUnavailable")}`,
            glyph: h("img", { class: "emoji-img", src: customEmojiUrl(emoji.id, emoji.animated), alt: "", loading: "lazy" }),
            disabled: !emoji.available,
          }),
        ),
        empty: words.length ? null : t("emojiPickerServerEmpty"),
      });
    }
    for (const group of groups) {
      const found = group.emojis.filter((emoji) => matches(emoji.name));
      if (found.length > 0) {
        sections.push({
          id: group.id,
          tab: h("span", { class: "emoji-char" }, group.emojis[0].value),
          buttons: found.map((emoji) => emojiButton({ value: emoji.value, label: emoji.name, glyph: h("span", { class: "emoji-char" }, emoji.value) })),
        });
      }
    }
    list.replaceChildren(
      ...sections.map((section) =>
        h(
          "section",
          { class: "emoji-section", "data-group": section.id },
          h("h3", { class: "emoji-section-title" }, t(section.id === "server" ? "emojiPickerServer" : `emojiGroup_${section.id}`)),
          section.buttons.length > 0
            ? h("div", { class: "emoji-grid", role: "group", "aria-label": t(section.id === "server" ? "emojiPickerServer" : `emojiGroup_${section.id}`) }, section.buttons)
            : h("p", { class: "help" }, section.empty),
        ),
      ),
      sections.length === 0 ? h("p", { class: "help emoji-none" }, t("emojiPickerNone")) : null,
    );
    // Search results show without tabs; the tabs jump to a group.
    tabs.hidden = words.length > 0;
    tabs.replaceChildren(
      ...sections.map((section) =>
        h(
          "button",
          {
            class: "emoji-tab",
            type: "button",
            title: t(section.id === "server" ? "emojiPickerServer" : `emojiGroup_${section.id}`),
            "aria-label": t(section.id === "server" ? "emojiPickerServer" : `emojiGroup_${section.id}`),
            onclick: () => {
              const target = list.querySelector(`[data-group="${section.id}"]`);
              list.scrollTop = target ? target.offsetTop - list.offsetTop : 0;
            },
          },
          section.tab,
        ),
      ),
    );
    list.scrollTop = 0;
  };

  const options = () => [...list.querySelectorAll(".emoji-option")];
  // Arrow keys move through the emojis; up and down go a row at a time.
  list.addEventListener("keydown", (event) => {
    const all = options();
    const index = all.indexOf(document.activeElement);
    if (index < 0) {
      return;
    }
    const grid = document.activeElement.parentElement;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length || 1;
    const rtl = document.documentElement.dir === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    if (index + step < 0) {
      search.focus();
      return;
    }
    all[Math.min(all.length - 1, index + step)]?.focus();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      // Not the page's save: pick the first match instead.
      event.preventDefault();
      options().find((option) => option.getAttribute("aria-disabled") !== "true")?.click();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      options()[0]?.focus();
    }
  });
  let groups = [];
  search.addEventListener("input", (event) => {
    // The page's save bar doesn't need to hear about searches.
    event.stopPropagation();
    render(groups, search.value);
  });
  // Clicks on the picker's empty space mustn't reach the <label> around it.
  panel.addEventListener("click", (event) => {
    if (!event.target.closest("button, input")) {
      event.preventDefault();
    }
  });

  const onOutside = (event) => {
    if (!wrap.isConnected || !wrap.contains(event.target)) {
      close();
    }
  };
  const onKey = (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    }
  };
  function close() {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    wrap.removeEventListener("keydown", onKey);
  }
  async function open() {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    wrap.addEventListener("keydown", onKey);
    search.value = "";
    hint.textContent = t("emojiPickerHint");
    render(groups);
    search.focus();
    if (groups.length === 0) {
      try {
        groups = await loadStandardEmojis();
        if (!panel.hidden) {
          render(groups, search.value);
        }
      } catch {
        hint.textContent = t("emojiPickerLoadFailed");
      }
    }
  }
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (panel.hidden) {
      open();
    } else {
      close();
    }
  });
  return wrap;
}

// --- Look and feel ---------------------------------------------------------------

function applyAppearance() {
  const root = document.documentElement;
  const { theme, accent, density, style } = state.appearance;
  if (theme === "auto") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  root.dataset.accent = accent;
  root.dataset.density = density;
  root.dataset.style = style;
}

function loadAppearance() {
  const saved = recall("appearance") ?? {};
  state.appearance = {
    theme: THEMES.includes(saved.theme) ? saved.theme : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULT_APPEARANCE.accent,
    density: DENSITIES.includes(saved.density) ? saved.density : DEFAULT_APPEARANCE.density,
    style: STYLES.includes(saved.style) ? saved.style : DEFAULT_APPEARANCE.style,
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
      h("h3", {}, t("appearanceStyle")),
      segmented(
        t("appearanceStyle"),
        STYLES.map((value) => ({ value, text: t(`style_${value}`) })),
        state.appearance.style,
        (style) => setAppearance({ style }),
      ),
      h("p", { class: "help" }, t("appearanceStyleHelp")),
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
    account.replaceChildren(
      languageSelect(),
      h(
        "button",
        { class: "icon-button", type: "button", "aria-label": t("appearanceTitle"), title: t("appearanceTitle"), onclick: openAppearance },
        icon("palette"),
      ),
      h("a", { class: "button ghost small topbar-login", href: "/auth/login" }, t("topLogin")),
    );
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
    h("a", { class: "menu-item", role: "menuitem", href: "#/servers" }, icon("layers"), t("allServers")),
    h("a", { class: "menu-item", role: "menuitem", href: "#/" }, icon("home"), t("topHome")),
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

// Logged out: the landing page, or a plain login card for someone appealing a ban.
function showLogin() {
  const failedLogin = new URLSearchParams(location.hash.split("?")[1] ?? "").get("login") === "failed";
  const appealing = /^#\/appeal\/\d{17,20}$/.test(location.hash);
  if (!appealing) {
    showLanding(failedLogin);
    return;
  }
  rememberReturn(location.hash);
  show(
    h(
      "section",
      { class: "login card" },
      h("div", { class: "login-art" }, h("img", { src: "favicon.svg", alt: "", width: 72, height: 72 })),
      h("h1", {}, t("loginTitle")),
      h("p", { class: "muted" }, t(appealing ? "appealLoginIntro" : "loginIntro")),
      failedLogin ? h("p", { class: "error-text" }, t("loginFailed")) : null,
      h("a", { class: "button primary big", href: "/auth/login" }, t("loginButton")),
    ),
  );
}

// --- Landing page ----------------------------------------------------------------

// What the bot does, for the landing page: [icon, tone, string key, commands].
// tests/dashboardGuide.test.js checks every icon and command is a real one.
const LANDING_FEATURES = [
  ["gavel", "red", "landingModeration", ["/ban", "/timeout", "/warn", "/case"]],
  ["shield", "amber", "landingAutomod", ["/settings automod", "/mediaonly"]],
  ["shieldCheck", "purple", "landingProtection", ["/raid", "/antinuke", "/quarantine"]],
  ["ticket", "cyan", "landingTickets", ["/tickets"]],
  ["trophy", "green", "landingLeveling", ["/rank", "/leaderboard", "/levels"]],
  ["users", "pink", "landingCommunity", ["/welcome", "/rolepanel", "/country"]],
  ["list", "blue", "landingLogs", ["/modlogs"]],
  ["calendar", "accent", "landingMessages", ["/schedule", "/feed", "/sticky"]],
  ["gift", "amber", "landingGiveaways", ["/giveaway", "/starboard"]],
  ["tag", "purple", "landingTags", ["/tag", "/tags", "/autoresponder"]],
  ["volume", "cyan", "landingVoice", ["/voice"]],
  ["bell", "pink", "landingTools", ["/remind", "/birthday", "/afk", "/highlight"]],
];

// The three steps from invite to a working setup: [icon, string key].
const LANDING_STEPS = [
  ["plus", "landingStepAdd"],
  ["key", "landingStepLogin"],
  ["sliders", "landingStepSetup"],
];

// What the dashboard itself gives staff: [icon, tone, string key].
const LANDING_DASHBOARD = [
  ["key", "purple", "landingDashPermissions"],
  ["search", "blue", "landingDashSearch"],
  ["book", "green", "landingDashGuide"],
  ["globe", "cyan", "landingDashLanguages"],
  ["palette", "pink", "landingDashLook"],
  ["download", "amber", "landingDashBackup"],
];

const LANDING_FAQ = ["landingFaqNative", "landingFaqAccess", "landingFaqCommands", "landingFaqPermissions"];

// Big numbers shortened (12.4K), small ones in full.
const formatCount = (value) =>
  value === null || value === undefined
    ? "–"
    : new Intl.NumberFormat(state.language, value >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(value);

// The public numbers, from /api/public/stats. No login needed, and a failure
// only hides the numbers.
async function loadPublicStats() {
  const response = await fetch("/api/public/stats", { credentials: "same-origin" });
  if (!response.ok) {
    throw new ApiError(response.status, {});
  }
  return response.json();
}

// 99.96 → "99.9%": rounded down, so the page never claims more uptime than there was.
const formatUptime = (percent) =>
  percent === null || percent === undefined
    ? "–"
    : new Intl.NumberFormat(state.language, { style: "percent", maximumFractionDigits: 1 }).format(Math.floor(percent * 10) / 1000);

// Counts a number up from zero when it first shows, unless the person asked
// for less motion. `format` turns the number into its text.
function countUp(element, value, format) {
  element.textContent = format(value);
  if (typeof value !== "number" || value <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / 900);
    // Ease out, so it slows into the real number.
    const shown = value * (1 - (1 - progress) ** 3);
    element.textContent = format(progress < 1 ? (Number.isInteger(value) ? Math.floor(shown) : shown) : value);
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

function landingStat(iconName, tone, value, label, format = formatCount) {
  const number = h("strong", {});
  countUp(number, value, format);
  return h("div", { class: `landing-stat tone-${tone}` }, iconChip(iconName, tone, "sm"), number, h("span", {}, label));
}

// How a day's bar is colored: [class, tone].
const uptimeLevel = (percent) =>
  percent === null ? "none" : percent >= 99 ? "up" : percent >= 95 ? "dip" : "down";

// One bar a day for the last 30 days, oldest first, like a status page.
function landingUptimeStrip(stats) {
  const days = stats.uptime?.days ?? [];
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const dateFormat = new Intl.DateTimeFormat(state.language, { month: "short", day: "numeric", timeZone: "UTC" });
  const bars = days.map((percent, index) => {
    const date = dateFormat.format(today - (days.length - 1 - index) * DAY_MS);
    const label = t("landingDayUptime", { date, percent: percent === null ? t("landingNoData") : formatUptime(percent) });
    return h("span", { class: `uptime-bar ${uptimeLevel(percent)}`, title: label, role: "listitem", "aria-label": label });
  });
  const live = stats.online
    ? [
        stats.upSince ? t("landingUpFor", { time: formatDuration(Date.now() - stats.upSince) }) : t("landingOnline"),
        stats.ping === null || stats.ping === undefined ? null : t("landingPing", { ms: formatNumber(stats.ping) }),
      ]
    : [t("landingOffline")];
  return h(
    "div",
    { class: "landing-uptime" },
    h(
      "div",
      { class: "landing-uptime-head" },
      h("strong", {}, t("landingUptimeDays")),
      h("span", { class: `landing-uptime-live ${stats.online ? "on" : "off"}` }, live.filter(Boolean).join(" · ")),
    ),
    h("div", { class: "uptime-bars", role: "list", "aria-label": t("landingUptimeDays") }, bars),
    h(
      "div",
      { class: "landing-uptime-scale" },
      h("span", {}, t("landingDaysAgo", { count: formatNumber(days.length) })),
      h("span", {}, t("landingToday")),
    ),
  );
}

// The numbers band under the hero, filled in once the numbers arrive.
function landingStats(stats) {
  const uptime = stats.uptime?.percent ?? null;
  return [
    landingStat("layers", "accent", stats.servers, t("landingServers")),
    landingStat("users", "pink", stats.members, t("landingMembers")),
    landingStat("zap", "amber", stats.commandsRun, t("landingCommands")),
    landingStat("gavel", "red", stats.cases, t("landingCases")),
    landingStat("ticket", "cyan", stats.tickets, t("landingTickets_title")),
    landingStat("activity", stats.online ? "green" : "gray", uptime, t("landingUptimeShort"), formatUptime),
    landingUptimeStrip(stats),
  ];
}

// The bot's online dot in the hero.
function landingStatus(stats) {
  return h(
    "span",
    { class: `landing-status ${stats.online ? "on" : "off"}` },
    stats.online && stats.upSince ? t("landingUpFor", { time: formatDuration(Date.now() - stats.upSince) }) : t(stats.online ? "landingOnline" : "landingOffline"),
    stats.uptime?.percent === null || stats.uptime?.percent === undefined
      ? null
      : h("span", { class: "landing-status-uptime" }, t("landingUptimeBadge", { percent: formatUptime(stats.uptime.percent) })),
  );
}

// A made-up Discord message from the bot, for the hero art.
function landingDemo(tone, iconName, title, text) {
  return h(
    "div",
    { class: `landing-demo tone-${tone}` },
    h("img", { src: "favicon.svg", alt: "", width: 36, height: 36 }),
    h(
      "div",
      {},
      h("span", { class: "landing-demo-name" }, "Rabble", h("span", { class: "landing-demo-bot" }, t("landingBot"))),
      h("div", { class: "landing-demo-embed" }, h("strong", {}, icon(iconName), title), h("span", {}, text)),
    ),
  );
}

// A section of the landing page with its heading. The id lets the footer jump to it.
function landingSection(id, title, intro, ...children) {
  return h(
    "section",
    { class: "landing-section", id: `landing-${id}`, "aria-labelledby": `landing-${id}-title` },
    h("h2", { id: `landing-${id}-title` }, title),
    intro ? h("p", { class: "landing-intro" }, intro) : null,
    ...children,
  );
}

// Jumps to a section without touching the URL hash, which is the router's.
const landingJump = (id, label) =>
  h(
    "button",
    {
      type: "button",
      class: "link-button",
      onclick: () => document.getElementById(`landing-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    },
    label,
  );

function showLanding(failedLogin = false) {
  const inviteButton = (extra = "") =>
    h(
      "a",
      { class: `button landing-invite big${extra}`, href: "https://discord.com/oauth2/authorize", target: "_blank", rel: "noopener", hidden: true },
      icon("plus"),
      t("landingAdd"),
    );
  const invites = [inviteButton(), inviteButton(), inviteButton(" landing-step-action")];
  const topInvite = h(
    "a",
    { class: "button primary small topnav-invite", href: "https://discord.com/oauth2/authorize", target: "_blank", rel: "noopener", hidden: true },
    icon("plus"),
    t("landingAdd"),
  );
  invites.push(topInvite);
  topnav.setAttribute("aria-label", t("landingFooterNav"));
  topnav.replaceChildren(
    h(
      "div",
      { class: "topnav-links" },
      landingJump("features", t("landingNavFeatures")),
      landingJump("steps", t("landingNavSteps")),
      landingJump("dashboard", t("landingNavDashboard")),
      landingJump("faq", t("landingNavFaq")),
    ),
    topInvite,
    // replaceChildren would print a null as "null", so only add the button when logged in.
    ...(state.me ? [h("a", { class: "button ghost small topnav-dashboard", href: "#/servers" }, icon("layers"), t("landingDashboard"))] : []),
  );
  topnav.hidden = false;
  const dashboardHref = state.me ? "#/servers" : "/auth/login";
  const login = () => h("a", { class: "button landing-login big", href: dashboardHref }, icon("home"), t("landingDashboard"));
  const status = h("span", { class: "landing-status" }, t("loading"));
  const stats = h("div", { class: "landing-stats", "aria-busy": "true" }, Array.from({ length: 6 }, () => h("span", { class: "sk sk-stat" })));
  const statsBand = h("section", { class: "landing-stats-band", "aria-label": t("landingStatsTitle") }, stats);

  show(
    h(
      "div",
      { class: "landing" },
      h(
        "header",
        { class: "landing-hero" },
        h(
          "div",
          { class: "landing-copy" },
          status,
          h("h1", {}, "Rabble"),
          h("p", { class: "landing-tagline" }, t("landingTagline")),
          failedLogin ? h("p", { class: "landing-error", role: "alert" }, t("loginFailed")) : null,
          h("div", { class: "landing-actions" }, invites[0], login()),
          h(
            "ul",
            { class: "landing-points" },
            ["landingPointCommands", "landingPointPick", "landingPointLanguages"].map((key) => h("li", {}, icon("check"), t(key))),
          ),
        ),
        h(
          "div",
          { class: "landing-art", "aria-hidden": "true" },
          landingDemo("red", "gavel", t("landingDemoCase_title"), t("landingDemoCase_text")),
          landingDemo("green", "trophy", t("landingDemoLevel_title"), t("landingDemoLevel_text")),
          landingDemo("cyan", "ticket", t("landingDemoTicket_title"), t("landingDemoTicket_text")),
        ),
      ),
      statsBand,
      landingSection(
        "features",
        t("landingFeaturesTitle"),
        t("landingFeaturesIntro"),
        h(
          "div",
          { class: "landing-features" },
          LANDING_FEATURES.map(([iconName, tone, key, commands]) =>
            h(
              "article",
              { class: `landing-feature card tone-${tone}` },
              iconChip(iconName, tone),
              h("h3", {}, t(`${key}_title`)),
              h("p", {}, t(`${key}_text`)),
              h("div", { class: "landing-commands" }, commands.map((command) => h("code", { dir: "ltr" }, command))),
            ),
          ),
        ),
      ),
      landingSection(
        "steps",
        t("landingStepsTitle"),
        t("landingStepsIntro"),
        h(
          "ol",
          { class: "landing-steps" },
          LANDING_STEPS.map(([iconName, key], index) =>
            h(
              "li",
              { class: "landing-step card" },
              h("span", { class: "landing-step-number" }, formatNumber(index + 1)),
              h("h3", {}, icon(iconName), t(`${key}_title`)),
              h("p", {}, t(`${key}_text`)),
              index === 0 ? invites[2] : null,
            ),
          ),
        ),
      ),
      landingSection(
        "dashboard",
        t("landingDashTitle"),
        t("landingDashIntro"),
        h(
          "div",
          { class: "landing-dash" },
          LANDING_DASHBOARD.map(([iconName, tone, key]) =>
            h(
              "div",
              { class: "landing-dash-item" },
              iconChip(iconName, tone),
              h("div", {}, h("h3", {}, t(`${key}_title`)), h("p", {}, t(`${key}_text`))),
            ),
          ),
        ),
      ),
      landingSection(
        "faq",
        t("landingFaqTitle"),
        null,
        h(
          "div",
          { class: "landing-faq" },
          LANDING_FAQ.map((key) => h("details", { class: "card" }, h("summary", {}, t(`${key}_q`)), h("p", {}, t(`${key}_a`)))),
        ),
      ),
      h(
        "section",
        { class: "landing-cta" },
        h("div", {}, h("h2", {}, t("landingCtaTitle")), h("p", {}, t("landingCtaText"))),
        h("div", { class: "landing-actions" }, invites[1], login()),
      ),
      h(
        "footer",
        { class: "landing-footer" },
        h("span", { class: "landing-footer-brand" }, h("img", { src: "favicon.svg", alt: "", width: 24, height: 24 }), "Rabble"),
        h(
          "nav",
          { "aria-label": t("landingFooterNav") },
          landingJump("features", t("landingNavFeatures")),
          landingJump("steps", t("landingNavSteps")),
          landingJump("dashboard", t("landingNavDashboard")),
          landingJump("faq", t("landingNavFaq")),
          h("a", { href: "/auth/login" }, t("landingDashboard")),
          h("a", { href: "/terms" }, t("landingTerms")),
          h("a", { href: "/privacy" }, t("landingPrivacy")),
        ),
      ),
    ),
  );

  loadPublicStats()
    .then((data) => {
      for (const link of invites) {
        link.href = data.inviteUrl;
        link.hidden = false;
      }
      status.replaceWith(landingStatus(data));
      stats.replaceChildren(...landingStats(data));
      stats.removeAttribute("aria-busy");
    })
    .catch(() => {
      status.remove();
      statsBand.remove();
    });
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
      const words = searchWords(search.value);
      cards.forEach((element) => (element.hidden = !matchesWords(searchable(element.dataset.name), words)));
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
    h("a", { class: "menu-item", role: "menuitem", href: "#/servers" }, icon("layers"), t("allServers")),
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

// The words typed in a filter box. A line of text matches when it holds every
// word, in any order, ignoring case and accents: "mod team" finds "Team Moderators".
const searchWords = (query) => searchable(query).split(/\s+/).filter(Boolean);
const matchesWords = (text, words) => words.every((word) => text.includes(word));

// Filter boxes inside a settings form: Enter mustn't save the form, and Esc clears the box.
function filterKeys(input, onChange) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    } else if (event.key === "Escape" && input.value !== "") {
      event.preventDefault();
      input.value = "";
      onChange();
    }
  });
}

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
    for (const part of GUIDE) {
      items.push({
        kind: "page",
        icon: part.icon,
        tone: part.tone,
        title: part.part,
        sub: t("page_guide"),
        text: searchable(`${part.part} ${t("page_guide")} ${part.about}`),
        href: guidePartLink(data.guild.id, part.id),
      });
    }
    for (const topic of GUIDE_TOPICS) {
      items.push({
        kind: "page",
        icon: topic.icon,
        tone: topic.tone,
        title: topic.title,
        sub: t("page_guide"),
        text: searchable(`${topic.title} ${t("page_guide")} ${topic.summary} ${(topic.commands ?? []).map(([usage]) => usage).join(" ")}`),
        href: guideLink(data.guild.id, topic.id),
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
// Options with a `group` go under that heading (a channel's category, or
// country and bot roles), after the ones without.
function picker({ id, options, value, emptyLabel }) {
  const missing = value && !options.some((option) => option.id === value);
  const option = (item) => h("option", { value: item.id, selected: item.id === value }, item.group ? (item.short ?? item.label) : item.label);
  const groups = new Map();
  for (const item of options.filter((item) => item.group)) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  return h(
    "select",
    { id },
    h("option", { value: "" }, emptyLabel),
    missing ? h("option", { value, selected: true }, t("unknownOption", { id: value })) : null,
    options.filter((item) => !item.group).map(option),
    [...groups].map(([label, items]) => h("optgroup", { label }, items.map(option))),
  );
}

const channelPrefix = (channel) => (channel.type === CHANNEL.CATEGORY ? "▸ " : channel.type === CHANNEL.VOICE ? "🔊 " : "#");
const channelLabel = (channel, channels) => {
  const parent = channels.find((other) => other.id === channel.parentId);
  return parent ? `${channelPrefix(channel)}${channel.name} (${parent.name})` : `${channelPrefix(channel)}${channel.name}`;
};

// A channel as a picker or checklist item. Pickers group channels under their category.
const channelItem = (channel, channels) => ({
  id: channel.id,
  label: channelLabel(channel, channels),
  short: `${channelPrefix(channel)}${channel.name}`,
  group: channels.find((other) => other.id === channel.parentId)?.name,
});

// A role as a picker or checklist item. Pickers put country and bot roles under
// their own headings, and checklists fold country roles away.
const roleItem = (role, { mention = true, dot = false } = {}) => ({
  id: role.id,
  label: mention ? `@${role.name}` : role.name,
  dot: dot ? roleDot(role) : undefined,
  group: role.managed ? t("roleKind_bot") : role.country ? t("roleKind_country") : undefined,
  country: Boolean(role.country),
});

const roleOptions = (data) => data.roles.map((role) => roleItem(role));
const postableChannels = (data) =>
  data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT].includes(channel.type))
    .map((channel) => channelItem(channel, data.channels));

// Checkboxes with a filter box, a "ticked only" switch and a count. Country
// roles fold away behind their own switch (ticked ones and filter matches stay
// visible), so a server with dozens of them still gets a short list.
function checkList({ name, items, checked, filterKey }) {
  const ticked = new Set(checked);
  const boxes = items.map((item) => {
    const box = h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", name, value: item.id, checked: ticked.has(item.id) }),
      item.dot ?? null,
      h("span", {}, item.label),
    );
    box.dataset.search = searchable(item.label);
    box.dataset.country = item.country ? "true" : "";
    return box;
  });
  const countryCount = items.filter((item) => item.country).length;
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted empty", hidden: true }, t("nothingMatches"));
  const onlyTicked = h("input", { type: "checkbox" });
  const showCountries = h("input", { type: "checkbox" });
  const filter = h("input", { type: "search", class: "grow", placeholder: t(filterKey), "aria-label": t(filterKey) });
  const clear = h("button", { type: "button", class: "link-button", hidden: true }, t("untickAll"));
  const update = () => {
    const words = searchWords(filter.value);
    let shown = 0;
    let selected = 0;
    boxes.forEach((box) => {
      const isChecked = box.querySelector("input").checked;
      const folded = box.dataset.country && !showCountries.checked && !isChecked && words.length === 0;
      box.hidden = folded || !matchesWords(box.dataset.search, words) || (onlyTicked.checked && !isChecked);
      shown += box.hidden ? 0 : 1;
      selected += isChecked ? 1 : 0;
    });
    count.textContent = t("selectedCount", { count: selected });
    clear.hidden = selected === 0;
    empty.hidden = shown > 0;
  };
  filter.addEventListener("input", update);
  filterKeys(filter, update);
  const element = h(
    "div",
    { class: "check-list", onchange: update },
    h(
      "div",
      { class: "toolbar" },
      filter,
      h("label", { class: "switch" }, onlyTicked, h("span", {}, t("onlyTicked"))),
      countryCount > 0 ? h("label", { class: "switch" }, showCountries, h("span", {}, t("showCountryRoles", { count: countryCount }))) : null,
      count,
      clear,
    ),
    h("div", { class: "checks scroll" }, boxes, empty),
  );
  // Unticking everything counts as a change, so the save bar notices it.
  clear.addEventListener("click", () => {
    boxes.forEach((box) => (box.querySelector("input").checked = false));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
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
// `heroExtra()` makes what goes on the right of the page title (tabs, say).
function settingsPage({ data, pageId, intro, cards, fields, after = null, heroExtra = () => undefined }) {
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
        setBusy(saveButton, true);
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
          header.replaceWith((header = pageHero(pageId, intro, data, heroExtra())));
        } catch (error) {
          failed(error);
        } finally {
          setBusy(saveButton, false);
        }
      },
    },
    h("div", { class: "settings-cards" }, cards),
    saveBar,
  );
  let header = pageHero(pageId, intro, data, heroExtra());
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

// Where each log goes (logs/logRoutes.js). Every kind of entry can have its own
// channel; groups ("All moderation cases") cover the kinds under them. Server
// and ticket events reuse the names of their on/off switches.
const ticketRouteOf = (event) => `ticket${event[0].toUpperCase()}${event.slice(1)}`;
const LOG_ROUTE_SECTIONS = [
  { section: "logs", items: [{ route: "commands" }, { route: "botDeletions" }, { route: "dashboard" }] },
  {
    section: "modLog",
    items: [
      { route: "cases", children: ["caseBan", "caseSoftban", "caseUnban", "caseKick", "caseTimeout", "caseUntimeout", "caseWarn", "caseNote"] },
      { route: "modActions", children: ["warningsCleared", "channelLock", "slowmode", "roleChange", "nicknameChange", "purge", "massRole", "tempRole", "quarantine"] },
      { route: "automod" },
      { route: "protection", children: ["raidAlert", "raidLockdown", "antiNuke"] },
    ],
  },
  { section: "serverLog", items: LOG_EVENTS.map((route) => ({ route, label: `logEvent_${route}` })) },
  { section: "ticketLog", items: TICKET_EVENTS.map((event) => ({ route: ticketRouteOf(event), label: `ticketEvent_${event}` })) },
];
const routeLabel = (item) => t(item.label ?? `logRoute_${item.route}`);
// A field whose label is already translated text.
const labelled = (text, control) => h("label", { class: "field" }, h("span", { class: "field-label" }, text), control);

// The "Where each log goes" card. Each picker's empty choice says where that
// kind of entry goes when it's left alone, and follows the channels picked
// above as they change. Returns { element, read(form) }.
function logRoutesCard(data, settings) {
  const saved = settings.logRoutes ?? {};
  const postable = postableChannels(data);
  const channelName = (id) => {
    const channel = data.channels.find((entry) => entry.id === id);
    return channel ? `#${channel.name}` : t("unknownOption", { id });
  };
  const pickers = new Map(); // route -> select
  const routePicker = (route) => {
    const select = picker({ id: `route-${route}`, options: postable, value: saved[route], emptyLabel: "" });
    select.dataset.route = route;
    pickers.set(route, select);
    return select;
  };

  const counts = new Map(); // section -> element showing how many have their own channel
  const defaults = new Map(); // section -> element showing the section's channel
  const sections = LOG_ROUTE_SECTIONS.map(({ section, items }) => {
    const count = h("span", { class: "badge" });
    const where = h("span", { class: "help" });
    counts.set(section, count);
    defaults.set(section, where);
    const routes = items.flatMap((item) => [item.route, ...(item.children ?? [])]);
    const reset = h(
      "button",
      {
        class: "ghost small",
        type: "button",
        onclick: (event) => {
          routes.forEach((route) => (pickers.get(route).value = ""));
          event.currentTarget.dispatchEvent(new Event("change", { bubbles: true }));
        },
      },
      t("logRoutesReset"),
    );
    // Groups get their own block; the kinds between them share one grid.
    const body = [];
    let simple = [];
    const flush = () => {
      if (simple.length > 0) {
        body.push(h("div", { class: "route-grid" }, simple));
        simple = [];
      }
    };
    for (const item of items) {
      if (!item.children) {
        simple.push(labelled(routeLabel(item), routePicker(item.route)));
        continue;
      }
      flush();
      body.push(
        h(
          "div",
          { class: "route-group" },
          h("div", { class: "route-grid" }, labelled(t("logRouteAll", { group: routeLabel(item) }), routePicker(item.route))),
          h(
            "div",
            { class: "route-grid route-children" },
            item.children.map((route) => labelled(routeLabel({ route }), routePicker(route))),
          ),
        ),
      );
    }
    flush();
    return h(
      "details",
      { class: "route-section collapsible", open: routes.some((route) => saved[route]) },
      h(
        "summary",
        {},
        h("span", { class: "route-summary" }, h("strong", {}, t(`logRouteSection_${section}`)), where),
        count,
      ),
      h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t(`logRouteSectionHelp_${section}`)), reset),
      body,
    );
  });

  // Where each section's entries go when nothing more specific is picked.
  const value = (form, id) => form.querySelector(`#${id}`)?.value || "";
  const sectionChannel = (form, section) => {
    const logs = value(form, "logsChannelId");
    const modLog = value(form, "modLogChannelId") || logs;
    if (section === "logs") {
      return logs;
    }
    if (section === "modLog") {
      return modLog;
    }
    if (section === "serverLog") {
      return value(form, "serverLogChannelId");
    }
    // Tickets: the ticket log channel, else "mod actions" if picked, else the mod-log channel.
    return value(form, "ticketLogChannelId") || pickers.get("modActions").value || modLog;
  };

  const element = h("div", { class: "route-sections" }, sections);
  const refresh = () => {
    const form = element.closest("form") ?? document;
    for (const { section, items } of LOG_ROUTE_SECTIONS) {
      const fallback = sectionChannel(form, section);
      defaults.get(section).textContent = fallback
        ? t("logRouteGoesTo", { channel: channelName(fallback) })
        : t("logRouteNowhereShort");
      const label = (channel) => (channel ? t("logRouteDefault", { channel: channelName(channel) }) : t("logRouteNowhere"));
      let own = 0;
      for (const item of items) {
        const group = pickers.get(item.route);
        group.options[0].textContent = label(fallback);
        own += group.value ? 1 : 0;
        for (const route of item.children ?? []) {
          const child = pickers.get(route);
          child.options[0].textContent = group.value
            ? t("logRouteSameAs", { group: routeLabel(item), channel: channelName(group.value) })
            : label(fallback);
          own += child.value ? 1 : 0;
        }
      }
      counts.get(section).textContent = own > 0 ? t("logRoutesOwn", { count: own }) : t("logRoutesAllDefault");
      counts.get(section).classList.toggle("badge-accent", own > 0);
    }
  };

  return {
    element,
    refresh,
    read: (form) => {
      const picked = [...form.querySelectorAll("select[data-route]")].filter((select) => select.value).map((select) => [select.dataset.route, select.value]);
      return picked.length > 0 ? Object.fromEntries(picked) : null;
    },
  };
}

async function showLogging(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const postable = postableChannels(data);
  const channelPicker = (key, emptyLabel = t("notSet")) => picker({ id: key, options: postable, value: data.settings[key], emptyLabel });
  const routes = logRoutesCard(data, data.settings);

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

  const ticketsOff = new Set(data.settings.disabledTicketLogEvents ?? []);
  const ticketSwitches = TICKET_EVENTS.map((event) =>
    h(
      "label",
      { class: "switch-card" },
      h("span", { class: "switch-text" }, h("strong", {}, t(`ticketEvent_${event}`)), h("span", { class: "help" }, t(`ticketEventHelp_${event}`))),
      h("span", { class: "switch" }, h("input", { type: "checkbox", name: "ticketLogEvent", value: event, checked: !ticketsOff.has(event), role: "switch" })),
    ),
  );

  const ignorable = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => channelItem(channel, data.channels));

  settingsPage({
    data,
    pageId: "logging",
    intro: t("loggingIntro"),
    cards: [
      card(
        t("sectionChannels"),
        "hash",
        "amber",
        h("p", { class: "help" }, t("logChannelsHelp")),
        field("logsChannel", "logsChannelHelp", channelPicker("logsChannelId")),
        field("modLogChannel", "modLogChannelHelp", channelPicker("modLogChannelId", t("useLogsChannel"))),
        field("serverLogChannel", "serverLogChannelHelp", channelPicker("serverLogChannelId")),
      ),
      card(t("logRoutesTitle"), "list", "blue", h("p", { class: "help" }, t("logRoutesHelp")), routes.element),
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
        t("sectionTicketLog"),
        "ticket",
        "cyan",
        field("ticketLogChannel", "ticketLogChannelHelp", channelPicker("ticketLogChannelId")),
        h("p", { class: "help" }, t("ticketLogEventsHelp")),
        h("div", { class: "switch-grid" }, ticketSwitches),
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
      modLogChannelId: selectValue("modLogChannelId"),
      serverLogChannelId: selectValue("serverLogChannelId"),
      disabledLogEvents: (form) => {
        const off = [...form.querySelectorAll('input[name="logEvent"]')].filter((box) => !box.checked).map((box) => box.value);
        return off.length > 0 ? off : null;
      },
      logIgnoredChannels: checkedList("ignore"),
      ticketLogChannelId: selectValue("ticketLogChannelId"),
      disabledTicketLogEvents: (form) => {
        const off = [...form.querySelectorAll('input[name="ticketLogEvent"]')].filter((box) => !box.checked).map((box) => box.value);
        return off.length > 0 ? off : null;
      },
      logRoutes: routes.read,
    },
  });
  // The "Default: #channel" choices follow the channels picked on the page.
  routes.element.closest("form")?.addEventListener("change", routes.refresh);
  routes.refresh();
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
  const roles = data.roles.filter((role) => !role.managed).map((role) => roleItem(role, { mention: false, dot: true }));
  const mediaOnly = data.settings.mediaOnly ?? { channelIds: [], allowLinks: true };
  const channels = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => channelItem(channel, data.channels));

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
      card(
        t("mediaOnlyTitle"),
        "image",
        "green",
        h("p", { class: "help" }, t("mediaOnlyHelp")),
        data.guild.community ? h("p", { class: "tip" }, icon("sparkles"), h("span", {}, t("mediaOnlyNativeTip"))) : null,
        h(
          "label",
          { class: "switch-card" },
          h("span", { class: "switch-text" }, h("strong", {}, t("mediaOnlyLinks")), h("span", { class: "help" }, t("mediaOnlyLinksHelp"))),
          h("span", { class: "switch" }, h("input", { id: "mediaOnlyLinks", type: "checkbox", role: "switch", checked: mediaOnly.allowLinks, "aria-label": t("mediaOnlyLinks") })),
        ),
        h("p", { class: "help" }, t("mediaOnlyPick")),
        checkList({ name: "mediaOnly", items: postableChannels(data), checked: mediaOnly.channelIds, filterKey: "filterChannels" }),
      ),
    ],
    fields: {
      automod: (form) => readAutomod(form, data.settings.automod),
      mediaOnly: (form) => ({ channelIds: checkedList("mediaOnly")(form) ?? [], allowLinks: form.querySelector("#mediaOnlyLinks").checked }),
    },
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
    // Left empty, the star stays the default.
    emoji: form.querySelector("#starboardEmoji").value.trim() || STARBOARD_DEFAULTS.emoji,
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

// --- Time zone picker -------------------------------------------------------------

// The regions a time zone's name starts with, in the order the picker lists them.
// Zones outside these (UTC, old aliases) go under "Other".
const TIME_ZONE_REGIONS = ["America", "Europe", "Africa", "Asia", "Australia", "Pacific", "Atlantic", "Indian", "Antarctica", "Arctic"];

// Minutes ahead of UTC for a zone at the given moment, from "GMT+05:30" style names.
function timeZoneOffset(zone, at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
}

// "UTC+5:30", "UTC−3", "UTC+0".
function formatOffset(minutes) {
  const sign = minutes < 0 ? "−" : "+";
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

// Browsers still list some zones by their old names. They work the same (the bot
// accepts both), but people search for and recognise the new ones.
const TIME_ZONE_NEW_NAMES = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};
const newTimeZoneName = (zone) => TIME_ZONE_NEW_NAMES[zone] ?? zone;

// The zone's name without its region, readable: "America/Argentina/Buenos_Aires" → "Argentina › Buenos Aires".
const timeZoneCity = (zone) => {
  const name = newTimeZoneName(zone);
  return (name.includes("/") ? name.split("/").slice(1) : [name]).join(" › ").replaceAll("_", " ");
};
const timeZoneRegion = (zone) => (TIME_ZONE_REGIONS.includes(zone.split("/")[0]) && zone.includes("/") ? zone.split("/")[0] : "Other");

// Every zone the browser knows, with its offset and search text, worked out once
// a page load (an offset only moves with daylight saving). `extra` adds a saved
// zone the list doesn't have, such as an old alias like "US/Eastern".
let timeZoneCache = null;
function timeZoneList(extra) {
  if (!timeZoneCache) {
    const now = new Date();
    const names = (zone, locale, style) =>
      new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "";
    const make = (zone) => {
      const offset = timeZoneOffset(zone, now);
      const plain = formatOffset(offset).replace("−", "-");
      const hours = plain.slice(3);
      return {
        zone,
        offset,
        city: timeZoneCity(zone),
        region: timeZoneRegion(zone),
        text: searchable(
          [zone.replaceAll("_", " "), newTimeZoneName(zone).replaceAll("_", " "), plain, `GMT${hours}`, hours, names(zone, "en-US", "short"), names(zone, "en-US", "long"), names(zone, state.language, "long")].join(" "),
        ),
      };
    };
    const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
    timeZoneCache = { make, items: ["UTC", ...zones.filter((zone) => zone !== "UTC")].map(make) };
  }
  const { make, items } = timeZoneCache;
  if (!extra || items.some((item) => item.zone === extra)) {
    return items;
  }
  // A saved new name ("Asia/Kolkata") takes the place of the browser's old one, so it isn't listed twice.
  const old = items.findIndex((item) => newTimeZoneName(item.zone) === extra);
  return old >= 0 ? items.map((item, index) => (index === old ? make(extra) : item)) : [...items, make(extra)];
}

// The time now in a zone, as "4:32 PM", with the weekday added when it's a
// different day there than here ("Tue 4:32 PM") – which matters for birthdays.
function timeIn(item) {
  const now = Date.now();
  const there = new Date(now + item.offset * 60_000);
  const here = new Date(now - new Date(now).getTimezoneOffset() * 60_000);
  const otherDay = there.getUTCDate() !== here.getUTCDate();
  return new Intl.DateTimeFormat(state.language, { timeZone: "UTC", hour: "numeric", minute: "2-digit", weekday: otherDay ? "short" : undefined }).format(there);
}

// A searchable time zone picker that keeps its value in a hidden input `id`, so
// forms read it like any other field. A button shows the chosen zone with its
// offset and time there now; opening it shows a search box, quick picks (your
// own zone, UTC) and every zone grouped by region, sorted by offset. Arrow keys,
// Enter and Esc work in the search box.
function timeZonePicker({ id, value, labelKey, helpKey }) {
  const fallback = "UTC";
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const items = timeZoneList(value);
  const byZone = new Map(items.map((item) => [item.zone, item]));
  const regionRank = (region) => (region === "Other" ? -1 : TIME_ZONE_REGIONS.indexOf(region));
  const sorted = [...items].sort((a, b) => regionRank(a.region) - regionRank(b.region) || a.offset - b.offset || a.city.localeCompare(b.city));

  const labelId = `${id}Label`;
  const listId = `${id}List`;
  const input = h("input", { type: "hidden", id, value: value || fallback });
  const summary = h("span", { class: "tz-summary" });
  const trigger = h("button", {
    type: "button",
    class: "tz-trigger",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
    "aria-controls": listId,
    "aria-labelledby": `${labelId} ${id}Summary`,
  });
  summary.id = `${id}Summary`;
  trigger.append(icon("globe"), summary, icon("chevronDown", "icon small tz-chevron"));
  const search = h("input", {
    type: "search",
    role: "combobox",
    autocomplete: "off",
    spellcheck: false,
    "aria-controls": listId,
    "aria-expanded": "true",
    "aria-autocomplete": "list",
    placeholder: t("tzSearch"),
    "aria-label": t("tzSearch"),
  });
  const list = h("ul", { id: listId, class: "tz-list", role: "listbox", "aria-labelledby": labelId });
  const count = h("span", { class: "muted tz-count", "aria-live": "polite" });
  const quick = h("div", { class: "tz-quick" });
  const panel = h("div", { class: "tz-panel", hidden: true }, h("div", { class: "tz-search" }, icon("search"), search), quick, list, count);
  const root = h(
    "div",
    { class: "field tz-field" },
    h("span", { class: "field-label", id: labelId }, t(labelKey)),
    input,
    trigger,
    panel,
    helpKey ? h("span", { class: "help" }, t(helpKey)) : null,
  );

  let shown = [];
  let active = 0;

  const describe = (zone) => {
    const item = byZone.get(zone);
    return item
      ? [h("strong", {}, item.zone === "UTC" ? "UTC" : item.city), h("span", { class: "muted" }, `${item.region === "Other" ? "" : `${t(`tzRegion_${item.region}`)} · `}${formatOffset(item.offset)} · ${timeIn(item)}`)]
      : [h("strong", {}, zone)];
  };
  const paintSummary = () => summary.replaceChildren(...describe(input.value));

  const choose = (zone) => {
    const changed = input.value !== zone;
    input.value = zone;
    paintSummary();
    close();
    trigger.focus();
    if (changed) {
      // Hidden inputs don't fire events, so tell the form (and its save bar) ourselves.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  const optionId = (index) => `${id}Option${index}`;
  // Scrolls the list (never the page) so the highlighted zone shows: in the middle
  // when the picker opens, otherwise just enough.
  const reveal = (row, centre) => {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const header = list.querySelector(".tz-group")?.offsetHeight ?? 0;
    if (centre) {
      list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
    } else if (top - header < list.scrollTop) {
      list.scrollTop = top - header;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  };
  const paint = (centre = false) => {
    const rows = [];
    let region = null;
    shown.forEach((item, index) => {
      if (item.region !== region) {
        region = item.region;
        rows.push(h("li", { class: "tz-group", role: "presentation" }, t(`tzRegion_${region}`)));
      }
      const selected = item.zone === input.value;
      const row = h(
        "li",
        {
          id: optionId(index),
          role: "option",
          class: `tz-option${index === active ? " active" : ""}`,
          "aria-selected": String(selected),
          onmousedown: (event) => event.preventDefault(),
          onclick: () => choose(item.zone),
          onmousemove: () => {
            if (active !== index) {
              list.querySelector(".tz-option.active")?.classList.remove("active");
              row.classList.add("active");
              active = index;
              search.setAttribute("aria-activedescendant", optionId(index));
            }
          },
        },
        h("span", { class: "tz-city" }, item.zone === "UTC" ? t("tzUtc") : item.city),
        h("span", { class: "tz-offset" }, formatOffset(item.offset)),
        h("span", { class: "tz-time muted" }, timeIn(item)),
        selected ? icon("check", "icon small tz-tick") : h("span", { class: "tz-tick" }),
      );
      rows.push(row);
    });
    if (shown.length === 0) {
      rows.push(h("li", { class: "muted empty", role: "presentation" }, t("nothingMatches")));
    }
    list.replaceChildren(...rows);
    count.textContent = t("tzCount", { count: shown.length });
    if (shown[active]) {
      search.setAttribute("aria-activedescendant", optionId(active));
      reveal(list.querySelector(".tz-option.active"), centre);
    } else {
      search.removeAttribute("aria-activedescendant");
    }
  };

  const filter = () => {
    const words = searchWords(search.value);
    shown = words.length ? sorted.filter((item) => matchesWords(item.text, words)) : sorted;
    const current = shown.findIndex((item) => item.zone === input.value);
    active = words.length || current < 0 ? 0 : current;
    paint(!words.length);
  };

  const paintQuick = () => {
    const picks = [mine, "UTC"].filter((zone, index, all) => zone && byZone.has(zone) && all.indexOf(zone) === index);
    quick.replaceChildren(
      ...picks.map((zone) =>
        h(
          "button",
          { type: "button", class: `tz-chip${zone === input.value ? " on" : ""}`, onmousedown: (event) => event.preventDefault(), onclick: () => choose(zone) },
          zone === mine ? t("tzMine", { zone: byZone.get(zone).city }) : t("tzUtc"),
        ),
      ),
    );
  };

  const open = () => {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    root.classList.add("open");
    search.value = "";
    paintQuick();
    filter();
    search.focus();
  };
  function close() {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
  }

  trigger.addEventListener("click", () => (panel.hidden ? open() : close()));
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      active = shown.length === 0 ? 0 : (active + step + shown.length) % shown.length;
      paint();
    } else if (event.key === "Enter") {
      // Enter picks the highlighted zone and must never submit the settings form.
      event.preventDefault();
      if (shown[active]) {
        choose(shown[active].zone);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (search.value) {
        search.value = "";
        filter();
      } else {
        close();
        trigger.focus();
      }
    }
  });
  // Leaving the picker (Tab, or a click elsewhere) closes it.
  root.addEventListener("focusout", (event) => {
    if (!panel.hidden && !root.contains(event.relatedTarget)) {
      close();
    }
  });

  // Keep "the time there now" current while the page is open.
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
    } else if (panel.hidden) {
      paintSummary();
    }
  }, 30_000);

  paintSummary();
  return root;
}

function birthdayCard(data, postable, defaults) {
  const saved = data.settings.birthdays ?? {};
  const roles = data.roles
    .filter((role) => role.id !== data.guild.id && !role.managed && (BigInt(role.permissions ?? 0) & BIRTHDAY_ROLE_FORBIDDEN) === 0n)
    .map((role) => roleItem(role));
  return card(
    t("sectionBirthdays"),
    "cake",
    "pink",
    h(
      "div",
      { class: "rule-body" },
      field("birthdayChannel", "birthdayChannelHelp", picker({ id: "birthdayChannelId", options: postable, value: saved.channelId, emptyLabel: t("communityOff") })),
      field("birthdayRole", "birthdayRoleHelp", picker({ id: "birthdayRoleId", options: roles, value: saved.roleId, emptyLabel: t("communityOff") })),
    ),
    timeZonePicker({ id: "birthdayTimezone", value: saved.timezone ?? "UTC", labelKey: "birthdayTimezone", helpKey: "birthdayTimezoneHelp" }),
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
    .map((role) => roleItem(role, { dot: true }));
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
          items: data.roles.filter((role) => !role.managed).map((role) => roleItem(role, { dot: true })),
          checked: persist.ignoredRoleIds ?? [],
          filterKey: "filterRoles",
        }),
      ),
      card(
        t("sectionRoleConfirm"),
        "check",
        "blue",
        h(
          "label",
          { class: "switch-card" },
          h("span", { class: "switch-text" }, h("strong", {}, t("roleConfirmDefault")), h("span", { class: "help" }, t("roleConfirmDefaultHelp"))),
          h(
            "span",
            { class: "switch" },
            h("input", { id: "roleConfirmDefault", type: "checkbox", role: "switch", checked: data.settings.roleConfirmations !== false, "aria-label": t("roleConfirmDefault") }),
          ),
        ),
      ),
    ],
    fields: {
      autoroleIds: checkedList("autorole"),
      rolePersist: readRolePersist,
      // On is the default, saved as no value.
      roleConfirmations: (form) => (form.querySelector("#roleConfirmDefault").checked ? null : false),
    },
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
          field(
            "starboardEmoji",
            "starboardEmojiHelp",
            emojiInput(data, { id: "starboardEmoji", value: starboard.emoji ?? STARBOARD_DEFAULTS.emoji, placeholder: STARBOARD_DEFAULTS.emoji }),
          ),
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
const cleanResponderTrigger = (text) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function readResponders(form) {
  const responders = [...form.querySelectorAll(".responder-row")]
    .map((row) => ({
      trigger: cleanResponderTrigger(row.querySelector(".responder-trigger").value),
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
  // Replaces every row (loading saved values again).
  const set = (values) => {
    list.replaceChildren(...values.map((item) => makeRow(item, remove)));
    update();
  };
  // Adds one filled-in row (from a template) and returns it, or null when the list is full.
  const add = (item) => {
    if (list.children.length >= max) {
      return null;
    }
    const row = makeRow(item, remove);
    list.append(row);
    update();
    list.dispatchEvent(new Event("input", { bubbles: true }));
    return row;
  };
  set(items);
  return { list, count, empty, addButton, set, add };
}

// "Start from a template": a card of ready-made entries. `preview(item)` is the
// short line under each title (the command or the trigger), `body(item)` the
// text it posts. `onUse(template, item)` adds it to the page's list.
function templateCard({ templates, makeItem, helpKey, exampleKey, preview, body, onUse }) {
  const tiles = templates.map((template) => {
    const item = makeItem(template);
    return h(
      "li",
      { class: "template-tile" },
      h(
        "div",
        { class: "template-head" },
        h("span", { class: "template-icon", "aria-hidden": "true" }, template.icon),
        h("span", { class: "template-text grow" }, h("strong", {}, t(`${template.kind}_${template.id}_title`)), h("span", { class: "template-preview", title: preview(item) }, preview(item))),
        h("button", { class: "ghost small", type: "button", onclick: () => onUse(makeItem(template)) }, t("tplUse")),
      ),
      // Bold markers would show as stars here; Discord shows them as bold.
      h("p", { class: "template-body" }, body(item).replaceAll("**", "")),
    );
  });
  return card(
    t("tplHeading"),
    "sparkles",
    "purple",
    h("p", { class: "help" }, t(helpKey)),
    h("p", { class: "template-example" }, t(exampleKey)),
    h("ul", { class: "template-grid" }, tiles),
  );
}

// Puts a template's row in front of the person: scrolled to, highlighted and focused.
function showTemplateRow(row, focus) {
  row.classList.add("template-new");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.querySelector(focus)?.focus({ preventScroll: true });
  setTimeout(() => row.classList.remove("template-new"), 2000);
}

// Adds a template to an editable list unless the same entry (by `key`) is already there.
function useTemplate(list, item, { existing, focus }) {
  const match = existing().find((entry) => entry.key === item.key);
  if (match) {
    toast(t("tplExists"), "error");
    showTemplateRow(match.row, focus);
    return;
  }
  const row = list.add(item.value);
  if (!row) {
    toast(t("tplFull"), "error");
    return;
  }
  showTemplateRow(row, focus);
  toast(t("tplAdded"));
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
      templateCard({
        templates: TAG_TEMPLATES.map((template) => ({ ...template, kind: "tagTpl" })),
        makeItem: (template) => tagFromTemplate(template, t),
        helpKey: "tplTagsHelp",
        exampleKey: "tagsExample",
        preview: (tag) => `/tag ${tag.name}`,
        body: (tag) => tag.content,
        onUse: (tag) =>
          useTemplate(tags, { key: tag.name, value: tag }, {
            focus: ".tag-content",
            existing: () =>
              [...tags.list.querySelectorAll(".tag-row")].map((row) => {
                const typed = row.querySelector(".tag-name").value;
                return { row, key: cleanTagName(typed) || typed.trim() };
              }),
          }),
      }),
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
    .map((channel) => channelItem(channel, data.channels));
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
      templateCard({
        templates: RESPONDER_TEMPLATES.map((template) => ({ ...template, kind: "respTpl" })),
        makeItem: (template) => responderFromTemplate(template, t),
        helpKey: "tplRespondersHelp",
        exampleKey: "respondersExample",
        preview: (responder) => `“${responder.trigger}” · ${t(`responderMatch_${responder.match}`)}`,
        body: (responder) => responder.reply,
        onUse: (responder) =>
          useTemplate(responders, { key: cleanResponderTrigger(responder.trigger), value: responder }, {
            focus: ".responder-reply",
            existing: () =>
              [...responders.list.querySelectorAll(".responder-row")].map((row) => ({
                row,
                key: cleanResponderTrigger(row.querySelector(".responder-trigger").value),
              })),
          }),
      }),
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
    setBusy(remove, true);
    try {
      await api(`/api/guilds/${guildId}/scheduled/${message.id}`, { method: "DELETE" });
      toast(t("scheduledDeleted"));
      onDeleted();
    } catch (error) {
      setBusy(remove, false);
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
        setBusy(submit, true);
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
          setBusy(submit, false);
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

// The XP leaderboard, a page at a time, below the settings: all time, or
// the XP earned in the last 7 or 30 days.
const LEADERBOARD_PERIODS = ["all", "week", "month"];

async function leaderboardCard(guildId, page, period) {
  const board = await api(`/api/guilds/${guildId}/levels?page=${page}&period=${period}`);
  const pages = Math.max(1, Math.ceil(board.total / board.pageSize));
  const go = (next, nextPeriod = period) => {
    const query = new URLSearchParams();
    if (next > 1) {
      query.set("page", String(next));
    }
    if (nextPeriod !== "all") {
      query.set("period", nextPeriod);
    }
    return `#/g/${guildId}/levels${query.size > 0 ? `?${query}` : ""}`;
  };
  const rows =
    board.entries.length === 0
      ? h("p", { class: "muted empty" }, t(period === "all" ? "levelsBoardEmpty" : "levelsBoardEmptyPeriod"))
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
                h(
                  "span",
                  { class: "muted" },
                  period === "all"
                    ? t("levelsBoardSub", { xp: formatNumber(entry.xp), messages: formatNumber(entry.messages) })
                    : t("levelsBoardGained", { gained: formatNumber(entry.gained ?? 0), xp: formatNumber(entry.xp) }),
                ),
              ),
              h("span", { class: "progress board-progress", title: `${formatNumber(entry.current)} / ${formatNumber(entry.needed)} XP` }, fillBar("progress-fill", entry.current / entry.needed)),
              h("span", { class: "badge badge-green" }, t("levelsLevel", { level: entry.level })),
            ),
          ),
        );
  const tabs = h(
    "div",
    { class: "segmented", role: "tablist", "aria-label": t("levelsBoard") },
    LEADERBOARD_PERIODS.map((value) =>
      h("a", { class: "button segment", role: "tab", href: go(1, value), "aria-selected": String(value === period), "aria-pressed": String(value === period) }, t(`levelsPeriod_${value}`)),
    ),
  );
  return card(
    t("levelsBoard"),
    "trophy",
    "amber",
    h("div", { class: "toolbar board-head" }, h("p", { class: "help grow" }, t(period === "all" ? "levelsBoardHelp" : `levelsBoardHelp_${period}`, { count: formatNumber(board.total) })), tabs),
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
  const period = LEADERBOARD_PERIODS.includes(query.get("period")) ? query.get("period") : "all";
  const config = data.settings.leveling;
  const defaults = data.communityDefaults ?? {};
  // Reward roles: the bot never hands out bot roles or Administrator / Manage Server.
  const givable = data.roles
    .filter((role) => !role.managed && (BigInt(role.permissions ?? 0) & AUTOROLE_FORBIDDEN) === 0n)
    .map((role) => roleItem(role));
  const roles = data.roles.filter((role) => !role.managed).map((role) => roleItem(role, { mention: false, dot: true }));
  const channels = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => channelItem(channel, data.channels));

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
    makeRow: (boost, removeBoost) => boostRow(boost ?? {}, roles.map((role) => ({ ...role, label: `@${role.label}` })), removeBoost),
    focus: "select",
    emptyKey: "levelsBoostsNone",
    addKey: "levelsBoostAdd",
  });

  const board = await leaderboardCard(guildId, page, period).catch((error) => {
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

// The parts of the country guide members read, with their size limits (as
// countries/guide.js checks them). The buttons are the bot's and can't be changed.
const GUIDE_PARTS = [
  { part: "title", max: 256, rows: 0 },
  { part: "intro", max: 1000, rows: 3 },
  { part: "stepsTitle", max: 256, rows: 0 },
  { part: "steps", max: 1000, rows: 4 },
  { part: "notesTitle", max: 256, rows: 0 },
  { part: "notes", max: 600, rows: 5 },
];
const guideInputId = (part) => `guide-${part}`;

// The guide's wording from the form: only what differs from the built-in text.
function readCountryGuide(form, defaults) {
  const guide = {};
  GUIDE_PARTS.forEach(({ part }) => {
    const text = form.querySelector(`#${guideInputId(part)}`).value.replace(/\r\n?/g, "\n").trim();
    if (text && text !== defaults[part]) {
      guide[part] = text;
    }
  });
  const color = colorNumber(form.querySelector("#guideColor").value);
  if (color !== defaults.color) {
    guide.color = color;
  }
  return Object.keys(guide).length > 0 ? guide : null;
}

// The guide as members will see it, with its fixed buttons.
function countryGuidePreview(form, data, info, isCountryChannel) {
  const value = (part) => form.querySelector(`#${guideInputId(part)}`).value.trim() || info.defaults[part];
  const notes = [value("notes"), info.fallbackNote, isCountryChannel ? info.channelNote : null].filter(Boolean).join("\n");
  const message = embedPreview(
    {
      content: "",
      embed: {
        title: value("title"),
        url: "",
        description: value("intro"),
        color: colorNumber(form.querySelector("#guideColor").value),
        author: { name: "", icon_url: "" },
        footer: { text: "" },
        image: { url: "" },
        thumbnail: { url: "" },
        fields: [
          { name: value("stepsTitle"), value: value("steps"), inline: false },
          { name: value("notesTitle"), value: notes, inline: false },
        ],
      },
    },
    data,
  );
  message.querySelectorAll("[data-color]").forEach((element) => element.style.setProperty("--embed-color", element.dataset.color || "transparent"));
  message.querySelector(".discord-body").append(
    h(
      "div",
      { class: "discord-buttons", "aria-label": t("countryButtonsLocked") },
      info.buttons.map((row) =>
        h(
          "div",
          { class: "discord-button-row" },
          row.map((button) => h("span", { class: `discord-button${button.primary ? " primary" : ""}` }, button.emoji ? h("span", { "aria-hidden": "true" }, button.emoji) : null, button.label)),
        ),
      ),
    ),
  );
  return message;
}

async function showCountry(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const info = data.countryGuide;
  const guide = data.settings.countryGuide ?? {};
  const savedColor = hexColor(guide.color ?? info.defaults.color);

  const guideInputs = GUIDE_PARTS.map(({ part, max, rows }) => {
    // Filled with the text members see now, so it can be edited in place.
    const text = guide[part] ?? info.defaults[part];
    const attributes = { id: guideInputId(part), maxLength: max };
    const control =
      rows === 0
        ? h("input", { ...attributes, type: "text", value: text })
        : h("textarea", { ...attributes, rows: Math.max(rows, text.split("\n").length + 1), class: "autosize" }, text);
    return field(`guide_${part}`, part === "notes" ? "guide_notesHelp" : null, control);
  });
  const colorInput = h("input", { id: "guideColor", type: "color", value: savedColor, "aria-label": t("embedColor") });
  const swatches = EMBED_SWATCHES.map((swatch) => {
    const button = h("button", {
      type: "button",
      class: "swatch",
      title: swatch,
      "aria-label": swatch,
      onclick: () => {
        colorInput.value = swatch;
        colorInput.dispatchEvent(new Event("input", { bubbles: true }));
      },
    });
    button.style.setProperty("--swatch", swatch);
    return button;
  });
  const resetGuide = h(
    "button",
    {
      type: "button",
      class: "ghost small",
      onclick: () => {
        GUIDE_PARTS.forEach(({ part }) => {
          document.getElementById(guideInputId(part)).value = info.defaults[part];
        });
        colorInput.value = hexColor(info.defaults.color);
        colorInput.dispatchEvent(new Event("input", { bubbles: true }));
      },
    },
    icon("refresh", "icon small"),
    h("span", {}, t("countryGuideReset")),
  );

  // Posting: where the guide goes, and where the last one is.
  const postChannel = picker({ id: "guidePostChannel", options: postableChannels(data), value: info.post?.channelId ?? data.settings.countryChannelId ?? null, emptyLabel: t("embedPickChannel") });
  const postedLine = h("p", { class: "help" });
  const showPosted = () => {
    const channel = data.channels.find((entry) => entry.id === info.post?.channelId);
    postedLine.replaceChildren(
      ...(info.post
        ? [
            t("countryGuidePostedIn", { channel: channel ? `#${channel.name}` : t("embedUnknownChannel") }),
            " ",
            h("a", { href: `https://discord.com/channels/${guildId}/${info.post.channelId}/${info.post.messageId}`, target: "_blank", rel: "noopener noreferrer" }, t("countryGuideOpen")),
          ]
        : [t("countryGuideNotPosted")]),
    );
  };
  showPosted();
  const postButton = h(
    "button",
    {
      type: "button",
      class: "primary",
      onclick: async () => {
        if (state.unsaved) {
          toast(t("countryGuideSaveFirst"), "error");
          return;
        }
        const channelId = postChannel.value;
        if (!channelId) {
          toast(t("embedPickChannel"), "error");
          return;
        }
        setBusy(postButton, true);
        try {
          const result = await api(`/api/guilds/${guildId}/country-guide`, { method: "POST", body: { channelId } });
          info.post = result.post;
          state.cache = null;
          showPosted();
          toast(t("countryGuidePosted"));
        } catch (error) {
          failed(error);
        } finally {
          setBusy(postButton, false);
        }
      },
    },
    icon("upload", "icon small"),
    h("span", {}, t("countryGuidePost")),
  );

  const preview = h("div", { class: "embed-preview" });
  const guideCard = card(
    t("countryGuideTitle"),
    "edit",
    "purple",
    h("p", { class: "help" }, t("countryGuideHelp")),
    h("div", { class: "embed-color-row" }, h("span", { class: "field-label" }, t("embedColor")), colorInput, h("div", { class: "swatches" }, swatches)),
    guideInputs,
    h("div", { class: "toolbar" }, resetGuide),
  );
  const previewCard = card(
    t("countryGuidePreview"),
    "eye",
    "green",
    preview,
    h("p", { class: "tip" }, icon("lock"), h("span", {}, t("countryButtonsLocked"))),
  );
  const postCard = card(
    t("countryGuidePostTitle"),
    "upload",
    "blue",
    h("p", { class: "help" }, t("countryGuidePostHelp")),
    field("countryGuidePostChannel", null, postChannel),
    postedLine,
    h("div", { class: "toolbar" }, postButton),
  );

  settingsPage({
    data,
    pageId: "country",
    intro: t("countryIntro"),
    cards: [
      card(
        t("countryWhere"),
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
        field("staffRole", "countryStaffRoleHelp", picker({ id: "countryStaffRoleId", options: roleOptions(data), value: data.settings.staffRoleId, emptyLabel: t("notSet") })),
      ),
      h("div", { class: "embed-layout" }, h("div", {}, guideCard, postCard), h("div", { class: "embed-side" }, previewCard)),
    ],
    fields: {
      countryChannelId: selectValue("countryChannelId"),
      staffRoleId: selectValue("countryStaffRoleId"),
      countryGuide: (form) => readCountryGuide(form, info.defaults),
    },
  });

  const form = main.querySelector("form.settings");
  const drawPreview = () => {
    const countryChannelId = form.querySelector("#countryChannelId").value;
    // The guide usually goes in the /country channel.
    if (!postChannel.value && countryChannelId) {
      postChannel.value = countryChannelId;
    }
    const target = postChannel.value || info.post?.channelId;
    preview.replaceChildren(countryGuidePreview(form, data, info, Boolean(countryChannelId) && target === countryChannelId));
  };
  form.addEventListener("input", drawPreview);
  form.addEventListener("change", drawPreview);
  drawPreview();
}

// Every Discord permission by bit, for the permission groups on the
// Permissions page. Staff permissions come first, most powerful first; they
// match permissions/moderatorPermissions.js plus the voice moderation ones.
const PERMISSION_BITS = {
  0: "CreateInstantInvite", 1: "KickMembers", 2: "BanMembers", 4: "ManageChannels", 5: "ManageGuild", 6: "AddReactions",
  7: "ViewAuditLog", 8: "PrioritySpeaker", 9: "Stream", 10: "ViewChannel", 11: "SendMessages", 12: "SendTTSMessages",
  13: "ManageMessages", 14: "EmbedLinks", 15: "AttachFiles", 16: "ReadMessageHistory", 17: "MentionEveryone",
  18: "UseExternalEmojis", 19: "ViewGuildInsights", 20: "Connect", 21: "Speak", 22: "MuteMembers", 23: "DeafenMembers",
  24: "MoveMembers", 25: "UseVAD", 26: "ChangeNickname", 27: "ManageNicknames", 28: "ManageRoles", 29: "ManageWebhooks",
  30: "ManageGuildExpressions", 31: "UseApplicationCommands", 32: "RequestToSpeak", 33: "ManageEvents", 34: "ManageThreads",
  35: "CreatePublicThreads", 36: "CreatePrivateThreads", 37: "UseExternalStickers", 38: "SendMessagesInThreads",
  39: "UseEmbeddedActivities", 40: "ModerateMembers", 41: "ViewCreatorMonetizationAnalytics", 42: "UseSoundboard",
  43: "CreateGuildExpressions", 44: "CreateEvents", 45: "UseExternalSounds", 46: "SendVoiceMessages",
  48: "SetVoiceChannelStatus", 49: "SendPolls", 50: "UseExternalApps", 51: "PinMessages", 52: "BypassSlowmode",
};
const STAFF_PERMISSION_BITS = [5, 28, 4, 2, 1, 40, 13, 27, 34, 51, 29, 30, 33, 7, 17, 22, 23, 24].map(BigInt);
const permissionLabel = (bit) => (PERMISSION_BITS[bit] ? t(`permBit_${PERMISSION_BITS[bit]}`) : t("permBitUnknown", { bit: String(bit) }));

// A role's permission value split into Administrator, staff permissions and
// everyday ones (bits Discord adds later show as "Unknown permission").
function describePermissions(bits) {
  const has = (bit) => (bits & (1n << bit)) !== 0n;
  const staff = STAFF_PERMISSION_BITS.filter(has);
  const everyday = [];
  for (let bit = 0n; bits >> bit > 0n; bit += 1n) {
    if (has(bit) && bit !== ADMINISTRATOR && !STAFF_PERMISSION_BITS.includes(bit)) {
      everyday.push(bit);
    }
  }
  return { admin: has(ADMINISTRATOR), staff, everyday };
}

// How many groups show before "Show more", how many role names a closed group
// previews, and how many an open group lists before "Show all".
const GROUPS_PER_PAGE = 8;
const PREVIEW_ROLES = 6;
const OPEN_ROLES = 40;
const ROLE_GROUP_KINDS = ["admin", "power", "basic"];

// Every role, grouped by its exact permissions: roles that can do exactly the
// same things share one row, so dozens of country or color roles are one line.
// Groups are sorted Administrator, staff permissions, then everything else,
// each by its highest role. A search (role or permission names) and a filter
// narrow it down, and the list is paged so it never turns into a long scroll.
function rolesTable(data) {
  const { settings } = data;
  const usedAs = (role) =>
    [
      role.id === settings.staffRoleId ? "usedStaff" : null,
      role.id === settings.modRoleId ? "usedMod" : null,
      (settings.dashboardRoleIds ?? []).includes(role.id) ? "usedDashboard" : null,
    ].filter(Boolean);
  const nameOf = (role) => (role.emoji ? `${role.emoji} ${role.name}` : role.name);

  // data.roles is sorted highest first, so a group's first role is its highest.
  const byBits = new Map();
  for (const role of data.roles) {
    let bits;
    try {
      bits = BigInt(role.permissions ?? 0);
    } catch {
      bits = 0n;
    }
    const key = bits.toString();
    if (!byBits.has(key)) {
      const described = describePermissions(bits);
      const names = [described.admin ? t("permAdmin") : null, ...[...described.staff, ...described.everyday].map(permissionLabel)].filter(Boolean);
      byBits.set(key, {
        key,
        bits,
        ...described,
        kind: described.admin ? "admin" : described.staff.length > 0 ? "power" : "basic",
        permissionSearch: searchable(names.join(" ")),
        roles: [],
      });
    }
    const used = usedAs(role);
    byBits.get(key).roles.push({ role, used, search: searchable(nameOf(role)) });
  }
  // A stable sort, so each kind keeps Discord's order (highest role first).
  const groups = [...byBits.values()].sort((a, b) => ROLE_GROUP_KINDS.indexOf(a.kind) - ROLE_GROUP_KINDS.indexOf(b.kind));

  const roleMatchesKind = (entry, group, kind) => {
    switch (kind) {
      case "all":
        return true;
      case "bot":
        return entry.role.managed;
      case "used":
        return entry.used.length > 0;
      case "country":
        return Boolean(entry.role.country);
      default:
        return group.kind === kind;
    }
  };
  const kindsPresent = ["all", ...ROLE_GROUP_KINDS.filter((kind) => groups.some((group) => group.kind === kind))];
  for (const extra of ["bot", "used", "country"]) {
    if (groups.some((group) => group.roles.some((entry) => roleMatchesKind(entry, group, extra)))) {
      kindsPresent.push(extra);
    }
  }

  const opened = new Set();
  const allRolesShown = new Set();
  let limit = GROUPS_PER_PAGE;

  const roleChip = (entry) =>
    h(
      "span",
      { class: "role-chip" },
      roleDot(entry.role),
      h("span", {}, nameOf(entry.role)),
      entry.role.managed ? h("span", { class: "badge" }, t("roleBot")) : null,
      entry.used.map((key) => h("span", { class: "badge badge-accent" }, t(key))),
    );
  const moreChip = (count) => h("span", { class: "role-chip more" }, t("morePermissions", { count }));

  const permissionBadges = (group) => {
    if (group.admin) {
      return [h("span", { class: "badge badge-red" }, t("permAdmin"))];
    }
    const badges = group.staff.slice(0, 3).map((bit) => h("span", { class: "badge badge-amber" }, permissionLabel(bit)));
    if (group.staff.length > 3) {
      badges.push(h("span", { class: "badge badge-amber" }, t("morePermissions", { count: group.staff.length - 3 })));
    }
    if (group.everyday.length > 0) {
      badges.push(h("span", { class: "muted perm-group-everyday" }, t("permGroupEverydayCount", { count: group.everyday.length })));
    } else if (group.staff.length === 0) {
      badges.push(h("span", { class: "muted perm-group-everyday" }, t("permGroupNone")));
    }
    return badges;
  };

  const groupRow = (group, roles) => {
    const filtered = roles.length < group.roles.length;
    const preview = roles.slice(0, PREVIEW_ROLES).map(roleChip);
    const body = h("div", { class: "perm-group-body" });
    const details = h(
      "details",
      { class: `perm-group kind-${group.kind}`, open: opened.has(group.key) },
      h(
        "summary",
        {},
        h(
          "span",
          { class: "perm-group-head" },
          h("span", { class: "badges" }, permissionBadges(group)),
          h(
            "span",
            { class: "count-pill", title: t("permGroupRolesIn") },
            filtered ? t("rolesShown", { shown: roles.length, total: group.roles.length }) : t("permGroupRoleCount", { count: group.roles.length }),
          ),
        ),
        h("span", { class: "role-chips perm-group-preview" }, preview, roles.length > PREVIEW_ROLES ? moreChip(roles.length - PREVIEW_ROLES) : null),
      ),
      body,
    );
    const drawBody = () => {
      const showAll = allRolesShown.has(group.key) || roles.length <= OPEN_ROLES;
      const permissionList = (titleKey, bits, tone) =>
        bits.length > 0
          ? h(
              "div",
              { class: "perm-group-list" },
              h("h4", {}, t(titleKey)),
              h("div", { class: "badges" }, bits.map((bit) => h("span", { class: `badge ${tone}` }, permissionLabel(bit)))),
            )
          : null;
      body.replaceChildren(
        h("h4", {}, t("permGroupRolesIn")),
        h(
          "div",
          { class: "role-chips" },
          (showAll ? roles : roles.slice(0, OPEN_ROLES)).map(roleChip),
          showAll
            ? null
            : h(
                "button",
                {
                  type: "button",
                  class: "button ghost small",
                  onclick: () => {
                    allRolesShown.add(group.key);
                    drawBody();
                  },
                },
                t("permGroupShowAllRoles", { count: roles.length }),
              ),
        ),
        group.admin
          ? h("p", { class: "tip" }, icon("shield"), h("span", {}, t("permGroupAdminNote")))
          : h(
              "div",
              { class: "perm-group-lists" },
              permissionList("permGroupStaffPermissions", group.staff, "badge-amber"),
              permissionList("permGroupEverydayPermissions", group.everyday, ""),
              group.staff.length === 0 && group.everyday.length === 0 ? h("p", { class: "muted" }, t("permGroupNoneHelp")) : null,
            ),
      );
    };
    details.addEventListener("toggle", () => {
      if (details.open) {
        opened.add(group.key);
        if (body.childElementCount === 0) {
          drawBody();
        }
      } else {
        opened.delete(group.key);
      }
    });
    if (details.open) {
      drawBody();
    }
    return details;
  };

  const list = h("div", { class: "perm-groups" });
  const summary = h("span", { class: "count-pill" });
  const search = h("input", { type: "search", class: "grow", placeholder: t("filterRolesOrPermissions"), "aria-label": t("filterRolesOrPermissions") });
  const kind = h("select", { "aria-label": t("roleKind"), class: "auto" }, kindsPresent.map((value) => h("option", { value }, t(`roleKind_${value}`))));

  const draw = () => {
    const words = searchWords(search.value);
    const matches = [];
    for (const group of groups) {
      // Words can be role or permission names: "mod ban" finds Moderator roles that can ban.
      const roles = group.roles.filter(
        (entry) => roleMatchesKind(entry, group, kind.value) && matchesWords(`${entry.search} ${group.permissionSearch}`, words),
      );
      if (roles.length > 0) {
        matches.push({ group, roles });
      }
    }
    const shownRoles = matches.reduce((sum, match) => sum + match.roles.length, 0);
    summary.textContent = t("permGroupSummary", { roles: shownRoles, groups: matches.length });

    const children = [];
    let section = null;
    for (const { group, roles } of matches.slice(0, limit)) {
      if (group.kind !== section) {
        section = group.kind;
        const inSection = matches.filter((match) => match.group.kind === section);
        children.push(h("h3", { class: "perm-group-section" }, t(`roleKind_${section}`), h("span", { class: "muted" }, ` · ${inSection.length}`)));
      }
      children.push(groupRow(group, roles));
    }
    if (matches.length === 0) {
      children.push(h("p", { class: "muted empty" }, t("nothingMatches")));
    }
    const left = matches.length - limit;
    if (left > 0) {
      children.push(
        h(
          "div",
          { class: "perm-group-more" },
          h(
            "button",
            {
              type: "button",
              class: "button ghost small",
              onclick: () => {
                limit += GROUPS_PER_PAGE;
                draw();
              },
            },
            t("permGroupShowMore", { count: Math.min(left, GROUPS_PER_PAGE) }),
          ),
          h("span", { class: "muted" }, t("rolesShown", { shown: limit, total: matches.length })),
        ),
      );
    }
    list.replaceChildren(...children);
  };
  const refilter = () => {
    limit = GROUPS_PER_PAGE;
    draw();
  };
  search.addEventListener("input", refilter);
  filterKeys(search, refilter);
  kind.addEventListener("change", refilter);
  draw();

  return card(
    t("allRoles"),
    "tag",
    "blue",
    h("p", { class: "help" }, t("allRolesHelp")),
    h("div", { class: "toolbar" }, search, kind, summary),
    list,
  );
}

// --- Permissions -------------------------------------------------------------------

const PRESETS = ["adminsOnly", "oneTeam", "twoTeams"];
const PRESET_ROLES = { adminsOnly: [], oneTeam: ["moderator"], twoTeams: ["moderator", "helper"] };
const RECOMMENDED_PRESET = "oneTeam";
// The commands helpers get in the two-team setup (permissions/presets.js).
const HELPER_COMMANDS = ["case", "modlogs", "note", "purge", "slowmode", "timeout", "untimeout", "warn"];
// Discord permission bits, for "Needs Ban Members" on commands.
const PERMISSION_NAMES = [
  { key: "permAdmin", bit: ADMINISTRATOR },
  ...PERMISSIONS,
  { key: "permManageNicknames", bit: 27n },
];
const COMMANDS_WITH_OWN_ROLE = { "country-staff": "staff" };
// The commands the mod role can use (they check it besides Discord's permission).
const MODERATION_COMMANDS = ["ban", "unban", "kick", "softban", "timeout", "untimeout", "warn", "note", "purge", "case", "modlogs", "lock", "unlock", "slowmode", "role", "nick", "quarantine", "temprole", "giveaway", "tags"];

const permissionName = (bits) => {
  const value = BigInt(bits);
  const names = PERMISSION_NAMES.filter((entry) => (value & (1n << entry.bit)) !== 0n).map((entry) => t(entry.key));
  return names.join(", ");
};
const roleName = (data, id) => {
  const role = data.roles.find((entry) => entry.id === id);
  return role ? `@${role.name}` : t("unknownOption", { id });
};
const channelName = (data, id) => {
  const channel = data.channels.find((entry) => entry.id === id);
  return channel ? channelLabel(channel, data.channels) : t("unknownOption", { id });
};
const presetName = (preset) => t(preset ? `permPreset_${preset}` : "permPresetNone");

function emptyRule() {
  return { disabled: false, roleIds: [], blockedRoleIds: [], channelIds: [] };
}

// The rules without empty ones, or null, the way the server saves them.
function cleanRules(rules) {
  const kept = Object.entries(rules).filter(
    ([, rule]) => rule.disabled || rule.roleIds.length > 0 || rule.blockedRoleIds.length > 0 || rule.channelIds.length > 0,
  );
  return kept.length > 0 ? Object.fromEntries(kept.map(([name, rule]) => [name, { ...rule }])) : null;
}

// A saved setting, in words, for the "what will change" list.
function describePermissionSetting(setting, value, data) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return t("permValueNone");
  }
  switch (setting) {
    case "modRoleId":
    case "staffRoleId":
      return roleName(data, value);
    case "dashboardRoleIds":
      return value.map((id) => roleName(data, id)).join(", ");
    case "permissionPreset":
      return presetName(value);
    case "commandRules": {
      const given = Object.entries(value).filter(([, rule]) => rule.roleIds.length > 0);
      return given.length > 0
        ? given.map(([name, rule]) => `/${name}: ${rule.roleIds.map((id) => roleName(data, id)).join(", ")}`).join(" · ")
        : t("permValueNoGrants");
    }
    default:
      return String(value);
  }
}

// The two tabs at the top of the page.
function permissionTabs(guildId, current) {
  return h(
    "div",
    { class: "segmented perm-tabs", role: "tablist", "aria-label": t("permTabs") },
    ["simple", "advanced"].map((tab) =>
      h(
        "a",
        {
          class: "button segment",
          role: "tab",
          href: `#/g/${guildId}/access${tab === "simple" ? "" : `?tab=${tab}`}`,
          "aria-selected": String(tab === current),
          "aria-pressed": String(tab === current),
        },
        icon(tab === "simple" ? "sparkles" : "sliders", "icon small"),
        t(`permTab_${tab}`),
      ),
    ),
  );
}

const lockedTip = (data) =>
  data.canManagePermissions ? null : h("p", { class: "tip" }, icon("lock"), h("span", {}, t("permOwnerOnly")));

// Which commands a role needs added under Integrations so Discord shows them.
function nativeHint(data, preset, roles) {
  const needsPermission = (name) => data.commands.some((command) => command.name === name && command.roleMode === "grant");
  const moderation = data.commands.filter((command) => command.roleMode === "grant" && MODERATION_COMMANDS.includes(command.name)).map((command) => command.name);
  const rows = [];
  if (roles.moderator && preset !== "adminsOnly") {
    rows.push([roles.moderator, moderation]);
  }
  if (roles.helper && preset === "twoTeams") {
    rows.push([roles.helper, HELPER_COMMANDS.filter(needsPermission)]);
  }
  return card(
    t("permNativeTitle"),
    "eye",
    "blue",
    h("p", { class: "help" }, t("permNativeHelp")),
    rows.length > 0
      ? h(
          "ul",
          { class: "change-list" },
          rows.map(([roleId, names]) =>
            h("li", {}, h("strong", {}, roleName(data, roleId)), h("span", { class: "command-chips" }, names.map((name) => h("code", {}, `/${name}`)))),
          ),
        )
      : null,
  );
}

function showSimplePermissions(data) {
  const guildId = data.guild.id;
  const settings = data.settings;
  const roles = roleOptions(data).filter((option) => !data.roles.find((role) => role.id === option.id)?.managed);
  let preset = PRESETS.includes(settings.permissionPreset) ? settings.permissionPreset : RECOMMENDED_PRESET;
  const chosen = { moderator: settings.modRoleId ?? "", helper: settings.permissionPreset === "twoTeams" ? (settings.staffRoleId ?? "") : "" };

  const moderatorPicker = picker({ id: "permModerator", options: roles, value: chosen.moderator, emptyLabel: t("permPickRole") });
  const helperPicker = picker({ id: "permHelper", options: roles, value: chosen.helper, emptyLabel: t("permPickRole") });
  const moderatorField = field("permRole_moderator", "permRoleHelp_moderator", moderatorPicker);
  const helperField = field("permRole_helper", "permRoleHelp_helper", helperPicker);
  const review = h("div", { class: "perm-review", hidden: true });
  const hint = h("div");
  const previewButton = h("button", { class: "primary", type: "button" }, icon("eye", "icon small"), t("permPreview"));

  const update = () => {
    chosen.moderator = moderatorPicker.value;
    chosen.helper = helperPicker.value;
    moderatorField.hidden = !PRESET_ROLES[preset].includes("moderator");
    helperField.hidden = !PRESET_ROLES[preset].includes("helper");
    review.hidden = true;
    hint.replaceChildren(nativeHint(data, preset, chosen));
  };

  const options = PRESETS.map((value) =>
    h(
      "label",
      { class: "preset-option" },
      h("input", { type: "radio", name: "preset", value, checked: value === preset }),
      h(
        "span",
        { class: "preset-text" },
        h("strong", {}, t(`permPreset_${value}`), value === RECOMMENDED_PRESET ? h("span", { class: "badge badge-green" }, t("permRecommended")) : null),
        h("span", { class: "help" }, t(`permPresetHelp_${value}`)),
        h("ul", { class: "preset-points" }, [1, 2, 3].map((index) => h("li", {}, t(`permPresetPoint_${value}_${index}`)))),
      ),
    ),
  );
  const optionGrid = h("div", { class: "preset-grid", role: "radiogroup", "aria-label": t("permChoose") }, options);
  optionGrid.addEventListener("change", (event) => {
    if (event.target.name === "preset") {
      preset = event.target.value;
      update();
    }
  });
  moderatorPicker.addEventListener("change", update);
  helperPicker.addEventListener("change", update);

  const body = () => ({ preset, roles: Object.fromEntries(PRESET_ROLES[preset].map((kind) => [kind, chosen[kind] || null])) });

  function showPlan(plan) {
    if (plan.changes.length === 0) {
      review.replaceChildren(h("p", { class: "muted" }, t("permNothingToChange")));
      review.hidden = false;
      return;
    }
    const apply = h("button", { class: "primary", type: "button" }, icon("check", "icon small"), t("permApply"));
    apply.addEventListener("click", async () => {
      setBusy(apply, true);
      try {
        await api(`/api/guilds/${guildId}/permissions/preset`, { method: "POST", body: { ...body(), dryRun: false } });
        toast(t("permApplied"));
        state.cache = null;
        route();
      } catch (error) {
        failed(error);
        setBusy(apply, false);
      }
    });
    review.replaceChildren(
      h("h3", {}, t("permPreviewTitle")),
      h(
        "ul",
        { class: "change-list" },
        plan.changes.map((change) =>
          h(
            "li",
            {},
            h("strong", {}, t(`permSetting_${change.setting}`)),
            h(
              "span",
              { class: "change-values" },
              h("span", { class: "muted" }, describePermissionSetting(change.setting, change.before, data)),
              h("span", { "aria-hidden": "true" }, " → "),
              h("span", {}, describePermissionSetting(change.setting, change.after, data)),
            ),
          ),
        ),
      ),
      h("div", { class: "toolbar" }, h("span", { class: "grow" }), apply),
    );
    review.hidden = false;
  }

  previewButton.addEventListener("click", async () => {
    setBusy(previewButton, true);
    try {
      showPlan(await api(`/api/guilds/${guildId}/permissions/preset`, { method: "POST", body: body() }));
    } catch (error) {
      failed(error);
    } finally {
      setBusy(previewButton, false);
      previewButton.disabled = !data.canManagePermissions;
    }
  });

  const current = settings.permissionPreset;
  const currentCard = card(
    t("permCurrent"),
    "key",
    "purple",
    h(
      "div",
      { class: "perm-current" },
      h("span", { class: `badge ${current ? "badge-accent" : ""}` }, presetName(current)),
      h("p", { class: "help" }, t(current ? (current === "custom" ? "permCurrentHelp_custom" : `permPresetHelp_${current}`) : "permCurrentHelp_none")),
      settings.nativePermissions === false ? h("p", { class: "tip" }, icon("lock"), h("span", {}, t("permNativeOffSimple"))) : null,
    ),
  );
  const chooseCard = card(
    t("permChoose"),
    "sparkles",
    "green",
    lockedTip(data),
    h("p", { class: "help" }, t("permChooseHelp")),
    optionGrid,
    h("div", { class: "perm-roles" }, moderatorField, helperField),
    h("div", { class: "toolbar" }, h("span", { class: "grow" }), previewButton),
    review,
  );
  if (!data.canManagePermissions) {
    chooseCard.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = true;
    });
  }
  update();
  show(
    guildLayout(
      data,
      "access",
      pageHero("access", t("accessIntro"), data, permissionTabs(guildId, "simple")),
      currentCard,
      chooseCard,
      hint,
      rolesTable(data),
    ),
  );
}

// One command in the Advanced tab: a summary line, and its rule's controls
// (made when it's first opened, since most are never opened).
function commandRuleRow(command, rules, data, roleItems, channelItems) {
  const rule = () => rules[command.name] ?? emptyRule();
  const badges = h("span", { class: "badges" });
  const drawBadges = () => {
    const current = rule();
    const permission = BigInt(command.permission);
    badges.replaceChildren(
      ...[
        permission === 0n ? h("span", { class: "badge" }, t("permEveryone")) : h("span", { class: "badge badge-amber" }, t("permNeeds", { permission: permissionName(permission) })),
        current.disabled ? h("span", { class: "badge badge-red" }, t("permRuleOffBadge")) : null,
        current.roleIds.length > 0 ? h("span", { class: "badge badge-accent" }, t(command.roleMode === "restrict" ? "permRuleOnlyBadge" : "permRuleRolesBadge", { count: current.roleIds.length })) : null,
        current.blockedRoleIds.length > 0 ? h("span", { class: "badge badge-pink" }, t("permRuleBlockedBadge", { count: current.blockedRoleIds.length })) : null,
        current.channelIds.length > 0 ? h("span", { class: "badge badge-cyan" }, t("permRuleChannelsBadge", { count: current.channelIds.length })) : null,
      ].filter(Boolean),
    );
  };
  const body = h("div", { class: "command-rule-body" });
  const details = h(
    "details",
    { class: "command-rule", "data-name": command.name },
    h("summary", {}, h("code", { class: "command-name" }, `/${command.name}`), badges),
    body,
  );

  const listOf = (name) => [...body.querySelectorAll(`input[name="${name}"]:checked`)].map((box) => box.value);
  const read = () => {
    const next = {
      disabled: !body.querySelector('input[name="ruleOn"]').checked,
      roleIds: command.roleMode === "none" ? [] : listOf(`ruleRoles-${command.name}`),
      blockedRoleIds: listOf(`ruleBlocked-${command.name}`),
      channelIds: listOf(`ruleChannels-${command.name}`),
    };
    rules[command.name] = next;
    drawBadges();
  };

  function build() {
    const current = rule();
    const own = COMMANDS_WITH_OWN_ROLE[command.name];
    const rolesPart =
      command.roleMode === "none"
        ? h("p", { class: "tip" }, icon("lock"), h("span", {}, t(own ? `permRuleNoRoles_${own}` : "permRuleNoRoles_admin")))
        : h(
            "div",
            { class: "field" },
            h("span", { class: "field-label" }, t(command.roleMode === "restrict" ? "permRuleRestrict" : "permRuleGrant")),
            h("span", { class: "help" }, command.roleMode === "restrict" ? t("permRuleRestrictHelp") : t("permRuleGrantHelp", { permission: permissionName(command.permission) })),
            checkList({ name: `ruleRoles-${command.name}`, items: roleItems(), checked: current.roleIds, filterKey: "filterRoles" }),
          );
    body.replaceChildren(
      h(
        "label",
        { class: "switch-card" },
        h("span", { class: "switch-text" }, h("strong", {}, t("permRuleOn")), h("span", { class: "help" }, t("permRuleOnHelp"))),
        h("span", { class: "switch" }, h("input", { type: "checkbox", name: "ruleOn", role: "switch", checked: !current.disabled, "aria-label": t("permRuleOn") })),
      ),
      rolesPart,
      h(
        "div",
        { class: "field" },
        h("span", { class: "field-label" }, t("permRuleBlocked")),
        h("span", { class: "help" }, t("permRuleBlockedHelp")),
        checkList({ name: `ruleBlocked-${command.name}`, items: roleItems(), checked: current.blockedRoleIds, filterKey: "filterRoles" }),
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field-label" }, t("permRuleChannels")),
        h("span", { class: "help" }, t("permRuleChannelsHelp")),
        checkList({ name: `ruleChannels-${command.name}`, items: channelItems, checked: current.channelIds, filterKey: "filterChannels" }),
      ),
    );
    if (!data.canManagePermissions) {
      body.querySelectorAll("input").forEach((control) => {
        if (control.type !== "search") {
          control.disabled = true;
        }
      });
    }
  }

  details.addEventListener("toggle", () => {
    if (details.open && body.childElementCount === 0) {
      build();
    }
  });
  // Runs before the form's own change handler, so the save bar sees the new rule.
  body.addEventListener("change", (event) => {
    if (event.target.type !== "search") {
      read();
    }
  });
  drawBadges();
  return details;
}

function showAdvancedPermissions(data) {
  const guildId = data.guild.id;
  const settings = data.settings;
  const roles = roleOptions(data);
  const rolePicker = (key) => picker({ id: key, options: roles, value: settings[key], emptyLabel: t("notSet") });
  // Made fresh for each list, since a dot element can only be in one place.
  const roleItems = () => data.roles.filter((role) => !role.managed).map((role) => roleItem(role, { mention: false, dot: true }));
  const channelItems = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => channelItem(channel, data.channels));

  // The rules being edited, by command name.
  const rules = Object.fromEntries(
    Object.entries(settings.commandRules ?? {}).map(([name, rule]) => [name, { ...emptyRule(), ...rule }]),
  );
  const rows = data.commands.map((command) => commandRuleRow(command, rules, data, roleItems, channelItems));
  const empty = h("p", { class: "muted empty", hidden: true }, t("nothingMatches"));
  const filter = h("input", { type: "search", class: "grow", placeholder: t("filterCommands"), "aria-label": t("filterCommands") });
  const onlyRules = h("input", { type: "checkbox" });
  const filterRows = () => {
    const text = filter.value.trim().toLowerCase().replace(/^\//, "");
    let shown = 0;
    rows.forEach((row) => {
      row.hidden = (text !== "" && !row.dataset.name.includes(text)) || (onlyRules.checked && !rules[row.dataset.name]);
      shown += row.hidden ? 0 : 1;
    });
    empty.hidden = shown > 0;
  };
  filter.addEventListener("input", filterRows);
  onlyRules.addEventListener("change", (event) => {
    event.stopPropagation();
    filterRows();
  });

  // Whether Discord permissions alone let members use commands (on unless saved as false).
  const nativeBox = h("input", { type: "checkbox", name: "nativePermissions", role: "switch", checked: settings.nativePermissions !== false, disabled: !data.canManagePermissions, "aria-label": t("permNative") });
  const nativeSwitch = h(
    "label",
    { class: "switch-card" },
    h("span", { class: "switch-text" }, h("strong", {}, t("permNative")), h("span", { class: "help" }, t("permNativeCountHelp"))),
    h("span", { class: "switch" }, nativeBox),
  );
  const nativeWarning = h("p", { class: "tip" }, icon("alert"), h("span", {}, t("permNativeOffTip")));
  const drawNative = () => {
    nativeWarning.hidden = nativeBox.checked;
  };
  nativeBox.addEventListener("change", drawNative);
  drawNative();

  const commandsCard = card(
    t("permCommands"),
    "zap",
    "amber",
    lockedTip(data),
    h("p", { class: "help" }, t("permCommandsHelp")),
    h("p", { class: "tip" }, icon("alert"), h("span", {}, t("permCommandsNative"))),
    h("div", { class: "toolbar" }, filter, h("label", { class: "switch" }, onlyRules, h("span", {}, t("permOnlyWithRules")))),
    h("div", { class: "command-rules" }, rows, empty),
  );
  settingsPage({
    data,
    pageId: "access",
    intro: t("accessIntro"),
    heroExtra: () => permissionTabs(guildId, "advanced"),
    cards: [
      card(
        t("permRolesTitle"),
        "shield",
        "red",
        lockedTip(data),
        nativeSwitch,
        nativeWarning,
        field("modRole", "modRoleHelp", rolePicker("modRoleId")),
        field("staffRole", "staffRoleHelp", rolePicker("staffRoleId")),
        h("div", { class: "field" }, h("span", { class: "field-label" }, t("dashboardAccess")), h("span", { class: "help" }, t("dashboardAccessHelp")), checkList({ name: "dashboardRole", items: roleItems(), checked: settings.dashboardRoleIds ?? [], filterKey: "filterRoles" })),
      ),
      commandsCard,
    ],
    fields: {
      nativePermissions: (form) => (form.querySelector('input[name="nativePermissions"]').checked ? null : false),
      modRoleId: selectValue("modRoleId"),
      staffRoleId: selectValue("staffRoleId"),
      dashboardRoleIds: checkedList("dashboardRole"),
      commandRules: () => cleanRules(rules),
    },
  });
}

async function showAccess(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (query.get("tab") === "advanced") {
    showAdvancedPermissions(data);
  } else {
    showSimplePermissions(data);
  }
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
      hero(t("overviewTitle", { name: guild.name }), t(canManageGuild(data) ? "overviewIntro" : "overviewIntroCases"), "blue", {
        lead: guildIcon(guild, "lg"),
        banner: bannerFor(guild.id),
      }),
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
          { class: `feature tone-${page.tone}${on ? " on" : ""}`, href: `#/g/${data.guild.id}/${page.id}` },
          iconChip(page.icon, page.tone, "sm"),
          h("span", { class: "grow" }, t(`page_${page.id}`)),
          h("span", { class: `status ${on ? "on" : "off"}` }, t(on ? "featureOn" : "featureOff")),
        );
      }),
    ),
  );
}

// What's set up and what isn't, with links to fix it. Steps a server doesn't
// want can be skipped (saved for everyone as setupSkipped). Hidden once every
// step is done; folded to one line once the rest are skipped.
function setupCard(data, { open = false } = {}) {
  const { settings, guild } = data;
  const steps = [
    { id: "logs", key: "setupLogs", done: Boolean(settings.logsChannelId), page: "logging" },
    { id: "serverLog", key: "setupServerLog", done: Boolean(settings.serverLogChannelId), page: "logging" },
    { id: "modLog", key: "setupModLog", done: Boolean(settings.modLogChannelId || settings.logsChannelId), page: "moderation" },
    { id: "modRole", key: "setupModRole", done: Boolean(settings.modRoleId), page: "moderation" },
    { id: "country", key: "setupCountry", done: Boolean(settings.countryChannelId), page: "country" },
    { id: "dashboard", key: "setupDashboard", done: (settings.dashboardRoleIds ?? []).length > 0, page: "access" },
    { id: "automod", key: "setupAutomod", done: Boolean(settings.automod?.enabled), page: "automod" },
    { id: "welcome", key: "setupWelcome", done: Boolean(settings.welcomeChannelId), page: "welcome" },
  ];
  const skipped = new Set(settings.setupSkipped ?? []);
  steps.forEach((step) => (step.skipped = !step.done && skipped.has(step.id)));
  const done = steps.filter((step) => step.done).length;
  const skippedCount = steps.filter((step) => step.skipped).length;
  const todo = steps.filter((step) => !step.done && !step.skipped);
  if (done === steps.length) {
    return null;
  }

  let section;
  const redraw = (options) => section.replaceWith(setupCard(data, options));
  const saveSkipped = async (ids, button) => {
    setBusy(button, true);
    try {
      const result = await api(`/api/guilds/${guild.id}/settings`, { method: "PUT", body: { setupSkipped: ids } });
      data.settings = result.settings;
      state.cache = { guildId: guild.id, data, at: Date.now() };
      redraw({ open: open || todo.length > 0 });
    } catch (error) {
      failed(error);
      setBusy(button, false);
    }
  };
  const currentSkips = steps.filter((step) => step.skipped).map((step) => step.id);
  const skip = (ids) => (event) => saveSkipped([...currentSkips, ...ids], event.currentTarget);
  const unskip = (id) => (event) => saveSkipped(currentSkips.filter((skippedId) => skippedId !== id), event.currentTarget);

  const progress = skippedCount > 0 ? t("setupProgressSkipped", { done, total: steps.length, skipped: skippedCount }) : t("setupProgress", { done, total: steps.length });
  const folded = todo.length === 0 && !open;
  section = h(
    "section",
    { class: `card setup${folded ? " folded" : ""}` },
    h(
      "div",
      { class: "toolbar" },
      h("h2", { class: "card-title grow" }, iconChip("check", "green"), t("setupTitle")),
      h("span", { class: "count-pill" }, progress),
      folded
        ? h("button", { type: "button", class: "button ghost small", onclick: () => redraw({ open: true }) }, t("setupShow"))
        : todo.length > 1
          ? h("button", { type: "button", class: "button ghost small", onclick: skip(todo.map((step) => step.id)) }, t("setupSkipAll"))
          : null,
    ),
    folded ? null : h("div", { class: "progress" }, fillBar("progress-fill", (done + skippedCount) / steps.length)),
    folded
      ? null
      : h(
          "ul",
          { class: "steps" },
          steps.map((step) =>
            h(
              "li",
              { class: step.done ? "done" : step.skipped ? "skipped" : "" },
              h("span", { class: "step-mark", "aria-hidden": "true" }, step.done ? icon("check", "icon tiny") : step.skipped ? icon("x", "icon tiny") : null),
              h("span", { class: "grow" }, t(step.key)),
              step.done
                ? h("span", { class: "muted" }, t("setupDone"))
                : step.skipped
                  ? h(
                      "span",
                      { class: "step-actions" },
                      h("span", { class: "muted" }, t("setupSkipped")),
                      h("button", { type: "button", class: "button ghost small", onclick: unskip(step.id) }, t("setupUndo")),
                    )
                  : h(
                      "span",
                      { class: "step-actions" },
                      h("button", { type: "button", class: "button ghost small", title: t("setupSkipHelp"), onclick: skip([step.id]) }, t("setupSkip")),
                      h("a", { class: "button ghost small", href: `#/g/${guild.id}/${step.page}` }, t("setupFix")),
                    ),
            ),
          ),
        ),
  );
  return section;
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
        h("span", { class: "ticket-subject" }, ticket.subject.replace(/\*\*/g, "").replace(/\n+/g, " · ")),
        h(
          "span",
          { class: "muted" },
          [ticket.category, ticket.userName ?? ticket.userId, formatDate(ticket.createdAt), ticket.hasTranscript ? t("ticketsMessages", { count: formatNumber(ticket.messageCount ?? 0) }) : null]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
      ticketBadge(ticket),
    ),
  );
}

// --- Ticket panel editor ------------------------------------------------------------
//
// The panel's look (tickets/panel.js) and its categories (tickets/categories.js),
// edited together with a live preview of the panel and of a new ticket's first
// message. Saving updates the posted panel in place.

const MAX_TICKET_CATEGORIES = 25;
const MAX_CATEGORY_QUESTIONS = 5;
const TICKET_BUTTON_STYLES = ["primary", "secondary", "success", "danger"];
const TICKET_PLACEHOLDERS = "{user} {username} {number} {staff} {category} {server}";
const newCategoryId = () => Math.random().toString(36).slice(2, 10) || "c1";

// Saved questions used to be plain text.
const ticketQuestion = (question) =>
  typeof question === "string"
    ? { label: question, placeholder: null, style: "paragraph", required: true, minLength: null, maxLength: null }
    : { placeholder: null, style: "paragraph", required: true, minLength: null, maxLength: null, ...question };

const ticketStyleSelect = (className, value, keyPrefix) =>
  h(
    "select",
    { class: className },
    TICKET_BUTTON_STYLES.map((style) => h("option", { value: style, selected: style === (value ?? "primary") }, t(`${keyPrefix}${style}`))),
  );

const ticketField = (labelKey, control, extraClass = "") =>
  h("label", { class: `field ${extraClass}`.trim() }, h("span", { class: "field-label" }, t(labelKey)), control);

function ticketQuestionRow(question, onRemove) {
  const value = ticketQuestion(question ?? { label: "" });
  const number = (className, current, min) => h("input", { class: className, type: "number", min, max: 1000, step: 1, value: current ?? "", placeholder: "—" });
  const row = h(
    "div",
    { class: "question-row" },
    h(
      "div",
      { class: "question-grid" },
      ticketField("ticketQuestionLabel", h("input", { class: "question-label", type: "text", maxLength: 45, required: true, value: value.label, placeholder: t("ticketQuestionLabelPlaceholder") })),
      ticketField("ticketQuestionHint", h("input", { class: "question-hint", type: "text", maxLength: 100, value: value.placeholder ?? "", placeholder: t("ticketFormHintDefault") })),
      ticketField(
        "ticketQuestionSize",
        h(
          "select",
          { class: "question-style" },
          h("option", { value: "short", selected: value.style === "short" }, t("ticketQuestionShort")),
          h("option", { value: "paragraph", selected: value.style !== "short" }, t("ticketQuestionParagraph")),
        ),
      ),
      ticketField("ticketQuestionMin", number("question-min", value.minLength, 0), "question-number"),
      ticketField("ticketQuestionMax", number("question-max", value.maxLength, 1), "question-number"),
    ),
    h(
      "div",
      { class: "toolbar" },
      h("label", { class: "switch" }, h("input", { class: "question-required", type: "checkbox", checked: value.required }), h("span", {}, t("ticketQuestionRequired"))),
      h("span", { class: "grow" }),
      h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
    ),
  );
  return row;
}

function readTicketQuestions(container) {
  const number = (input) => (input.value.trim() === "" ? null : Number(input.value));
  return [...container.querySelectorAll(".question-row")].map((row) => ({
    label: row.querySelector(".question-label").value.trim(),
    placeholder: row.querySelector(".question-hint").value.trim() || null,
    style: row.querySelector(".question-style").value,
    required: row.querySelector(".question-required").checked,
    minLength: number(row.querySelector(".question-min")),
    maxLength: number(row.querySelector(".question-max")),
  }));
}

function categoryRow(category, roles, onRemove) {
  const value = category ?? { id: newCategoryId(), label: "", emoji: null, description: null, staffRoleId: null, style: "primary", intro: null, nameFormat: null, pingStaff: null, questions: [] };
  const questions = editableList({
    items: (value.questions ?? []).map(ticketQuestion),
    max: MAX_CATEGORY_QUESTIONS,
    makeRow: ticketQuestionRow,
    focus: ".question-label",
    emptyKey: "ticketQuestionsNone",
    addKey: "ticketQuestionAdd",
  });
  const ping = value.pingStaff === true ? "on" : value.pingStaff === false ? "off" : "";
  const staff = picker({ id: `staff-${value.id}`, options: roles, value: value.staffRoleId, emptyLabel: t("ticketCategoryStaffDefault") });
  staff.classList.add("category-staff");
  const row = h(
    "details",
    { class: "category-row", "data-id": value.id, open: !category },
    h(
      "summary",
      {},
      h("span", { class: "category-title" }, value.emoji ? `${value.emoji} ` : "", value.label || t("ticketCategoryNew")),
      h("span", { class: "muted" }, t("ticketCategoryQuestionCount", { count: (value.questions ?? []).length })),
    ),
    h(
      "div",
      { class: "category-grid" },
      ticketField("ticketCategoryLabel", h("input", { class: "category-label", type: "text", maxLength: 80, required: true, value: value.label, placeholder: t("ticketCategoryLabelPlaceholder") })),
      ticketField("ticketCategoryEmoji", h("input", { class: "category-emoji", type: "text", maxLength: 64, value: value.emoji ?? "", placeholder: "🐞" }), "category-emoji-field"),
      ticketField("ticketCategoryStyle", ticketStyleSelect("category-style", value.style, "ticketButtonStyle_")),
      ticketField("ticketCategoryStaff", staff),
    ),
    ticketField("ticketCategoryDescription", h("input", { class: "category-description", type: "text", maxLength: 200, value: value.description ?? "", placeholder: t("ticketCategoryDescriptionPlaceholder") })),
    ticketField("ticketCategoryIntro", h("textarea", { class: "category-intro", rows: 2, maxLength: 1500, placeholder: t("ticketCategoryFollowPanel") }, value.intro ?? "")),
    h(
      "div",
      { class: "category-grid" },
      ticketField("ticketCategoryNameFormat", h("input", { class: "category-name-format", type: "text", maxLength: 90, value: value.nameFormat ?? "", placeholder: t("ticketCategoryFollowPanel") })),
      ticketField(
        "ticketCategoryPing",
        h(
          "select",
          { class: "category-ping" },
          h("option", { value: "", selected: ping === "" }, t("ticketCategoryPingPanel")),
          h("option", { value: "on", selected: ping === "on" }, t("ticketCategoryPingOn")),
          h("option", { value: "off", selected: ping === "off" }, t("ticketCategoryPingOff")),
        ),
      ),
    ),
    h("div", { class: "toolbar" }, h("strong", { class: "grow" }, t("ticketCategoryQuestions")), questions.count, questions.addButton),
    h("p", { class: "help" }, t("ticketCategoryQuestionsHelp", { max: MAX_CATEGORY_QUESTIONS })),
    questions.empty,
    h("div", { class: "question-list" }, questions.list),
    h("div", { class: "toolbar" }, h("span", { class: "grow" }), h("button", { class: "ghost small danger-text", type: "button", onclick: () => onRemove(row) }, t("ticketCategoryRemove"))),
  );
  // The summary follows the label as it's typed.
  row.addEventListener("input", () => {
    const emoji = row.querySelector(".category-emoji").value.trim();
    const label = row.querySelector(".category-label").value.trim();
    row.querySelector(".category-title").textContent = `${emoji ? `${emoji} ` : ""}${label || t("ticketCategoryNew")}`;
    row.querySelector("summary .muted").textContent = t("ticketCategoryQuestionCount", { count: row.querySelectorAll(".question-row").length });
  });
  return row;
}

function readTicketCategories(form) {
  const categories = [...form.querySelectorAll(".category-row")].map((row) => {
    const ping = row.querySelector(".category-ping").value;
    return {
      id: row.dataset.id,
      label: row.querySelector(".category-label").value.trim(),
      emoji: row.querySelector(".category-emoji").value.trim() || null,
      description: row.querySelector(".category-description").value.trim() || null,
      staffRoleId: row.querySelector(".category-staff").value || null,
      style: row.querySelector(".category-style").value,
      intro: row.querySelector(".category-intro").value.trim() || null,
      nameFormat: row.querySelector(".category-name-format").value.trim() || null,
      pingStaff: ping === "on" ? true : ping === "off" ? false : null,
      questions: readTicketQuestions(row),
    };
  });
  return categories.length > 0 ? categories : null;
}

function readTicketLook(form) {
  const value = (id) => form.querySelector(`#${id}`).value.trim() || null;
  return {
    title: value("tkTitle"),
    description: value("tkDescription"),
    color: readColorChooser(form, "tkColor"),
    authorName: value("tkAuthor"),
    authorIconUrl: value("tkAuthorIcon"),
    imageUrl: value("tkImage"),
    thumbnailUrl: value("tkThumbnail"),
    footer: value("tkFooter"),
    layout: form.querySelector("#tkLayout").value,
    menuPlaceholder: value("tkMenuPlaceholder"),
    buttonLabel: value("tkButtonLabel"),
    buttonEmoji: value("tkButtonEmoji"),
    buttonStyle: form.querySelector("#tkButtonStyle").value,
    intro: value("tkIntro"),
    nameFormat: value("tkNameFormat"),
    pingStaff: form.querySelector("#tkPingStaff").checked,
  };
}

// Fills {user}, {number}… with example values, for the preview.
function ticketSample(text, values) {
  return text.replace(/\{(user|username|number|staff|category|server)\}/g, (match, key) => values[key] ?? match);
}

const ticketPreviewButton = (style, emoji, label) =>
  h("span", { class: `discord-button ${style}` }, emoji ? h("span", { "aria-hidden": "true" }, emoji.startsWith("<") ? "🙂" : emoji) : null, label);

// The posted panel as Discord would show it.
function ticketPanelPreview(look, categories, data, defaults) {
  const described = look.layout === "menu" && categories.length > 0 ? [] : categories.filter((category) => category.description);
  const message = embedPreview(
    {
      content: "",
      embed: {
        title: look.title || defaults.title,
        url: "",
        description: look.description || defaults.description,
        color: look.color ?? defaults.color,
        author: { name: look.authorName ?? "", icon_url: look.authorIconUrl ?? "" },
        footer: { text: look.footer ?? "" },
        image: { url: look.imageUrl ?? "" },
        thumbnail: { url: look.thumbnailUrl ?? "" },
        fields: described.map((category) => ({ name: `${category.emoji ? `${category.emoji} ` : ""}${category.label || t("ticketCategoryNew")}`, value: category.description, inline: false })),
      },
    },
    data,
  );
  let components;
  if (categories.length === 0) {
    components = h("div", { class: "discord-button-row" }, ticketPreviewButton(look.buttonStyle, look.buttonEmoji ?? "🎫", look.buttonLabel || defaults.buttonLabel));
  } else if (look.layout === "menu") {
    components = h(
      "div",
      { class: "discord-select" },
      h("span", { class: "discord-select-box" }, h("span", {}, look.menuPlaceholder || defaults.menuPlaceholder), icon("chevronDown", "icon small")),
      h(
        "ul",
        { class: "discord-select-options" },
        categories.map((category) =>
          h(
            "li",
            {},
            category.emoji ? h("span", { class: "discord-select-emoji", "aria-hidden": "true" }, category.emoji.startsWith("<") ? "🙂" : category.emoji) : null,
            h("span", {}, h("strong", {}, category.label || t("ticketCategoryNew")), category.description ? h("span", { class: "muted" }, category.description.slice(0, 100)) : null),
          ),
        ),
      ),
    );
  } else {
    const rows = [];
    for (let index = 0; index < categories.length; index += 5) {
      rows.push(
        h(
          "div",
          { class: "discord-button-row" },
          categories.slice(index, index + 5).map((category) => ticketPreviewButton(category.style, category.emoji, category.label || t("ticketCategoryNew"))),
        ),
      );
    }
    components = rows;
  }
  message.querySelector(".discord-body").append(h("div", { class: "discord-buttons" }, components));
  return message;
}

// A new ticket's first message, for the first category (or the single button).
function ticketWelcomePreview(look, category, data, defaults) {
  const staffRoleId = category?.staffRoleId ?? defaults.staffRoleId ?? data.settings.modRoleId ?? data.settings.staffRoleId ?? null;
  const values = {
    user: `@${t("ticketSampleUsername")}`,
    username: t("ticketSampleUsername"),
    number: "7",
    staff: staffRoleId ? `<@&${staffRoleId}>` : defaults.staffWord,
    category: category?.label ?? "",
    server: data.guild.name,
  };
  const intro = category?.intro || look.intro;
  const ping = category?.pingStaff ?? look.pingStaff;
  let content = intro ? ticketSample(intro, values) : ticketSample(staffRoleId ? defaults.intro : defaults.introNoStaff, values);
  if (ping && staffRoleId && !content.includes(values.staff)) {
    content = `${content}\n${values.staff}`;
  }
  const questions = (category?.questions ?? []).filter((question) => question.label);
  const subject = questions.length > 0 ? questions.map((question, index) => `**${question.label}**\n${index === 0 ? t("ticketSampleAnswer") : "…"}`).join("\n\n") : t("ticketSampleAnswer");
  const thread = ticketSample(category?.nameFormat || look.nameFormat || defaults.nameFormat, { ...values, user: t("ticketSampleUsername"), number: "0007", category: category?.label || "ticket" }).slice(0, 100);
  const message = embedPreview(
    {
      content,
      embed: {
        title: category?.label || defaults.subject,
        url: "",
        description: subject,
        color: defaults.brandColor ?? defaults.color,
        author: { name: "", icon_url: "" },
        footer: { text: "" },
        image: { url: "" },
        thumbnail: { url: "" },
        fields: [],
      },
    },
    data,
  );
  message.querySelector(".discord-body").append(h("div", { class: "discord-buttons" }, h("div", { class: "discord-button-row" }, ticketPreviewButton("secondary", "🔒", defaults.closeButton))));
  return h(
    "div",
    {},
    h("p", { class: "discord-thread-name" }, icon("hash", "icon small"), h("span", {}, thread)),
    message,
    h("p", { class: "help" }, ping && staffRoleId ? t("ticketPreviewPings") : t("ticketPreviewNoPing")),
  );
}

// A colour chooser: the browser's colour picker (it has an eyedropper in most
// browsers), an eyedropper button where the browser offers one, a hex code box and
// quick swatches. With nothing chosen it shows `fallback` and follows it; read the
// choice back with readColorChooser(). Every change fires "input" so forms refresh.
const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalHex(text) {
  const match = HEX_COLOR.exec(text.trim());
  if (!match) {
    return null;
  }
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return `#${digits.toLowerCase()}`;
}

function colorChooser({ id, value, fallback, followKey, resetKey }) {
  const native = h("input", { id, type: "color", value: hexColor(value ?? fallback), "aria-label": t("embedColor") });
  const hex = h("input", {
    id: `${id}Hex`,
    class: "color-hex",
    type: "text",
    value: hexColor(value ?? fallback).toUpperCase(),
    maxLength: 7,
    spellcheck: false,
    autocomplete: "off",
    "aria-label": t("colorHex"),
  });
  const status = h("span", { class: "help color-status" });
  const reset = h("button", { type: "button", class: "ghost small" }, icon("refresh", "icon small"), h("span", {}, t(resetKey)));
  const element = h("div", { class: "color-chooser" });
  element.dataset.custom = String(value !== null && value !== undefined);

  const update = () => {
    const custom = element.dataset.custom === "true";
    reset.hidden = !custom;
    status.textContent = custom ? "" : t(followKey, { hex: hexColor(fallback).toUpperCase() });
  };
  // Sets the colour from the picker, a swatch, the eyedropper or a reset.
  const choose = (color, custom) => {
    native.value = color;
    hex.value = color.toUpperCase();
    hex.setCustomValidity("");
    element.dataset.custom = String(custom);
    update();
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };

  native.addEventListener("input", (event) => {
    event.stopPropagation();
    choose(native.value, true);
  });
  // Typing: a full hex code applies straight away; anything else is flagged and
  // the last good colour stays until it's fixed.
  hex.addEventListener("input", () => {
    const color = normalHex(hex.value);
    hex.setCustomValidity(color ? "" : t("colorHexInvalid"));
    if (color) {
      native.value = color;
      element.dataset.custom = "true";
      update();
    }
  });
  hex.addEventListener("blur", () => {
    const color = normalHex(hex.value);
    if (color) {
      hex.value = color.toUpperCase();
    }
  });
  reset.addEventListener("click", () => choose(hexColor(fallback), false));

  const swatches = EMBED_SWATCHES.map((swatch) => {
    const button = h("button", { type: "button", class: "swatch", title: swatch, "aria-label": swatch, onclick: () => choose(swatch, true) });
    button.style.setProperty("--swatch", swatch);
    return button;
  });
  // Chrome and Edge can pick any colour on the screen; elsewhere the colour box's
  // own picker is the way in.
  const dropper =
    "EyeDropper" in window
      ? h(
          "button",
          {
            type: "button",
            class: "ghost small icon-button",
            title: t("colorEyedropper"),
            "aria-label": t("colorEyedropper"),
            onclick: async () => {
              try {
                const { sRGBHex } = await new window.EyeDropper().open();
                const color = normalHex(sRGBHex);
                if (color) {
                  choose(color, true);
                }
              } catch {
                // Closed with Escape: keep the colour as it was.
              }
            },
          },
          icon("pipette", "icon small"),
        )
      : null;

  element.append(h("div", { class: "color-chooser-row" }, native, hex, dropper, h("div", { class: "swatches" }, swatches), reset), status);
  update();
  return element;
}

// The chosen colour as a number, or null while it follows the fallback.
function readColorChooser(form, id) {
  const chooser = form.querySelector(`#${id}`).closest(".color-chooser");
  return chooser.dataset.custom === "true" ? colorNumber(form.querySelector(`#${id}`).value) : null;
}

// The Tickets page's editor, for people who can change settings: a wizard that
// walks through the panel one step at a time, with the previews alongside. Every
// step can be opened from the step bar, and Save works from any of them.
const TICKET_STEPS = [
  { id: "panel", titleKey: "ticketSectionPanel", helpKey: "ticketStepPanelHelp", icon: "image", tone: "purple" },
  { id: "types", titleKey: "ticketCategories", helpKey: "ticketCategoriesHelp", icon: "layers", tone: "purple" },
  { id: "pick", titleKey: "ticketSectionPick", helpKey: "ticketStepPickHelp", icon: "list", tone: "blue" },
  { id: "new", titleKey: "ticketSectionNew", helpKey: "ticketStepNewHelp", icon: "ticket", tone: "cyan" },
  { id: "review", titleKey: "ticketSectionReview", helpKey: "ticketStepReviewHelp", icon: "check", tone: "green" },
];

function ticketPanelEditor(guildId, data) {
  const defaults = data.ticketDefaults;
  const look = data.settings.ticketPanel ?? {};
  // @everyone is the role with the server's ID; listed first.
  const roles = [{ id: guildId, label: t("feedsEveryone") }, ...data.roles.filter((role) => role.id !== guildId && !role.managed).map((role) => roleItem(role))];
  const categories = editableList({
    items: data.settings.ticketCategories ?? [],
    max: MAX_TICKET_CATEGORIES,
    makeRow: (category, remove) => categoryRow(category, roles, remove),
    focus: ".category-label",
    emptyKey: "ticketCategoriesNone",
    addKey: "ticketCategoriesAdd",
  });
  const input = (id, current, attributes = {}) => h("input", { id, type: "text", value: current ?? "", ...attributes });

  const color = colorChooser({ id: "tkColor", value: look.color, fallback: defaults.color, followKey: "ticketColorFollowing", resetKey: "ticketColorReset" });
  const layout = h(
    "select",
    { id: "tkLayout" },
    h("option", { value: "buttons", selected: look.layout !== "menu" }, t("ticketLayoutButtons")),
    h("option", { value: "menu", selected: look.layout === "menu" }, t("ticketLayoutMenu")),
  );
  const layoutField = field("ticketLayout", "ticketLayoutHelp", layout);
  const menuField = field("ticketMenuPlaceholder", null, input("tkMenuPlaceholder", look.menuPlaceholder, { maxLength: 150, placeholder: defaults.menuPlaceholder }));
  const singleButton = h(
    "div",
    { class: "category-grid" },
    ticketField("ticketButtonLabel", input("tkButtonLabel", look.buttonLabel, { maxLength: 80, placeholder: defaults.buttonLabel })),
    ticketField("ticketCategoryEmoji", input("tkButtonEmoji", look.buttonEmoji, { maxLength: 64, placeholder: "🎫" }), "category-emoji-field"),
    ticketField("ticketCategoryStyle", (() => {
      const select = ticketStyleSelect("", look.buttonStyle, "ticketButtonStyle_");
      select.id = "tkButtonStyle";
      return select;
    })()),
  );
  const singleHelp = h("p", { class: "help" }, t("ticketSingleButtonHelp"));
  const pingStaff = h("input", { id: "tkPingStaff", type: "checkbox", role: "switch", checked: look.pingStaff !== false, "aria-label": t("ticketPingStaff") });

  const panelPreview = h("div", { class: "embed-preview" });
  const welcomePreview = h("div", { class: "embed-preview" });
  const reviewList = h("dl", { class: "wizard-review" });
  const save = h("button", { class: "primary", type: "submit" }, t("save"));
  const back = h("button", { class: "ghost", type: "button", onclick: () => go(current - 1) }, icon("chevronLeft", "icon small"), h("span", {}, t("wizardBack")));
  const next = h("button", { class: "primary", type: "button", onclick: () => checkStep(current) && go(current + 1) }, h("span", {}, t("wizardNext")), icon("chevronRight", "icon small"));
  const position = h("span", { class: "muted wizard-position" });
  const summaryCount = h("span", { class: "muted" });

  const stepBodies = {
    panel: [
      h("div", { class: "field" }, h("span", { class: "field-label" }, t("embedColor")), color),
      h("p", { class: "help" }, t("ticketColorHelp")),
      h("div", { class: "embed-grid" }, field("embedAuthor", null, input("tkAuthor", look.authorName, { maxLength: 256 })), field("embedAuthorIcon", null, input("tkAuthorIcon", look.authorIconUrl, { placeholder: "https://…" }))),
      field("embedTitle", null, input("tkTitle", look.title, { maxLength: 256, placeholder: defaults.title })),
      field("embedDescription", "embedDescriptionHelp", h("textarea", { id: "tkDescription", rows: 4, maxLength: 4096, placeholder: defaults.description }, look.description ?? "")),
      h("div", { class: "embed-grid" }, field("embedImage", null, input("tkImage", look.imageUrl, { placeholder: "https://…" })), field("embedThumbnail", null, input("tkThumbnail", look.thumbnailUrl, { placeholder: "https://…" }))),
      field("embedFooter", null, input("tkFooter", look.footer, { maxLength: 2048 })),
    ],
    types: [h("div", { class: "toolbar" }, h("span", { class: "grow" }), categories.count, categories.addButton), categories.empty, categories.list],
    pick: [layoutField, menuField, singleHelp, singleButton],
    new: [
      field("ticketIntro", null, h("textarea", { id: "tkIntro", rows: 3, maxLength: 1500, placeholder: defaults.intro }, look.intro ?? "")),
      h("p", { class: "help" }, t("ticketPlaceholdersHelp", { placeholders: TICKET_PLACEHOLDERS })),
      field("ticketNameFormat", "ticketNameFormatHelp", input("tkNameFormat", look.nameFormat, { maxLength: 90, placeholder: defaults.nameFormat })),
      h(
        "label",
        { class: "switch-card" },
        h("span", { class: "switch-text" }, h("strong", {}, t("ticketPingStaff")), h("span", { class: "help" }, t("ticketPingStaffHelp"))),
        h("span", { class: "switch" }, pingStaff),
      ),
    ],
    review: [reviewList, h("p", { class: "help" }, t(defaults.posted ? "ticketSaveUpdatesPanel" : "ticketSaveNoPanel"))],
  };
  const sections = TICKET_STEPS.map((step, index) =>
    h(
      "div",
      { class: "editor-section wizard-panel", id: `tk-step-${step.id}`, role: "group", "aria-labelledby": `tk-step-title-${step.id}`, hidden: index !== 0 },
      h("h3", { class: "editor-section-title", id: `tk-step-title-${step.id}` }, iconChip(step.icon, step.tone, "sm"), t(step.titleKey)),
      h("p", { class: "help" }, t(step.helpKey)),
      ...stepBodies[step.id],
    ),
  );
  const stepButtons = TICKET_STEPS.map((step, index) =>
    h(
      "button",
      { type: "button", class: "wizard-step", "aria-controls": `tk-step-${step.id}`, onclick: () => go(index) },
      h("span", { class: "wizard-step-number", "aria-hidden": "true" }, String(index + 1)),
      h("span", { class: "wizard-step-label" }, t(step.titleKey)),
    ),
  );
  const stepBar = h("ol", { class: "wizard-steps", "aria-label": t("ticketPanelEditor") }, stepButtons.map((button) => h("li", {}, button)));

  // Steps you've been through are ticked; the open one is marked current.
  let current = 0;
  const seen = new Set([0]);
  function go(index, focus = true) {
    current = Math.max(0, Math.min(TICKET_STEPS.length - 1, index));
    seen.add(current);
    sections.forEach((section, number) => (section.hidden = number !== current));
    stepButtons.forEach((button, number) => {
      button.classList.toggle("done", seen.has(number) && number !== current);
      if (number === current) {
        button.setAttribute("aria-current", "step");
      } else {
        button.removeAttribute("aria-current");
      }
    });
    const last = current === TICKET_STEPS.length - 1;
    back.disabled = current === 0;
    next.hidden = last;
    save.classList.toggle("primary", last);
    save.classList.toggle("ghost", !last);
    position.textContent = t("wizardPosition", { step: current + 1, total: TICKET_STEPS.length });
    if (focus) {
      sections[current].querySelector(".editor-section-title").scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // Shows the browser's message on the step's first unfinished field.
  const firstInvalid = (root) => [...root.querySelectorAll("input, select, textarea")].find((element) => !element.checkValidity());
  function showInvalid(element) {
    const step = sections.findIndex((section) => section.contains(element));
    go(step, false);
    element.closest("details")?.setAttribute("open", "");
    element.reportValidity();
  }
  function checkStep(index) {
    const invalid = firstInvalid(sections[index]);
    if (invalid) {
      showInvalid(invalid);
      return false;
    }
    return true;
  }

  const form = h(
    "form",
    {
      class: "ticket-editor wizard",
      noValidate: true,
      oninput: () => refresh(),
      onchange: () => refresh(),
      onsubmit: async (event) => {
        event.preventDefault();
        // Hidden steps can't show the browser's message, so open the step first.
        const invalid = firstInvalid(form);
        if (invalid) {
          showInvalid(invalid);
          return;
        }
        setBusy(save, true);
        try {
          const result = await api(`/api/guilds/${guildId}/settings`, {
            method: "PUT",
            body: { ticketPanel: readTicketLook(form), ticketCategories: readTicketCategories(form) },
          });
          data.settings = result.settings;
          state.cache = { guildId, data, at: Date.now() };
          state.unsaved = false;
          refresh(false);
          toast(t(defaults.posted ? "ticketPanelSavedPosted" : "ticketPanelSaved"));
        } catch (error) {
          failed(error);
        } finally {
          setBusy(save, false);
        }
      },
    },
    stepBar,
    ...sections,
    h("div", { class: "toolbar wizard-nav" }, back, position, h("span", { class: "grow" }), save, next),
  );

  // The last step: everything at a glance, each line a way back to its step.
  function review(now, kinds) {
    const edit = (stepId) =>
      h("button", { type: "button", class: "ghost small", onclick: () => go(TICKET_STEPS.findIndex((step) => step.id === stepId)) }, icon("edit", "icon small"), h("span", {}, t("wizardEdit")));
    const chip = h("span", { class: "color-dot" });
    chip.style.setProperty("--swatch", hexColor(now.color ?? defaults.color));
    const lines = [
      ["panel", t("ticketSectionPanel"), h("span", {}, chip, `${now.title || defaults.title} · ${hexColor(now.color ?? defaults.color).toUpperCase()}`)],
      ["types", t("ticketCategories"), kinds.length > 0 ? kinds.map((kind) => `${kind.emoji ? `${kind.emoji} ` : ""}${kind.label || t("ticketCategoryNew")}`).join(", ") : t("ticketReviewNoTypes")],
      ["pick", t("ticketSectionPick"), kinds.length === 0 ? t("ticketReviewSingle", { label: now.buttonLabel || defaults.buttonLabel }) : t(now.layout === "menu" ? "ticketLayoutMenu" : "ticketLayoutButtons")],
      ["new", t("ticketNameFormat"), now.nameFormat || defaults.nameFormat],
      ["new", t("ticketPingStaff"), t(now.pingStaff ? "featureOn" : "featureOff")],
    ];
    reviewList.replaceChildren(...lines.map(([stepId, label, value]) => h("div", { class: "wizard-review-row" }, h("dt", {}, label), h("dd", {}, value), edit(stepId))));
  }

  function refresh(changed = true) {
    const now = readTicketLook(form);
    const kinds = readTicketCategories(form) ?? [];
    const hasCategories = kinds.length > 0;
    menuField.hidden = !hasCategories || now.layout !== "menu";
    layoutField.hidden = !hasCategories;
    singleButton.hidden = hasCategories;
    singleHelp.hidden = hasCategories;
    panelPreview.replaceChildren(ticketPanelPreview(now, kinds, data, defaults));
    welcomePreview.replaceChildren(ticketWelcomePreview(now, kinds[0] ?? null, data, defaults));
    for (const preview of [panelPreview, welcomePreview]) {
      preview.querySelectorAll("[data-color]").forEach((element) => element.style.setProperty("--embed-color", element.dataset.color || "transparent"));
    }
    review(now, kinds);
    summaryCount.textContent = t("ticketCategoriesSummary", { count: kinds.length });
    if (changed) {
      state.unsaved = true;
    }
  }

  const editor = h(
    "details",
    { class: "card collapsible", open: true },
    h("summary", {}, iconChip("edit", "purple"), h("span", { class: "card-title" }, t("ticketPanelEditor")), summaryCount),
    h(
      "div",
      { class: "embed-layout" },
      form,
      h(
        "aside",
        { class: "embed-side" },
        card(t("ticketPreviewPanel"), "eye", "green", panelPreview),
        card(t("ticketPreviewWelcome"), "message", "blue", welcomePreview),
      ),
    ),
  );
  go(0, false);
  refresh(false);
  return editor;
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
    setBusy(more, true);
    try {
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
    } finally {
      setBusy(more, false);
    }
  };
  more.addEventListener("click", () => load().catch(failed));
  show(
    guildLayout(
      data,
      "tickets",
      pageHero("tickets", t("ticketsIntro"), data),
      canManageGuild(data) && data.ticketDefaults ? ticketPanelEditor(guildId, data) : null,
      filters,
      card(t("page_tickets"), "ticket", "cyan", summary, empty, list, h("div", { class: "center" }, more)),
    ),
  );
  await load();
}

// One ticket's history, oldest first: what happened, who did it, and when.
function ticketHistory(guildId, events) {
  if (events.length === 0) {
    return h("p", { class: "muted empty" }, t("ticketsHistoryNone"));
  }
  return h(
    "ul",
    { class: "timeline" },
    events.map((entry) =>
      h(
        "li",
        { class: `tk-${entry.event}` },
        h("span", { class: "timeline-dot", "aria-hidden": "true" }),
        h(
          "div",
          { class: "timeline-body" },
          h("div", { class: "timeline-head" }, h("strong", {}, t(`ticketEvent_${entry.event}`)), h("span", { class: "muted" }, formatDate(entry.at))),
          entry.people.length > 0
            ? h("p", { class: "timeline-reason" }, entry.people.flatMap((person, index) => [index > 0 ? ", " : null, ticketPerson(guildId, person.id, person.name)]))
            : null,
          entry.detail ? h("p", { class: "timeline-reason" }, entry.detail) : null,
          h(
            "span",
            { class: "muted timeline-by" },
            entry.actorId ? [t("ticketsHistoryBy"), " ", ticketPerson(guildId, entry.actorId, entry.actorName)] : t("ticketsHistoryAutomatic"),
          ),
        ),
      ),
    ),
  );
}

async function showTicket(guildId, data, number) {
  const { ticket, transcript, events = [] } = await api(`/api/guilds/${guildId}/tickets/${number}`);
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
      card(t("ticketsHistory"), "clock", "purple", ticketHistory(guildId, events)),
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

// --- Ban appeals -------------------------------------------------------------------

const MAX_APPEAL_QUESTIONS = 5;
const MAX_APPEAL_QUESTION_LENGTH = 200;
const APPEAL_FILTERS = ["open", "accepted", "denied", "all"];
const APPEAL_BADGES = { open: "badge-amber", accepted: "badge-green", denied: "badge-red" };
const appealLink = (guildId, number) => `#/g/${guildId}/appeals?appeal=${number}`;
const appealPageUrl = (guildId) => `${location.origin}/#/appeal/${guildId}`;
const appealBadge = (appeal) => h("span", { class: `badge ${APPEAL_BADGES[appeal.status] ?? ""}` }, t(`appealStatus_${appeal.status}`));

function questionRow(question, onRemove) {
  const row = h(
    "div",
    { class: "reward-row" },
    icon("message"),
    h("input", {
      class: "appeal-question grow",
      type: "text",
      maxLength: MAX_APPEAL_QUESTION_LENGTH,
      required: true,
      placeholder: t("appealsQuestionPlaceholder"),
      value: question ?? "",
      "aria-label": t("appealsQuestion"),
    }),
    h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
  );
  return row;
}

function readAppeals(form) {
  return {
    enabled: form.querySelector("#appealsEnabled").checked,
    channelId: form.querySelector("#appealsChannelId").value || null,
    questions: [...form.querySelectorAll(".appeal-question")].map((input) => input.value.replace(/\s+/g, " ").trim()).filter(Boolean),
    cooldownDays: Number(form.querySelector("#appealsCooldown").value),
  };
}

function appealRow(guildId, appeal) {
  return h(
    "li",
    {},
    h(
      "a",
      { class: "ticket-row", href: appealLink(guildId, appeal.number) },
      h("strong", { class: "ticket-number" }, `#${appeal.number}`),
      h(
        "span",
        { class: "ticket-main" },
        h("span", { class: "ticket-subject" }, appeal.userName ?? appeal.userTag ?? appeal.userId),
        h("span", { class: "muted" }, [formatDate(appeal.createdAt), appeal.banReason].filter(Boolean).join(" · ")),
      ),
      appealBadge(appeal),
    ),
  );
}

// The appeals sent to the server, filtered by status, with "Load more".
function appealList(guildId) {
  let status = "open";
  let page = 0;
  const list = h("ul", { class: "ticket-list" });
  const empty = h("p", { class: "muted empty", hidden: true });
  const summary = h("p", { class: "help" });
  const more = h("button", { class: "ghost", type: "button", hidden: true }, t("loadMore"));
  const load = async ({ reset = false } = {}) => {
    if (reset) {
      page = 0;
      list.replaceChildren();
    }
    setBusy(more, true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status !== "all") {
        params.set("status", status);
      }
      const result = await api(`/api/guilds/${guildId}/appeals?${params}`);
      list.append(...result.appeals.map((appeal) => appealRow(guildId, appeal)));
      summary.textContent = t("appealsOpenCount", { count: formatNumber(result.openCount) });
      empty.textContent = t(status === "open" ? "appealsNoneOpen" : "appealsNone");
      empty.hidden = list.children.length > 0;
      page += 1;
      more.hidden = !result.more;
    } finally {
      setBusy(more, false);
    }
  };
  more.addEventListener("click", () => load().catch(failed));
  const filter = segmented(
    t("appealsFilter"),
    APPEAL_FILTERS.map((value) => ({ value, text: t(`appealStatus_${value}`) })),
    status,
    (value) => {
      status = value;
      load({ reset: true }).catch(failed);
    },
  );
  const element = card(t("appealsList"), "folder", "amber", h("div", { class: "toolbar" }, summary, h("span", { class: "grow" }), filter), empty, list, h("div", { class: "center" }, more));
  return { element, load };
}

async function showAppeal(guildId, data, number) {
  let { appeal } = await api(`/api/guilds/${guildId}/appeals/${number}`);
  const render = () => {
    const person = h("a", { href: memberLink(guildId, appeal.userId) }, appeal.userName ?? appeal.userTag ?? appeal.userId);
    const facts = [
      [t("appealsFrom"), person],
      [t("appealsSent"), formatDate(appeal.createdAt)],
      [t("appealsBanReason"), appeal.banReason ?? t("appealsNoReason")],
      appeal.decidedAt ? [t("appealsDecidedBy"), appeal.decidedBy ? h("a", { href: memberLink(guildId, appeal.decidedBy) }, appeal.decidedByName ?? appeal.decidedBy) : "—"] : null,
      appeal.decidedAt ? [t("appealsDecided"), formatDate(appeal.decidedAt)] : null,
      appeal.decisionReason ? [t("appealsDecisionReason"), appeal.decisionReason] : null,
    ].filter(Boolean);
    const answers = appeal.answers.map((entry) =>
      h("div", { class: "appeal-answer" }, h("strong", {}, entry.question ?? t("appealDefaultQuestion")), h("p", {}, entry.answer)),
    );
    let decide = null;
    if (appeal.status === "open") {
      const reason = h("textarea", { id: "appealReason", rows: 2, maxLength: 512, placeholder: t("appealsReasonPlaceholder") });
      const buttons = [];
      const send = async (decision) => {
        if (decision === "accept" && !confirm(t("appealsAcceptConfirm"))) {
          return;
        }
        buttons.forEach((button) => setBusy(button, true));
        try {
          ({ appeal } = await api(`/api/guilds/${guildId}/appeals/${number}`, { method: "POST", body: { decision, reason: reason.value } }));
          toast(t(decision === "accept" ? "appealsAccepted" : "appealsDenied"));
          render();
        } catch (error) {
          failed(error);
          buttons.forEach((button) => setBusy(button, false));
        }
      };
      buttons.push(
        h("button", { class: "primary", type: "button", onclick: () => send("accept") }, icon("check", "icon small"), t("appealsAccept")),
        h("button", { class: "danger", type: "button", onclick: () => send("deny") }, icon("x", "icon small"), t("appealsDeny")),
      );
      decide = card(
        t("appealsDecide"),
        "gavel",
        "red",
        h("p", { class: "help" }, t("appealsDecideHelp")),
        field("appealsDecisionReason", "appealsReasonHelp", reason),
        h("div", { class: "toolbar" }, buttons),
      );
    }
    show(
      guildLayout(
        data,
        "appeals",
        h("a", { class: "back", href: `#/g/${guildId}/appeals` }, t("appealsBack")),
        h(
          "section",
          { class: "card" },
          h("div", { class: "toolbar" }, h("h1", { class: "grow ticket-title" }, t("appealsTitle", { number: appeal.number })), appealBadge(appeal)),
          h("dl", { class: "facts" }, facts.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])),
        ),
        card(t("appealsAnswers"), "message", "blue", answers),
        decide,
      ),
    );
  };
  render();
}

async function showAppeals(guildId) {
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const number = Number.parseInt(query.get("appeal") ?? "", 10);
  if (Number.isInteger(number) && number > 0) {
    return showAppeal(guildId, data, number);
  }
  const config = data.settings.appeals;
  const questions = editableList({
    items: config.questions,
    max: MAX_APPEAL_QUESTIONS,
    makeRow: questionRow,
    focus: ".appeal-question",
    emptyKey: "appealsNoQuestions",
    addKey: "appealsAddQuestion",
  });
  const link = h("input", { type: "text", readOnly: true, value: appealPageUrl(guildId), class: "grow", "aria-label": t("appealsLink") });
  const appeals = appealList(guildId);
  settingsPage({
    data,
    pageId: "appeals",
    intro: t("appealsIntro"),
    cards: [
      card(
        t("appealsSettings"),
        "gavel",
        "amber",
        h(
          "label",
          { class: "switch-card" },
          h("span", { class: "switch-text" }, h("strong", {}, t("appealsEnabled")), h("span", { class: "help" }, t("appealsEnabledHelp"))),
          h("span", { class: "switch" }, h("input", { id: "appealsEnabled", type: "checkbox", role: "switch", checked: config.enabled, "aria-label": t("appealsEnabled") })),
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, t("appealsLink")),
          h(
            "div",
            { class: "link-row" },
            link,
            h(
              "button",
              {
                class: "ghost small",
                type: "button",
                onclick: () => navigator.clipboard?.writeText(link.value).then(() => toast(t("appealsLinkCopied")), () => link.select()),
              },
              icon("copy", "icon small"),
              t("appealsCopyLink"),
            ),
          ),
          h("span", { class: "help" }, t("appealsLinkHelp")),
        ),
        field("appealsChannel", "appealsChannelHelp", picker({ id: "appealsChannelId", options: postableChannels(data), value: config.channelId, emptyLabel: t("appealsChannelDefault") })),
        field("appealsCooldown", "appealsCooldownHelp", h("input", { id: "appealsCooldown", type: "number", min: 0, max: 365, step: 1, required: true, value: config.cooldownDays })),
      ),
      card(
        t("appealsQuestions"),
        "message",
        "blue",
        h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("appealsQuestionsHelp")), questions.count, questions.addButton),
        questions.empty,
        questions.list,
      ),
    ],
    fields: { appeals: readAppeals },
    after: appeals.element,
  });
  await appeals.load();
}

// The page a banned member opens (from the link in their ban DM) to appeal.
async function showAppealForm(guildId) {
  state.me = await api("/api/me");
  renderChrome();
  const info = await api(`/api/appeals/${guildId}`);
  const header = h("div", { class: "appeal-head" }, guildIcon(info.guild, "lg"), h("h1", {}, t("appealPageTitle", { server: info.guild.name })));
  const panel = (...children) => show(h("section", { class: "card appeal-page" }, header, ...children));
  const notice = (key, values) => panel(h("p", { class: "muted" }, t(key, values)));
  switch (info.state) {
    case "closed":
      return notice("appealClosed");
    case "not-banned":
      return notice("appealNotBanned");
    case "pending":
      return notice("appealPending", { date: formatDate(info.latest.createdAt) });
    case "cooldown":
      return notice("appealCooldown", { date: formatDate(info.cooldownEndsAt) });
  }
  const boxes = info.questions.map((question, index) => {
    const box = messageBox(`appealAnswer${index}`, "", t("appealAnswerPlaceholder"), info.maxAnswer);
    box.querySelector("textarea").required = true;
    return h("label", { class: "field" }, h("span", { class: "field-label" }, question ?? t("appealDefaultQuestion")), box);
  });
  const submit = h("button", { class: "primary big", type: "submit" }, t("appealSend"));
  const form = h(
    "form",
    {
      class: "appeal-form",
      onsubmit: async (event) => {
        event.preventDefault();
        const answers = [...form.querySelectorAll("textarea")].map((box) => box.value.trim());
        if (answers.some((answer) => !answer)) {
          toast(t("appealAnswerAll"), "error");
          return;
        }
        setBusy(submit, true);
        try {
          await api(`/api/appeals/${guildId}`, { method: "POST", body: { answers } });
          notice("appealSent");
        } catch (error) {
          failed(error);
          setBusy(submit, false);
        }
      },
    },
    boxes,
    submit,
  );
  const previous =
    info.latest?.status === "denied" ? h("p", { class: "tip" }, icon("alert"), h("span", {}, t("appealPreviouslyDenied", { date: formatDate(info.latest.decidedAt) }))) : null;
  panel(
    h("p", { class: "muted" }, t("appealIntro")),
    h("dl", { class: "facts" }, h("dt", {}, t("appealsBanReason")), h("dd", {}, info.banReason ?? t("appealsNoReason"))),
    previous,
    form,
  );
}

// --- Embed builder ---------------------------------------------------------------

const MAX_EMBED_FIELDS = 25;
const EMBED_DEFAULT_COLOR = "#5865f2";
const EMBED_SWATCHES = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245", "#f0b232", "#00a8fc", "#99aab5"];

// Discord-style markdown for the preview: **bold**, *italic*, __underline__,
// ~~strike~~, `code`, [links](https://…) and mentions shown as names.
function discordMarkdown(text, data) {
  const pattern = /(\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|<@!?(\d{17,20})>|<@&(\d{17,20})>|<#(\d{17,20})>)/s;
  const nodes = [];
  let rest = text;
  while (rest) {
    const match = rest.match(pattern);
    if (!match) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) {
      nodes.push(rest.slice(0, match.index));
    }
    const [whole, , bold, underline, italic, italic2, strike, code, linkText, linkUrl, userId, roleId, channelId] = match;
    if (bold !== undefined) {
      nodes.push(h("strong", {}, discordMarkdown(bold, data)));
    } else if (underline !== undefined) {
      nodes.push(h("u", {}, discordMarkdown(underline, data)));
    } else if (italic !== undefined || italic2 !== undefined) {
      nodes.push(h("em", {}, discordMarkdown(italic ?? italic2, data)));
    } else if (strike !== undefined) {
      nodes.push(h("s", {}, discordMarkdown(strike, data)));
    } else if (code !== undefined) {
      nodes.push(h("code", {}, code));
    } else if (linkText !== undefined) {
      nodes.push(h("a", { href: linkUrl, target: "_blank", rel: "noopener noreferrer" }, linkText));
    } else if (userId) {
      nodes.push(h("span", { class: "mention" }, `@${data.people?.[userId] ?? t("embedUnknownUser")}`));
    } else if (roleId) {
      nodes.push(h("span", { class: "mention" }, `@${data.roles.find((role) => role.id === roleId)?.name ?? t("embedUnknownRole")}`));
    } else if (channelId) {
      nodes.push(h("span", { class: "mention" }, `#${data.channels.find((channel) => channel.id === channelId)?.name ?? t("embedUnknownChannel")}`));
    }
    rest = rest.slice(match.index + whole.length);
  }
  return nodes;
}

const hexColor = (number) => `#${number.toString(16).padStart(6, "0")}`;
const colorNumber = (hex) => Number.parseInt(hex.slice(1), 16);
const httpUrl = (text) => (/^https?:\/\/\S+$/.test(text) ? text : null);

function embedFieldRow(field, onRemove) {
  const row = h(
    "div",
    { class: "embed-field-row" },
    h("input", { class: "embed-field-name", type: "text", maxLength: 256, placeholder: t("embedFieldName"), value: field?.name ?? "", "aria-label": t("embedFieldName") }),
    h("textarea", { class: "embed-field-value", rows: 2, maxLength: 1024, placeholder: t("embedFieldValue"), "aria-label": t("embedFieldValue") }, field?.value ?? ""),
    h(
      "div",
      { class: "toolbar" },
      h("label", { class: "switch" }, h("input", { class: "embed-field-inline", type: "checkbox", checked: Boolean(field?.inline) }), h("span", {}, t("embedFieldInline"))),
      h("span", { class: "grow" }),
      h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
    ),
  );
  return row;
}

// The editor's message, in the shape the server checks ({ content, embed }).
function readEmbedForm(form) {
  const value = (selector) => form.querySelector(selector).value.trim();
  return {
    content: value("#embedContent"),
    embed: {
      title: value("#embedTitle"),
      url: value("#embedUrl"),
      description: value("#embedDescription"),
      color: form.querySelector("#embedUseColor").checked ? colorNumber(form.querySelector("#embedColor").value) : null,
      author: { name: value("#embedAuthor"), icon_url: value("#embedAuthorIcon") },
      footer: { text: value("#embedFooter") },
      image: { url: value("#embedImage") },
      thumbnail: { url: value("#embedThumbnail") },
      fields: [...form.querySelectorAll(".embed-field-row")].map((row) => ({
        name: row.querySelector(".embed-field-name").value.trim(),
        value: row.querySelector(".embed-field-value").value.trim(),
        inline: row.querySelector(".embed-field-inline").checked,
      })),
    },
  };
}

// The message as Discord would show it.
function embedPreview(message, data) {
  const md = (text) => discordMarkdown(text, data);
  const embed = message.embed;
  const fields = embed.fields.filter((field) => field.name || field.value);
  const hasEmbed = Boolean(embed.title || embed.description || embed.author.name || embed.footer.text || httpUrl(embed.image.url) || httpUrl(embed.thumbnail.url) || fields.length > 0);
  const bar = embed.color === null ? null : hexColor(embed.color);
  const thumbnail = httpUrl(embed.thumbnail.url);
  return h(
    "div",
    { class: "discord-message" },
    h("img", { class: "discord-avatar", src: "favicon.svg", alt: "" }),
    h(
      "div",
      { class: "discord-body" },
      h("div", { class: "discord-head" }, h("strong", {}, t("embedBotName")), h("span", { class: "discord-bot-tag" }, t("embedBotTag")), h("span", { class: "muted" }, t("embedToday"))),
      message.content ? h("div", { class: "discord-content" }, md(message.content)) : null,
      hasEmbed
        ? h(
            "div",
            { class: `discord-embed${bar ? "" : " no-color"}`, "data-color": bar ?? "" },
            h(
              "div",
              { class: "discord-embed-main" },
              embed.author.name
                ? h("div", { class: "discord-embed-author" }, httpUrl(embed.author.icon_url) ? h("img", { src: embed.author.icon_url, alt: "" }) : null, embed.author.name)
                : null,
              embed.title
                ? h("div", { class: "discord-embed-title" }, httpUrl(embed.url) ? h("a", { href: embed.url, target: "_blank", rel: "noopener noreferrer" }, md(embed.title)) : md(embed.title))
                : null,
              embed.description ? h("div", { class: "discord-embed-description" }, md(embed.description)) : null,
              fields.length > 0
                ? h(
                    "div",
                    { class: "discord-embed-fields" },
                    fields.map((field) => h("div", { class: `discord-embed-field${field.inline ? " inline" : ""}` }, h("strong", {}, md(field.name)), h("div", {}, md(field.value)))),
                  )
                : null,
              httpUrl(embed.image.url) ? h("img", { class: "discord-embed-image", src: embed.image.url, alt: "" }) : null,
              embed.footer.text ? h("div", { class: "discord-embed-footer" }, embed.footer.text) : null,
            ),
            thumbnail ? h("img", { class: "discord-embed-thumbnail", src: thumbnail, alt: "" }) : null,
          )
        : null,
      !message.content && !hasEmbed ? h("p", { class: "muted" }, t("embedEmpty")) : null,
    ),
  );
}

function sentRow(guildId, entry, data, onEdit) {
  const channel = data.channels.find((item) => item.id === entry.channelId);
  return h(
    "li",
    { class: "sent-row" },
    iconChip("message", "blue", "sm"),
    h(
      "span",
      { class: "ticket-main" },
      h("span", { class: "ticket-subject" }, entry.summary),
      h(
        "span",
        { class: "muted" },
        [channel ? `#${channel.name}` : null, entry.sentByName ?? entry.sentBy, formatDate(entry.editedAt ?? entry.sentAt), entry.editedAt ? t("embedEdited") : null].filter(Boolean).join(" · "),
      ),
    ),
    h("a", { class: "button ghost small", href: `https://discord.com/channels/${guildId}/${entry.channelId}/${entry.messageId}`, target: "_blank", rel: "noopener" }, icon("external", "icon small")),
    h("button", { class: "ghost small", type: "button", onclick: () => onEdit(`https://discord.com/channels/${guildId}/${entry.channelId}/${entry.messageId}`) }, icon("edit", "icon small"), t("embedEdit")),
  );
}

async function showEmbeds(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  // Editing an existing message: { channelId, messageId }.
  let editing = null;
  const blank = { content: "", embed: { title: "", url: "", description: "", color: colorNumber(EMBED_DEFAULT_COLOR), author: { name: "", icon_url: "" }, footer: { text: "" }, image: { url: "" }, thumbnail: { url: "" }, fields: [] } };

  const input = (id, attributes = {}) => h("input", { id, type: "text", ...attributes });
  const fields = editableList({ items: [], max: MAX_EMBED_FIELDS, makeRow: embedFieldRow, focus: ".embed-field-name", emptyKey: "embedNoFields", addKey: "embedAddField" });
  const colorInput = h("input", { id: "embedColor", type: "color", value: EMBED_DEFAULT_COLOR, "aria-label": t("embedColor") });
  const useColor = h("input", { id: "embedUseColor", type: "checkbox", checked: true });
  const swatches = EMBED_SWATCHES.map((swatch) => {
    const button = h("button", {
      type: "button",
      class: "swatch",
      "data-swatch": swatch,
      title: swatch,
      "aria-label": swatch,
      onclick: () => {
        colorInput.value = swatch;
        useColor.checked = true;
        refresh();
      },
    });
    button.style.setProperty("--swatch", swatch);
    return button;
  });
  const channelSelect = picker({ id: "embedChannel", options: postableChannels(data), value: null, emptyLabel: t("embedPickChannel") });
  const modeLine = h("p", { class: "help" });
  const send = h("button", { class: "primary", type: "submit" }, icon("upload", "icon small"), h("span", {}, t("embedSend")));
  const preview = h("div", { class: "embed-preview" });
  const count = h("span", { class: "char-count" });

  const form = h(
    "form",
    {
      class: "embed-form",
      oninput: () => refresh(),
      onchange: () => refresh(),
      onsubmit: async (event) => {
        event.preventDefault();
        await submit();
      },
    },
    card(
      t("embedWhere"),
      "hash",
      "blue",
      modeLine,
      field("embedChannel", null, channelSelect),
      field("embedContent", "embedContentHelp", h("textarea", { id: "embedContent", rows: 3, maxLength: 2000, placeholder: t("embedContentPlaceholder") })),
    ),
    card(
      t("embedEmbed"),
      "image",
      "purple",
      h(
        "div",
        { class: "embed-color-row" },
        h("label", { class: "switch" }, useColor, h("span", {}, t("embedUseColor"))),
        colorInput,
        h("div", { class: "swatches" }, swatches),
      ),
      h("div", { class: "embed-grid" }, field("embedAuthor", null, input("embedAuthor", { maxLength: 256 })), field("embedAuthorIcon", null, input("embedAuthorIcon", { placeholder: "https://…" }))),
      h("div", { class: "embed-grid" }, field("embedTitle", null, input("embedTitle", { maxLength: 256 })), field("embedUrl", null, input("embedUrl", { placeholder: "https://…" }))),
      field("embedDescription", "embedDescriptionHelp", h("textarea", { id: "embedDescription", rows: 5, maxLength: 4096 })),
      h("div", { class: "toolbar" }, h("strong", { class: "grow" }, t("embedFields")), fields.count, fields.addButton),
      fields.empty,
      fields.list,
      h("div", { class: "embed-grid" }, field("embedImage", null, input("embedImage", { placeholder: "https://…" })), field("embedThumbnail", null, input("embedThumbnail", { placeholder: "https://…" }))),
      field("embedFooter", null, input("embedFooter", { maxLength: 2048 })),
      h("div", { class: "toolbar" }, count),
    ),
    h(
      "div",
      { class: "save-bar embed-actions" },
      h("button", { class: "ghost", type: "button", onclick: () => load(null) }, t("embedClear")),
      h("span", { class: "grow" }),
      send,
    ),
  );

  function refresh() {
    const message = readEmbedForm(form);
    preview.replaceChildren(embedPreview(message, data));
    preview.querySelectorAll("[data-color]").forEach((element) => element.style.setProperty("--embed-color", element.dataset.color || "transparent"));
    const embed = message.embed;
    const total = [embed.title, embed.description, embed.author.name, embed.footer.text, ...embed.fields.flatMap((entry) => [entry.name, entry.value])].join("").length;
    count.textContent = t("embedTotal", { count: formatNumber(total), max: "6,000" });
    count.classList.toggle("danger-text", total > 6000);
    state.unsaved = true;
  }

  // Fills the editor with a message (or empties it) and says what Send does.
  function load(target) {
    editing = target ? { channelId: target.channelId, messageId: target.messageId } : null;
    const message = target?.message ?? blank;
    const embed = message.embed ?? blank.embed;
    const set = (id, value) => (form.querySelector(`#${id}`).value = value ?? "");
    set("embedContent", message.content);
    set("embedTitle", embed.title);
    set("embedUrl", embed.url);
    set("embedDescription", embed.description);
    set("embedAuthor", embed.author.name);
    set("embedAuthorIcon", embed.author.icon_url);
    set("embedFooter", embed.footer.text);
    set("embedImage", embed.image.url);
    set("embedThumbnail", embed.thumbnail.url);
    useColor.checked = embed.color !== null;
    colorInput.value = embed.color === null ? EMBED_DEFAULT_COLOR : hexColor(embed.color);
    fields.set(embed.fields);
    channelSelect.value = editing?.channelId ?? "";
    channelSelect.disabled = Boolean(editing);
    const channel = editing && data.channels.find((item) => item.id === editing.channelId);
    modeLine.textContent = editing
      ? t(target.message.extraEmbeds > 0 ? "embedEditingExtra" : "embedEditing", { channel: channel ? `#${channel.name}` : editing.channelId, count: target.message.extraEmbeds })
      : t("embedNew");
    send.lastChild.textContent = t(editing ? "embedSave" : "embedSend");
    refresh();
    state.unsaved = false;
  }

  async function submit() {
    const message = readEmbedForm(form);
    setBusy(send, true);
    try {
      if (editing) {
        await api(`/api/guilds/${guildId}/messages/${editing.channelId}/${editing.messageId}`, { method: "PUT", body: { message } });
        toast(t("embedSaved"));
      } else {
        if (!channelSelect.value) {
          toast(t("embedPickChannel"), "error");
          return;
        }
        const result = await api(`/api/guilds/${guildId}/messages`, { method: "POST", body: { channelId: channelSelect.value, message } });
        toast(t("embedSent"));
        load({ channelId: result.message.channelId, messageId: result.message.messageId, message: { ...message, extraEmbeds: 0, embed: { ...message.embed } } });
      }
      state.unsaved = false;
      await loadSent();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(send, false);
    }
  }

  async function lookUp(link) {
    if (state.unsaved && !confirm(t("leaveUnsaved"))) {
      return;
    }
    try {
      const found = await api(`/api/guilds/${guildId}/messages/lookup?${new URLSearchParams({ link })}`);
      load(found);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      failed(error);
    }
  }

  const linkInput = h("input", { type: "url", class: "grow", placeholder: t("embedLinkPlaceholder"), "aria-label": t("embedLinkPlaceholder") });
  const editBar = h(
    "form",
    {
      class: "card toolbar link-bar",
      onsubmit: (event) => {
        event.preventDefault();
        if (linkInput.value.trim()) {
          lookUp(linkInput.value.trim());
        }
      },
    },
    icon("edit"),
    h("span", { class: "muted" }, t("embedEditExisting")),
    linkInput,
    h("button", { class: "ghost", type: "submit" }, t("embedLoad")),
  );

  const sentList = h("ul", { class: "ticket-list" });
  const sentEmpty = h("p", { class: "muted empty" }, t("embedNoneSent"));
  async function loadSent() {
    const { messages } = await api(`/api/guilds/${guildId}/messages`);
    sentList.replaceChildren(...messages.map((entry) => sentRow(guildId, entry, data, lookUp)));
    sentEmpty.hidden = messages.length > 0;
  }

  show(
    guildLayout(
      data,
      "embeds",
      pageHero("embeds", t("embedsIntro"), data),
      editBar,
      h("div", { class: "embed-layout" }, form, h("aside", { class: "embed-side" }, card(t("embedPreview"), "eye", "green", preview))),
      card(t("embedRecent"), "list", "amber", sentEmpty, sentList),
    ),
  );
  load(null);
  await loadSent();
}

// --- Feeds ---------------------------------------------------------------------------

const FEED_KINDS = ["youtube", "youtube_shorts", "youtube_live", "twitch", "kick", "bluesky", "mastodon", "reddit", "github", "rss"];
const FEED_TONES = {
  youtube: "red",
  youtube_shorts: "red",
  youtube_live: "red",
  twitch: "purple",
  kick: "green",
  bluesky: "cyan",
  mastodon: "purple",
  reddit: "amber",
  github: "gray",
  rss: "blue",
};
const FEED_ICONS = {
  youtube: "image",
  youtube_shorts: "image",
  youtube_live: "mic",
  twitch: "mic",
  kick: "mic",
  bluesky: "message",
  mastodon: "message",
  reddit: "message",
  github: "download",
  rss: "rss",
};
// Kinds that need keys on the bot's server; the message shown without them.
const FEED_KEYS_OFF = { twitch: "feedsTwitchOff", kick: "feedsKickOff" };

// "@everyone" when a feed pings everyone (the role with the server's ID).
const feedPingLabel = (guildId, roleId, data) => {
  if (!roleId) {
    return null;
  }
  if (roleId === guildId) {
    return "@everyone";
  }
  const role = data.roles.find((item) => item.id === roleId);
  return role ? `@${role.name}` : t("unknownOption", { id: roleId });
};

// A feed's message box. Its placeholder is what the feed posts while the box is
// empty (the default for its kind, in the server's language), and one button
// either copies that default in to edit or clears a custom message back to it.
// setKind() swaps the default when the type changes on the add form.
function feedMessageField(data, { id, kind, value }) {
  const defaults = data.communityDefaults?.feedMessages ?? {};
  const max = 500;
  let current = kind;
  const defaultFor = () => defaults[current] ?? defaults.rss ?? "";
  const box = h("textarea", { id, rows: 3, maxLength: max });
  box.value = value ?? "";
  const count = h("span", { class: "char-count" });
  const status = h("span", { class: "help grow" });
  const toggle = h("button", { class: "ghost small", type: "button" });
  const update = () => {
    const custom = box.value.trim() !== "";
    box.placeholder = defaultFor();
    count.textContent = `${box.value.length}/${max}`;
    status.textContent = t(custom ? "feedsMessageCustom" : "feedsMessageUsingDefault");
    toggle.replaceChildren(icon(custom ? "refresh" : "edit", "icon small"), t(custom ? "feedsMessageReset" : "feedsMessageEditDefault"));
  };
  toggle.addEventListener("click", () => {
    const custom = box.value.trim() !== "";
    box.value = custom ? "" : defaultFor();
    update();
    box.focus();
  });
  box.addEventListener("input", update);
  update();
  return {
    box,
    setKind(next) {
      current = next;
      update();
    },
    element: h(
      "div",
      { class: "feed-message" },
      field("feedsMessage", "feedsMessageHelp", h("span", { class: "message-box" }, box, count)),
      h("div", { class: "toolbar" }, status, toggle),
    ),
  };
}

// One followed feed. Edit opens a form under it for where it posts, who it
// pings and its message; what it follows stays (that's a new feed).
function feedRow(guildId, feed, data, roles, onChanged) {
  const channel = data.channels.find((item) => item.id === feed.channelId);
  const facts = [
    channel ? `#${channel.name}` : t("unknownOption", { id: feed.channelId }),
    feedPingLabel(guildId, feed.roleId, data),
    feed.postedAt ? t("feedsLastPost", { date: formatAgo(feed.postedAt) }) : t("feedsNoPostYet"),
    t(feed.message ? "feedsCustomMessage" : "feedsDefaultMessage"),
  ].filter(Boolean);
  const editor = h("div", { class: "feed-editor", hidden: true });
  const editButton = h("button", { class: "ghost small", type: "button", "aria-expanded": "false" }, t("embedEdit"));

  const closeEditor = () => {
    editor.hidden = true;
    editor.replaceChildren();
    editButton.setAttribute("aria-expanded", "false");
  };

  const openEditor = () => {
    const channelPicker = picker({ id: `feedChannel-${feed.id}`, options: postableChannels(data), value: feed.channelId, emptyLabel: t("embedPickChannel") });
    channelPicker.required = true;
    const rolePicker = picker({ id: `feedRole-${feed.id}`, options: roles, value: feed.roleId, emptyLabel: t("feedsNoRole") });
    const message = feedMessageField(data, { id: `feedMessage-${feed.id}`, kind: feed.kind, value: feed.message });
    const messageInput = message.box;
    const save = h("button", { class: "primary small", type: "submit" }, t("feedsSave"));
    const form = h(
      "form",
      {
        onsubmit: async (event) => {
          event.preventDefault();
          setBusy(save, true);
          try {
            await api(`/api/guilds/${guildId}/feeds/${feed.id}`, {
              method: "PATCH",
              body: { channelId: channelPicker.value, roleId: rolePicker.value || null, message: messageInput.value.trim() || null },
            });
            toast(t("feedsEdited", { name: feed.name }));
            onChanged();
          } catch (error) {
            failed(error);
            setBusy(save, false);
          }
        },
      },
      h(
        "div",
        { class: "embed-grid" },
        field("feedsChannel", null, channelPicker),
        field("feedsRole", "feedsRoleHelp", rolePicker),
      ),
      message.element,
      h("div", { class: "toolbar" }, h("span", { class: "grow" }), h("button", { class: "ghost small", type: "button", onclick: closeEditor }, t("cancel")), save),
    );
    editor.replaceChildren(form);
    editor.hidden = false;
    editButton.setAttribute("aria-expanded", "true");
    channelPicker.focus();
  };
  editButton.addEventListener("click", () => (editor.hidden ? openEditor() : closeEditor()));

  return h(
    "li",
    { class: "sent-row feed-row" },
    iconChip(FEED_ICONS[feed.kind] ?? "rss", FEED_TONES[feed.kind], "sm"),
    h(
      "span",
      { class: "ticket-main" },
      h("span", { class: "ticket-subject" }, h("strong", {}, feed.name), " ", h("span", { class: "badge" }, t(`feedsKind_${feed.kind}`))),
      h("span", { class: "muted" }, facts.join(" · ")),
      feed.lastError ? h("span", { class: "danger-text small-text" }, t("feedsProblem", { error: feed.lastError })) : null,
    ),
    h(
      "span",
      { class: "row-actions" },
      editButton,
      h(
        "button",
        {
          class: "ghost small",
          type: "button",
          onclick: async () => {
            if (!confirm(t("feedsRemoveConfirm", { name: feed.name }))) {
              return;
            }
            try {
              await api(`/api/guilds/${guildId}/feeds/${feed.id}`, { method: "DELETE" });
              toast(t("feedsRemoved"));
              onChanged();
            } catch (error) {
              failed(error);
            }
          },
        },
        t("tagRemove"),
      ),
    ),
    editor,
  );
}

async function showFeeds(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const list = h("ul", { class: "ticket-list" });
  const empty = h("p", { class: "muted empty" }, t("feedsNone"));
  const countPill = h("span", { class: "count-pill" });
  let kind = "youtube";
  // Set by load(): which of Twitch and Kick have keys.
  let liveReady = {};
  const sourceHelp = h("span", { class: "help" });
  const sourceInput = h("input", { id: "feedSource", type: "text", required: true, maxLength: 500 });
  const showKind = () => {
    sourceInput.placeholder = t(`feedsSourcePlaceholder_${kind}`);
    const off = kind in FEED_KEYS_OFF && liveReady[kind] === false;
    sourceHelp.textContent = off ? t(FEED_KEYS_OFF[kind]) : t(`feedsSourceHelp_${kind}`);
    sourceHelp.classList.toggle("danger-text", off);
    message.setKind(kind);
  };
  // @everyone is the role with the server's ID; listed first.
  const roles = [{ id: guildId, label: t("feedsEveryone") }, ...data.roles.filter((role) => role.id !== guildId && !role.managed).map((role) => roleItem(role))];
  const add = h("button", { class: "primary", type: "submit" }, icon("plus", "icon small"), t("feedsAdd"));
  const message = feedMessageField(data, { id: "feedMessage", kind, value: null });
  const messageInput = message.box;

  async function load() {
    const result = await api(`/api/guilds/${guildId}/feeds`);
    list.replaceChildren(...result.feeds.map((feed) => feedRow(guildId, feed, data, roles, () => load().catch(failed))));
    empty.hidden = result.feeds.length > 0;
    countPill.textContent = t("tagsCount", { count: result.feeds.length, max: result.max });
    add.disabled = result.feeds.length >= result.max;
    liveReady = result.live ?? {};
    showKind();
  }

  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        setBusy(add, true);
        add.lastChild.textContent = t("feedsAdding");
        try {
          const result = await api(`/api/guilds/${guildId}/feeds`, {
            method: "POST",
            body: {
              kind,
              source: sourceInput.value.trim(),
              channelId: form.querySelector("#feedChannel").value || null,
              roleId: form.querySelector("#feedRole").value || null,
              message: messageInput.value.trim() || null,
            },
          });
          toast(t("feedsAdded", { name: result.feed.name }));
          sourceInput.value = "";
          messageInput.value = "";
          message.setKind(kind);
          add.lastChild.textContent = t("feedsAdd");
          // load() then disables the button again if the limit is reached.
          setBusy(add, false);
          await load();
        } catch (error) {
          add.lastChild.textContent = t("feedsAdd");
          setBusy(add, false);
          failed(error);
        }
      },
    },
    field(
      "feedsKind",
      null,
      h(
        "select",
        {
          id: "feedKind",
          onchange: (event) => {
            kind = event.currentTarget.value;
            showKind();
          },
        },
        FEED_KINDS.map((value) => h("option", { value, selected: value === kind }, t(`feedsKind_${value}`))),
      ),
    ),
    h("label", { class: "field" }, h("span", { class: "field-label" }, t("feedsSource")), sourceInput, sourceHelp),
    h("p", { class: "help" }, t("feedsOtherSites")),
    h(
      "div",
      { class: "embed-grid" },
      field("feedsChannel", null, picker({ id: "feedChannel", options: postableChannels(data), value: null, emptyLabel: t("embedPickChannel") })),
      field("feedsRole", "feedsRoleHelp", picker({ id: "feedRole", options: roles, value: null, emptyLabel: t("feedsNoRole") })),
    ),
    message.element,
    h("div", { class: "toolbar" }, h("span", { class: "grow" }), add),
  );
  form.querySelector("#feedChannel").required = true;
  showKind();

  show(
    guildLayout(
      data,
      "feeds",
      pageHero("feeds", t("feedsIntro"), data),
      card(t("feedsNew"), "plus", "green", form),
      card(t("page_feeds"), "rss", "amber", h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("feedsListHelp")), countPill), empty, list),
    ),
  );
  await load();
}

// --- Sticky messages ---------------------------------------------------------------

function stickyRow(sticky, data, onEdit, onRemove) {
  const channel = data.channels.find((item) => item.id === sticky.channelId);
  return h(
    "li",
    { class: "sent-row" },
    iconChip("pin", "pink", "sm"),
    h(
      "span",
      { class: "ticket-main" },
      h("span", { class: "ticket-subject" }, h("strong", {}, channel ? `#${channel.name}` : t("unknownOption", { id: sticky.channelId }))),
      h("span", { class: "muted sticky-preview" }, sticky.content),
      h("span", { class: "muted small-text" }, t("stickyUpdated", { date: formatAgo(sticky.updatedAt) })),
    ),
    h("span", { class: "row-actions" }, h("button", { class: "ghost small", type: "button", onclick: onEdit }, t("embedEdit")), h("button", { class: "ghost small", type: "button", onclick: onRemove }, t("tagRemove"))),
  );
}

async function showStickies(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const list = h("ul", { class: "ticket-list" });
  const empty = h("p", { class: "muted empty" }, t("stickyNone"));
  const countPill = h("span", { class: "count-pill" });
  const save = h("button", { class: "primary", type: "submit" }, icon("pin", "icon small"), t("stickySave"));
  const content = h("textarea", { id: "stickyContent", rows: 4, maxLength: 1500, required: true, placeholder: t("stickyPlaceholder") });
  const counter = h("span", { class: "muted small-text" });
  const showCount = () => {
    counter.textContent = `${content.value.length}/1500`;
  };
  content.addEventListener("input", showCount);
  let current = [];
  let max = 10;

  async function load() {
    const result = await api(`/api/guilds/${guildId}/stickies`);
    current = result.stickies;
    max = result.max;
    list.replaceChildren(
      ...current.map((sticky) =>
        stickyRow(
          sticky,
          data,
          () => {
            form.querySelector("#stickyChannel").value = sticky.channelId;
            content.value = sticky.content;
            showCount();
            content.focus();
          },
          async () => {
            if (!confirm(t("stickyRemoveConfirm"))) {
              return;
            }
            try {
              await api(`/api/guilds/${guildId}/stickies/${sticky.channelId}`, { method: "DELETE" });
              toast(t("stickyRemoved"));
              await load();
            } catch (error) {
              failed(error);
            }
          },
        ),
      ),
    );
    empty.hidden = current.length > 0;
    countPill.textContent = t("tagsCount", { count: current.length, max });
  }

  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const channelId = form.querySelector("#stickyChannel").value;
        setBusy(save, true);
        try {
          const replacing = current.some((sticky) => sticky.channelId === channelId);
          await api(`/api/guilds/${guildId}/stickies/${channelId}`, { method: "PUT", body: { content: content.value } });
          toast(t(replacing ? "stickyChanged" : "stickyAdded"));
          content.value = "";
          showCount();
          await load();
        } catch (error) {
          failed(error);
        } finally {
          setBusy(save, false);
        }
      },
    },
    field("stickyChannel", "stickyChannelHelp", picker({ id: "stickyChannel", options: postableChannels(data), value: null, emptyLabel: t("embedPickChannel") })),
    field("stickyContent", "stickyContentHelp", content),
    h("div", { class: "toolbar" }, counter, h("span", { class: "grow" }), save),
  );
  form.querySelector("#stickyChannel").required = true;
  showCount();

  show(
    guildLayout(
      data,
      "sticky",
      pageHero("sticky", t("stickyIntro"), data),
      card(t("stickyNew"), "pin", "pink", form),
      card(t("page_sticky"), "list", "blue", h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("stickyListHelp")), countPill), empty, list),
    ),
  );
  await load();
}

// --- Backup ------------------------------------------------------------------

// Download every setting as a file, or restore one: the file is checked first
// and the page lists what would change before anything is saved.
async function showBackup(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const download = h("a", { class: "button primary", href: `/api/guilds/${guildId}/backup`, download: "" }, icon("download", "icon small"), t("backupDownload"));
  const file = h("input", { id: "backupFile", type: "file", accept: ".json,application/json" });
  const review = h("div", { class: "backup-review", hidden: true });
  // The chosen file as uploaded: { file: its text, fileName }. The server
  // checks it again in full; these checks only spare a pointless upload.
  let upload = null;

  const itemList = (items, line) => h("ul", { class: "backup-list" }, ...items.map((item) => h("li", {}, line(item))));

  function showPlan(plan) {
    const parts = [];
    if (plan.changes.length === 0) {
      parts.push(h("p", { class: "muted" }, t("backupNothing")));
    } else {
      parts.push(h("h3", {}, t("backupChanges", { count: plan.changes.length })), itemList(plan.changes, (change) => change.label));
    }
    if (plan.skipped.length > 0) {
      parts.push(
        h("h3", {}, t("backupSkipped", { count: plan.skipped.length })),
        itemList(plan.skipped, (entry) => [h("strong", {}, entry.label), " ", h("span", { class: "muted" }, entry.reason === "invalid" && entry.message ? entry.message : t(`backupReason_${entry.reason}`))]),
      );
    }
    if (plan.unchanged > 0) {
      parts.push(h("p", { class: "muted small-text" }, t("backupUnchanged", { count: plan.unchanged })));
    }
    if (plan.changes.length > 0) {
      const confirmButton = h("button", { class: "primary", type: "button" }, icon("upload", "icon small"), t("backupRestore"));
      confirmButton.addEventListener("click", async () => {
        if (!confirm(t("backupRestoreConfirm", { count: plan.changes.length }))) {
          return;
        }
        setBusy(confirmButton, true);
        try {
          const result = await api(`/api/guilds/${guildId}/backup/restore`, { method: "POST", body: { ...upload, dryRun: false } });
          toast(t("backupRestored", { count: result.changes.length }));
          await showBackup(guildId);
        } catch (error) {
          failed(error);
          setBusy(confirmButton, false);
        }
      });
      parts.push(h("div", { class: "toolbar" }, h("span", { class: "grow" }), confirmButton));
    }
    review.replaceChildren(...parts);
    review.hidden = false;
  }

  file.addEventListener("change", async () => {
    review.hidden = true;
    upload = null;
    const chosen = file.files?.[0];
    if (!chosen) {
      return;
    }
    if (chosen.size > 512 * 1024) {
      toast(t("backupTooBig"), "error");
      return;
    }
    // Only a .json file whose type is JSON or unknown (some systems give none).
    if (!/\.json$/i.test(chosen.name) || !["", "application/json", "text/json"].includes(chosen.type)) {
      toast(t("backupNotJson"), "error");
      file.value = "";
      return;
    }
    const text = await chosen.text();
    try {
      JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      toast(t("backupNotJson"), "error");
      file.value = "";
      return;
    }
    upload = { file: text, fileName: chosen.name };
    try {
      showPlan(await api(`/api/guilds/${guildId}/backup/restore`, { method: "POST", body: { ...upload, dryRun: true } }));
    } catch (error) {
      failed(error);
    }
  });

  show(
    guildLayout(
      data,
      "backup",
      pageHero("backup", t("backupIntro"), data),
      card(t("backupDownloadTitle"), "download", "cyan", h("p", { class: "help" }, t("backupDownloadHelp")), h("div", { class: "toolbar" }, download)),
      card(t("backupRestoreTitle"), "upload", "amber", field("backupFile", "backupFileHelp", file), review),
    ),
  );
}

// --- Branding ----------------------------------------------------------------------

const BRANDING_NICKNAME_MAX = 32;
// Each image is sent as a data: URL. Keeping both under about 400 KB keeps
// the request under nginx's default 1 MB limit.
const BRANDING_IMAGE_MAX = 400_000;
const BRANDING_SIZES = { avatar: [512, 512], banner: [960, 384] };
const BRANDING_FALLBACK_COLOR = "#7c5cff";

// Reads an image file, crops it to fill width×height and shrinks it, in the
// browser. Returns a data: URL (PNG, else WebP, else JPEG, whichever fits).
async function shrinkImage(file, [width, height]) {
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Not an image"));
    image.src = source;
  });
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error("Not an image");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  canvas.getContext("2d").drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  for (const [type, quality] of [["image/png"], ["image/webp", 0.9], ["image/jpeg", 0.88], ["image/jpeg", 0.7]]) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type}`) && url.length <= BRANDING_IMAGE_MAX) {
      return url;
    }
  }
  throw new Error("Too big");
}

// The Branding page: the bot's nickname, avatar and banner in this
// server (Discord's per-server profile), and the embed colour.
async function showBranding(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  let saved;
  try {
    saved = await api(`/api/guilds/${guildId}/branding`);
  } catch (error) {
    failed(error);
    return;
  }
  // What's changed and not saved yet. Images: a data: URL, or null for the default.
  let draft = {};

  const nickname = h("input", { id: "brandingNickname", type: "text", maxLength: BRANDING_NICKNAME_MAX, autocomplete: "off" });
  const colorInput = h("input", { id: "brandingColor", type: "color", "aria-label": t("brandingColor") });
  const colorState = h("p", { class: "help" });
  const saveButton = h("button", { class: "primary", type: "button" }, icon("check", "icon small"), t("brandingSave"));

  // Preview: the bot's profile card, and an embed in the chosen colour.
  const previewBanner = h("div", { class: "brand-banner" });
  const previewAvatar = h("img", { class: "brand-avatar", alt: "" });
  const previewName = h("strong", { class: "brand-name" });
  const sampleAvatar = h("img", { class: "discord-avatar", alt: "" });
  const sampleName = h("strong", {});
  const sampleEmbed = h(
    "div",
    { class: "brand-embed" },
    h("strong", {}, t("brandingSampleTitle")),
    h("p", {}, t("brandingSampleText")),
  );

  const current = (part) => (part in draft ? draft[part] : saved[part]);
  const imageOf = (part) => {
    const changed = draft[part];
    if (changed !== undefined) {
      return changed ?? saved.defaults[`${part}Url`];
    }
    return saved[`${part}Url`] ?? saved.defaults[`${part}Url`];
  };
  const colorOf = () => {
    const value = current("color");
    return value === null || value === undefined ? null : hexColor(value);
  };

  function refresh() {
    const name = nickname.value.trim() || saved.defaults.name;
    const avatar = imageOf("avatar");
    const banner = imageOf("banner");
    const color = colorOf();
    previewAvatar.hidden = !avatar;
    sampleAvatar.hidden = !avatar;
    if (avatar) {
      previewAvatar.src = avatar;
      sampleAvatar.src = avatar;
    }
    previewBanner.replaceChildren(banner ? h("img", { src: banner, alt: "" }) : "");
    previewBanner.style.setProperty("--brand", color ?? BRANDING_FALLBACK_COLOR);
    sampleEmbed.style.setProperty("--brand", color ?? BRANDING_FALLBACK_COLOR);
    previewName.replaceChildren(name, h("span", { class: "app-badge" }, "APP"));
    sampleName.replaceChildren(name, " ", h("span", { class: "app-badge" }, "APP"));
    colorState.textContent = color ? "" : t("brandingColorUsingDefault");
    colorState.hidden = Boolean(color);
    saveButton.disabled = Object.keys(changes()).length === 0;
  }

  // The fields that differ from what Discord and the dashboard have now.
  function changes() {
    const body = {};
    const nick = nickname.value.trim() || null;
    if (nick !== (saved.nickname ?? null)) {
      body.nickname = nick;
    }
    for (const part of ["avatar", "banner"]) {
      if (draft[part] !== undefined) {
        body[part] = draft[part];
      }
    }
    if ("color" in draft && draft.color !== saved.color) {
      body.color = draft.color;
    }
    return body;
  }

  function fill() {
    draft = {};
    nickname.value = saved.nickname ?? "";
    nickname.placeholder = saved.defaults.name;
    colorInput.value = saved.color === null ? BRANDING_FALLBACK_COLOR : hexColor(saved.color);
    refresh();
  }

  const setColor = (value) => {
    draft.color = value;
    if (value !== null) {
      colorInput.value = hexColor(value);
    }
    refresh();
  };
  colorInput.addEventListener("input", () => setColor(Number.parseInt(colorInput.value.slice(1), 16)));
  nickname.addEventListener("input", refresh);
  const swatches = [BRANDING_FALLBACK_COLOR, ...EMBED_SWATCHES].map((swatch) => {
    const button = h("button", { type: "button", class: "swatch", title: swatch, "aria-label": swatch, onclick: () => setColor(Number.parseInt(swatch.slice(1), 16)) });
    button.style.setProperty("--swatch", swatch);
    return button;
  });

  // A file picker and a "use default" button for the avatar or banner.
  function imagePicker(part) {
    const input = h("input", { id: `branding_${part}`, type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "visually-hidden" });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) {
        return;
      }
      try {
        draft[part] = await shrinkImage(file, BRANDING_SIZES[part]);
      } catch {
        toast(t("brandingImageFailed"), "error");
        return;
      }
      refresh();
    });
    const choose = h("label", { class: "button ghost small", for: input.id }, icon("upload", "icon small"), t("brandingChooseImage"));
    const reset = h(
      "button",
      {
        type: "button",
        class: "ghost small",
        onclick: () => {
          draft[part] = null;
          refresh();
        },
      },
      icon("refresh", "icon small"),
      t("brandingUseDefault"),
    );
    const label = part === "avatar" ? "brandingAvatar" : "brandingBanner";
    return h(
      "div",
      { class: "field" },
      h("span", { class: "field-label" }, t(label)),
      h("div", { class: "toolbar" }, input, choose, reset),
      h("span", { class: "help" }, t(`${label}Help`)),
    );
  }

  saveButton.addEventListener("click", async () => {
    const body = changes();
    if (Object.keys(body).length === 0) {
      toast(t("brandingNothing"));
      return;
    }
    setBusy(saveButton, true);
    try {
      saved = await api(`/api/guilds/${guildId}/branding`, { method: "PATCH", body });
      state.cache = null;
      fill();
      toast(t("brandingSaved"));
    } catch (error) {
      failed(error);
    } finally {
      setBusy(saveButton, false);
      refresh();
    }
  });
  const discard = h("button", { class: "ghost", type: "button", onclick: fill }, t("brandingDiscard"));

  show(
    guildLayout(
      data,
      "branding",
      pageHero("branding", t("brandingIntro"), data),
      h(
        "div",
        { class: "brand-grid" },
        h(
          "div",
          { class: "brand-column" },
          card(
            t("brandingProfile"),
            "user",
            "pink",
            field("brandingNickname", "brandingNicknameHelp", nickname),
            imagePicker("avatar"),
            imagePicker("banner"),
            h("p", { class: "help" }, t("brandingRateHelp")),
          ),
          card(
            t("brandingColor"),
            "palette",
            "purple",
            h("p", { class: "help" }, t("brandingColorHelp")),
            h(
              "div",
              { class: "toolbar" },
              colorInput,
              h("div", { class: "swatches" }, swatches),
              h("button", { type: "button", class: "ghost small", onclick: () => setColor(null) }, icon("refresh", "icon small"), t("brandingColorDefault")),
            ),
            colorState,
          ),
        ),
        card(
          t("brandingPreview"),
          "image",
          "blue",
          h(
            "div",
            { class: "embed-preview brand-preview" },
            h("div", { class: "brand-card" }, previewBanner, previewAvatar, h("div", { class: "brand-card-body" }, previewName)),
            h("div", { class: "discord-message" }, sampleAvatar, h("div", { class: "discord-body" }, h("div", { class: "discord-head" }, sampleName), sampleEmbed)),
          ),
          h("p", { class: "help" }, t("brandingLimits")),
        ),
      ),
      h("div", { class: "toolbar" }, h("span", { class: "grow" }), discard, saveButton),
    ),
  );
  fill();
}

// --- Server stats ------------------------------------------------------------------

const COUNTER_PRESET_NAMES = ["members", "humans", "bots", "boosts", "channels", "roles"];
const COUNTER_TEMPLATE_MAX = 60;

// A counter: its channel's current name (or that it's being created), and its
// name template, editable in place.
function counterRow(guildId, counter, data, onChanged) {
  const channel = counter.channelId && data.channels.find((item) => item.id === counter.channelId);
  const input = h("input", { type: "text", value: counter.template, maxLength: COUNTER_TEMPLATE_MAX, "aria-label": t("countersName") });
  const save = h("button", { class: "small", type: "button", hidden: true }, t("save"));
  input.addEventListener("input", () => {
    save.hidden = input.value.trim() === counter.template;
  });
  save.addEventListener("click", async () => {
    setBusy(save, true);
    try {
      await api(`/api/guilds/${guildId}/counters/${counter.id}`, { method: "PATCH", body: { template: input.value } });
      toast(t("countersSaved"));
      onChanged();
    } catch (error) {
      failed(error);
      setBusy(save, false);
    }
  });
  const remove = h(
    "button",
    {
      class: "ghost small",
      type: "button",
      onclick: async () => {
        if (!confirm(t("countersRemoveConfirm"))) {
          return;
        }
        try {
          const result = await api(`/api/guilds/${guildId}/counters/${counter.id}`, { method: "DELETE" });
          toast(t(result.channelDeleted ? "countersRemoved" : "countersRemovedKeptChannel"));
          onChanged();
        } catch (error) {
          failed(error);
        }
      },
    },
    t("tagRemove"),
  );
  const status = counter.channelId
    ? h("span", { class: "muted" }, icon("volume", "icon small"), " ", channel ? channel.name : t("countersChannelPending"))
    : counter.error
      ? null
      : h("span", { class: "muted" }, t("countersCreating"));
  return h(
    "li",
    { class: "sent-row counter-row" },
    iconChip("chart", "blue", "sm"),
    h("span", { class: "ticket-main" }, h("span", { class: "counter-edit" }, input, save), status, counter.error ? h("span", { class: "danger-text small-text" }, t("feedsProblem", { error: counter.error })) : null),
    remove,
  );
}

async function showCounters(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const list = h("ul", { class: "ticket-list" });
  const empty = h("p", { class: "muted empty" }, t("countersNone"));
  const countPill = h("span", { class: "count-pill" });
  const add = h("button", { class: "primary", type: "submit" }, icon("plus", "icon small"), t("countersAdd"));
  let presets = {};
  const nameInput = h("input", { id: "counterName", type: "text", required: true, maxLength: COUNTER_TEMPLATE_MAX });
  const categories = data.channels.filter((channel) => channel.type === CHANNEL.CATEGORY).map((channel) => ({ id: channel.id, label: channel.name }));
  let refreshTimer;

  async function load() {
    const result = await api(`/api/guilds/${guildId}/counters`);
    presets = result.presets;
    if (!nameInput.value) {
      nameInput.value = presets.members;
    }
    list.replaceChildren(...result.counters.map((counter) => counterRow(guildId, counter, data, () => load().catch(failed))));
    empty.hidden = result.counters.length > 0;
    countPill.textContent = t("tagsCount", { count: result.counters.length, max: result.max });
    add.disabled = result.counters.length >= result.max;
    // New counters get their channel from the bot within a minute; check back.
    clearTimeout(refreshTimer);
    if (result.counters.some((counter) => !counter.channelId && !counter.error)) {
      refreshTimer = setTimeout(() => {
        if (document.body.contains(list)) {
          loadManagedGuild(guildId, { fresh: true })
            .then((fresh) => {
              if (fresh) {
                data.channels = fresh.channels;
              }
              return load();
            })
            .catch(() => {});
        }
      }, 15_000);
    }
  }

  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        setBusy(add, true);
        try {
          await api(`/api/guilds/${guildId}/counters`, {
            method: "POST",
            body: { template: nameInput.value, categoryId: form.querySelector("#counterCategory").value || null },
          });
          toast(t("countersAdded"));
          // load() then disables the button again if the limit is reached.
          setBusy(add, false);
          await load();
        } catch (error) {
          setBusy(add, false);
          failed(error);
        }
      },
    },
    field(
      "countersPreset",
      null,
      h(
        "div",
        { class: "segmented wrap" },
        COUNTER_PRESET_NAMES.map((name, index) => {
          const button = h("button", { type: "button", class: "segment", "aria-pressed": String(index === 0) }, t(`countersPreset_${name}`));
          button.addEventListener("click", (event) => {
            pickOne([...event.currentTarget.parentElement.children], event.currentTarget);
            nameInput.value = presets[name] ?? nameInput.value;
          });
          return button;
        }),
      ),
    ),
    h(
      "div",
      { class: "embed-grid" },
      field("countersName", "countersNameHelp", nameInput),
      field("countersCategory", "countersCategoryHelp", picker({ id: "counterCategory", options: categories, value: null, emptyLabel: t("countersNoCategory") })),
    ),
    h("div", { class: "toolbar" }, h("span", { class: "grow" }), add),
  );

  show(
    guildLayout(
      data,
      "counters",
      pageHero("counters", t("countersIntro"), data),
      card(t("countersNew"), "plus", "green", form),
      card(t("page_counters"), "chart", "blue", h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("countersListHelp")), countPill), empty, list),
    ),
  );
  await load();
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
    setBusy(more, true);
    try {
      const page = await api(`/api/guilds/${guildId}/activity${before ? `?before=${before}` : ""}`);
      list.append(...page.entries.map((entry) => activityRow(entry, data)));
      empty.hidden = list.children.length > 0;
      before = page.next;
      more.hidden = !page.next;
    } finally {
      setBusy(more, false);
    }
  };
  more.addEventListener("click", () => load().catch(failed));
  show(guildLayout(data, "activity", pageHero("activity", t("activityIntro"), data), h("section", { class: "card" }, empty, list, h("div", { class: "center" }, more))));
  await load();
}

// --- Guide -------------------------------------------------------------------

// Every topic in guide.js, in order, with the part it's in.
const GUIDE_TOPICS = GUIDE.flatMap(({ id, part, sections }) => sections.map((section) => ({ ...section, part, partId: id })));
const guideLink = (guildId, topicId) => `#/g/${guildId}/guide${topicId ? `?topic=${topicId}` : ""}`;
// The command reference's page for each slash command, by name ("/ban").
const COMMAND_PAGES = new Map(GUIDE_TOPICS.filter((topic) => topic.command).map((topic) => [topic.command, topic]));
// The command page a usage line ("/case view number") belongs to.
const commandPageOf = (usage) => COMMAND_PAGES.get(usage.split(" ")[0]);
const guidePartLink = (guildId, partId) => `#/g/${guildId}/guide?part=${partId}`;

// Guide text: `code`, **bold** and *italic* become elements, everything else stays text.
function guideText(text) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/).filter(Boolean).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return h("code", {}, part.slice(1, -1));
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return h("strong", {}, part.slice(2, -2));
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return h("em", {}, part.slice(1, -1));
    }
    return part;
  });
}

// Everything a topic says, lowercased, for the filter box.
const guideSearchText = (topic) =>
  searchable(
    [
      topic.title,
      topic.part,
      topic.summary,
      topic.who,
      topic.native,
      ...(topic.steps ?? []),
      ...(topic.commands ?? []).flat(),
      ...(topic.usages ?? []).flatMap((usage) => [usage.usage, usage.what, ...usage.options.flat()]),
      ...[topic.table, topic.legend].flatMap((table) => (table ? table.rows.flat() : [])),
      ...(topic.example ?? []),
      ...(topic.tips ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  );

// Guide text is English, so it keeps reading left to right in Arabic.
const guideEnglish = (tag, attributes, ...children) => h(tag, { ...attributes, lang: "en", dir: "ltr" }, ...children);

const guideEnglishNote = () => (state.language === "en" ? null : h("p", { class: "tip" }, icon("globe"), h("span", {}, t("guideEnglishNote"))));

// Guide › part › topic, above a part or topic page.
function guideCrumbs(guildId, part, topic) {
  const crumbs = [h("a", { href: guideLink(guildId) }, t("page_guide"))];
  if (part) {
    crumbs.push(topic ? guideEnglish("a", { href: guidePartLink(guildId, part.id) }, part.part) : guideEnglish("span", { "aria-current": "page" }, part.part));
  }
  if (topic) {
    crumbs.push(guideEnglish("span", { "aria-current": "page" }, topic.title));
  }
  return h(
    "nav",
    { class: "guide-crumbs", "aria-label": t("page_guide") },
    crumbs.flatMap((crumb, index) => (index === 0 ? [crumb] : [icon("chevronRight", "icon small"), crumb])),
  );
}

// A topic as a row that opens its page.
function guideTopicRow(guildId, topic, withPart = false) {
  return guideEnglish(
    "a",
    { class: "card guide-row", href: guideLink(guildId, topic.id) },
    iconChip(topic.icon, topic.tone),
    h(
      "span",
      { class: "grow" },
      h("strong", {}, topic.title),
      h("span", { class: "muted" }, guideText(topic.summary)),
      withPart ? h("span", { class: "guide-row-part" }, topic.part) : null,
    ),
    icon("chevronRight", "icon small"),
  );
}

// Previous and next, at the bottom of a part or topic page.
function guidePager(previous, next) {
  const link = (entry, labelKey, iconName, className) =>
    entry
      ? h(
          "a",
          { class: `card guide-pager-link ${className}`, href: entry.href },
          h("span", { class: "muted" }, className === "next" ? null : icon(iconName, "icon small"), t(labelKey), className === "next" ? icon(iconName, "icon small") : null),
          guideEnglish("strong", {}, entry.title),
        )
      : h("span");
  return h("nav", { class: "guide-pager" }, link(previous, "guidePrevious", "chevronLeft", "previous"), link(next, "guideNext", "chevronRight", "next"));
}

function guideTable({ head, rows }) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "table guide-table" },
      head.some(Boolean) ? h("thead", {}, h("tr", {}, head.map((cell) => h("th", {}, cell)))) : null,
      h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, guideText(cell)))))),
    ),
  );
}

// One way to run a command: its usage line, what it does, and each option.
// An option in [brackets] in the usage line is optional.
function guideUsage({ usage, what, options }) {
  const optional = new Set([...usage.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]));
  const rows = options.map(([name, text]) =>
    h(
      "tr",
      {},
      h("td", {}, h("code", {}, name), h("span", { class: `guide-flag${optional.has(name) ? "" : " required"}` }, t(optional.has(name) ? "guideOptional" : "guideRequired"))),
      h("td", {}, guideText(text)),
    ),
  );
  return h(
    "div",
    { class: "guide-usage" },
    h("h3", {}, h("code", {}, usage)),
    h("p", {}, guideText(what)),
    rows.length > 0
      ? h("div", { class: "table-wrap" }, h("table", { class: "table guide-table guide-options", "aria-label": t("guideOptions") }, h("tbody", {}, rows)))
      : h("p", { class: "muted" }, t("guideNoOptions")),
  );
}

// Links to the command pages for the commands a feature topic lists.
function guideCommandLinks(guildId, topic) {
  const pages = [...new Set((topic.commands ?? []).map(([usage]) => commandPageOf(usage)).filter(Boolean))];
  if (pages.length === 0) {
    return null;
  }
  return h(
    "p",
    { class: "guide-command-links" },
    h("strong", {}, t("guideCommandPage")),
    pages.map((page) => h("a", { class: "guide-sibling", href: guideLink(guildId, page.id) }, page.command)),
  );
}

// Everything one topic says, as a card.
function guideTopicBody(topic, guildId) {
  const related = topic.related && GUIDE_TOPICS.find((entry) => entry.id === topic.related);
  const commands = topic.commands?.length
    ? h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table guide-table guide-commands" },
          h("thead", {}, h("tr", {}, h("th", {}, t("guideCommand")), h("th", {}, t("guideWhat")))),
          h("tbody", {}, topic.commands.map(([usage, what]) => h("tr", {}, h("td", {}, h("code", {}, usage)), h("td", {}, guideText(what))))),
        ),
      )
    : null;
  return guideEnglish(
    "section",
    { class: "card guide-body" },
    topic.who ? h("p", { class: "guide-who" }, h("strong", {}, t("guideWho")), " ", guideText(topic.who)) : null,
    topic.native ? h("p", { class: "tip" }, icon("sparkles"), h("span", {}, h("strong", {}, t("guideNative")), " ", guideText(topic.native))) : null,
    related
      ? h("p", { class: "tip" }, icon("book"), h("span", {}, h("strong", {}, t("guideReadMore")), " ", h("a", { href: guideLink(guildId, related.id) }, related.title)))
      : null,
    topic.steps?.length ? h("ol", { class: "guide-steps" }, topic.steps.map((step) => h("li", {}, guideText(step)))) : null,
    topic.table ? guideTable(topic.table) : null,
    commands,
    guideCommandLinks(guildId, topic),
    topic.usages?.length ? h("div", { class: "guide-usages" }, topic.usages.map((usage) => guideUsage(usage))) : null,
    topic.legend ? guideTable(topic.legend) : null,
    topic.example?.length ? h("div", { class: "guide-example" }, h("span", { class: "field-label" }, t("guideExample")), h("pre", {}, h("code", {}, topic.example.join("\n")))) : null,
    topic.tips?.length
      ? h("div", {}, h("span", { class: "field-label" }, t("guideGoodToKnow")), h("ul", { class: "guide-tips" }, topic.tips.map((tip) => h("li", {}, guideText(tip)))))
      : null,
  );
}

// The guide's first page: one card per part, and a search over every topic.
function guideHome(data) {
  const guildId = data.guild.id;
  const searchTexts = GUIDE_TOPICS.map((topic) => ({ topic, text: guideSearchText(topic) }));
  const partCard = (part) =>
    h(
      "a",
      { class: "card guide-part-card", href: guidePartLink(guildId, part.id) },
      iconChip(part.icon, part.tone, "lg"),
      guideEnglish("strong", {}, part.part),
      guideEnglish("span", { class: "muted" }, part.about),
      h("span", { class: "guide-count" }, t("guideTopicCount", { count: part.sections.length })),
    );
  // The feature parts first, then each group (the command reference) under its heading.
  const groups = [...new Set(GUIDE.map((part) => part.group ?? ""))];
  const parts = h(
    "div",
    { class: "guide-groups" },
    groups.flatMap((group) => [
      group ? guideEnglish("h2", { class: "guide-group-title" }, group) : null,
      h("div", { class: "guide-parts" }, GUIDE.filter((part) => (part.group ?? "") === group).map(partCard)),
    ]),
  );
  const results = h("div", { class: "guide-list", hidden: true });
  const empty = h("p", { class: "muted empty", hidden: true }, t("guideNoMatch"));
  const input = h("input", { type: "search", class: "grow", placeholder: t("guideFilter"), "aria-label": t("guideFilter"), autocomplete: "off" });
  const filter = () => {
    const words = searchWords(input.value);
    const found = words.length > 0 ? searchTexts.filter((entry) => matchesWords(entry.text, words)) : [];
    results.replaceChildren(...found.map((entry) => guideTopicRow(guildId, entry.topic, true)));
    parts.hidden = words.length > 0;
    results.hidden = found.length === 0;
    empty.hidden = words.length === 0 || found.length > 0;
  };
  input.addEventListener("input", filter);
  filterKeys(input, filter);
  return [pageHero("guide", t("guideIntro"), data), guideEnglishNote(), h("div", { class: "guide-toolbar" }, input), parts, results, empty];
}

// One part: its topics, one row each.
function guidePart(data, part) {
  const guildId = data.guild.id;
  const index = GUIDE.indexOf(part);
  const pagerEntry = (entry) => entry && { href: guidePartLink(guildId, entry.id), title: entry.part };
  return [
    guideCrumbs(guildId, part),
    guideEnglish("div", {}, hero(part.part, part.about, part.tone, { iconName: part.icon })),
    guideEnglishNote(),
    h(
      "div",
      { class: "guide-list" },
      part.sections.map((section) => guideTopicRow(guildId, GUIDE_TOPICS.find((topic) => topic.id === section.id))),
    ),
    guidePager(pagerEntry(GUIDE[index - 1]), pagerEntry(GUIDE[index + 1])),
  ];
}

// One topic: the other topics in its part, what it says, and the topics before and after it.
function guideTopicPage(data, topic) {
  const guildId = data.guild.id;
  const part = GUIDE.find((entry) => entry.id === topic.partId);
  const index = GUIDE_TOPICS.indexOf(topic);
  const page = topic.page && visiblePages(data).find((entry) => entry.id === topic.page);
  const openPage = page ? h("a", { class: "button ghost small", href: `#/g/${guildId}/${page.id}` }, icon(page.icon, "icon small"), t("guideOpenPage", { page: t(`page_${page.id}`) })) : null;
  const pagerEntry = (entry) => entry && { href: guideLink(guildId, entry.id), title: entry.title };
  return [
    guideCrumbs(guildId, part, topic),
    guideEnglish("div", {}, hero(topic.title, guideText(topic.summary), topic.tone, { iconName: topic.icon, extra: openPage })),
    guideEnglishNote(),
    part.sections.length > 1
      ? guideEnglish(
          "nav",
          { class: "guide-siblings", "aria-label": part.part },
          part.sections.map((section) =>
            h("a", { class: "guide-sibling", href: guideLink(guildId, section.id), "aria-current": section.id === topic.id ? "page" : undefined }, section.title),
          ),
        )
      : null,
    guideTopicBody(topic, guildId),
    guidePager(pagerEntry(GUIDE_TOPICS[index - 1]), pagerEntry(GUIDE_TOPICS[index + 1])),
  ];
}

// The guide: #/g/<id>/guide, ?part=<id> for one part, ?topic=<id> for one topic.
async function showGuide(guildId) {
  const data = await loadGuild(guildId);
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const topic = GUIDE_TOPICS.find((entry) => entry.id === query.get("topic"));
  const part = !topic && GUIDE.find((entry) => entry.id === query.get("part"));
  const content = topic ? guideTopicPage(data, topic) : part ? guidePart(data, part) : guideHome(data);
  show(guildLayout(data, "guide", content));
}

// --- Routing -----------------------------------------------------------------

const SHOW_PAGE = {
  overview: showOverview,
  guide: showGuide,
  activity: showActivity,
  antinuke: showAntiNuke,
  cases: showCases,
  members: showMembers,
  tickets: showTickets,
  appeals: showAppeals,
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
  embeds: showEmbeds,
  feeds: showFeeds,
  counters: showCounters,
  sticky: showStickies,
  backup: showBackup,
  branding: showBranding,
  moderation: showModeration,
  logging: showLogging,
  access: showAccess,
};

// Where to go back to after logging in (the appeal page someone opened while
// logged out). Session storage can be off, so this is best effort.
const RETURN_KEY = "rv-return";
function rememberReturn(hash) {
  try {
    sessionStorage.setItem(RETURN_KEY, hash);
  } catch {
    // Private mode.
  }
}
function takeReturn() {
  try {
    const hash = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return hash;
  } catch {
    return null;
  }
}

// The landing page is for everyone, logged in or not. Logged in, it shows
// the account menu and a link to the dashboard.
async function showHome() {
  if (!state.me) {
    const response = await fetch("/api/me", { credentials: "same-origin" }).catch(() => null);
    state.me = response?.ok ? await response.json().catch(() => null) : null;
    renderChrome();
  }
  const failedLogin = new URLSearchParams(location.hash.split("?")[1] ?? "").get("login") === "failed";
  showLanding(failedLogin);
}

async function route() {
  let [path] = location.hash.replace(/^#/, "").split("?");
  if (path === "/servers") {
    const back = takeReturn();
    if (back && /^#\/appeal\/\d{17,20}$/.test(back)) {
      history.replaceState(null, "", back);
      [path] = location.hash.replace(/^#/, "").split("?");
    }
  }
  const appeal = path.match(/^\/appeal\/(\d{17,20})$/);
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
    if (appeal) {
      await showAppealForm(appeal[1]);
    } else if (match && SHOW_PAGE[pageId]) {
      await SHOW_PAGE[pageId](match[1]);
    } else if (path === "/servers") {
      await showServers();
    } else {
      await showHome();
    }
  } catch (error) {
    failed(error);
    if (!(error instanceof ApiError && error.status === 401) && match) {
      show(h("p", { class: "muted empty" }, t("errorGeneric")), h("a", { class: "button ghost", href: "#/servers" }, t("backToServers")));
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
