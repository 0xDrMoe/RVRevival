// How the AI ticket assistant works in a server, saved under
// Setting.TICKET_AI and changed on the dashboard's AI assistant page. Off
// until a server turns it on: ticket text is sent to an AI provider
// (Anthropic) only for servers that opt in.
//
// What a server can change:
//
//   enabled        the switch for everything below. Off by default.
//   triage         when a ticket opens, the AI notes a priority, a short
//                  summary, the category that fits best and the knowledge
//                  base articles that answer it, in the staff-only ticket log.
//   helpers        the Staff assist button: Summarize ticket and Suggest reply
//                  (staff read and edit the reply before it's sent).
//   closeSummary   a short AI summary in the ticket log when a ticket closes.
//   useTags        the server's tags (/tag) count as knowledge base articles.
//   monthlyLimit   AI requests a month for the server, capped by the bot's
//                  own AI_MONTHLY_LIMIT.
//   panelIds       when there are any, only these panels use the assistant
//                  ("main" is the main panel).
//   persona        { name, tone, toneNotes, emoji }: who the assistant is and
//                  how it sounds.
//   replies        { length, language, greeting, signOff, format, knowledge,
//                  placeholders, disclosure }: how suggested replies are written.
//   triageRules    { priorities, urgentWords, highWords, suggestCategory,
//                  maxArticles, summaryLanguage }: how tickets are triaged.
//   summaries      { style, maxPoints, closeDetail, closeLanguage }.
//   instructions   the server's own guidance, in its words (2000 characters).
//   avoidTopics    subjects the assistant never answers; it says staff will
//                  follow up instead.
//   privacy        { redactEmails, redactPhones, redactIps, fileNames }: what
//                  is taken out of ticket text before it's sent. Card numbers
//                  and Discord tokens are always taken out.
//   access         { roleIds, cooldownSeconds, messageLimit }: who of the
//                  ticket staff can use Staff assist, how often, and how much
//                  of a ticket the AI reads.
//   panels         per-panel changes: { [panelId]: { enabled, triage, helpers,
//                  closeSummary, tone, length, language, instructions } }.
//                  A missing key follows the server's setting.
//
// Some things are never settings (ai/guardrails.js): the assistant always
// says it's an AI when asked, never claims to be staff or a person, can't
// act on Discord, never asks for passwords, codes or card numbers, never
// helps break Discord's Terms or Community Guidelines, never pings, and the
// "AI" label on replies can't be turned off. The server's instructions sit
// below those rules: where they disagree, the rules win.

import { SUPPORTED_LANGUAGES } from "../i18n/i18n.js";

export const DEFAULT_MONTHLY_LIMIT = 200;
export const MIN_MONTHLY_LIMIT = 1;
export const MAX_MONTHLY_LIMIT = 5000;
export const MAX_AI_PANELS = 10;

export const TONES = Object.freeze(["friendly", "professional", "casual", "formal", "playful", "empathetic"]);
export const EMOJI_LEVELS = Object.freeze(["none", "few", "often"]);
export const REPLY_LENGTHS = Object.freeze(["short", "medium", "long"]);
export const REPLY_FORMATS = Object.freeze(["plain", "markdown"]);
export const KNOWLEDGE_MODES = Object.freeze(["strict", "general"]);
export const DISCLOSURES = Object.freeze(["checked", "assisted"]);
export const SUMMARY_STYLES = Object.freeze(["bullets", "paragraph"]);
export const CLOSE_DETAILS = Object.freeze(["brief", "detailed"]);
// "member": the language the member writes in; "server": the server's language.
export const REPLY_LANGUAGES = Object.freeze(["member", "server", ...SUPPORTED_LANGUAGES]);
export const LOG_LANGUAGES = Object.freeze(["en", "server"]);
export const PRIORITY_LEVELS = Object.freeze(["low", "normal", "high", "urgent"]);
export const PANEL_FEATURES = Object.freeze(["enabled", "triage", "helpers", "closeSummary"]);

