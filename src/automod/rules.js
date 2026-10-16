// What each automod rule looks for in a message's text. These are plain
// functions with no Discord objects, so they're easy to test; automod.js
// decides what to do about a match.

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

// The first banned word in `content`, or undefined. Accents, capitals and
// number-for-letter swaps don't hide a word.
export function findBannedWord(content, words) {
  if (!content || words.length === 0) {
    return undefined;
  }
  const text = plain(content);
  const swapped = withoutLookalikes(text);
  return words.find((word) => {
    const pattern = wordPattern(word);
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
