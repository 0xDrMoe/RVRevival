// Fetches feeds safely. Server managers type the addresses, and the bot runs
// on a VPS, so nothing on the VPS's own network may be reached: every address
// (and every redirect) must resolve to a public IP. Responses are capped in
// size and time.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseFeed } from "./parseFeed.js";

export const FeedKind = Object.freeze({ YOUTUBE: "youtube", REDDIT: "reddit", RSS: "rss" });
export const FEED_KINDS = Object.values(FeedKind);

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "RumbleverseRevivalBot/1.0 (Discord bot feed reader)";

export class FeedError extends Error {
  name = "FeedError";
  // `reason` is one of: bad-source, blocked, unreachable, not-a-feed
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// Loopback, private, link-local, carrier-grade NAT, multicast and other
// addresses that aren't on the public internet.
export function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isPrivateAddress(mapped[1]);
    }
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return true;
}

async function checkHost(url, lookup) {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FeedError("bad-source", "Feed links start with https://.");
  }
  if (url.username || url.password) {
    throw new FeedError("bad-source", "Feed links can't contain a login.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) {
    throw new FeedError("unreachable", `Couldn't find ${url.hostname}.`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new FeedError("blocked", "That address points to a private network.");
  }
}

// GETs a public URL and returns its text. Options are for tests.
export async function safeFetchText(link, { fetchImpl = fetch, lookup = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new FeedError("bad-source", "That isn't a link.");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await checkHost(url, lookup);
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FeedError("unreachable", `${url.hostname} didn't answer.`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location"), url);
      continue;
    }
    if (!response.ok) {
      throw new FeedError("unreachable", `${url.hostname} answered ${response.status}.`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) {
      throw new FeedError("not-a-feed", "That feed is too big.");
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      return text.slice(0, MAX_BYTES);
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FeedError("not-a-feed", "That feed is too big.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new FeedError("unreachable", "Too many redirects.");
}

const YOUTUBE_CHANNEL = /^UC[\w-]{22}$/;
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

// What the user typed → the feed's address and a display name.
// YouTube: a channel ID, a /channel/ link or an @handle (looked up on YouTube).
// Reddit: r/name, name or a subreddit link. RSS: any public link.
export async function resolveSource(kind, input, options = {}) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text || text.length > 500) {
    throw new FeedError("bad-source", "Type what to follow.");
  }
  if (kind === FeedKind.REDDIT) {
    const name = text.match(/^(?:https?:\/\/(?:www\.|old\.|new\.)?reddit\.com)?\/?(?:r\/)?([A-Za-z0-9_]+)\/?$/i)?.[1];
    if (!name || !SUBREDDIT.test(name)) {
      throw new FeedError("bad-source", "Type a subreddit, like r/gaming.");
    }
    return { url: `https://www.reddit.com/r/${name}/new/.rss`, name: `r/${name}` };
  }
  if (kind === FeedKind.YOUTUBE) {
    let channelId = YOUTUBE_CHANNEL.test(text) ? text : text.match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1];
    if (!channelId) {
      const handle = text.match(/^(?:https?:\/\/(?:www\.|m\.)?youtube\.com\/)?(@[\w.-]{3,30})\/?$/)?.[1];
      if (!handle) {
        throw new FeedError("bad-source", "Type a YouTube channel link, like https://youtube.com/@name.");
      }
      const page = await safeFetchText(`https://www.youtube.com/${handle}`, options);
      channelId = page.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1] ?? page.match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1];
      if (!channelId) {
        throw new FeedError("not-a-feed", `Couldn't find the YouTube channel ${handle}.`);
      }
    }
    return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, name: null };
  }
  if (kind === FeedKind.RSS) {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new FeedError("bad-source", "Paste the feed's full link, starting with https://.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new FeedError("bad-source", "Paste the feed's full link, starting with https://.");
    }
    return { url: url.href, name: null };
  }
  throw new FeedError("bad-source", "Pick YouTube, Reddit or RSS.");
}

// Fetches and reads a feed. Throws FeedError when it isn't one.
export async function fetchFeed(url, options = {}) {
  const feed = parseFeed(await safeFetchText(url, options));
  if (feed.items.length === 0 && !feed.title) {
    throw new FeedError("not-a-feed", "That link isn't an RSS or Atom feed.");
  }
  return feed;
}
