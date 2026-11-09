// Following YouTube channels (videos, Shorts or live streams), Twitch and Kick
// channels, Bluesky and Mastodon accounts, subreddits, GitHub releases and RSS
// feeds: adding one (from /feed or the dashboard), reading one, and writing the
// post for a new item.

import { fillVariables } from "../dashboard/public/variables.js";
import { translate } from "../i18n/i18n.js";
import { FeedError, FeedKind, fetchFeed, resolveSource } from "./fetchFeed.js";
import { MAX_FEEDS, PENDING_FIRST_READ } from "./feedStore.js";
import { fetchYoutubeLive } from "./youtubeLive.js";

export const MAX_FEED_MESSAGE_LENGTH = 500;

export class FeedLimit extends Error {
  name = "FeedLimit";
}

export class FeedDuplicate extends Error {
  name = "FeedDuplicate";
}

const DEFAULT_MESSAGE_KEYS = {
  youtube: "feedDefaultYoutube",
  youtube_shorts: "feedDefaultYoutubeShorts",
  youtube_live: "feedDefaultYoutubeLive",
  twitch: "feedDefaultTwitch",
  kick: "feedDefaultKick",
  bluesky: "feedDefaultBluesky",
  mastodon: "feedDefaultMastodon",
  reddit: "feedDefaultReddit",
  github: "feedDefaultGithub",
  rss: "feedDefaultRss",
};

// What each kind of feed posts when it has no message of its own, in a
// language: { youtube: "📺 **{author}** uploaded…", … }. The dashboard shows
// these as the message box's placeholder.
export function defaultFeedMessages(language) {
  return Object.fromEntries(Object.entries(DEFAULT_MESSAGE_KEYS).map(([kind, key]) => [kind, translate(language, key)]));
}

const PLATFORM_NAMES = { twitch: "Twitch", kick: "Kick" };

// YouTube's feed server often answers 404 or 500 for a feed that's fine and
// then 200 a second later, so its feeds get a few tries before giving up.
const YOUTUBE_TRIES = 4;
const YOUTUBE_RETRY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchYoutubeFeed(url, options = {}) {
  const delay = options.retryDelayMs ?? YOUTUBE_RETRY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchFeed(url, options);
    } catch (error) {
      if (attempt >= YOUTUBE_TRIES || !(error instanceof FeedError) || error.reason !== "unreachable") {
        throw error;
      }
      await sleep(delay * attempt);
    }
  }
}

// What's in a feed now: { title, items }. YouTube live reads the channel's
// /live page, everything else is RSS or Atom. Used by feeds/feedPoller.js.
export function readFeed(url, kind, options) {
  if (kind === FeedKind.YOUTUBE_LIVE) {
    return fetchYoutubeLive(url, options);
  }
  return kind === FeedKind.YOUTUBE || kind === FeedKind.YOUTUBE_SHORTS ? fetchYoutubeFeed(url, options) : fetchFeed(url, options);
}

// A Twitch or Kick channel: checks it exists and counts a stream that's
// already live as seen, so adding it mid-stream doesn't ping anyone.
async function readLiveChannel(kind, api, login) {
  const platform = PLATFORM_NAMES[kind];
  if (!api) {
    throw new FeedError("not-configured", `${platform} isn't set up on this bot.`);
  }
  const [channel] = await api.channels([login]);
  if (!channel) {
    throw new FeedError("no-account", `There's no ${platform} channel called ${login}.`);
  }
  const live = await api.streams([login]);
  return { title: channel.name, items: live.map((stream) => ({ id: stream.id })) };
}