export const MAX_NAME = 32;
export const MIN_NAME = 2;
export const MAX_TONE_NOTES = 300;
export const MAX_GREETING = 150;
export const MAX_INSTRUCTIONS = 2000;
export const MAX_PANEL_INSTRUCTIONS = 1000;
export const MAX_PRIORITY_NOTE = 200;
export const MAX_WORDS = 20;
export const MAX_WORD = 40;
export const MAX_TOPICS = 20;
export const MAX_TOPIC = 100;
export const MAX_ACCESS_ROLES = 10;
export const MAX_ARTICLES_PER_TRIAGE = 5;
export const MIN_COOLDOWN = 3;
export const MAX_COOLDOWN = 300;
export const MIN_MESSAGES = 20;
export const MAX_MESSAGES = 300;
export const MIN_POINTS = 3;
export const MAX_POINTS = 8;
// Placeholders a greeting and sign-off can use.
export const REPLY_PLACEHOLDERS = Object.freeze(["member", "staff", "server", "assistant"]);

const freeze = (value) => Object.freeze(value);

export const DEFAULT_TICKET_AI = freeze({
  enabled: false,
  triage: true,
  helpers: true,
  closeSummary: true,
  useTags: true,
  monthlyLimit: DEFAULT_MONTHLY_LIMIT,
  panelIds: freeze([]),
  persona: freeze({ name: "", tone: "friendly", toneNotes: "", emoji: "none" }),
  replies: freeze({
    length: "medium",
    language: "member",
    greeting: "",
    signOff: "",
    format: "markdown",
    knowledge: "strict",
    placeholders: true,
    disclosure: "checked",
  }),
  triageRules: freeze({
    priorities: freeze({ low: "", normal: "", high: "", urgent: "" }),
    urgentWords: freeze([]),
    highWords: freeze([]),
    suggestCategory: true,
    maxArticles: 3,
    summaryLanguage: "en",
  }),
  summaries: freeze({ style: "bullets", maxPoints: 5, closeDetail: "brief", closeLanguage: "en" }),
  instructions: "",
  avoidTopics: freeze([]),
  privacy: freeze({ redactEmails: true, redactPhones: true, redactIps: true, fileNames: true }),
  access: freeze({ roleIds: freeze([]), cooldownSeconds: 8, messageLimit: MAX_MESSAGES }),
  panels: freeze({}),
});

const SWITCHES = ["enabled", "triage", "helpers", "closeSummary", "useTags"];
const PANEL_ID = /^[a-z0-9-]{1,32}$/;
const ROLE_ID = /^\d{17,20}$/;
// Names that would pass the assistant off as Discord, Anthropic, a person or staff.
const IMPERSONATING = /discord|anthropic|clyde|\bsystem\b|\bofficial\b|\badmin(istrator)?\b|\bmod(erator)?\b|\bstaff\b|\bowner\b|\bhuman\b|\breal person\b/i;
const NAME_CHARACTERS = /^[\p{L}\p{N} .'_\-!?&()]+$/u;

export class InvalidTicketAi extends Error {
  name = "InvalidTicketAi";
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const objectOr = (value) => (isObject(value) ? value : {});
const oneOf = (list, value, fallback) => (list.includes(value) ? value : fallback);
const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const clamp = (value, min, max, fallback) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
// One line of text: control characters out, spaces squeezed, cut to `max`.
export const oneLine = (value, max) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
// Several lines: control characters out except newlines, at most two blank lines in a row.
export const multiLine = (value, max) =>
  typeof value === "string"
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
    : "";
const wordList = (value, maxItems, maxLength) =>
  Array.isArray(value)
    ? [...new Set(value.map((entry) => oneLine(entry, maxLength).toLowerCase()).filter(Boolean))].slice(0, maxItems)
    : [];
const panelList = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && PANEL_ID.test(id)))].slice(0, MAX_AI_PANELS) : []);
const roleList = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && ROLE_ID.test(id)))].slice(0, MAX_ACCESS_ROLES) : []);

function normalizePersona(value) {
  const saved = objectOr(value);
  const name = oneLine(saved.name, MAX_NAME);
  const defaults = DEFAULT_TICKET_AI.persona;
  return {
    name: name.length >= MIN_NAME && NAME_CHARACTERS.test(name) && !IMPERSONATING.test(name) ? name : "",
    tone: oneOf(TONES, saved.tone, defaults.tone),
    toneNotes: oneLine(saved.toneNotes, MAX_TONE_NOTES),
    emoji: oneOf(EMOJI_LEVELS, saved.emoji, defaults.emoji),
  };
}

