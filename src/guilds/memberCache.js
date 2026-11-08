// Loading a server's whole member list, for commands that count or act on
// every member (/roleinfo, /massrole).
//
// Discord sends the list in chunks over the gateway (it needs the Server
// Members intent), which takes a while on big servers. discord.js keeps the
// cache up to date from join, leave and update events afterwards, so a server
// is fetched again at most once every 10 minutes, and two commands asking at
// the same time share one fetch.

const REFETCH_AFTER_MS = 10 * 60_000;

// Whether every member is in the cache.
export const hasAllMembers = (guild) => (guild.members?.cache?.size ?? 0) >= (guild.memberCount ?? Number.POSITIVE_INFINITY);

// Options: now (for tests)
export function createMemberLoader({ now = Date.now } = {}) {
  // guildId -> when its members were last fetched
  const fetchedAt = new Map();
  // guildId -> the fetch in progress
  const inFlight = new Map();

  // Resolves to true once the cache holds every member (or was filled in the
  // last 10 minutes, since memberCount can lag a little behind), false when
  // Discord didn't send the list in `timeMs`.
  async function loadAll(guild, { timeMs = 60_000 } = {}) {
    if (hasAllMembers(guild)) {
      return true;
    }
    const last = fetchedAt.get(guild.id);
    if (last !== undefined && now() - last < REFETCH_AFTER_MS) {
      return true;
    }
    if (inFlight.has(guild.id)) {
      return inFlight.get(guild.id);
    }
    const loading = guild.members
      .fetch({ time: timeMs })
      .then(
        () => {
          fetchedAt.set(guild.id, now());
          return true;
        },
        () => false,
      )
      .finally(() => inFlight.delete(guild.id));
    inFlight.set(guild.id, loading);
    return loading;
  }

  return { loadAll };
}
