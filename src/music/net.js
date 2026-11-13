// Network helpers for music. Members type the links, so every address (and
// every redirect) must be on the public internet, like feeds
// (feeds/fetchFeed.js). Pages and API answers are capped in size and time;
// audio streams are capped in time only until they start.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FeedError, isPrivateAddress, safeFetchText } from "../feeds/fetchFeed.js";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 RabbleBot/1.0";

// `reason` names the message members see (musicError_<reason> in the locales):
//   bad-link      not a link the bot understands
//   youtube       a YouTube link (YouTube doesn't allow other apps to play it)
//   blocked       points to a private network
//   unreachable   the site didn't answer or said no
//   not-found     nothing at that link, or no search results
//   not-audio     the link isn't audio
//   preview-only  SoundCloud only lets subscribers hear it (30-second preview)
//   no-match      no free copy of a Spotify, Apple Music or Deezer song
//   no-stream     a library song was found but its audio wouldn't load
//   no-ffmpeg     ffmpeg isn't installed on the bot's server
//   unsupported   a kind of link that isn't supported (an artist page, say)
export class MusicError extends Error {
  name = "MusicError";
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
  }
}

const FEED_REASONS = { "bad-source": "bad-link", blocked: "blocked", unreachable: "unreachable", "not-a-feed": "unreachable" };

// GETs a page or API answer as text (2 MB cap unless `maxBytes` says otherwise).
export async function fetchText(url, { headers = {}, maxBytes, fetchImpl, lookup } = {}) {
  try {
    return await safeFetchText(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers }, maxBytes, fetchImpl, lookup });
  } catch (error) {
    if (error instanceof FeedError) {
      throw new MusicError(error.reason === "unreachable" && / 404\.$/.test(error.message) ? "not-found" : (FEED_REASONS[error.reason] ?? "unreachable"), error.message);
    }
    throw error;
  }
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, headers: { Accept: "application/json", ...options.headers } });
  try {
    return JSON.parse(text);
  } catch {
    throw new MusicError("unreachable", `${new URL(url).hostname} didn't answer with JSON.`);
  }
}

async function checkHost(url, lookup) {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MusicError("bad-link", "Links start with https://.");
  }
  if (url.username || url.password) {
    throw new MusicError("bad-link", "Links can't contain a login.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) {
    throw new MusicError("unreachable", `Couldn't find ${url.hostname}.`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new MusicError("blocked", "That address points to a private network.");
  }
}

// Opens a public URL for reading, following up to 5 redirects (each checked).
// Returns { url, response, abort }: the final address, the response with its
// body still unread, and a function that stops the download. The time limit
// covers only the wait for the headers, so radio streams can play for hours.
// `method: "HEAD"` only follows the redirects (short links).
export async function openUrl(link, { method = "GET", headers = {}, fetchImpl = fetch, lookup = dnsLookup, timeoutMs = TIMEOUT_MS } = {}) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new MusicError("bad-link", "That isn't a link.");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await checkHost(url, lookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*", "Icy-MetaData": "0", ...headers },
        signal: controller.signal,
      });
    } catch {
      throw new MusicError("unreachable", `${url.hostname} didn't answer.`);
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel?.().catch(() => {});
      url = new URL(location, url);
      continue;
    }
    if (method === "HEAD") {
      await response.body?.cancel?.().catch(() => {});
      return { url, response, abort: () => {} };
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new MusicError(response.status === 404 || response.status === 410 ? "not-found" : "unreachable", `${url.hostname} answered ${response.status}.`);
    }
    return { url, response, abort: () => controller.abort() };
  }
  throw new MusicError("unreachable", "Too many redirects.");
}

// Where a short link (on.soundcloud.com, spotify.link, link.deezer.com) leads.
// Some sites answer HEAD with an error, so a failed HEAD tries GET.
export async function expandLink(link, options = {}) {
  try {
    const { url, response } = await openUrl(link, { ...options, method: "HEAD" });
    if (response.ok) {
      return url.href;
    }
  } catch (error) {
    if (error instanceof MusicError && error.reason === "blocked") {
      throw error;
    }
  }
  const { url, abort } = await openUrl(link, options);
  abort();
  return url.href;
}
