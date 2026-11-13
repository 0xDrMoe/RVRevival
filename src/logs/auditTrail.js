// Recent audit log entries, so the server log can say who did something: who
// deleted a message, gave a role, server-muted someone or moved them.
//
// Discord sends each new audit log entry to the bot (the "audit log entry
// create" event, which needs View Audit Log). The change itself (a deleted
// message, a member update) arrives on its own, usually a moment before its
// audit log entry, so find() waits a little for a matching entry.
//
// It's a best guess: Discord merges repeats of the same action by the same
// person into one entry (say, a moderator deleting several messages from one
// member in a few minutes), and sends nothing for the repeats. Then no entry
// is found and the log entry simply doesn't say who did it.

import { PermissionFlagsBits } from "discord.js";

// Entries older than this are forgotten.
const KEEP_MS = 30 * 1000;
// At most this many entries are kept per server, newest first.
const MAX_PER_GUILD = 50;
// How long find() waits for an entry by default, and how old an entry it
// accepts: a change and its entry arrive within a moment of each other.
export const AUDIT_WAIT_MS = 2000;
const LOOK_BACK_MS = 3000;

// Options:
//   now         the clock (replaceable in tests)
//   setTimer    setTimeout (replaceable in tests)
export function createAuditTrail({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  // guild ID -> [{ entry, at }], newest first
  const recent = new Map();
  // guild ID -> Set of { match, resolve }
  const waiting = new Map();

  function prune(guildId) {
    const list = recent.get(guildId);
    if (!list) {
      return [];
    }
    const fresh = list.filter((item) => now() - item.at < KEEP_MS).slice(0, MAX_PER_GUILD);
    if (fresh.length > 0) {
      recent.set(guildId, fresh);
    } else {
      recent.delete(guildId);
    }
    return fresh;
  }

  const canRead = (guild) => Boolean(guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog));

  return {
    canRead,

    // Call for every new audit log entry.
    record(entry, guild) {
      if (!entry || !guild?.id) {
        return;
      }
      recent.set(guild.id, [{ entry, at: now() }, ...prune(guild.id)]);
      // The first one waiting for it gets it.
      for (const waiter of waiting.get(guild.id) ?? []) {
        if (waiter.match(entry)) {
          waiter.resolve(entry);
          break;
        }
      }
    },

    // The newest entry in `guild` that `match(entry)` accepts, from the last
    // `lookBackMs` or arriving within `waitMs`; undefined if none does (or the
    // bot can't read the audit log there). An entry found is used up, so the
    // next change of the same kind isn't put down to the same person.
    async find(guild, match, { waitMs = AUDIT_WAIT_MS, lookBackMs = LOOK_BACK_MS } = {}) {
      if (!guild?.id) {
        return undefined;
      }
      const known = prune(guild.id).find((item) => now() - item.at <= lookBackMs && match(item.entry));
      if (known) {
        recent.set(guild.id, recent.get(guild.id).filter((item) => item !== known));
        return known.entry;
      }
      if (waitMs <= 0 || !canRead(guild)) {
        return undefined;
      }
      return new Promise((resolve) => {
        let set = waiting.get(guild.id);
        if (!set) {
          set = new Set();
          waiting.set(guild.id, set);
        }
        const waiter = {
          match,
          resolve: (entry) => {
            if (entry) {
              const list = recent.get(guild.id) ?? [];
              recent.set(guild.id, list.filter((item) => item.entry !== entry));
            }
            clearTimer(timer);
            set.delete(waiter);
            if (set.size === 0) {
              waiting.delete(guild.id);
            }
            resolve(entry);
          },
        };
        const timer = setTimer(() => waiter.resolve(undefined), waitMs);
        timer?.unref?.();
        set.add(waiter);
      });
    },
  };
}

export const noAuditTrail = Object.freeze({
  canRead: () => false,
  record: () => {},
  find: async () => undefined,
});