function normalizeReplies(value) {
  const saved = objectOr(value);
  const defaults = DEFAULT_TICKET_AI.replies;
  return {
    length: oneOf(REPLY_LENGTHS, saved.length, defaults.length),
    language: oneOf(REPLY_LANGUAGES, saved.language, defaults.language),
    greeting: oneLine(saved.greeting, MAX_GREETING),
    signOff: oneLine(saved.signOff, MAX_GREETING),
    format: oneOf(REPLY_FORMATS, saved.format, defaults.format),
    knowledge: oneOf(KNOWLEDGE_MODES, saved.knowledge, defaults.knowledge),
    placeholders: flag(saved.placeholders, defaults.placeholders),
    disclosure: oneOf(DISCLOSURES, saved.disclosure, defaults.disclosure),
  };
}

function normalizeTriageRules(value) {
  const saved = objectOr(value);
  const defaults = DEFAULT_TICKET_AI.triageRules;
  const priorities = objectOr(saved.priorities);
  return {
    priorities: Object.fromEntries(PRIORITY_LEVELS.map((level) => [level, oneLine(priorities[level], MAX_PRIORITY_NOTE)])),
    urgentWords: wordList(saved.urgentWords, MAX_WORDS, MAX_WORD),
    highWords: wordList(saved.highWords, MAX_WORDS, MAX_WORD),
    suggestCategory: flag(saved.suggestCategory, defaults.suggestCategory),
    maxArticles: clamp(saved.maxArticles, 0, MAX_ARTICLES_PER_TRIAGE, defaults.maxArticles),
    summaryLanguage: oneOf(LOG_LANGUAGES, saved.summaryLanguage, defaults.summaryLanguage),
  };
}

function normalizeSummaries(value) {
  const saved = objectOr(value);
  const defaults = DEFAULT_TICKET_AI.summaries;
  return {
    style: oneOf(SUMMARY_STYLES, saved.style, defaults.style),
    maxPoints: clamp(saved.maxPoints, MIN_POINTS, MAX_POINTS, defaults.maxPoints),
    closeDetail: oneOf(CLOSE_DETAILS, saved.closeDetail, defaults.closeDetail),
    closeLanguage: oneOf(LOG_LANGUAGES, saved.closeLanguage, defaults.closeLanguage),
  };
}

function normalizePrivacy(value) {
  const saved = objectOr(value);
  const defaults = DEFAULT_TICKET_AI.privacy;
  return {
    redactEmails: flag(saved.redactEmails, defaults.redactEmails),
    redactPhones: flag(saved.redactPhones, defaults.redactPhones),
    redactIps: flag(saved.redactIps, defaults.redactIps),
    fileNames: flag(saved.fileNames, defaults.fileNames),
  };
}

function normalizeAccess(value) {
  const saved = objectOr(value);
  const defaults = DEFAULT_TICKET_AI.access;
  return {
    roleIds: roleList(saved.roleIds),
    cooldownSeconds: clamp(saved.cooldownSeconds, MIN_COOLDOWN, MAX_COOLDOWN, defaults.cooldownSeconds),
    messageLimit: clamp(saved.messageLimit, MIN_MESSAGES, MAX_MESSAGES, defaults.messageLimit),
  };
}

// One panel's changes: only the keys it sets.
function normalizePanel(value) {
  const saved = objectOr(value);
  const panel = {};
  for (const key of PANEL_FEATURES) {
    if (typeof saved[key] === "boolean") {
      panel[key] = saved[key];
    }
  }
  if (TONES.includes(saved.tone)) {
    panel.tone = saved.tone;
  }
  if (REPLY_LENGTHS.includes(saved.length)) {
    panel.length = saved.length;
  }
  if (REPLY_LANGUAGES.includes(saved.language)) {
    panel.language = saved.language;
  }
  const instructions = multiLine(saved.instructions, MAX_PANEL_INSTRUCTIONS);
  if (instructions) {
    panel.instructions = instructions;
  }
  return panel;
}

function normalizePanels(value) {
  const entries = Object.entries(objectOr(value))
    .filter(([id]) => PANEL_ID.test(id))
    .map(([id, panel]) => [id, normalizePanel(panel)])
    .filter(([, panel]) => Object.keys(panel).length > 0)
    .slice(0, MAX_AI_PANELS);
  return Object.fromEntries(entries);
}

