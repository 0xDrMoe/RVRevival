// Dehoisting (/dehoist or the dashboard's Moderation page): names that start
// with symbols like "!" or "." sort above everyone else in the member list.
// With auto-dehoist on, the bot drops those symbols from the nickname of
// anyone who joins or renames with one; /dehoist run fixes everyone already
// here. A name that's nothing but symbols becomes "Dehoisted".
//
// Needs Manage Nicknames, and like Discord itself the bot can't rename the
// owner or anyone whose top role is above its own. Bots are left alone.

import { PermissionFlagsBits } from "discord.js";
import { Setting } from "../settings/guildSettings.js";

// ASCII punctuation up to the backtick sorts before letters in Discord's member list.
const HOIST = /^[\s!-/:-@[-`]+/u;
export const FALLBACK_NAME = "Dehoisted";
// One /dehoist run renames at most this many members; run it again for more.
export const MAX_DEHOIST_PER_RUN = 100;

export const dehoistOn = (guildSettings, guildId) => guildSettings.get(guildId, Setting.DEHOIST) === true;

export const isHoisted = (name) => typeof name === "string" && HOIST.test(name);

// The name without its leading symbols, at most 32 characters (Discord's limit).
export function dehoistedName(name) {
  const cleaned = String(name ?? "").replace(HOIST, "").trim().slice(0, 32);
  return cleaned || FALLBACK_NAME;
}

const canRename = (member) =>
  !member.user?.bot && member.id !== member.guild?.ownerId && member.manageable !== false && Boolean(member.guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageNicknames));

// Renames one member if their name is hoisted. Returns true when renamed.
export async function dehoistMember(member, reason = "Dehoist") {
  if (!isHoisted(member.displayName) || !canRename(member)) {
    return false;
  }
  await member.setNickname(dehoistedName(member.displayName), reason);
  return true;
}

// Options: guildSettings, logger
export function createDehoist({ guildSettings, logger }) {
  // Servers with a /dehoist run going, so two can't overlap.
  const running = new Set();

  const quietly = async (member) => {
    try {
      await dehoistMember(member, "Auto-dehoist");
    } catch (error) {
      logger.debug("Couldn't dehoist a member", { guildId: member.guild.id, error });
    }
  };

  return {
    async memberJoined(member) {
      if (dehoistOn(guildSettings, member.guild.id)) {
        await quietly(member);
      }
    },

    async memberUpdated(before, after) {
      if (before.displayName !== after.displayName && dehoistOn(guildSettings, after.guild.id)) {
        await quietly(after);
      }
    },

    // Renames everyone hoisted, up to MAX_DEHOIST_PER_RUN. Returns
    // { renamed, failed, more } or null when a run is already going.
    async run(guild) {
      if (running.has(guild.id)) {
        return null;
      }
      running.add(guild.id);
      try {
        const members = await guild.members.fetch();
        const hoisted = [...members.values()].filter((member) => isHoisted(member.displayName) && canRename(member));
        let renamed = 0;
        let failed = 0;
        for (const member of hoisted.slice(0, MAX_DEHOIST_PER_RUN)) {
          try {
            await member.setNickname(dehoistedName(member.displayName), "/dehoist run");
            renamed++;
          } catch {
            failed++;
          }
        }
        return { renamed, failed, more: Math.max(0, hoisted.length - MAX_DEHOIST_PER_RUN) };
      } finally {
        running.delete(guild.id);
      }
    },
  };
}
