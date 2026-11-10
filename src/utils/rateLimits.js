// Shared tools that keep the bot under Discord's rate limits.
//
// discord.js already waits out the limits Discord tells it about, one queue
// per route. That keeps requests from failing, but it can't stop the bot from
// asking for far more than it needs: a stats channel renamed every minute, a
// starboard post edited once per reaction, a member hopping in and out of a
// join-to-create hub. These tools cut the requests down before they're made:
//
//   createRateLimiter   at most `limit` actions per `windowMs`, per key
//   LatestOnly          per key, one task running and only the newest waiting
//   createBatchSender   while a message is on its way to a channel, the next
//                       ones wait and go out together as one message
//   createMessageDeleter  while a delete is on its way, the next ones in the
//                       same channel go out together as one bulk delete
//   canPost             whether the bot may post in a channel, so it doesn't
//                       ask (and get refused, which Discord counts against
//                       the bot) when it can't
//   isRenameLimited     discord.js's filter for the channel name/topic limit
//   retryAfterMs        how long a rate-limit error says to wait

import { PermissionFlagsBits } from "discord.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Past this many keys, keys with no recent actions are forgotten.
const SWEEP_SIZE = 5000;

// Options: limit, windowMs, now, wait (tests)
export function createRateLimiter({ limit, windowMs, now = Date.now, wait = sleep }) {
  // key -> times of the actions inside the window, oldest first
  const hits = new Map();

  function recent(key) {
    const time = now();
    const list = hits.get(key);
    if (!list) {
      return [];
    }
    while (list.length > 0 && time - list[0] >= windowMs) {
      list.shift();
    }
    if (list.length === 0) {
      hits.delete(key);
    }
    return list;
  }

  function sweep() {
    if (hits.size < SWEEP_SIZE) {
      return;
    }
    for (const key of [...hits.keys()]) {
      recent(key);
    }
  }

  // Milliseconds until `key` may act again (0 = now).
  function waitTime(key) {
    const list = recent(key);
    return list.length < limit ? 0 : list[0] + windowMs - now();
  }

  // Records an action and returns true, or returns false when `key` is at its limit.
  function take(key) {
    if (waitTime(key) > 0) {
      return false;
    }
    sweep();
    const list = hits.get(key) ?? [];
    list.push(now());
    hits.set(key, list);
    return true;
  }

  // Waits for a free slot, then takes it.
  async function acquire(key) {
    for (;;) {
      if (take(key)) {
        return;
      }
      await wait(Math.max(1, waitTime(key)));
    }
  }

  return { waitTime, take, acquire };
}

// Runs tasks per key so that at most one runs and one waits. A task added
// while another is waiting replaces it (the waiting one's callers get the
// newer task's result), so a burst of updates turns into two at most. Use it
// for work that reads the current state when it runs, like a post that shows
// a count.
export class LatestOnly {
  // key -> { next: { task, promise, resolve, reject } | null }
  #states = new Map();

  run(key, task) {
    const state = this.#states.get(key);
    if (!state) {
      const fresh = { next: null };
      this.#states.set(key, fresh);
      const result = Promise.resolve().then(task);
      result.then(
        () => this.#drain(key, fresh),
        () => this.#drain(key, fresh),
      );
      return result;
    }
    if (state.next) {
      state.next.task = task;
      return state.next.promise;
    }
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    state.next = { task, promise, resolve, reject };
    return promise;
  }

  #drain(key, state) {
    const next = state.next;
    if (!next) {
      this.#states.delete(key);
      return;
    }
    state.next = null;
    const result = Promise.resolve().then(next.task);
    result.then(next.resolve, next.reject);
    result.then(
      () => this.#drain(key, state),
      () => this.#drain(key, state),
    );
  }

  get size() {
    return this.#states.size;
  }
}

// Discord's limits for one message.
const MAX_CONTENT = 2000;
const MAX_MENTIONED_USERS = 100;

// Sends plain-text messages ({ content, allowedMentions: { users } }) to
// channels. The first message goes out at once; messages for the same
// channel that come in while it's on its way wait, then go out together, one
// per line, in as few messages as fit. A burst of 200 joins becomes a handful
// of welcome messages instead of 200.
export function createBatchSender() {
  // channel ID -> [{ content, users, resolve, reject }]
  const waiting = new Map();
  const busy = new Set();

  function combine(entries) {
    const batches = [];
    let current = null;
    for (const entry of entries) {
      const fits =
        current &&
        current.content.length + 1 + entry.content.length <= MAX_CONTENT &&
        new Set([...current.users, ...entry.users]).size <= MAX_MENTIONED_USERS;
      if (fits) {
        current.content += `\n${entry.content}`;
        entry.users.forEach((id) => current.users.add(id));
        current.entries.push(entry);
      } else {
        current = { content: entry.content, users: new Set(entry.users), entries: [entry] };
        batches.push(current);
      }
    }
    return batches;
  }

  async function flush(channel) {
    busy.add(channel.id);
    try {
      while (waiting.get(channel.id)?.length) {
        const entries = waiting.get(channel.id);
        waiting.delete(channel.id);
        for (const batch of combine(entries)) {
          try {
            const sent = await channel.send({ content: batch.content, allowedMentions: { users: [...batch.users] } });
            batch.entries.forEach((entry) => entry.resolve(sent));
          } catch (error) {
            batch.entries.forEach((entry) => entry.reject(error));
          }
        }
      }
    } finally {
      busy.delete(channel.id);
    }
  }

  return {
    send(channel, { content, allowedMentions }) {
      return new Promise((resolve, reject) => {
        const entry = { content: String(content).slice(0, MAX_CONTENT), users: allowedMentions?.users ?? [], resolve, reject };
        waiting.set(channel.id, [...(waiting.get(channel.id) ?? []), entry]);
        if (!busy.has(channel.id)) {
          flush(channel);
        }
      });
    },
  };
}