// The saved options with every default filled in. Never throws.
export function normalizeTicketAi(saved) {
  const value = objectOr(saved);
  return {
    enabled: value.enabled === true,
    triage: value.triage !== false,
    helpers: value.helpers !== false,
    closeSummary: value.closeSummary !== false,
    useTags: value.useTags !== false,
    monthlyLimit: clamp(value.monthlyLimit, MIN_MONTHLY_LIMIT, MAX_MONTHLY_LIMIT, DEFAULT_MONTHLY_LIMIT),
    panelIds: panelList(value.panelIds),
    persona: normalizePersona(value.persona),
    replies: normalizeReplies(value.replies),
    triageRules: normalizeTriageRules(value.triageRules),
    summaries: normalizeSummaries(value.summaries),
    instructions: multiLine(value.instructions, MAX_INSTRUCTIONS),
    avoidTopics: wordList(value.avoidTopics, MAX_TOPICS, MAX_TOPIC),
    privacy: normalizePrivacy(value.privacy),
    access: normalizeAccess(value.access),
    panels: normalizePanels(value.panels),
  };
}

// Whether tickets from this panel (null = the main panel) use the assistant.
export function panelUsesAi(options, panelId) {
  const id = panelId ?? "main";
  if (options.panels?.[id]?.enabled === false) {
    return false;
  }
  return options.panelIds.length === 0 || options.panelIds.includes(id);
}

// The options for one panel's tickets: the server's, with that panel's changes on top.
// `instructions` stays the server's; the panel's own are `panelInstructions`.
export function optionsForPanel(options, panelId) {
  const panel = options.panels?.[panelId ?? "main"] ?? {};
  return {
    ...options,
    triage: panel.triage ?? options.triage,
    helpers: panel.helpers ?? options.helpers,
    closeSummary: panel.closeSummary ?? options.closeSummary,
    persona: { ...options.persona, tone: panel.tone ?? options.persona.tone },
    replies: { ...options.replies, length: panel.length ?? options.replies.length, language: panel.language ?? options.replies.language },
    panelInstructions: panel.instructions ?? "",
  };
}

// The name the assistant goes by: the server's, or the default for the language.
export const assistantName = (options, fallback = "Rabble AI") => options.persona?.name || fallback;

// --- Checking what the dashboard sends --------------------------------------------

const fail = (message) => {
  throw new InvalidTicketAi(message);
};

function checkKeys(value, defaults, where) {
  if (!isObject(value)) {
    fail(`${where} is { ${Object.keys(defaults).join(", ")} }.`);
  }
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(defaults, key));
  if (unknown) {
    fail(`Unknown ${where} option "${unknown}".`);
  }
}

function checkChoice(list, value, label) {
  if (value !== undefined && !list.includes(value)) {
    fail(`${label} is one of: ${list.join(", ")}.`);
  }
}

function checkSwitch(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    fail(`${label} is on or off (true or false).`);
  }
}

function checkText(value, max, label) {
  if (value !== undefined && (typeof value !== "string" || value.length > max)) {
    fail(`${label} is text of at most ${max} characters.`);
  }
}

function checkInteger(value, min, max, label) {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    fail(`${label} is a whole number from ${min} to ${max}.`);
  }
}

function checkWords(value, maxItems, maxLength, label) {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= maxLength)) {
    fail(`${label} is a list of up to ${maxItems} entries, each at most ${maxLength} characters.`);
  }
}

// A greeting or sign-off: only the placeholders it knows, and no pings.
function checkTemplate(value, label) {
  checkText(value, MAX_GREETING, label);
  if (typeof value !== "string") {
    return;
  }
  const unknown = [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).find((name) => !REPLY_PLACEHOLDERS.includes(name));
  if (unknown) {
    fail(`${label} can use {${REPLY_PLACEHOLDERS.join("}, {")}}, not {${unknown}}.`);
  }
  checkNoPings(value, label);
}

function checkNoPings(value, label) {
  if (typeof value === "string" && /@(everyone|here)|<@[!&]?\d+>|<#\d+>/.test(value)) {
    fail(`${label} can't mention people, roles or channels.`);
  }
}

