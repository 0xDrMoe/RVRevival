// Works out which invite a new member used, for the server log's join entries
// ("Joined with discord.gg/abc123, made by @Moe, used 12 times").
//
// Discord doesn't say which invite someone used, so the bot remembers how many
// times each of the server's invites has been used and, when someone joins,
// looks for the one whose count went up. That needs Manage Server (to list
// invites); without it, join entries just leave the invite out. It's a best
// guess: if two people join at the same moment, or someone joins through the
// vanity link, Discovery or a bot, there may be no single answer, and then
// nothing is said.
//
// Counts are only kept in memory: nothing is saved.

import { PermissionFlagsBits } from "discord.js";

// Servers are looked at one at a time at startup, this far apart, so a bot
// in many servers doesn't send a burst of requests.
const PRIME_GAP_MS = 1500;

// Options:
//   logger
//   wants(guild)   whether join entries in this server would show the invite
export function createInviteTracker({ logger, wants = () => true, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  // guild ID -> Map(code -> { uses, maxUses, inviterId, expiresAt })
  const counts = new Map();
  // guild ID -> promise of the previous lookup, so joins are looked at in order
  const chains = new Map();

  const canList = (guild) => Boolean(guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageGuild));

  const snapshot = (invites) =>
    new Map(
      [...invites.values()].map((invite) => [
        invite.code,
        { uses: invite.uses ?? 0, maxUses: invite.maxUses ?? 0, inviterId: invite.inviterId ?? invite.inviter?.id, expiresAt: invite.expiresTimestamp ?? null },
      ]),
    );

  async function fetchCounts(guild) {
    const invites = await guild.invites.fetch({ cache: false });
    return snapshot(invites);
  }

  async function prime(guild) {
    if (!canList(guild) || !wants(guild)) {
      return;
    }
    try {
      counts.set(guild.id, await fetchCounts(guild));
    } catch (error) {
      logger?.debug?.("Couldn't list a server's invites", { guildId: guild.id, error });
    }
  }

  async function lookUp(guild) {
    const before = counts.get(guild.id);
    const after = await fetchCounts(guild);
    counts.set(guild.id, after);
    if (!before) {
      return undefined;
    }
    // Invites used since last time, counting ones made since then as unused.
    const used = [...after].filter(([code, now]) => now.uses > (before.get(code)?.uses ?? 0));
    if (used.length === 1) {
      const [code, now] = used[0];
      return { code, inviterId: now.inviterId, uses: now.uses, maxUses: now.maxUses };
    }
    if (used.length > 1) {
      return undefined;
    }
    // A one-time (or last-use) invite disappears as it's used.
    const gone = [...before].filter(
      ([code, then]) => !after.has(code) && then.maxUses > 0 && then.uses + 1 >= then.maxUses && (!then.expiresAt || then.expiresAt > Date.now()),
    );
    if (gone.length === 1) {
      const [code, then] = gone[0];
      return { code, inviterId: then.inviterId, uses: then.uses + 1, maxUses: then.maxUses, used: true };
    }
    return undefined;
  }

  return {
    // At startup: remember each server's invites, one server at a time.
    async primeAll(guilds) {
      for (const guild of guilds) {
        if (canList(guild) && wants(guild)) {
          await prime(guild);
          await sleep(PRIME_GAP_MS);
        }
      }
    },

    prime,

    // Keep counts right as invites come and go (needs the Guild Invites intent).
    inviteCreated(invite) {
      const list = counts.get(invite.guild?.id);
      list?.set(invite.code, {
        uses: invite.uses ?? 0,
        maxUses: invite.maxUses ?? 0,
        inviterId: invite.inviterId ?? invite.inviter?.id,
        expiresAt: invite.expiresTimestamp ?? null,
      });
    },
    inviteDeleted(invite) {
      counts.get(invite.guild?.id)?.delete(invite.code);
    },
    guildDeleted(guildId) {
      counts.delete(guildId);
      chains.delete(guildId);
    },

    // The invite `member` most likely joined with, as { code, inviterId, uses,
    // maxUses }, or undefined. Never throws.
    async inviteUsed(member) {
      const guild = member.guild;
      if (!canList(guild)) {
        return undefined;
      }
      const previous = chains.get(guild.id) ?? Promise.resolve();
      const next = previous.then(
        () => lookUp(guild),
        () => lookUp(guild),
      );
      const settled = next.catch(() => undefined);
      chains.set(guild.id, settled);
      try {
        return await next;
      } catch (error) {
        logger?.debug?.("Couldn't work out which invite a member used", { guildId: guild.id, error });
        return undefined;
      } finally {
        if (chains.get(guild.id) === settled) {
          chains.delete(guild.id);
        }
      }
    },
  };
}

export const noInviteTracker = Object.freeze({
  primeAll: async () => {},
  prime: async () => {},
  inviteCreated: () => {},
  inviteDeleted: () => {},
  guildDeleted: () => {},
  inviteUsed: async () => undefined,
});
