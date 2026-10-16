// Carries out moderation actions: does the Discord side (ban, kick, timeout…),
// DMs the member, records a numbered case and posts it in the mod-log channel.
// Commands check permissions and hierarchy before calling these; Discord errors
// are passed back to the caller.

import { escapeMarkdown, time, TimestampStyles } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { CaseAction } from "./caseStore.js";
import { noModLog } from "./modLog.js";

// Discord's longest audit log reason.
const MAX_AUDIT_REASON = 512;

// The DM each action sends, if any. Unbanned users share no server with the
// bot, so they can't be DMed.
const DM_MESSAGES = {
  [CaseAction.BAN]: "dmBan",
  [CaseAction.SOFTBAN]: "dmSoftban",
  [CaseAction.KICK]: "dmKick",
  [CaseAction.TIMEOUT]: "dmTimeout",
  [CaseAction.UNTIMEOUT]: "dmUntimeout",
  [CaseAction.WARN]: "dmWarn",
};

// What shows in the server's audit log: the reason and who used the bot.
export function auditReason(moderator, reason) {
  const text = `${reason || "No reason given"} (by ${moderator.tag ?? moderator.username ?? moderator.id})`;
  return text.length > MAX_AUDIT_REASON ? `${text.slice(0, MAX_AUDIT_REASON - 1)}…` : text;
}

