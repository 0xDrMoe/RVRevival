// Ends giveaways (/giveaway) when their time is up. The bot checks every 15
// seconds; giveaways that ended while it was offline are ended as soon as it's
// back. Also forgets giveaways that ended more than 30 days ago.

import { endGiveaway, KEEP_ENDED_MS } from "./giveaways.js";

// Options:
//   client, store (GiveawayStore), logger, forcedLanguage
export function createGiveawayScheduler({ client, store, logger, forcedLanguage, intervalMs = 15_000, now = Date.now, random }) {
  let timer;
  let running = false;

  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const giveaway of store.due(now())) {
        const guild = client.guilds.cache.get(giveaway.guildId);
        await endGiveaway({ giveaway, guild, store, logger, forcedLanguage, now, random }).catch((error) => {
          logger.error("Ending a giveaway crashed", { guildId: giveaway.guildId, giveaway: giveaway.id, error });
          // Ended without winners rather than retried every 15 seconds forever.
          store.markEnded(giveaway.id, now(), []);
        });
      }
      store.deleteEndedBefore(now() - KEEP_ENDED_MS);
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    start() {
      if (timer) {
        return;
      }
      const run = () => sweep().catch((error) => logger.error("Checking giveaways crashed", { error }));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
