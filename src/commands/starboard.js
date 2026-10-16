// The /starboard command: admins set up the starboard, where messages with
// enough ⭐ reactions are reposted (see community/starboard.js).
//
//   /starboard set channel:#starboard [threshold:3] [emoji:⭐]
//   /starboard off
//   /starboard show
//
// Needs Manage Server. The same settings are on the dashboard's Community page.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { cleanEmoji } from "../community/rolePanels.js";
import { DEFAULT_EMOJI, DEFAULT_THRESHOLD, MAX_THRESHOLD, MIN_THRESHOLD, starboardOf } from "../community/starboard.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";

const COMMAND_NAME = "starboard";
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildStarboardCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "starboardCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "starboardSetDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "starboardChannelOptionDescription")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addIntegerOption((option) =>
          withDescription(option.setName("threshold"), "starboardThresholdOptionDescription")
            .setMinValue(MIN_THRESHOLD)
            .setMaxValue(MAX_THRESHOLD),
        )
        .addStringOption((option) => withDescription(option.setName("emoji"), "starboardEmojiOptionDescription").setMaxLength(64)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("off"), "starboardOffDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("show"), "starboardShowDescription"))
    .toJSON();
}

// Options:
//   guildSettings, forcedLanguage
export function createStarboardCommand({ guildSettings, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({
        content: translate(language, key, values),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: translate(language, "permManageGuild") });
    }
    const guildId = interaction.guildId;
    const current = starboardOf(guildSettings, guildId);
    const describe = (config) => ({ channel: `<#${config.channelId}>`, threshold: config.threshold, emoji: config.emoji });

    switch (interaction.options.getSubcommand()) {
      case "set": {
        const channel = interaction.options.getChannel("channel", true);
        const me = interaction.guild.members.me;
        if (!me || !channel.permissionsFor?.(me)?.has(POST_PERMISSIONS)) {
          return answer(Status.REFUSED, "starboardCannotPost", { channel: `<#${channel.id}>` });
        }
        const emojiText = interaction.options.getString("emoji");
        const emoji = emojiText ? cleanEmoji(emojiText) : (current?.emoji ?? DEFAULT_EMOJI);
        if (!emoji) {
          return answer(Status.REFUSED, "starboardBadEmoji");
        }
        const config = {
          channelId: channel.id,
          threshold: interaction.options.getInteger("threshold") ?? current?.threshold ?? DEFAULT_THRESHOLD,
          emoji,
        };
        await guildSettings.set(guildId, Setting.STARBOARD, config);
        return answer(Status.SUCCESS, "starboardSet", describe(config));
      }
      case "off":
        await guildSettings.clear(guildId, Setting.STARBOARD);
        return answer(Status.SUCCESS, "starboardOff");
      case "show":
        return current ? answer(Status.SUCCESS, "starboardShow", describe(current)) : answer(Status.SUCCESS, "starboardShowOff");
    }
    return answer(Status.FAILED, "unexpected");
  }

  return { name: COMMAND_NAME, data: buildStarboardCommandData(), execute };
}
