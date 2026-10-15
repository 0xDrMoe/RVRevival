// The /country-help command: explains to server admins how the bot works, and
// shows whether it's set up correctly in this server.
//
// Only members with the Manage Server permission can see or use it.

import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";

const COMMAND_NAME = "country-help";
const EMBED_COLOR = 0x5865f2;

export function buildCountryHelpCommandData() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription(translate("en", "helpCommandDescription"))
    .setDescriptionLocalizations(discordLocalizations("helpCommandDescription"))
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON();
}

// Live checks for this server, one line each.
function statusLines(interaction, channelSettings, text) {
  const channelId = channelSettings.get(interaction.guildId);
  const channelLine = channelId ? text("channelShow", { channel: `<#${channelId}>` }) : text("channelShowNone");

  const botCanManageRoles = interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false;
  const permissionLine = botCanManageRoles ? text("helpStatusCanManageRoles") : text("helpStatusCannotManageRoles");

  return [`📍 ${channelLine}`, permissionLine].join("\n");
}

// Options:
//   channelSettings  where the chosen /country channel is stored (ChannelSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createCountryHelpCommand({ channelSettings, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);

    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: text("guildOnly"), flags: MessageFlags.Ephemeral });
      return;
    }
    // Discord already hides the command from everyone else, but check anyway.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: text("helpNoPermission"), flags: MessageFlags.Ephemeral });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(text("helpTitle"))
      .addFields(
        { name: text("helpMembersTitle"), value: text("helpMembers") },
        { name: text("helpChannelTitle"), value: text("helpChannel") },
        { name: text("helpSetupTitle"), value: text("helpSetup") },
        { name: text("helpLanguageTitle"), value: text("helpLanguage") },
        { name: text("helpStatusTitle"), value: statusLines(interaction, channelSettings, text) },
      );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  return { name: COMMAND_NAME, data: buildCountryHelpCommandData(), execute };
}
