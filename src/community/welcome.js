// Welcome and leave messages, the welcome DM and autoroles (/welcome or the
// dashboard's Community page).
//
// When someone joins, the bot posts the welcome message in the welcome channel,
// DMs them the welcome DM and gives them the autoroles. If the server uses
// membership screening (rules to accept first), the roles wait until they've
// accepted, since Discord doesn't let pending members have roles. When someone
// leaves, the leave message goes in the leave channel. Bots get none of this,
// only the bot autoroles (a separate list, so a "Bots" role can be automatic).
//
// Rate limits: when many people join or leave at once, the messages that pile
// up while one is being posted go out together, one per line. Welcome DMs stop
// at WELCOME_DMS_PER_MINUTE per server (Discord flags bots that DM lots of new
// members as spam); the welcome message in the channel still goes out.
//
// Messages can use the "welcome" variables (dashboard/public/variables.js):
// {user} (a mention), {username}, {server} and {members} (the member count;
// the old {count} still works). Unset messages use a default in the server's
// language.
//
// Each of the three can also carry an embed (community/welcomeEmbeds.js). With
// an embed, only text the server wrote goes with it, not the default line.

import { escapeMarkdown, PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { isModeratorRole } from "../permissions/moderatorPermissions.js";
import { Setting } from "../settings/guildSettings.js";
import { fillVariables } from "../dashboard/public/variables.js";
import { sendDm } from "../utils/dms.js";
import { canPost, createBatchSender, createRateLimiter } from "../utils/rateLimits.js";
import { defaultEmbedColor, renderWelcomeEmbed, savedEmbed, TEXT_SETTING } from "./welcomeEmbeds.js";

export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_AUTOROLES = 10;
export const WELCOME_DMS_PER_MINUTE = 10;
// How recently someone must have joined for a rules acceptance the bot only
// half saw (see justAcceptedRules) to still give them their autoroles.
const RECENT_JOIN_MS = 24 * 60 * 60 * 1000;

// Fills in the placeholders. The member's name and the server's name can't add
// formatting; only {user} mentions anyone.
export function renderTemplate(template, { member, guild }) {
  const name = member.displayName ?? member.user?.globalName ?? member.user?.username ?? "";
  const values = {
    user: `<@${member.id}>`,
    username: escapeMarkdown(name),
    server: escapeMarkdown(guild.name ?? ""),
    members: guild.memberCount ? new Intl.NumberFormat("en-US").format(guild.memberCount) : "?",
  };
  return fillVariables(template, "welcome", values).slice(0, 2000);
}

// The welcome or leave text for a member: the server's own, or the default.
export function welcomeText(guildSettings, guild, member, kind, forcedLanguage) {
  const saved = guildSettings.get(guild.id, kind === "leave" ? Setting.LEAVE_MESSAGE : Setting.WELCOME_MESSAGE);
  const language = pickLanguage(guild.preferredLocale, forcedLanguage);
  const template = saved ?? translate(language, kind === "leave" ? "welcomeDefaultLeave" : "welcomeDefaultWelcome");
  return renderTemplate(template, { member, guild });
}

// What to send for a kind ("welcome", "leave" or "dm"): { content, embeds },
// or null when there's nothing (no welcome DM set up).
export function welcomePayload(guildSettings, guild, member, kind, forcedLanguage) {
  const saved = savedEmbed(guildSettings, guild.id, kind);
  const ownText = guildSettings.get(guild.id, TEXT_SETTING[kind]);
  let content = "";
  if (ownText) {
    content = renderTemplate(ownText, { member, guild });
  } else if (!saved && kind !== "dm") {
    content = welcomeText(guildSettings, guild, member, kind, forcedLanguage);
  }
  const embeds = saved ? [renderWelcomeEmbed(saved, { member, guild, color: defaultEmbedColor(guildSettings, guild.id) })] : [];
  return content || embeds.length > 0 ? { content, embeds } : null;
}

// Options:
//   guildSettings, logger
//   forcedLanguage   the default messages' language (BOT_LANGUAGE); otherwise the server's
//   skipAutoroles    (member) => true for members who mustn't get autoroles (quarantined)
export function createWelcomer({ guildSettings, logger, forcedLanguage, skipAutoroles = () => false, now = Date.now }) {
  const sender = createBatchSender();
  const dmLimit = createRateLimiter({ limit: WELCOME_DMS_PER_MINUTE, windowMs: 60_000, now });
  // "<server>:<what>" already warned about, so a busy server can't flood the console.
  const warned = new Set();
  const warnOnce = (guild, what, message, error) => {
    const key = `${guild.id}:${what}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn(message, { guildId: guild.id, error });
    }
  };

  async function post(guild, setting, payload, userId, what) {
    const channelId = guildSettings.get(guild.id, setting);
    const channel = channelId && guild.channels.cache.get(channelId);
    if (!channel?.isTextBased?.()) {
      return;
    }
    // Asking anyway would only get a refusal, which Discord counts against the bot.
    if (!canPost(channel)) {
      warnOnce(guild, what, `Couldn't post the ${what} message. Give the bot View Channel and Send Messages there.`);
      return;
    }
    try {
      await sender.send(channel, { ...payload, allowedMentions: { users: [userId] } });
      warned.delete(`${guild.id}:${what}`);
    } catch (error) {
      warnOnce(guild, what, `Couldn't post the ${what} message. Give the bot View Channel and Send Messages there.`, error);
    }
  }

  // Gives the autoroles (or, to a bot, the bot autoroles) the bot is allowed to
  // give. Roles it can't give are skipped with a console warning (once per
  // server until it works again), so the reason shows up in `pm2 logs`.
  async function giveAutoroles(member) {
    if (skipAutoroles(member)) {
      return;
    }
    const guild = member.guild;
    const me = guild.members.me;
    const setting = member.user?.bot ? Setting.BOT_AUTOROLES : Setting.AUTOROLES;
    const saved = guildSettings.getList(guild.id, setting).filter((id) => !member.roles.cache.has(id));
    if (saved.length === 0) {
      return;
    }
    const skipped = [];
    const ids = saved.filter((id) => {
      const role = guild.roles.cache.get(id);
      if (!role) {
        return false;
      }
      if (role.managed || isModeratorRole(role)) {
        skipped.push(`${role.name} (a bot role or has moderator permissions)`);
        return false;
      }
      if (!me || role.position >= me.roles.highest.position) {
        skipped.push(`${role.name} (at or above the bot's highest role)`);
        return false;
      }
      return true;
    });
    if (skipped.length > 0) {
      warnOnce(guild, "autoroles-skipped", `Couldn't give some autoroles: ${skipped.join(", ")}.`);
    }
    if (ids.length === 0) {
      return;
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      warnOnce(guild, "autoroles", "Couldn't give autoroles. Give the bot Manage Roles.");
      return;
    }
    try {
      await member.roles.add(ids, "Autorole");
      warned.delete(`${guild.id}:autoroles`);
      if (skipped.length === 0) {
        warned.delete(`${guild.id}:autoroles-skipped`);
      }
    } catch (error) {
      warnOnce(guild, "autoroles", "Couldn't give autoroles. Move the bot's role above them.", error);
    }
  }

  // Whether a member who just stopped being pending (accepted the rules) still
  // needs their autoroles. When the bot hadn't cached them (it restarted after
  // they joined) Discord's old copy is partial and doesn't say whether they were
  // pending, so anyone who joined in the last day counts.
  function justAcceptedRules(oldMember, newMember) {
    if (newMember.pending || newMember.user?.bot) {
      return false;
    }
    if (oldMember?.pending === true) {
      return true;
    }
    const unknown = !oldMember || oldMember.partial || oldMember.pending == null;
    const joinedAt = newMember.joinedTimestamp ?? newMember.joinedAt?.getTime?.();
    return unknown && typeof joinedAt === "number" && now() - joinedAt < RECENT_JOIN_MS;
  }

  return {
    async memberJoined(member) {
      // Roles first, so a slow or failing welcome message or DM can't hold them up.
      if (member.user?.bot || !member.pending) {
        await giveAutoroles(member).catch((error) => logger.error("Couldn't give autoroles", { guildId: member.guild.id, error }));
      }
      if (member.user?.bot) {
        return;
      }
      const guild = member.guild;
      if (guildSettings.get(guild.id, Setting.WELCOME_CHANNEL)) {
        await post(guild, Setting.WELCOME_CHANNEL, welcomePayload(guildSettings, guild, member, "welcome", forcedLanguage), member.id, "welcome");
      }
      const dm = welcomePayload(guildSettings, guild, member, "dm", forcedLanguage);
      if (dm && dmLimit.take(guild.id)) {
        const { content, embeds } = dm;
        await sendDm(member, { ...(content ? { content } : {}), ...(embeds.length > 0 ? { embeds } : {}), allowedMentions: { parse: [] } }).catch(() =>
          logger.debug("Couldn't DM a new member; their DMs are closed", { guildId: guild.id }),
        );
      } else if (dm) {
        logger.debug("Skipped a welcome DM; too many people joined at once", { guildId: guild.id });
      }
    },

    // Members who had to accept the rules get their autoroles once they do.
    async memberUpdated(oldMember, newMember) {
      if (justAcceptedRules(oldMember, newMember)) {
        await giveAutoroles(newMember);
      }
    },

    async memberLeft(member) {
      if (!member.user || member.user.bot) {
        return;
      }
      const guild = member.guild;
      if (guildSettings.get(guild.id, Setting.LEAVE_CHANNEL)) {
        await post(guild, Setting.LEAVE_CHANNEL, welcomePayload(guildSettings, guild, member, "leave", forcedLanguage), member.id, "leave");
      }
    },
  };
}