// Options:
//   store            the CaseStore
//   modLog           posts cases in the mod-log channel (see modLog.js)
//   logger
//   forcedLanguage   DM in this language (BOT_LANGUAGE); otherwise the server's language
//   botActions       remembers what the bot does itself, so the ban/kick/timeout
//                    events Discord sends back aren't recorded twice (RecentIds)
//   onModeratorAction  called with (guild, moderatorId, "ban" | "kick") after a
//                    ban or kick, so anti-nuke counts bans done through the bot
//   appealLink       (guild) => the ban-appeal page's address, or null; added
//                    to ban DMs
//   now              the clock (replaceable in tests)
export function createModerationService({ store, modLog = noModLog, logger, forcedLanguage, botActions, onModeratorAction, appealLink, now = Date.now }) {
  const markOwnAction = (guild, userId, action) => botActions?.add(`${guild.id}:${userId}:${action}`);
  const counted = (guild, moderator, action) => {
    Promise.resolve(onModeratorAction?.(guild, moderator?.id, action)).catch((error) =>
      logger?.error("Anti-nuke failed on a moderator action", { error }),
    );
  };

  // DMs the member about an action. Returns whether it arrived; closed DMs are normal.
  async function notify(user, guild, action, { reason, expiresAt }) {
    const key = expiresAt && action === CaseAction.BAN ? "dmTempBan" : DM_MESSAGES[action];
    if (!key || user.bot) {
      return undefined;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    const lines = [
      translate(language, key, {
        server: escapeMarkdown(guild.name),
        until: expiresAt ? time(Math.floor(expiresAt / 1000), TimestampStyles.LongDateTime) : "",
      }),
    ];
    lines.push(reason ? translate(language, "dmReason", { reason }) : translate(language, "dmNoReason"));
    const appeal = action === CaseAction.BAN ? appealLink?.(guild) : null;
    if (appeal) {
      lines.push(translate(language, "dmAppeal", { url: appeal }));
    }
    try {
      await user.send({ content: lines.join("\n").slice(0, 2000), allowedMentions: { parse: [] } });
      return true;
    } catch (error) {
      logger?.debug("Couldn't DM a member about a moderation action", { userId: user.id, action, error });
      return false;
    }
  }

  // Saves a case and posts it in the mod-log channel.
  async function recordCase({ guild, action, user, moderator, reason, durationMs, expiresAt, pendingUnban, dmSent }) {
    const moderationCase = store.createCase({
      guildId: guild.id,
      action,
      userId: user.id,
      userTag: user.tag ?? user.username,
      moderatorId: moderator.id,
      moderatorTag: moderator.tag ?? moderator.username,
      reason: reason || undefined,
      durationMs,
      expiresAt,
      pendingUnban,
      dmSent,
      createdAt: now(),
    });
    await modLog.postCase(guild, moderationCase);
    logger?.info("Moderation case recorded", {
      guildId: guild.id,
      case: moderationCase.number,
      action,
      userId: user.id,
      moderatorId: moderator.id,
    });
    return store.getCase(guild.id, moderationCase.number) ?? moderationCase;
  }

  return {
    store,
    recordCase,

    // Bans `user` (a User; `member` is their GuildMember if they're in the server).
    // With `durationMs`, they're unbanned automatically when it ends.
    async ban({ guild, user, member, moderator, reason, durationMs, deleteMessageSeconds = 0 }) {
      const expiresAt = durationMs ? now() + durationMs : undefined;
      // DM first: once banned, they no longer share a server with the bot.
      const dmSent = member ? await notify(user, guild, CaseAction.BAN, { reason, expiresAt }) : undefined;
      markOwnAction(guild, user.id, CaseAction.BAN);
      await guild.members.ban(user.id, { reason: auditReason(moderator, reason), deleteMessageSeconds });
      counted(guild, moderator, "ban");
      // A new ban replaces any temporary ban still waiting to end.
      store.clearPendingUnbans(guild.id, user.id);
      return recordCase({
        guild,
        action: CaseAction.BAN,
        user,
        moderator,
        reason,
        durationMs,
        expiresAt,
        pendingUnban: Boolean(expiresAt),
        dmSent,
      });
    },

    async unban({ guild, user, moderator, reason }) {
      markOwnAction(guild, user.id, CaseAction.UNBAN);
      await guild.members.unban(user.id, auditReason(moderator, reason));
      store.clearPendingUnbans(guild.id, user.id);
      return recordCase({ guild, action: CaseAction.UNBAN, user, moderator, reason });
    },

    // Bans and immediately unbans, to delete a member's recent messages. They
    // can rejoin with an invite, like after a kick.
    async softban({ guild, member, moderator, reason, deleteMessageSeconds }) {
      const dmSent = await notify(member.user, guild, CaseAction.SOFTBAN, { reason });
      markOwnAction(guild, member.id, CaseAction.BAN);
      markOwnAction(guild, member.id, CaseAction.UNBAN);
      await guild.members.ban(member.id, { reason: auditReason(moderator, reason), deleteMessageSeconds });
      await guild.members.unban(member.id, auditReason(moderator, `Softban: ${reason || "No reason given"}`));
      counted(guild, moderator, "ban");
      return recordCase({ guild, action: CaseAction.SOFTBAN, user: member.user, moderator, reason, dmSent });
    },

    async kick({ guild, member, moderator, reason }) {
      const dmSent = await notify(member.user, guild, CaseAction.KICK, { reason });
      markOwnAction(guild, member.id, CaseAction.KICK);
      await member.kick(auditReason(moderator, reason));
      counted(guild, moderator, "kick");
      return recordCase({ guild, action: CaseAction.KICK, user: member.user, moderator, reason, dmSent });
    },

    async timeout({ guild, member, moderator, reason, durationMs }) {
      const expiresAt = now() + durationMs;
      markOwnAction(guild, member.id, CaseAction.TIMEOUT);
      await member.timeout(durationMs, auditReason(moderator, reason));
      const dmSent = await notify(member.user, guild, CaseAction.TIMEOUT, { reason, expiresAt });
      return recordCase({
        guild,
        action: CaseAction.TIMEOUT,
        user: member.user,
        moderator,
        reason,
        durationMs,
        expiresAt,
        dmSent,
      });
    },

    async untimeout({ guild, member, moderator, reason }) {
      markOwnAction(guild, member.id, CaseAction.UNTIMEOUT);
      await member.timeout(null, auditReason(moderator, reason));
      const dmSent = await notify(member.user, guild, CaseAction.UNTIMEOUT, { reason });
      return recordCase({ guild, action: CaseAction.UNTIMEOUT, user: member.user, moderator, reason, dmSent });
    },

    // A private note for moderators: recorded, never sent to the member.
    async note({ guild, user, moderator, reason }) {
      return recordCase({ guild, action: CaseAction.NOTE, user, moderator, reason });
    },

    async warn({ guild, member, moderator, reason }) {
      const dmSent = await notify(member.user, guild, CaseAction.WARN, { reason });
      return recordCase({ guild, action: CaseAction.WARN, user: member.user, moderator, reason, dmSent });
    },

    // Changes a case's reason and updates its mod-log post. Returns the case,
    // or undefined if there's no such case.
    async updateReason(guild, number, reason) {
      const updated = store.updateReason(guild.id, number, reason || undefined, now());
      if (updated) {
        await modLog.refreshCase(guild, updated);
      }
      return updated;
    },
  };
}
