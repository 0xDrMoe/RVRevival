// Welcome and leave messages, the welcome DM and autoroles (/welcome or the
// dashboard's Community page).
//
// When someone joins, the bot posts the welcome message in the welcome channel,
// DMs them the welcome DM and gives them the autoroles. If the server uses
// membership screening (rules to accept first), the roles wait until they've
// accepted, since Discord doesn't let pending members have roles. When someone
// leaves, the leave message goes in the leave channel. Bots get none of this.
//
// Messages can use {user} (a mention), {username}, {server} and {count} (the
// member count). Unset messages use a default in the server's language.

import { escapeMarkdown, PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";

export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_AUTOROLES = 10;
export const PLACEHOLDERS = ["{user}", "{username}", "{server}", "{count}"];

// Fills in the placeholders. The member's name and the server's name can't add
// formatting; only {user} mentions anyone.
export function renderTemplate(template, { member, guild }) {
  const name = member.displayName ?? member.user?.globalName ?? member.user?.username ?? "";
  const values = {
    user: `<@${member.id}>`,
    username: escapeMarkdown(name),
    server: escapeMarkdown(guild.name ?? ""),
    count: guild.memberCount ? new Intl.NumberFormat("en-US").format(guild.memberCount) : "?",
  };
  return template.replace(/\{(user|username|server|count)\}/g, (_match, key) => values[key]).slice(0, 2000);
}

// The welcome or leave text for a member: the server's own, or the default.
export function welcomeText(guildSettings, guild, member, kind, forcedLanguage) {
  const saved = guildSettings.get(guild.id, kind === "leave" ? Setting.LEAVE_MESSAGE : Setting.WELCOME_MESSAGE);
  const language = pickLanguage(guild.preferredLocale, forcedLanguage);
  const template = saved ?? translate(language, kind === "leave" ? "welcomeDefaultLeave" : "welcomeDefaultWelcome");
  return renderTemplate(template, { member, guild });
}

// Options:
//   guildSettings, logger
//   forcedLanguage   the default messages' language (BOT_LANGUAGE); otherwise the server's
export function createWelcomer({ guildSettings, logger, forcedLanguage }) {
  // "<server>:<what>" already warned about, so a busy server can't flood the console.
  const warned = new Set();
  const warnOnce = (guild, what, message, error) => {
    const key = `${guild.id}:${what}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn(message, { guildId: guild.id, error });
    }
  };

  async function post(guild, setting, content, userId, what) {
    const channelId = guildSettings.get(guild.id, setting);
    const channel = channelId && guild.channels.cache.get(channelId);
    if (!channel?.isTextBased?.()) {
      return;
    }
    try {
      await channel.send({ content, allowedMentions: { users: [userId] } });
      warned.delete(`${guild.id}:${what}`);
    } catch (error) {
      warnOnce(guild, what, `Couldn't post the ${what} message. Give the bot View Channel and Send Messages there.`, error);
    }
  }

  // Gives the autoroles the bot is allowed to give.
  async function giveAutoroles(member) {
    const guild = member.guild;
    const me = guild.members.me;
    const ids = guildSettings.getList(guild.id, Setting.AUTOROLES).filter((id) => {
      const role = guild.roles.cache.get(id);
      return role && !role.managed && me && role.position < me.roles.highest.position && !member.roles.cache.has(id);
    });
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
    } catch (error) {
      warnOnce(guild, "autoroles", "Couldn't give autoroles. Move the bot's role above them.", error);
    }
  }

  return {
    async memberJoined(member) {
      if (member.user?.bot) {
        return;
      }
      const guild = member.guild;
      await post(guild, Setting.WELCOME_CHANNEL, welcomeText(guildSettings, guild, member, "welcome", forcedLanguage), member.id, "welcome");
      const dm = guildSettings.get(guild.id, Setting.WELCOME_DM);
      if (dm) {
        await member
          .send({ content: renderTemplate(dm, { member, guild }), allowedMentions: { parse: [] } })
          .catch(() => logger.debug("Couldn't DM a new member; their DMs are closed", { guildId: guild.id }));
      }
      if (!member.pending) {
        await giveAutoroles(member);
      }
    },

    // Members who had to accept the rules get their autoroles once they do.
    async memberUpdated(oldMember, newMember) {
      if (oldMember.pending && !newMember.pending && !newMember.user?.bot) {
        await giveAutoroles(newMember);
      }
    },

    async memberLeft(member) {
      if (!member.user || member.user.bot) {
        return;
      }
      const guild = member.guild;
      await post(guild, Setting.LEAVE_CHANNEL, welcomeText(guildSettings, guild, member, "leave", forcedLanguage), member.id, "leave");
    },
  };
}