// Discord deletes up to 100 messages in one bulk delete, if they're newer than two weeks.
const MAX_BULK = 100;

// Deletes messages. The first delete in a channel goes out at once; deletes
// that come in while it's on its way wait, then go out as one bulk delete. A
// spam wave of 50 messages costs a few requests instead of 50. Each call
// resolves when its message is gone and rejects with the error if it couldn't
// be deleted, like message.delete().
export function createMessageDeleter() {
  // channel ID -> [{ message, resolve, reject }]
  const waiting = new Map();
  const busy = new Set();

  async function deleteOne(entry) {
    try {
      await entry.message.delete();
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    }
  }

  async function deleteMany(channel, entries) {
    if (entries.length === 1 || typeof channel?.bulkDelete !== "function") {
      for (const entry of entries) {
        await deleteOne(entry);
      }
      return;
    }
    let deleted;
    try {
      deleted = await channel.bulkDelete(
        entries.map((entry) => entry.message.id),
        true,
      );
    } catch (error) {
      // No permission: none of them can be deleted, and asking again would only be refused.
      if (error?.code === 50013 || error?.code === 50001) {
        entries.forEach((entry) => entry.reject(error));
        return;
      }
      // A bulk delete fails as a whole (one message already gone, say): one by one instead.
      for (const entry of entries) {
        await deleteOne(entry);
      }
      return;
    }
    for (const entry of entries) {
      // Older than two weeks: bulk delete skips it.
      if (deleted?.has?.(entry.message.id) === false) {
        await deleteOne(entry);
      } else {
        entry.resolve();
      }
    }
  }

  async function flush(channel, channelId) {
    busy.add(channelId);
    try {
      while (waiting.get(channelId)?.length) {
        const entries = waiting.get(channelId);
        waiting.delete(channelId);
        for (let start = 0; start < entries.length; start += MAX_BULK) {
          await deleteMany(channel, entries.slice(start, start + MAX_BULK));
        }
      }
    } finally {
      busy.delete(channelId);
    }
  }

  return {
    delete(message) {
      return new Promise((resolve, reject) => {
        const channelId = message.channelId ?? message.channel?.id;
        if (!channelId) {
          message.delete().then(() => resolve(), reject);
          return;
        }
        waiting.set(channelId, [...(waiting.get(channelId) ?? []), { message, resolve, reject }]);
        if (!busy.has(channelId)) {
          flush(message.channel, channelId);
        }
      });
    },
  };
}

// The one the bot uses, so deletes from automod, media-only channels and the
// country channel in the same channel share batches.
const sharedDeleter = createMessageDeleter();
export const deleteMessage = (message) => sharedDeleter.delete(message);

export const CANT_POST = "The bot can't post there; give it View Channel and Send Messages.";

// Whether the bot may post in the channel. Unknown (no permission info, as in
// a DM or a test fake) counts as yes, so Discord gets to decide.
export function canPost(channel, { embeds = false } = {}) {
  const me = channel?.guild?.members?.me;
  if (!me || typeof channel.permissionsFor !== "function") {
    return true;
  }
  const permissions = channel.permissionsFor(me);
  if (!permissions) {
    return true;
  }
  const send = channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  return permissions.has([PermissionFlagsBits.ViewChannel, send, ...(embeds ? [PermissionFlagsBits.EmbedLinks] : [])]);
}

// For discord.js's rejectOnRateLimit: Discord lets a channel's name or topic
// change only twice per 10 minutes. Waiting that out would hold up every other
// change to the channel for minutes, so those requests fail at once instead
// and the caller tries again later.
export const isRenameLimited = (info) => (info?.sublimitTimeout ?? 0) > 0;

// How long a discord.js RateLimitError (or a 429) says to wait, or 0.
export function retryAfterMs(error) {
  if (error?.name !== "RateLimitError" && error?.status !== 429) {
    return 0;
  }
  return Math.max(error.sublimitTimeout ?? 0, error.retryAfter ?? 0, error.timeToReset ?? 0, 1000);
}
