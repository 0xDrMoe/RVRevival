// Following YouTube and Twitch channels, Bluesky and Mastodon accounts,
// subreddits and RSS feeds: adding one (from /feed or the dashboard) and
// writing the post for a new item (a video, a post, or a Twitch stream going
// live).

import { translate } from "../i18n/i18n.js";
import { FeedError, FeedKind, fetchFeed, resolveSource } from "./fetchFeed.js";
import { MAX_FEEDS } from "./feedStore.js";

export const MAX_FEED_MESSAGE_LENGTH = 500;

export class FeedLimit extends Error {
  name = "FeedLimit";
}

export class FeedDuplicate extends Error {
  name = "FeedDuplicate";
}

const DEFAULT_MESSAGE_KEYS = {
  youtube: "feedDefaultYoutube",
  twitch: "feedDefaultTwitch",
  bluesky: "feedDefaultBluesky",
  mastodon: "feedDefaultMastodon",
  reddit: "feedDefaultReddit",
  rss: "feedDefaultRss",
};

// A Twitch channel: checks it exists and counts a stream that's already live
// as seen, so adding it mid-stream doesn't ping anyone.
async function readTwitch(twitch, login) {
  if (!twitch) {
    throw new FeedError("not-configured", "Twitch isn't set up on this bot.");
  }
  const [user] = await twitch.users([login]);
  if (!user) {
    throw new FeedError("no-account", `There's no Twitch channel called ${login}.`);
  }
  const live = await twitch.streams([login]);
  return { title: user.display_name || user.login, items: live.map((stream) => ({ id: stream.id })) };
}

// Looks the source up, reads the feed once and saves it, with everything in it
// now counted as seen (only later items are posted). `twitch` is the Twitch
// API (feeds/twitch.js), undefined when the bot has no Twitch keys. Throws
// FeedLimit, FeedDuplicate or FeedError.
export async function addFeed({ store, guildId, kind, source, channelId, roleId = null, message = null, createdBy, fetchOptions, twitch, now = Date.now }) {
  if (store.count(guildId) >= MAX_FEEDS) {
    throw new FeedLimit(`A server can follow up to ${MAX_FEEDS} feeds.`);
  }
  const resolved = await resolveSource(kind, source, fetchOptions);
  if (store.find(guildId, resolved.url, channelId)) {
    throw new FeedDuplicate("That feed already posts in that channel.");
  }
  const feed = kind === FeedKind.TWITCH ? await readTwitch(twitch, resolved.login) : await fetchFeed(resolved.url, fetchOptions);
  const name = (resolved.name ?? feed.title ?? "").trim() || new URL(resolved.url).hostname;
  return store.add({
    guildId,
    kind,
    // Twitch is checked by login, so it keeps the clean one.
    source: resolved.login ?? source.trim().slice(0, 500),
    url: resolved.url,
    name: name.replace(/\s+/g, " ").slice(0, 100),
    channelId,
    roleId,
    message: message?.trim().slice(0, MAX_FEED_MESSAGE_LENGTH) || null,
    seen: feed.items.map((item) => item.id),
    createdBy,
    createdAt: now(),
  });
}

const fill = (template, values) => template.replace(/\{(title|link|author|feed|game)\}/g, (whole, key) => values[key] ?? whole);

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
  const template = feed.message ?? translate(language, DEFAULT_MESSAGE_KEYS[feed.kind] ?? DEFAULT_MESSAGE_KEYS.rss);
  const text = fill(template, values).trim();
  const content = `${feed.roleId ? `<@&${feed.roleId}> ` : ""}${text}`.slice(0, 2000);
  return { content, allowedMentions: { parse: [], roles: feed.roleId ? [feed.roleId] : [] } };
}

export { FeedError, FeedKind };
