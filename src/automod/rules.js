// What each automod rule looks for in a message's text. These are plain
// functions with no Discord objects, so they're easy to test; automod.js
// decides what to do about a match.

import { domainToUnicode } from "node:url";

// Discord's own invite links. dsc.gg and discord.me are popular invite
// shorteners that can't be looked up, so they always count as other servers.
const INVITE = /(?:https?:\/\/)?(?:www\.)?(discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me)\/([a-z0-9-]{2,64})/gi;
const LOOKUP_HOSTS = new Set(["discord.gg", "discord.com/invite", "discordapp.com/invite"]);

// Links people post without thinking of them as links: GIFs from Discord's GIF
// picker (Tenor), Discord's own media and links to messages. Always allowed.
export const ALWAYS_ALLOWED_DOMAINS = ["tenor.com", "discord.com", "discordapp.com", "discordapp.net"];

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
// Mentions, custom emoji, channels and timestamps aren't words someone typed.
const DISCORD_MARKUP = /<(?:@[!&]?|#|a?:\w+:|t:)[^>]*>/g;

// Common letter swaps used to dodge word filters: "b4dw0rd" -> "badword".
const LOOKALIKES = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i" };

// Lowercase, without accents: "Ñandú" -> "nandu".
function plain(text) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

const withoutLookalikes = (text) => text.replace(/[013457@$!]/g, (character) => LOOKALIKES[character]);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A banned word as a pattern. "*" at the start or end also matches longer
// words ("bad*" catches "badly"); otherwise only the whole word matches.
// Spaces in a phrase match any run of spaces.
function wordPattern(word) {
  const startsOpen = word.startsWith("*");
  const endsOpen = word.endsWith("*");
  const core = plain(word.replace(/^\*+|\*+$/g, ""));
  if (!core) {
    return undefined;
  }
  const body = core.split(" ").map(escapeRegExp).join("\\s+");
  const before = startsOpen ? "" : "(?<![\\p{L}\\p{N}])";
  const after = endsOpen ? "" : "(?![\\p{L}\\p{N}])";
  return new RegExp(`${before}${body}${after}`, "u");
}

// Compiled patterns by banned word, so a message doesn't build hundreds of
// regular expressions. Cleared when it gets this big (lists change rarely).
const MAX_CACHED_PATTERNS = 10_000;
const patterns = new Map();

function cachedWordPattern(word) {
  let pattern = patterns.get(word);
  if (pattern === undefined) {
    if (patterns.size >= MAX_CACHED_PATTERNS) {
      patterns.clear();
    }
    pattern = wordPattern(word) ?? null;
    patterns.set(word, pattern);
  }
  return pattern;
}

// Per word list: one pattern matching any of its words, so a clean message
// (nearly all of them) is checked with two tests instead of two per word.
// Lists from GuildSettings.derived() keep their identity until they change.
const combinedPatterns = new WeakMap();

function combinedPattern(words) {
  let combined = combinedPatterns.get(words);
  if (combined === undefined) {
    const sources = words.map(cachedWordPattern).filter(Boolean).map((pattern) => `(?:${pattern.source})`);
    combined = sources.length > 0 ? new RegExp(sources.join("|"), "u") : null;
    combinedPatterns.set(words, combined);
  }
  return combined;
}

// The first banned word in `content`, or undefined. Accents, capitals and
// number-for-letter swaps don't hide a word.
export function findBannedWord(content, words) {
  if (!content || words.length === 0) {
    return undefined;
  }
  const text = plain(content);
  const swapped = withoutLookalikes(text);
  const combined = combinedPattern(words);
  if (!combined || !(combined.test(text) || combined.test(swapped))) {
    return undefined;
  }
  return words.find((word) => {
    const pattern = cachedWordPattern(word);
    return pattern && (pattern.test(text) || pattern.test(swapped));
  });
}

// Every invite link in `content`, as { code, lookup }. `lookup` says whether
// Discord can tell which server it's for.
export function findInvites(content) {
  if (!content) {
    return [];
  }
  return [...content.matchAll(INVITE)].map((match) => ({
    code: match[2],
    lookup: LOOKUP_HOSTS.has(match[1].toLowerCase()),
  }));
}

// "https://Clips.Twitch.tv/x" -> "clips.twitch.tv".
function hostOf(link) {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

// Whether `host` is `domain` or one of its subdomains.
const isUnder = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// The website of the first link that isn't allowed, or undefined.
export function findBlockedLink(content, allowedDomains) {
  if (!content) {
    return undefined;
  }
  const allowed = [...ALWAYS_ALLOWED_DOMAINS, ...allowedDomains];
  for (const [link] of content.matchAll(URL_PATTERN)) {
    const host = hostOf(link);
    if (host && !allowed.some((domain) => isUnder(host, domain))) {
      return host;
    }
  }
  return undefined;
}

// How many different members and roles `content` mentions.
export function countMentions(content) {
  if (!content) {
    return 0;
  }
  const users = new Set([...content.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]));
  const roles = new Set([...content.matchAll(/<@&(\d+)>/g)].map((match) => match[1]));
  return users.size + roles.size;
}

// Whether `content` is mostly capital letters: at least `minLength` letters,
// of which at least `percent` percent are capitals. Links, mentions and emoji
// don't count, and neither do letters without capitals (Arabic, Chinese…).
export function isMostlyCaps(content, { percent, minLength }) {
  if (!content) {
    return false;
  }
  const letters = [...content.replace(URL_PATTERN, " ").replace(DISCORD_MARKUP, " ")].filter(
    (character) => character.toLowerCase() !== character.toUpperCase(),
  );
  if (letters.length < minLength) {
    return false;
  }
  const capitals = letters.filter((character) => character === character.toUpperCase()).length;
  return capitals * 100 >= letters.length * percent;
}

// The text two messages are compared by to spot repeats: lowercase, spaces squeezed.
export function repeatKey(content) {
  return String(content ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// --- Scam and phishing links ---------------------------------------------------

// The real websites scams pretend to be. A link to one of these (or a
// subdomain) is never a scam; a host that looks almost the same is.
const OFFICIAL_DOMAINS = [
  "discord.com",
  "discord.gg",
  "discord.gift",
  "discord.new",
  "discord.media",
  "discord.dev",
  "discordapp.com",
  "discordapp.net",
  "discordstatus.com",
  "discordcdn.com",
  "steamcommunity.com",
  "steampowered.com",
  "steamstatic.com",
  "steamgames.com",
];
// The names scam sites copy, as they look once the domain ending is gone.
const BRANDS = ["discord", "discordapp", "steamcommunity", "steampowered", "steam"];
// Words scam hosts add to a brand name: "discord-nitro.gift", "steam-gifts.ru".
const BAIT_HOST_WORDS = /(?:nitro|gift|free|airdrop|promo|claim|reward|giveaway|trade|offer|drop)/;
// Messages that dangle free Nitro or Steam items next to a link.
const BAIT_TEXT = [
  /\b(?:free|gift(?:ed)?|claim|get)\b[^\n]{0,40}\bnitro\b/i,
  /\bnitro\b[^\n]{0,40}\b(?:free|gift|for free|giveaway)\b/i,
  /\bsteam\b[^\n]{0,40}\b(?:gift|free|giveaway)\b/i,
  /\b(?:i'?m leaving|leaving) (?:cs ?go|cs2|the game)\b/i,
  /\b(?:airdrop|crypto giveaway)\b/i,
];
// Real sites whose names look like a brand's, so they're never called scams.
const KNOWN_SAFE_DOMAINS = ["discords.com", "discordbotlist.com", "discordservers.com", "disboard.org", "discord.me", "dsc.gg", "top.gg", "steamgifts.com", "steamtrades.com", "steamdb.info", "steamladder.com", "steamrep.com"];
// Letters from other alphabets that look Latin, as used in "xn--" hosts: dіscord with a Cyrillic і.
const CONFUSABLES = { а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ԁ: "d", ѕ: "s", ɡ: "g", ı: "i", ⅼ: "l", ο: "o", ν: "v", м: "m", т: "t", к: "k", н: "h" };
const unconfuse = (text) => [...text.normalize("NFKD").replace(/\p{M}/gu, "")].map((character) => CONFUSABLES[character] ?? character).join("");
// Character swaps scam hosts use to look like the real thing: dlscord, d1scord, steamcommunlty.
const HOST_LOOKALIKES = { 0: "o", 1: "l", 3: "e", 4: "a", 5: "s", 7: "t", i: "l", rn: "m", vv: "w" };
const MASKED_LINK = /\[([^\]]{1,200})\]\(\s*<?(https?:\/\/[^)\s>]+)>?\s*\)/gi;

// "d1scord-app" -> "dlscordapp": lookalike letters merged, hyphens dropped.
const hostSkeleton = (label) => label.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[0134578i]/g, (character) => HOST_LOOKALIKES[character] ?? character).replace(/-/g, "");

// Edit distance, stopping early once it passes `limit`.
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[b.length];
}

