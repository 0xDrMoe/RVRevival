// A server's automod settings: which rules are on, what each one does, the
// limits they use, and who or where is left alone. The whole configuration is
// one setting (Setting.AUTOMOD), saved as a JSON object.
//
// normalizeAutomod() reads a saved value, filling in defaults for anything
// missing or invalid, so the bot never trips over an old or hand-edited value.
// checkAutomod() is strict: the dashboard uses it to refuse bad input.

// The rules, in the order they're checked. The first one a message breaks wins.
// The names are saved in the settings, so never rename one.
export const AutomodRule = Object.freeze({
  SCAM_LINKS: "scamLinks",
  BANNED_WORDS: "bannedWords",
  INVITES: "invites",
  LINKS: "links",
  MENTIONS: "mentions",
  SPAM: "spam",
  DUPLICATES: "duplicates",
  CAPS: "caps",
  EMOJIS: "emojis",
  LINES: "lines",
  ZALGO: "zalgo",
});

export const AUTOMOD_RULES = Object.values(AutomodRule);

// How each rule is named in the mod log (English, like the other logs).
export const RULE_LABELS = {
  [AutomodRule.SCAM_LINKS]: "Scam link",
  [AutomodRule.BANNED_WORDS]: "Banned word",
  [AutomodRule.INVITES]: "Invite link",
  [AutomodRule.LINKS]: "Link",
  [AutomodRule.MENTIONS]: "Mass mention",
  [AutomodRule.SPAM]: "Spam",
  [AutomodRule.DUPLICATES]: "Repeated message",
  [AutomodRule.CAPS]: "Too many capitals",
  [AutomodRule.EMOJIS]: "Too many emoji",
  [AutomodRule.LINES]: "Too many lines",
  [AutomodRule.ZALGO]: "Glitched text",
};

// What a rule does to a message that breaks it.
export const AutomodAction = Object.freeze({
  DELETE: "delete", // delete it, tell the member in the channel and note it in the mod log
  WARN: "warn", // delete it and warn the member (a case that counts toward the warning steps)
  TIMEOUT: "timeout", // delete it and time the member out (a case)
  LOG: "log", // leave it, only note it in the mod log (to try a rule out first)
});

export const AUTOMOD_ACTIONS = Object.values(AutomodAction);

// What happens after too many warnings isn't automod's job any more: automod's
// warnings count toward the server's warning steps (moderation/warnThresholds.js),
// like every other warning. Older saves may still carry an `escalation`
// object; it's ignored here and moved into the steps at startup
// (moderation/warnStepsMigration.js).

// Every number automod uses: where it lives in the configuration, its range and default.
export const AUTOMOD_LIMITS = Object.freeze({
  mentions: { path: ["rules", "mentions", "limit"], min: 2, max: 50, default: 5 },
  spamMessages: { path: ["rules", "spam", "messages"], min: 3, max: 20, default: 6 },
  spamSeconds: { path: ["rules", "spam", "seconds"], min: 2, max: 60, default: 5 },
  duplicates: { path: ["rules", "duplicates", "count"], min: 2, max: 10, default: 3 },
  capsPercent: { path: ["rules", "caps", "percent"], min: 50, max: 100, default: 70 },
  capsMinLength: { path: ["rules", "caps", "minLength"], min: 5, max: 200, default: 15 },
  emojis: { path: ["rules", "emojis", "limit"], min: 3, max: 100, default: 10 },
  lines: { path: ["rules", "lines", "limit"], min: 3, max: 100, default: 15 },
  timeoutMinutes: { path: ["timeoutMinutes"], min: 1, max: 40320, default: 10 },
});

export const MAX_BANNED_WORDS = 200;
export const MAX_WORD_LENGTH = 60;
export const MAX_ALLOWED_DOMAINS = 100;
export const MAX_EXEMPT_ROLES = 50;
export const MAX_EXEMPT_CHANNELS = 50;
// Each rule can also skip its own roles and channels (on top of the ones above).
export const MAX_RULE_EXEMPT_ROLES = 25;
export const MAX_RULE_EXEMPT_CHANNELS = 25;

// What every rule has besides its own settings. `notify` posts the
// "please don't…" notice in the channel; `timeoutMinutes` (null = the server's
// timeout length) is how long "delete and time out" lasts for this rule.
const RULE_EXTRAS = { notify: true, timeoutMinutes: null, exemptRoleIds: [], exemptChannelIds: [] };

