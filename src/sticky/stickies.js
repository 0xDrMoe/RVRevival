// Sticky messages: a message that stays at the bottom of a channel. When
// people talk, the bot waits for a quiet moment (REPOST_DELAY_MS), deletes
// its last copy and posts it again. At most one repost per channel every
// MIN_GAP_MS, so a busy channel doesn't turn into a wall of copies.

const REPOST_DELAY_MS = 5_000;
const MIN_GAP_MS = 15_000;

export const stickyPayload = (content) => ({ content, allowedMentions: { parse: [] } });

// Options: store (sticky/stickyStore.js), logger, now, setTimer, clearTimer (tests)
export function createStickies({ store, logger, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // channel ID -> pending repost timer
  const pending = new Map();
  // channel ID -> when the bot last posted the sticky there
  const postedAt = new Map();
  // Channels being reposted right now, so two timers can't post twice.
  const posting = new Set();

  // Deletes the last copy and posts the sticky again. Also used when it's set or changed.
  async function repost(channel) {
    const sticky = store.get(channel.id);
    if (!sticky || posting.has(channel.id)) {
      return undefined;
    }
    posting.add(channel.id);
    try {
      if (sticky.messageId) {
        await channel.messages.delete(sticky.messageId).catch(() => {});
      }
      const sent = await channel.send(stickyPayload(sticky.content));
      // Removed or changed meanwhile: only record this copy if it's still the one.
      if (store.get(channel.id)?.content === sticky.content) {
        store.posted(channel.id, sent.id);
      } else {
        await sent.delete().catch(() => {});
      }
      postedAt.set(channel.id, now());
      return sent;
    } finally {
      posting.delete(channel.id);
    }
  }

  function schedule(channel, delay) {
    const timer = setTimer(() => {
      pending.delete(channel.id);
      repost(channel).catch((error) => logger.debug("Couldn't repost a sticky message", { channelId: channel.id, error }));
    }, delay);
    timer?.unref?.();
    pending.set(channel.id, timer);
  }

  return {
    repost,

    // Every message: a message in a sticky channel queues a repost.
    messageCreated(message) {
      if (!message.inGuild?.() || message.author?.bot || message.webhookId || pending.has(message.channelId)) {
        return;
      }
      if (!store.get(message.channelId)) {
        return;
      }
      const sinceLast = now() - (postedAt.get(message.channelId) ?? -Infinity);
      schedule(message.channel, Math.max(REPOST_DELAY_MS, MIN_GAP_MS - sinceLast));
    },

    // Stops a queued repost (the sticky was removed).
    cancel(channelId) {
      const timer = pending.get(channelId);
      if (timer) {
        clearTimer(timer);
        pending.delete(channelId);
      }
    },

    // A deleted channel takes its sticky with it.
    channelDeleted(channel) {
      this.cancel(channel.id);
      store.delete(channel.id);
    },
  };
}
