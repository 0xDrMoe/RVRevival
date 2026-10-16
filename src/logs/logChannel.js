// Posts entries in one of a server's log channels (the logs, mod-log or
// server-log channel from /settings). Posting never throws: if the channel is
// missing or the bot can't post there, the caller carries on and a warning goes
// to the console, once per server and channel until posting works again.

import { PermissionFlagsBits } from "discord.js";

// Options:
//   guildSettings   where the channels are stored (GuildSettings)
//   logger
export function createLogChannelPoster({ guildSettings, logger }) {
  // "<server id>:<setting>" pairs already warned about.
  const warned = new Set();

  // The first of `settings` that is set, and its channel. Throws if that channel is gone.
  function channelFor(guild, settings) {
    for (const setting of settings) {
      const channelId = guildSettings.get(guild.id, setting);
      if (!channelId) {
        continue;
      }
      const channel = guild.channels?.cache.get(channelId);
      if (!channel?.isTextBased?.()) {
        throw Object.assign(new Error("The log channel no longer exists or isn't a text channel"), { setting });
      }
      return { setting, channel };
    }
    return undefined;
  }

  function warnOnce(guild, setting, error) {
    const key = `${guild.id}:${setting}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn(
        "Couldn't post in the logs channel. Give the bot View Channel, Send Messages, Embed Links and Attach Files there.",
        { guildId: guild.id, setting, channelId: guildSettings.get(guild.id, setting), error },
      );
    }
  }

  function botCanAttachIn(guild, channel) {
    const me = guild.members?.me;
    return Boolean(me && channel.permissionsFor?.(me)?.has(PermissionFlagsBits.AttachFiles));
  }

  return {
    // Whether any of `settings` has a channel in this server.
    isEnabled: (guild, settings) => Boolean(guild && settings.some((setting) => guildSettings.get(guild.id, setting))),

    // Posts in the first channel of `settings` that is set. `build({ canAttach })`
    // returns { embed, files? }. Returns the posted message, or undefined.
    async post(guild, settings, build) {
      if (!guild) {
        return undefined;
      }
      let target;
      try {
        target = channelFor(guild, settings);
        if (!target) {
          return undefined;
        }
        // Without Attach Files the whole message would be refused, so post
        // without files instead.
        const canAttach = botCanAttachIn(guild, target.channel);
        const { embed, files = [] } = build({ canAttach });
        const message = await target.channel.send({
          embeds: [embed],
          files: canAttach ? files : [],
          allowedMentions: { parse: [] },
        });
        warned.delete(`${guild.id}:${target.setting}`);
        return message;
      } catch (error) {
        warnOnce(guild, target?.setting ?? error.setting ?? settings[0], error);
        return undefined;
      }
    },

    // Replaces the embed of an earlier entry. Returns whether it worked.
    async edit(guild, channelId, messageId, embed) {
      try {
        const channel = guild?.channels?.cache.get(channelId);
        if (!channel?.isTextBased?.()) {
          return false;
        }
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
        return true;
      } catch (error) {
        logger.debug("Couldn't edit a log entry", { guildId: guild?.id, channelId, messageId, error });
        return false;
      }
    },
  };
}