// A YouTube feed. Videos fall back to all uploads if YouTube has no
// long-videos list for the channel. Shorts keep their own list even when
// YouTube won't serve it yet (a channel with no Shorts, or a feed server
// having a bad minute): the feed is saved with everything in the channel's
// uploads counted as seen and marked PENDING_FIRST_READ, so its first good read
// only posts Shorts made after it was added (feeds/feedPoller.js). The name
// comes from the channel's own feed, since a list's title is just "Videos".
async function readYoutube(kind, resolved, fetchOptions) {
  let url = resolved.url;
  let feed;
  try {
    feed = await readFeed(url, kind, fetchOptions);
  } catch (error) {
    if (!(error instanceof FeedError)) {
      throw error;
    }
    if (kind === FeedKind.YOUTUBE_SHORTS) {
      const uploads = await fetchYoutubeFeed(resolved.channelFeed, fetchOptions).catch(() => {
        throw new FeedError("unreachable", "YouTube isn't answering right now. Try again in a minute.");
      });
      return { url, feed: { title: uploads.title || uploads.items[0]?.author || "", items: uploads.items }, pending: true };
    }
    if (!resolved.fallbackUrl) {
      throw error;
    }
    url = resolved.fallbackUrl;
    feed = await fetchYoutubeFeed(url, fetchOptions);
  }
  const channel = url === resolved.channelFeed ? feed : await fetchFeed(resolved.channelFeed, fetchOptions).catch(() => null);
  return { url, feed: { ...feed, title: channel?.title || feed.items[0]?.author || "" } };
}

const YOUTUBE_KINDS = new Set([FeedKind.YOUTUBE, FeedKind.YOUTUBE_SHORTS, FeedKind.YOUTUBE_LIVE]);

// The three things a YouTube channel can post, as /feed and the dashboard name
// them, and the kind of feed each one is saved as.
export const YOUTUBE_TYPES = Object.freeze({ videos: FeedKind.YOUTUBE, shorts: FeedKind.YOUTUBE_SHORTS, live: FeedKind.YOUTUBE_LIVE });
export const YOUTUBE_TYPE_OF_KIND = Object.freeze(Object.fromEntries(Object.entries(YOUTUBE_TYPES).map(([type, kind]) => [kind, type])));