// Each rule's default action and its own settings.
const RULE_DEFAULTS = {
  [AutomodRule.SCAM_LINKS]: { action: AutomodAction.TIMEOUT },
  [AutomodRule.BANNED_WORDS]: { action: AutomodAction.DELETE, words: [] },
  [AutomodRule.INVITES]: { action: AutomodAction.DELETE },
  [AutomodRule.LINKS]: { action: AutomodAction.DELETE, allowedDomains: [] },
  [AutomodRule.MENTIONS]: { action: AutomodAction.TIMEOUT, limit: AUTOMOD_LIMITS.mentions.default },
  [AutomodRule.SPAM]: {
    action: AutomodAction.TIMEOUT,
    messages: AUTOMOD_LIMITS.spamMessages.default,
    seconds: AUTOMOD_LIMITS.spamSeconds.default,
  },
  [AutomodRule.DUPLICATES]: { action: AutomodAction.DELETE, count: AUTOMOD_LIMITS.duplicates.default },
  [AutomodRule.CAPS]: {
    action: AutomodAction.DELETE,
    percent: AUTOMOD_LIMITS.capsPercent.default,
    minLength: AUTOMOD_LIMITS.capsMinLength.default,
  },
  [AutomodRule.EMOJIS]: { action: AutomodAction.DELETE, limit: AUTOMOD_LIMITS.emojis.default },
  [AutomodRule.LINES]: { action: AutomodAction.DELETE, limit: AUTOMOD_LIMITS.lines.default },
  [AutomodRule.ZALGO]: { action: AutomodAction.DELETE },
};

// Automod with everything switched off.
export function defaultAutomod() {
  return {
    enabled: false,
    rules: Object.fromEntries(
      AUTOMOD_RULES.map((rule) => [rule, { enabled: false, ...structuredClone(RULE_EXTRAS), ...structuredClone(RULE_DEFAULTS[rule]) }]),
    ),
    exemptRoleIds: [],
    exemptChannelIds: [],
    timeoutMinutes: AUTOMOD_LIMITS.timeoutMinutes.default,
  };
}