function checkPersona(value) {
  if (value === undefined) {
    return;
  }
  checkKeys(value, DEFAULT_TICKET_AI.persona, "persona");
  checkText(value.name, MAX_NAME, "The assistant's name");
  const name = oneLine(value.name, MAX_NAME);
  if (name) {
    if (name.length < MIN_NAME || !NAME_CHARACTERS.test(name)) {
      fail(`The assistant's name is ${MIN_NAME} to ${MAX_NAME} letters, numbers, spaces and simple punctuation.`);
    }
    if (IMPERSONATING.test(name)) {
      fail("The assistant's name can't pass it off as Discord, Anthropic, a person or a staff member.");
    }
  }
  checkChoice(TONES, value.tone, "The tone");
  checkText(value.toneNotes, MAX_TONE_NOTES, "Tone notes");
  checkNoPings(value.toneNotes, "Tone notes");
  checkChoice(EMOJI_LEVELS, value.emoji, "Emoji");
}

function checkReplies(value) {
  if (value === undefined) {
    return;
  }
  checkKeys(value, DEFAULT_TICKET_AI.replies, "replies");
  checkChoice(REPLY_LENGTHS, value.length, "The reply length");
  checkChoice(REPLY_LANGUAGES, value.language, "The reply language");
  checkTemplate(value.greeting, "The greeting");
  checkTemplate(value.signOff, "The sign-off");
  checkChoice(REPLY_FORMATS, value.format, "The reply format");
  checkChoice(KNOWLEDGE_MODES, value.knowledge, "What replies may draw on");
  checkSwitch(value.placeholders, "Check markers");
  checkChoice(DISCLOSURES, value.disclosure, "The AI label");
}

function checkTriageRules(value) {
  if (value === undefined) {
    return;
  }
  checkKeys(value, DEFAULT_TICKET_AI.triageRules, "triage rules");
  if (value.priorities !== undefined) {
    checkKeys(value.priorities, DEFAULT_TICKET_AI.triageRules.priorities, "priority notes");
    for (const level of PRIORITY_LEVELS) {
      checkText(value.priorities[level], MAX_PRIORITY_NOTE, `The ${level} priority note`);
      checkNoPings(value.priorities[level], `The ${level} priority note`);
    }
  }
  checkWords(value.urgentWords, MAX_WORDS, MAX_WORD, "Urgent words");
  checkWords(value.highWords, MAX_WORDS, MAX_WORD, "High-priority words");
  checkSwitch(value.suggestCategory, "Suggest a better ticket type");
  checkInteger(value.maxArticles, 0, MAX_ARTICLES_PER_TRIAGE, "Articles to suggest");
  checkChoice(LOG_LANGUAGES, value.summaryLanguage, "The triage language");
}

function checkSummaries(value) {
  if (value === undefined) {
    return;
  }
  checkKeys(value, DEFAULT_TICKET_AI.summaries, "summaries");
  checkChoice(SUMMARY_STYLES, value.style, "The summary style");
  checkInteger(value.maxPoints, MIN_POINTS, MAX_POINTS, "Summary points");
  checkChoice(CLOSE_DETAILS, value.closeDetail, "The close summary detail");
  checkChoice(LOG_LANGUAGES, value.closeLanguage, "The close summary language");
}

function checkPrivacy(value) {
  if (value === undefined) {
    return;
  }
  checkKeys(value, DEFAULT_TICKET_AI.privacy, "privacy");
  for (const key of Object.keys(DEFAULT_TICKET_AI.privacy)) {
    checkSwitch(value[key], key);
  }
}

function checkAccess(value, isRole) {
  if (value === undefined) {
    return;
  }
  checkKeys(value, DEFAULT_TICKET_AI.access, "access");
  if (value.roleIds !== undefined && (!Array.isArray(value.roleIds) || value.roleIds.length > MAX_ACCESS_ROLES || !value.roleIds.every((id) => typeof id === "string" && ROLE_ID.test(id) && isRole(id)))) {
    fail(`Pick up to ${MAX_ACCESS_ROLES} roles from this server, or none for all ticket staff.`);
  }
  checkInteger(value.cooldownSeconds, MIN_COOLDOWN, MAX_COOLDOWN, "The cooldown");
  checkInteger(value.messageLimit, MIN_MESSAGES, MAX_MESSAGES, "Messages the AI reads");
}