// The part of a host before its ending: "free-discord.gift" -> "free-discord",
// "steamcommunity.com.ru" -> "steamcommunity.com" (both labels are checked).
const hostLabels = (host) => host.split(".").slice(0, -1);

// Why `host` looks like a scam copy of an official site, or undefined.
export function scamHostReason(host) {
  if (!host || [...OFFICIAL_DOMAINS, ...KNOWN_SAFE_DOMAINS].some((domain) => isUnder(host, domain))) {
    return undefined;
  }
  for (const rawLabel of hostLabels(host)) {
    // "xn--dscord-6ya" is how "dіscord" (Cyrillic і) travels; read it as the letters it shows.
    const label = rawLabel.startsWith("xn--") ? unconfuse(domainToUnicode(`${rawLabel}.com`).split(".")[0]).toLowerCase() : rawLabel;
    const plainLabel = label.replace(/-/g, "");
    const skeleton = hostSkeleton(label);
    if (label !== rawLabel && BRANDS.some((brand) => plainLabel === brand)) {
      return `look-alike letters: ${host}`;
    }
    for (const brand of BRANDS) {
      const brandSkeleton = hostSkeleton(brand);
      // "discord-nitro", "steamgift": a brand name with bait words around it.
      if (plainLabel !== brand && skeleton.includes(brandSkeleton) && BAIT_HOST_WORDS.test(plainLabel.replace(brand, ""))) {
        return `looks like ${brand}: ${host}`;
      }
      // "dlscord", "discorcl", "steamcommunlty": one or two letters off the real name.
      const limit = brand.length >= 10 ? 2 : 1;
      if (plainLabel !== brand && brand.length >= 6 && (skeleton === brandSkeleton || editDistance(skeleton, brandSkeleton, limit) <= limit)) {
        return `looks like ${brand}: ${host}`;
      }
    }
  }
  return undefined;
}

