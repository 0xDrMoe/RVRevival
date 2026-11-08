// Posts when a followed Twitch channel goes live. Every CHECK_EVERY_MS it asks
// Twitch which followed channels are live, all of them at once (100 per
// request), and posts once per stream: a stream's ID goes into the feed's
// `seen` list, so the same broadcast is never announced twice, even after a
// restart.

import { pickLanguage } from "../i18n/i18n.js";
import { buildFeedPost } from "./feeds.js";
import { FeedKind } from "./fetchFeed.js";

export const TWITCH_CHECK_EVERY_MS = 2 * 60 * 1000;
const POST_ERROR = "Couldn't post in the channel";

// Options: client, store (FeedStore), twitch (feeds/twitch.js), logger, forcedLanguage, now
export function createTwitchPoller({ client, store, twitch, logger, forcedLanguage, intervalMs = TWITCH_CHECK_EVERY_MS, now = Date.now }) {
  let timer;
  let running = false;

  async function announce(feed, stream) {
    const guild = client.guilds.cache.get(feed.guildId);
    const seen = [stream.id, ...feed.seen];
    const channel = guild.channels.cache.get(feed.channelId);
    const item = {
      id: stream.id,
      title: stream.title || "(untitled)",
      link: feed.url,
      author: stream.user_name || feed.name,
      game: stream.game_name || "",
    };
    try {
      if (!channel?.isTextBased?.()) {
        throw new Error("The feed's channel is gone.");
      }
      await channel.send(buildFeedPost(feed, item, pickLanguage(guild.preferredLocale, forcedLanguage)));
    } catch (error) {
      logger.warn("Couldn't post a Twitch live notification", { guildId: feed.guildId, feedId: feed.id, error });
      // Counted as seen anyway: a fixed channel shouldn't get an old stream.
      store.checked(feed.id, { seen, checkedAt: now() });
      store.failed(feed.id, { error: `${POST_ERROR}: ${error.message ?? error}`, checkedAt: now() });
      return;
    }
    store.checked(feed.id, { seen, checkedAt: now(), postedAt: now() });
  }

  async function tick() {
    if (running) {
      return;
    }
    running = true;
    try {
      const feeds = store.listKind(FeedKind.TWITCH).filter((feed) => client.guilds.cache.has(feed.guildId));
      if (feeds.length === 0) {
        return;
      }
      let live;
      try {
        live = await twitch.streams(feeds.map((feed) => feed.source));
      } catch (error) {
        logger.debug("Couldn't ask Twitch who's live", { error });
        for (const feed of feeds) {
          store.failed(feed.id, { error: error.message ?? error, checkedAt: now() });
        }
        return;
      }
      const byLogin = new Map(live.map((stream) => [String(stream.user_login).toLowerCase(), stream]));
      for (const feed of feeds) {
        const stream = byLogin.get(feed.source);
        if (stream && !feed.seen.includes(stream.id)) {
          await announce(feed, stream).catch((error) => logger.error("Announcing a Twitch stream crashed", { feedId: feed.id, error }));
        } else if (feed.lastError && !feed.lastError.startsWith(POST_ERROR)) {
          // Twitch answered, so its old error no longer applies (a posting
          // problem stays until the next post works). Otherwise nothing
          // changed: no need to write.
          store.checked(feed.id, { seen: feed.seen, checkedAt: now() });
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => tick().catch((error) => logger.error("Twitch check crashed", { error })), intervalMs);
        timer.unref?.();
      }
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