function checkPanels(value, isPanel) {
  if (value === undefined) {
    return;
  }
  if (!isObject(value) || Object.keys(value).length > MAX_AI_PANELS) {
    fail(`Panel changes are for up to ${MAX_AI_PANELS} ticket panels.`);
  }
  const allowed = { enabled: 0, triage: 0, helpers: 0, closeSummary: 0, tone: 0, length: 0, language: 0, instructions: 0 };
  for (const [id, panel] of Object.entries(value)) {
    if (!PANEL_ID.test(id) || !isPanel(id)) {
      fail(`"${id}" isn't one of this server's ticket panels.`);
    }
    checkKeys(panel, allowed, "panel");
    for (const key of PANEL_FEATURES) {
      checkSwitch(panel[key], `The panel's ${key}`);
    }
    checkChoice(TONES, panel.tone, "The panel's tone");
    checkChoice(REPLY_LENGTHS, panel.length, "The panel's reply length");
    checkChoice(REPLY_LANGUAGES, panel.language, "The panel's reply language");
    checkText(panel.instructions, MAX_PANEL_INSTRUCTIONS, "The panel's instructions");
    checkNoPings(panel.instructions, "The panel's instructions");
  }
}

// Whether `value` (normalized) equals the defaults, so nothing needs saving.
function isDefault(value, defaults = DEFAULT_TICKET_AI) {
  if (Array.isArray(defaults)) {
    return Array.isArray(value) && value.length === 0;
  }
  if (isObject(defaults)) {
    const keys = new Set([...Object.keys(defaults), ...Object.keys(objectOr(value))]);
    return [...keys].every((key) => (Object.hasOwn(defaults, key) ? isDefault(value?.[key], defaults[key]) : false));
  }
  return value === defaults;
}

// Checks dashboard input. `isPanel(id)` says whether a panel exists and
// `isRole(id)` whether a role does. Returns what to save, or null when
// everything is the default.
export function checkTicketAi(value, { isPanel = () => true, isRole = () => true } = {}) {
  checkKeys(value, DEFAULT_TICKET_AI, "AI assistant");
  for (const key of SWITCHES) {
    checkSwitch(value[key], key);
  }
  if (value.monthlyLimit !== undefined && (!Number.isInteger(value.monthlyLimit) || value.monthlyLimit < MIN_MONTHLY_LIMIT || value.monthlyLimit > MAX_MONTHLY_LIMIT)) {
    fail(`The monthly limit is ${MIN_MONTHLY_LIMIT} to ${MAX_MONTHLY_LIMIT} requests.`);
  }
  if (
    value.panelIds !== undefined &&
    (!Array.isArray(value.panelIds) || value.panelIds.length > MAX_AI_PANELS || !value.panelIds.every((id) => typeof id === "string" && PANEL_ID.test(id) && isPanel(id)))
  ) {
    fail(`Pick up to ${MAX_AI_PANELS} ticket panels from this server, or none for every panel.`);
  }
  checkPersona(value.persona);
  checkReplies(value.replies);
  checkTriageRules(value.triageRules);
  checkSummaries(value.summaries);
  checkText(value.instructions, MAX_INSTRUCTIONS, "The instructions");
  checkNoPings(value.instructions, "The instructions");
  checkWords(value.avoidTopics, MAX_TOPICS, MAX_TOPIC, "Topics to avoid");
  checkPrivacy(value.privacy);
  checkAccess(value.access, isRole);
  checkPanels(value.panels, isPanel);
  const clean = normalizeTicketAi(value);
  return isDefault(clean) ? null : clean;
}

// One line for the dashboard's change log.
export function describeTicketAi(value) {
  const options = normalizeTicketAi(value);
  if (!options.enabled) {
    return "off";
  }
  const parts = [
    options.triage ? "triage" : null,
    options.helpers ? "staff helpers" : null,
    options.closeSummary ? "close summaries" : null,
    options.useTags ? "tags as knowledge" : null,
  ].filter(Boolean);
  const panels = options.panelIds.length > 0 ? `panels ${options.panelIds.join(", ")}` : "every panel";
  const style = [
    options.persona.name ? `named ${options.persona.name}` : null,
    `${options.persona.tone} tone`,
    `${options.replies.length} replies`,
    options.instructions ? "custom instructions" : null,
    Object.keys(options.panels).length > 0 ? `${Object.keys(options.panels).length} panel changes` : null,
  ].filter(Boolean);
  return `on (${parts.join(", ") || "nothing"}; ${panels}; ${options.monthlyLimit} requests a month; ${style.join(", ")})`;
}