// The first scam or phishing link in `content`, as a short reason, or
// undefined. Catches look-alike Discord and Steam sites, links whose text
// shows one website but lead to another, and "free Nitro" bait with a link
// to anywhere that isn't Discord or Steam.
export function findScamLink(content) {
  if (!content) {
    return undefined;
  }
  for (const [, label, target] of content.matchAll(MASKED_LINK)) {
    const shown = label.match(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,63})/i);
    const targetHost = hostOf(target);
    if (shown && targetHost) {
      const shownHost = shown[1].toLowerCase().replace(/^www\./, "");
      if (!isUnder(targetHost.replace(/^www\./, ""), shownHost)) {
        return `link shows ${shownHost} but goes to ${targetHost}`;
      }
    }
  }
  const hosts = [...content.matchAll(URL_PATTERN)].map(([link]) => hostOf(link)).filter(Boolean);
  for (const host of hosts) {
    const reason = scamHostReason(host);
    if (reason) {
      return reason;
    }
  }
  const outside = hosts.find((host) => !OFFICIAL_DOMAINS.some((domain) => isUnder(host, domain)) && !ALWAYS_ALLOWED_DOMAINS.some((domain) => isUnder(host, domain)));
  if (outside && BAIT_TEXT.some((pattern) => pattern.test(content))) {
    return `free gift bait linking to ${outside}`;
  }
  return undefined;
}

// --- Emoji, lines and glitched text --------------------------------------------

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const CUSTOM_EMOJI = /<a?:\w{2,32}:\d{17,20}>/g;

// How many emoji `content` has: Discord's custom emoji plus every emoji
// character (a family or a flag counts once).
export function countEmojis(content) {
  if (!content) {
    return 0;
  }
  const custom = content.match(CUSTOM_EMOJI)?.length ?? 0;
  const rest = content.replace(CUSTOM_EMOJI, " ");
  const characters = segmenter ? [...segmenter.segment(rest)].map((part) => part.segment) : [...rest];
  return custom + characters.filter((character) => PICTOGRAPH.test(character)).length;
}

// How many lines `content` takes up (blank lines count: they push chat up too).
export const countLines = (content) => (content ? content.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").length : 0);

// The combining marks "zalgo" text stacks on letters. Scripts like Hindi,
// Thai and Arabic use other marks, so they're never caught.
const STACKING_MARK = /[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]/u;
// A letter carrying this many marks is glitched (Vietnamese needs at most 2).
const MARKS_PER_LETTER = 3;

// Whether `content` is glitched "zalgo" text: several letters each buried
// under three or more stacked marks, or one letter under eight or more.
export function isZalgo(content) {
  if (!content) {
    return false;
  }
  let stacked = 0;
  let run = 0;
  let worst = 0;
  for (const character of content.normalize("NFD")) {
    if (STACKING_MARK.test(character)) {
      run += 1;
      continue;
    }
    if (run >= MARKS_PER_LETTER) {
      stacked += 1;
    }
    worst = Math.max(worst, run);
    run = 0;
  }
  if (run >= MARKS_PER_LETTER) {
    stacked += 1;
  }
  worst = Math.max(worst, run);
  return stacked >= 3 || worst >= 8;
}

// What a message breaks for the rules that only look at one message's text
// and have no Discord lookups (scam links, emoji, lines, glitched text), as a
// short detail for the mod log, or undefined. Shared by automod.js and the
// dashboard's rule tester, so both always agree.
export function textRuleDetail(rule, content, settings) {
  switch (rule) {
    case "scamLinks":
      return findScamLink(content);
    case "emojis": {
      const count = countEmojis(content);
      return count >= settings.limit ? `${count} emoji` : undefined;
    }
    case "lines": {
      const count = countLines(content);
      return count >= settings.limit ? `${count} lines` : undefined;
    }
    case "zalgo":
      return isZalgo(content) ? "stacked accent marks" : undefined;
    default:
      return undefined;
  }
}