// The UC… ID of the channel a YouTube feed follows, read from its address
// (UULF…/UUSH… playlist, channel feed or /live page), or null.
export function youtubeChannelOf(feed) {
  if (!YOUTUBE_KINDS.has(feed.kind)) {
    return null;
  }
  const match = feed.url.match(/[?&]channel_id=(UC[\w-]{22})|[?&]playlist_id=UU(?:LF|SH|LV)([\w-]{22})|\/channel\/(UC[\w-]{22})\//);
  if (!match) {
    return null;
  }
  return match[1] ?? (match[2] ? `UC${match[2]}` : match[3]);
}

// What counts as one feed toward the limit: a YouTube channel posting in one
// channel is one, whether it posts videos, Shorts, live streams or all three.
export function feedGroupKey(feed) {
  const youtube = youtubeChannelOf(feed);
  return youtube ? `youtube:${youtube}:${feed.channelId}` : `feed:${feed.id}`;
}

export function countFeeds(store, guildId) {
  return new Set(store.list(guildId).map(feedGroupKey)).size;
}

// Looks the source up, reads it once and saves it, with everything in it now
// counted as seen (only later items are posted). `live` holds the Twitch and
// Kick APIs (feeds/twitch.js, feeds/kick.js); a platform without keys is left
// out. Throws FeedLimit, FeedDuplicate or FeedError.
export async function addFeed({ store, guildId, kind, source, channelId, roleId = null, message = null, createdBy, fetchOptions, live = {}, now = Date.now }) {
  const groups = new Set(store.list(guildId).map(feedGroupKey));
  const full = groups.size >= MAX_FEEDS;
  if (full && !YOUTUBE_KINDS.has(kind)) {
    throw new FeedLimit(`A server can follow up to ${MAX_FEEDS} feeds.`);
  }
  const resolved = await resolveSource(kind, source, fetchOptions);
  // Another type for a YouTube channel already posting here doesn't count.
  if (full && !groups.has(feedGroupKey({ kind, url: resolved.channelFeed ?? "", channelId }))) {
    throw new FeedLimit(`A server can follow up to ${MAX_FEEDS} feeds.`);
  }
  const duplicate = () => store.find(guildId, resolved.url, channelId) || (resolved.fallbackUrl && store.find(guildId, resolved.fallbackUrl, channelId));
  if (duplicate()) {
    throw new FeedDuplicate("That feed already posts in that channel.");
  }
  let url = resolved.url;
  let feed;
  let pending = false;
  if (kind in PLATFORM_NAMES) {
    feed = await readLiveChannel(kind, live[kind], resolved.login);
  } else if (YOUTUBE_KINDS.has(kind)) {
    ({ url, feed, pending = false } = await readYoutube(kind, resolved, fetchOptions));
    if (url !== resolved.url && store.find(guildId, url, channelId)) {
      throw new FeedDuplicate("That feed already posts in that channel.");
    }
  } else {
    feed = await fetchFeed(url, fetchOptions);
  }
  const name = (resolved.name ?? feed.title ?? "").trim() || new URL(url).hostname;
  return store.add({
    guildId,
    kind,
    // Twitch and Kick are checked by login, so they keep the clean one.
    source: resolved.login ?? source.trim().slice(0, 500),
    url,
    name: name.replace(/\s+/g, " ").slice(0, 100),
    channelId,
    roleId,
    message: message?.trim().slice(0, MAX_FEED_MESSAGE_LENGTH) || null,
    seen: [...(pending ? [PENDING_FIRST_READ] : []), ...feed.items.map((item) => item.id)],
    createdBy,
    createdAt: now(),
  });
}

// Follows a YouTube channel's videos, Shorts and/or live streams (`types`,
// keys of YOUTUBE_TYPES) in one channel: one saved feed per type. Types the
// channel already posts there are skipped. All or nothing: if one type can't
// be added, the ones added before it are removed again. `messages` holds a
// message per type ({ shorts: "…" }); a type without one uses `message`.
// Returns the new feeds; throws like addFeed, and FeedDuplicate when every
// type is there.
export async function addYoutubeFeeds({ types, messages = {}, message = null, source, fetchOptions, ...options }) {
  const kinds = [...new Set(types)].map((type) => YOUTUBE_TYPES[type]).filter(Boolean);
  if (kinds.length === 0) {
    throw new FeedError("no-types", "Pick at least one of videos, Shorts or live streams.");
  }
  // The channel is looked up once; each type then starts from its ID.
  const { channelFeed } = await resolveSource(FeedKind.YOUTUBE, source, fetchOptions);
  const channelId = new URL(channelFeed).searchParams.get("channel_id");
  const added = [];
  try {
    for (const kind of kinds) {
      try {
        added.push(await addFeed({ ...options, kind, source: channelId, message: messages[YOUTUBE_TYPE_OF_KIND[kind]] ?? message, fetchOptions }));
      } catch (error) {
        if (!(error instanceof FeedDuplicate)) {
          throw error;
        }
      }
    }
  } catch (error) {
    for (const feed of added) {
      options.store.delete(options.guildId, feed.id);
    }
    throw error;
  }
  if (added.length === 0) {
    throw new FeedDuplicate("That channel already posts those in that channel.");
  }
  return added;
}

// The message posted for a new item: the feed's own message or the default
// for its kind, with the role ping in front.
export function buildFeedPost(feed, item, language) {
  const values = {
    title: item.title,
    link: item.link || "",
    author: item.author || feed.name,
    feed: feed.name,
    game: item.game || "",
  };
  const template = feed.message || translate(language, DEFAULT_MESSAGE_KEYS[feed.kind] ?? DEFAULT_MESSAGE_KEYS.rss);
  const text = fillVariables(template, "feed", values).trim();
  // The @everyone role has the server's ID, and Discord only pings it as
  // plain "@everyone" (a <@&id> mention of it shows but pings no one).
  if (feed.roleId && feed.roleId === feed.guildId) {
    return { content: `@everyone ${text}`.slice(0, 2000), allowedMentions: { parse: ["everyone"], roles: [] } };
  }
  const content = `${feed.roleId ? `<@&${feed.roleId}> ` : ""}${text}`.slice(0, 2000);
  return { content, allowedMentions: { parse: [], roles: feed.roleId ? [feed.roleId] : [] } };
}

export { FeedError, FeedKind };
