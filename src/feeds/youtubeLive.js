// Is a YouTube channel live right now? YouTube's free feeds don't say (a
// stream shows up there when it's scheduled, not when it starts), and its
// Data API needs a key with a small daily quota. So this reads the channel's
// public /live page, which opens the stream that's on, if any. Answers like a
// feed: one item (the stream) while live, none otherwise, so feeds/feedPoller.js
// posts each stream once.

import { decodeXml } from "./parseFeed.js";
import { safeFetchText } from "./fetchFeed.js";

// Skips the cookie-consent page YouTube shows to some regions.
const HEADERS = { Cookie: "SOCS=CAI; CONSENT=YES+", "Accept-Language": "en-US,en;q=0.8" };

// A string from YouTube's embedded JSON ("…&…" → "…&…").
function jsonText(raw) {
  if (raw === undefined) {
    return "";
  }
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

// Reads the /live page's HTML. Exported for tests.
export function readLivePage(html) {
  if (typeof html !== "string" || !/"isLiveNow"\s*:\s*true/.test(html)) {
    return { title: "", items: [] };
  }
  const videoId =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1] ??
    html.match(/"liveStreamabilityRenderer"\s*:\s*\{\s*"videoId"\s*:\s*"([\w-]{11})"/)?.[1] ??
    html.match(/"videoDetails"\s*:\s*\{\s*"videoId"\s*:\s*"([\w-]{11})"/)?.[1];
  if (!videoId) {
    return { title: "", items: [] };
  }
  const title = decodeXml(html.match(/<meta name="title" content="([^"]*)"/)?.[1] ?? "") || jsonText(html.match(/"videoDetails"\s*:\s*\{[^}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]);
  const author = jsonText(html.match(/"ownerChannelName"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? html.match(/"author"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]);
  return {
    title: author,
    items: [{ id: videoId, title: (title || "(untitled)").slice(0, 256), link: `https://www.youtube.com/watch?v=${videoId}`, author: author.slice(0, 100), publishedAt: null }],
  };
}

// The stream on `url` (a channel's /live page), if any. Throws FeedError.
export async function fetchYoutubeLive(url, options = {}) {
  return readLivePage(await safeFetchText(url, { ...options, headers: HEADERS }));
}
