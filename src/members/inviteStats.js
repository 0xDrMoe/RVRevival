// Invite tracking for /invites: who invited each new member, and how many of
// the people someone invited are still here.
//
// Off until a server switches it on (/invites tracking or the dashboard's
// Members page), and it needs the bot to have Manage Server, since that's the
// only way to read invite counts. The invite is worked out by
// logs/inviteTracker.js, the same lookup the server log's join entries use.
// Joins through the vanity link, Discovery or a bot are saved with no inviter.
// Records live in data/bot.db (table invite_joins); /mydata deletes a
// member's own.

import { PermissionFlagsBits } from "discord.js";
import { Setting } from "../settings/guildSettings.js";

export const inviteTrackingOn = (guildSettings, guildId) => guildSettings.get(guildId, Setting.INVITE_TRACKING) === true;

export const canReadInvites = (guild) => Boolean(guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageGuild));

// Options: guildSettings, store (GrowthStore), inviteTracker, logger, now
export function createInviteStats({ guildSettings, store, inviteTracker, logger, now = Date.now }) {
  return {
    async memberJoined(member) {
      const guild = member.guild;
      if (member.user?.bot || !inviteTrackingOn(guildSettings, guild.id) || !canReadInvites(guild)) {
        return;
      }
      const at = now();
      const invite = await inviteTracker.inviteUsed(member);
      // An invite someone made for themselves (an alt) doesn't count for them.
      const inviterId = invite?.inviterId && invite.inviterId !== member.id ? invite.inviterId : null;
      try {
        store.recordJoin(guild.id, member.id, { inviterId, code: invite?.code ?? null }, at);
      } catch (error) {
        logger.error("Couldn't save who invited a member", { guildId: guild.id, error });
      }
    },

    memberLeft(member) {
      if (!member.user?.bot) {
        store.recordLeave(member.guild.id, member.id, now());
      }
    },
  };
}
