// A YouTube channel's Videos or Shorts tab, read like a feed. YouTube's free
// feeds (videos.xml) often answer 404 or 500, sometimes for hours, so when
// they won't answer the bot reads the channel's public /videos or /shorts page
// instead. The page has no upload dates, so items carry publishedAt: null. IDs
// are the bare video IDs, like the feeds' (parseFeed reads yt:videoId), so
// switching between the two never posts anything twice.

import { FeedError, safeFetchText } from "./fetchFeed.js";

// Skips the cookie-consent page YouTube shows to some regions.
export const YOUTUBE_PAGE_HEADERS = { Cookie: "SOCS=CAI; CONSENT=YES+", "Accept-Language": "en-US,en;q=0.8" };

const MAX_ITEMS = 30;
// A channel tab's or /live page's HTML is 1 to 1.5 MB.
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

// The page's ytInitialData object, or null.
function initialData(html) {
  const start = html.indexOf("var ytInitialData = ");
  if (start < 0) {
    return null;
  }
  const from = start + "var ytInitialData = ".length;
  const end = html.indexOf(";</script>", from);
  if (end < 0) {
    return null;
  }
  try {
    return JSON.parse(html.slice(from, end));
  } catch {
    return null;
  }
}

// Every video on the page, in page order (newest first), without repeats.
function collect(data) {
  const items = [];
  const seen = new Set();
  const add = (videoId, title) => {
    if (typeof videoId === "string" && /^[\w-]{11}$/.test(videoId) && !seen.has(videoId) && items.length < MAX_ITEMS) {
      seen.add(videoId);
      items.push({ videoId, title: typeof title === "string" ? title : "" });
    }
  };
  const stack = [data];
  // Depth-first, children pushed in reverse so the page order is kept.
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (node.shortsLockupViewModel) {
      const view = node.shortsLockupViewModel;
      add(view.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? view.entityId?.replace(/^shorts-shelf-item-/, ""), view.overlayMetadata?.primaryText?.content);
      continue;
    }
    if (node.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const view = node.lockupViewModel;
      add(view.contentId, view.metadata?.lockupMetadataViewModel?.title?.content);
      continue;
    }
    if (node.videoRenderer?.videoId) {
      add(node.videoRenderer.videoId, node.videoRenderer.title?.runs?.[0]?.text ?? node.videoRenderer.title?.simpleText);
      continue;
    }
    if (node.reelItemRenderer?.videoId) {
      add(node.reelItemRenderer.videoId, node.reelItemRenderer.headline?.simpleText);
      continue;
    }
    const children = Array.isArray(node) ? node : Object.values(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return items;
}

// Reads a /videos or /shorts page's HTML. `shorts` picks the link style.
// Exported for tests.
export function readChannelPage(html, { shorts = false } = {}) {
  const data = typeof html === "string" ? initialData(html) : null;
  if (!data) {
    throw new FeedError("not-a-feed", "That YouTube page didn't load properly.");
  }
  const author = String(data.metadata?.channelMetadataRenderer?.title ?? "").slice(0, 100);
  return {
    title: author,
    channelName: author,
    items: collect(data).map(({ videoId, title }) => ({
      id: videoId,
      title: (title || "(untitled)").slice(0, 256),
      link: shorts ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
      author,
      publishedAt: null,
    })),
  };
}

// A channel's Videos or Shorts tab as { title, items }. Throws FeedError.
export async function fetchChannelPage(channelId, tab, options = {}) {
  const html = await safeFetchText(`https://www.youtube.com/channel/${channelId}/${tab}`, { ...options, headers: YOUTUBE_PAGE_HEADERS, maxBytes: MAX_PAGE_BYTES });
  return readChannelPage(html, { shorts: tab === "shorts" });
}
