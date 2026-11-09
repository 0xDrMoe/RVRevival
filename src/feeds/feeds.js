// Following YouTube channels (videos, Shorts or live streams), Twitch and Kick
// channels, Bluesky and Mastodon accounts, subreddits, GitHub releases and RSS
// feeds: adding one (from /feed or the dashboard), reading one, and writing the
// post for a new item.

import { fillVariables } from "../dashboard/public/variables.js";
import { translate } from "../i18n/i18n.js";
import { FeedError, FeedKind, fetchFeed, resolveSource } from "./fetchFeed.js";
import { MAX_FEEDS } from "./feedStore.js";
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

// What's in a feed now: { title, items }. YouTube live reads the channel's
// /live page, everything else is RSS or Atom. Used by feeds/feedPoller.js.
export function readFeed(url, kind, options) {
  return kind === FeedKind.YOUTUBE_LIVE ? fetchYoutubeLive(url, options) : fetchFeed(url, options);
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
// long-videos list for the channel; Shorts have no fallback. The name comes
// from the channel's own feed, since a list's title is just "Videos".
async function readYoutube(kind, resolved, fetchOptions) {
  let url = resolved.url;
  let feed;
  try {
    feed = await readFeed(url, kind, fetchOptions);
  } catch (error) {
    if (!(error instanceof FeedError) || !resolved.fallbackUrl) {
      throw kind === FeedKind.YOUTUBE_SHORTS && error instanceof FeedError ? new FeedError("no-shorts", "YouTube has no Shorts list for that channel.") : error;
    }
    url = resolved.fallbackUrl;
    feed = await fetchFeed(url, fetchOptions);
  }
  const channel = url === resolved.channelFeed ? feed : await fetchFeed(resolved.channelFeed, fetchOptions).catch(() => null);
  return { url, feed: { ...feed, title: channel?.title || feed.items[0]?.author || "" } };
}

const YOUTUBE_KINDS = new Set([FeedKind.YOUTUBE, FeedKind.YOUTUBE_SHORTS, FeedKind.YOUTUBE_LIVE]);

// Looks the source up, reads it once and saves it, with everything in it now
// counted as seen (only later items are posted). `live` holds the Twitch and
// Kick APIs (feeds/twitch.js, feeds/kick.js); a platform without keys is left
// out. Throws FeedLimit, FeedDuplicate or FeedError.
export async function addFeed({ store, guildId, kind, source, channelId, roleId = null, message = null, createdBy, fetchOptions, live = {}, now = Date.now }) {
  if (store.count(guildId) >= MAX_FEEDS) {
    throw new FeedLimit(`A server can follow up to ${MAX_FEEDS} feeds.`);
  }
  const resolved = await resolveSource(kind, source, fetchOptions);
  const duplicate = () => store.find(guildId, resolved.url, channelId) || (resolved.fallbackUrl && store.find(guildId, resolved.fallbackUrl, channelId));
  if (duplicate()) {
    throw new FeedDuplicate("That feed already posts in that channel.");
  }
  let url = resolved.url;
  let feed;
  if (kind in PLATFORM_NAMES) {
    feed = await readLiveChannel(kind, live[kind], resolved.login);
  } else if (YOUTUBE_KINDS.has(kind)) {
    ({ url, feed } = await readYoutube(kind, resolved, fetchOptions));
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
    seen: feed.items.map((item) => item.id),
    createdBy,
    createdAt: now(),
  });
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
