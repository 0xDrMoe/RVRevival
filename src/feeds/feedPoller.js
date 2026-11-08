// Checks followed feeds and posts what's new. Every minute it looks at up to
// PER_TICK feeds that weren't checked for CHECK_EVERY_MS (YouTube live:
// LIVE_CHECK_EVERY_MS). Servers following the same feed share one download,
// and up to FETCH_CONCURRENCY downloads run at once, so one slow site doesn't
// hold up the rest. Twitch and Kick are feeds/livePoller.js. At most MAX_POSTS
// new items are posted per check, so a feed that suddenly lists fifty "new"
// items can't flood a channel.

import { pickLanguage } from "../i18n/i18n.js";
import { buildFeedPost, readFeed } from "./feeds.js";

export const CHECK_EVERY_MS = 10 * 60 * 1000;
export const LIVE_CHECK_EVERY_MS = 3 * 60 * 1000;
const MAX_POSTS = 3;
// 200 a minute keeps up with 2,000 feeds checked every 10 minutes.
export const PER_TICK = 200;
export const FETCH_CONCURRENCY = 6;

// Runs work(item) for every item, at most `limit` at a time.
async function forEachLimited(items, limit, work) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}

// Options: client, store (FeedStore), logger, forcedLanguage, fetchFeed
// ((url, kind) → { title, items }, for tests), now
export function createFeedPoller({ client, store, logger, forcedLanguage, fetchFeed = readFeed, intervalMs = 60_000, now = Date.now }) {
  let timer;
  let running = false;

  // `read` is the download, shared by every server following the same feed.
  async function check(feed, read = () => fetchFeed(feed.url, feed.kind)) {
    const guild = client.guilds.cache.get(feed.guildId);
    if (!guild) {
      store.checked(feed.id, { seen: feed.seen, checkedAt: now() });
      return;
    }
    let items;
    try {
      ({ items } = await read());
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
      const bySource = new Map();
      for (const feed of store.due(now() - CHECK_EVERY_MS, PER_TICK, now() - LIVE_CHECK_EVERY_MS)) {
        const key = `${feed.kind} ${feed.url}`;
        bySource.set(key, [...(bySource.get(key) ?? []), feed]);
      }
      await forEachLimited([...bySource.values()], FETCH_CONCURRENCY, async (group) => {
        let download;
        // Only downloaded if a server in the group still has the bot.
        const read = () => (download ??= fetchFeed(group[0].url, group[0].kind));
        for (const feed of group) {
          await check(feed, read).catch((error) => logger.error("Checking a feed crashed", { feedId: feed.id, error }));
        }
      });
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