export class InvalidAutomod extends Error {
  name = "InvalidAutomod";
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const DISCORD_ID = /^\d{17,20}$/;
// A host name like youtube.com or clips.twitch.tv.
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// "  BadWord " -> "badword". Inner spaces are kept (phrases) but squeezed.
export function cleanWord(word) {
  return String(word ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// "https://www.YouTube.com/watch" -> "youtube.com", or undefined if it isn't a website.
export function cleanDomain(text) {
  let host = String(text ?? "").trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
  return DOMAIN.test(host) ? host : undefined;
}

// Reads a value at `path` ("rules", "spam", "seconds") from an object.
export function readPath(object, path) {
  return path.reduce((value, key) => (isObject(value) ? value[key] : undefined), object);
}

// A copy of `object` with the value at `path` replaced.
export function withPath(object, path, value) {
  const [key, ...rest] = path;
  return { ...object, [key]: rest.length === 0 ? value : withPath(object[key] ?? {}, rest, value) };
}

const inRange = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max;
const uniqueStrings = (list) => [...new Set(list)];
const validIds = (list, max) => (Array.isArray(list) ? uniqueStrings(list.filter((id) => typeof id === "string" && DISCORD_ID.test(id))).slice(0, max) : []);

// The saved value with defaults filled in. Never throws.
export function normalizeAutomod(saved) {
  const config = defaultAutomod();
  if (!isObject(saved)) {
    return config;
  }
  config.enabled = saved.enabled === true;
  for (const rule of AUTOMOD_RULES) {
    const savedRule = readPath(saved, ["rules", rule]);
    if (!isObject(savedRule)) {
      continue;
    }
    config.rules[rule].enabled = savedRule.enabled === true;
    if (AUTOMOD_ACTIONS.includes(savedRule.action)) {
      config.rules[rule].action = savedRule.action;
    }
    config.rules[rule].notify = savedRule.notify !== false;
    if (inRange(savedRule.timeoutMinutes, AUTOMOD_LIMITS.timeoutMinutes)) {
      config.rules[rule].timeoutMinutes = savedRule.timeoutMinutes;
    }
    config.rules[rule].exemptRoleIds = validIds(savedRule.exemptRoleIds, MAX_RULE_EXEMPT_ROLES);
    config.rules[rule].exemptChannelIds = validIds(savedRule.exemptChannelIds, MAX_RULE_EXEMPT_CHANNELS);
  }
  const words = readPath(saved, ["rules", AutomodRule.BANNED_WORDS, "words"]);
  if (Array.isArray(words)) {
    config.rules.bannedWords.words = uniqueStrings(
      words
        .filter((word) => typeof word === "string")
        .map(cleanWord)
        .filter((word) => word && word.length <= MAX_WORD_LENGTH),
    ).slice(0, MAX_BANNED_WORDS);
  }
  const domains = readPath(saved, ["rules", AutomodRule.LINKS, "allowedDomains"]);
  if (Array.isArray(domains)) {
    config.rules.links.allowedDomains = uniqueStrings(domains.filter((domain) => typeof domain === "string").map(cleanDomain).filter(Boolean)).slice(0, MAX_ALLOWED_DOMAINS);
  }
  for (const limit of Object.values(AUTOMOD_LIMITS)) {
    const value = readPath(saved, limit.path);
    if (inRange(value, limit)) {
      Object.assign(config, withPath(config, limit.path, value));
    }
  }
  config.exemptRoleIds = validIds(saved.exemptRoleIds, MAX_EXEMPT_ROLES);
  config.exemptChannelIds = validIds(saved.exemptChannelIds, MAX_EXEMPT_CHANNELS);
  return config;
}

// Checks a whole configuration from the dashboard and returns it cleaned (with
// the same shape as normalizeAutomod). `isRole(id)` and `isChannel(id)` say
// whether an ID belongs to this server. Throws InvalidAutomod.
export function checkAutomod(value, { isRole, isChannel }) {
  if (!isObject(value)) {
    throw new InvalidAutomod("Send automod as an object.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new InvalidAutomod("Say whether automod is on.");
  }
  for (const rule of AUTOMOD_RULES) {
    const entry = readPath(value, ["rules", rule]);
    if (!isObject(entry) || typeof entry.enabled !== "boolean" || !AUTOMOD_ACTIONS.includes(entry.action)) {
      throw new InvalidAutomod(`Say whether the ${rule} rule is on and what it does.`);
    }
    // The per-rule extras are optional, so older pages and backups still save.
    if (entry.notify !== undefined && typeof entry.notify !== "boolean") {
      throw new InvalidAutomod(`Say whether the ${rule} rule posts a notice.`);
    }
    const minutes = AUTOMOD_LIMITS.timeoutMinutes;
    if (entry.timeoutMinutes !== undefined && entry.timeoutMinutes !== null && !inRange(entry.timeoutMinutes, minutes)) {
      throw new InvalidAutomod(`The ${rule} rule's timeout must be a whole number from ${minutes.min} to ${minutes.max} minutes, or empty.`);
    }
    const ruleRoles = entry.exemptRoleIds ?? [];
    if (!Array.isArray(ruleRoles) || ruleRoles.length > MAX_RULE_EXEMPT_ROLES || !ruleRoles.every(isRole)) {
      throw new InvalidAutomod(`Pick at most ${MAX_RULE_EXEMPT_ROLES} roles from this server for the ${rule} rule to skip.`);
    }
    const ruleChannels = entry.exemptChannelIds ?? [];
    if (!Array.isArray(ruleChannels) || ruleChannels.length > MAX_RULE_EXEMPT_CHANNELS || !ruleChannels.every(isChannel)) {
      throw new InvalidAutomod(`Pick at most ${MAX_RULE_EXEMPT_CHANNELS} channels or categories for the ${rule} rule to skip.`);
    }
  }
  for (const [name, limit] of Object.entries(AUTOMOD_LIMITS)) {
    if (!inRange(readPath(value, limit.path), limit)) {
      throw new InvalidAutomod(`${name} must be a whole number from ${limit.min} to ${limit.max}.`);
    }
  }
  const words = readPath(value, ["rules", AutomodRule.BANNED_WORDS, "words"]);
  if (!Array.isArray(words) || words.length > MAX_BANNED_WORDS) {
    throw new InvalidAutomod(`List at most ${MAX_BANNED_WORDS} banned words.`);
  }
  if (!words.every((word) => typeof word === "string" && cleanWord(word) && cleanWord(word).length <= MAX_WORD_LENGTH)) {
    throw new InvalidAutomod(`Each banned word must be 1 to ${MAX_WORD_LENGTH} characters.`);
  }
  const domains = readPath(value, ["rules", AutomodRule.LINKS, "allowedDomains"]);
  if (!Array.isArray(domains) || domains.length > MAX_ALLOWED_DOMAINS) {
    throw new InvalidAutomod(`List at most ${MAX_ALLOWED_DOMAINS} allowed websites.`);
  }
  const badDomain = domains.find((domain) => typeof domain !== "string" || !cleanDomain(domain));
  if (badDomain !== undefined) {
    throw new InvalidAutomod(`"${String(badDomain).slice(0, 60)}" isn't a website address, like youtube.com.`);
  }
  const { exemptRoleIds, exemptChannelIds } = value;
  if (!Array.isArray(exemptRoleIds) || exemptRoleIds.length > MAX_EXEMPT_ROLES || !exemptRoleIds.every(isRole)) {
    throw new InvalidAutomod(`Pick at most ${MAX_EXEMPT_ROLES} roles from this server (not @everyone).`);
  }
  if (!Array.isArray(exemptChannelIds) || exemptChannelIds.length > MAX_EXEMPT_CHANNELS || !exemptChannelIds.every(isChannel)) {
    throw new InvalidAutomod(`Pick at most ${MAX_EXEMPT_CHANNELS} channels or categories from this server.`);
  }
  return normalizeAutomod(value);
}

// Whether one rule leaves a member alone: one of its own exempt roles, or a
// channel (or its category) it skips. `channelIds` = the channel, its parent and grandparent.
export function ruleSkips(settings, { channelIds, roleIds }) {
  return settings.exemptChannelIds.some((id) => channelIds.includes(id)) || settings.exemptRoleIds.some((id) => roleIds?.has(id));
}

// The rules that are switched on, in checking order.
export const activeRules = (config) => AUTOMOD_RULES.filter((rule) => config.rules[rule].enabled);
