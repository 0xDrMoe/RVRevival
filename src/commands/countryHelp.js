// The /country-help command: an admin runs it in a channel, and the bot posts a
// short public message there telling members how to get their country role.
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

// The public message. It only holds what members need to use /country.
export function buildHelpEmbed(language) {
  const text = (key) => translate(language, key);
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(text("helpTitle"))
    .setDescription(text("helpIntro"))
    .addFields(
      { name: text("helpStepsTitle"), value: text("helpSteps") },
      { name: text("helpNotesTitle"), value: text("helpNotes") },
    );
}

// Options:
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createCountryHelpCommand({ forcedLanguage } = {}) {
  async function execute(interaction) {
    // Errors go only to the admin, in their own language.
    const adminLanguage = pickLanguage(interaction.locale, forcedLanguage);

    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: translate(adminLanguage, "guildOnly"), flags: MessageFlags.Ephemeral });
      return;
    }
    // Discord already hides the command from everyone else, but check anyway.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: translate(adminLanguage, "helpNoPermission"), flags: MessageFlags.Ephemeral });
      return;
    }

    // Everyone reads the post, so it uses the server's language, not the admin's.
    // Posting it as the command's reply needs no extra channel permissions.
    const serverLanguage = pickLanguage(interaction.guildLocale, forcedLanguage);
    await interaction.reply({ embeds: [buildHelpEmbed(serverLanguage)] });
  }

  return { name: COMMAND_NAME, data: buildCountryHelpCommandData(), execute };
}
