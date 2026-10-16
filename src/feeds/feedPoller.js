// Checks followed feeds and posts what's new. Every minute it looks at the
// feeds that weren't checked for CHECK_EVERY_MS, one at a time. At most
// MAX_POSTS new items are posted per check, so a feed that suddenly lists
// fifty "new" items can't flood a channel.

import { pickLanguage } from "../i18n/i18n.js";
import { buildFeedPost } from "./feeds.js";
import { fetchFeed as defaultFetchFeed } from "./fetchFeed.js";

export const CHECK_EVERY_MS = 10 * 60 * 1000;
const MAX_POSTS = 3;
const PER_TICK = 10;

// Options: client, store (FeedStore), logger, forcedLanguage, fetchFeed, now
export function createFeedPoller({ client, store, logger, forcedLanguage, fetchFeed = defaultFetchFeed, intervalMs = 60_000, now = Date.now }) {
  let timer;
  let running = false;

  async function check(feed) {
    const guild = client.guilds.cache.get(feed.guildId);
    if (!guild) {
      store.checked(feed.id, { seen: feed.seen, checkedAt: now() });
      return;
    }
    let items;
    try {
      ({ items } = await fetchFeed(feed.url));
    } catch (error) {
      logger.debug("Couldn't read a feed", { guildId: feed.guildId, feedId: feed.id, error });
      store.failed(feed.id, { error: error.message ?? error, checkedAt: now() });
      return;
    }
    const seen = new Set(feed.seen);
    const fresh = items.filter((item) => !seen.has(item.id));
    const allIds = [...fresh.map((item) => item.id), ...feed.seen];
    if (fresh.length === 0) {
      store.checked(feed.id, { seen: allIds, checkedAt: now() });
      return;
    }
    const channel = guild.channels.cache.get(feed.channelId);
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    // Oldest first, like they were published.
    const toPost = fresh.slice(0, MAX_POSTS).reverse();
    try {
      if (!channel?.isTextBased?.()) {
        throw new Error("The feed's channel is gone.");
      }
      for (const item of toPost) {
        await channel.send(buildFeedPost(feed, item, language));
      }
    } catch (error) {
      logger.warn("Couldn't post a feed item", { guildId: feed.guildId, feedId: feed.id, error });
      // Counted as seen anyway, so a fixed channel doesn't get a backlog.
      store.checked(feed.id, { seen: allIds, checkedAt: now() });
      store.failed(feed.id, { error: `Couldn't post in the channel: ${error.message ?? error}`, checkedAt: now() });
      return;
    }
    store.checked(feed.id, { seen: allIds, checkedAt: now(), postedAt: now() });
  }

  async function tick() {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const feed of store.due(now() - CHECK_EVERY_MS, PER_TICK)) {
        await check(feed).catch((error) => logger.error("Checking a feed crashed", { feedId: feed.id, error }));
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    check,
    start() {
      if (!timer) {
        timer = setInterval(() => tick().catch((error) => logger.error("Feed check crashed", { error })), intervalMs);
        timer.unref?.();
      }
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
