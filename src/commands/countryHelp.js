// The /country-help command: an admin runs it in a channel, and the bot posts a
// standalone public message there telling members how to get their country role,
// with a button per continent and a "Type my country" button (see countryPicker.js).
// The admin gets a private confirmation.
//
// The guide also has a "Translate this message" button. It privately shows the
// guide in the clicker's Discord language, with a menu to switch to any of the
// bot's languages (Arabic included, which Discord can't detect) and the same
// continent buttons, so members can get their role from the translated copy.
//
// Only members with the Manage Server permission can see or use it.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { discordLocalizations, pickLanguage, SUPPORTED_LANGUAGES, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { buildGuideRows } from "./countryPicker.js";

const COMMAND_NAME = "country-help";
const EMBED_COLOR = 0x5865f2;

// Fixed, so the button keeps working on guides posted before a restart.
export const TranslateId = Object.freeze({
  BUTTON: "country-guide:translate",
  MENU: "country-guide:language",
});

export function buildCountryHelpCommandData() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription(translate("en", "helpCommandDescription"))
    .setDescriptionLocalizations(discordLocalizations("helpCommandDescription"))
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON();
}

// The public message. It only holds what members need to pick their country.
// `isCountryChannel` adds a note that other messages there are deleted.
export function buildHelpEmbed(language, { isCountryChannel = false } = {}) {
  const text = (key) => translate(language, key);
  const notes = [text("helpNotes"), text("helpFallbackNote"), ...(isCountryChannel ? [text("helpChannelNote")] : [])].join("\n");
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(text("helpTitle"))
    .setDescription(text("helpIntro"))
    .addFields(
      { name: text("helpStepsTitle"), value: text("helpSteps") },
      { name: text("helpNotesTitle"), value: notes },
    );
}

// The public guide's buttons: the picker's rows, with "Translate this message"
// next to "Type my country".
export function buildPostedRows(language) {
  const rows = buildGuideRows(language);
  rows.at(-1).addComponents(
    new ButtonBuilder()
      .setCustomId(TranslateId.BUTTON)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🌐")
      .setLabel(translate(language, "translateButtonLabel")),
  );
  return rows;
}

// The menu under a translated copy. Each language is listed in its own name
// ("Deutsch", "العربية"), so people can find theirs whatever they're reading.
export function buildLanguageMenuRow(language) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TranslateId.MENU)
      .setPlaceholder(translate(language, "translatePlaceholder"))
      .addOptions(
        SUPPORTED_LANGUAGES.map((code) => ({
          label: translate(code, "languageName"),
          value: code,
          default: code === language,
        })),
      ),
  );
}

// The private, translated copy: same guide and picker buttons, plus the language menu.
export function buildTranslatedGuide(language, { isCountryChannel = false } = {}) {
  return {
    embeds: [buildHelpEmbed(language, { isCountryChannel })],
    components: [...buildGuideRows(language), buildLanguageMenuRow(language)],
  };
}

// Whether the bot can post an embed in the channel the command was used in.
function canPostHere(interaction) {
  const send = interaction.channel?.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return interaction.appPermissions.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.EmbedLinks]);
}

// Options:
//   guildSettings    where the /country channel is stored (GuildSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createCountryHelpCommand({ guildSettings, forcedLanguage } = {}) {
  async function execute(interaction) {
    // Errors go only to the admin, in their own language.
    const adminLanguage = pickLanguage(interaction.locale, forcedLanguage);

    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: translate(adminLanguage, "guildOnly"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "guildOnly");
    }
    // Discord already hides the command from everyone else, but check anyway.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: translate(adminLanguage, "helpNoPermission"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "helpNoPermission");
    }

    const channel = interaction.channel;
    if (!channel || !canPostHere(interaction)) {
      await interaction.reply({ content: translate(adminLanguage, "helpCannotPost"), flags: MessageFlags.Ephemeral });
      return result(Status.FAILED, "helpCannotPost");
    }

    // Answer the admin privately first, so the interaction can't expire while posting.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Everyone reads the post, so it uses the server's language, not the admin's.
    const serverLanguage = pickLanguage(interaction.guildLocale, forcedLanguage);
    const countryChannelId = guildSettings?.get(interaction.guildId, Setting.COUNTRY_CHANNEL);
    const isCountryChannel = countryChannelId !== undefined && countryChannelId === channel.id;
    try {
      await channel.send({
        embeds: [buildHelpEmbed(serverLanguage, { isCountryChannel })],
        components: buildPostedRows(serverLanguage),
      });
    } catch (error) {
      // Permissions can change between the check above and the send.
      if (!isPermissionError(error)) {
        throw error;
      }
      await interaction.editReply({ content: translate(adminLanguage, "helpCannotPost") });
      return result(Status.FAILED, "helpCannotPost");
    }
    await interaction.editReply({ content: translate(adminLanguage, "helpPosted") });
    return result(Status.SUCCESS, "helpPosted");
  }

  const isCountryChannel = (interaction) => {
    const countryChannelId = guildSettings?.get(interaction.guildId, Setting.COUNTRY_CHANNEL);
    return countryChannelId !== undefined && countryChannelId === interaction.channelId;
  };

  // "Translate this message": the guide privately, in the clicker's Discord
  // language. BOT_LANGUAGE is ignored here, since they asked for a translation.
  async function showTranslation(interaction) {
    const language = pickLanguage(interaction.locale);
    await interaction.reply({
      ...buildTranslatedGuide(language, { isCountryChannel: isCountryChannel(interaction) }),
      flags: MessageFlags.Ephemeral,
    });
    return null; // not worth a log entry
  }

  // A language picked from the menu: swap the private copy to that language.
  async function switchLanguage(interaction) {
    const picked = interaction.values?.[0];
    // The menu only holds supported codes, but the value still comes from the client.
    const language = SUPPORTED_LANGUAGES.includes(picked) ? picked : pickLanguage(interaction.locale);
    await interaction.update(buildTranslatedGuide(language, { isCountryChannel: isCountryChannel(interaction) }));
    return null;
  }

  const components = {
    [TranslateId.BUTTON]: { label: "Translate guide button", handle: showTranslation },
    [TranslateId.MENU]: { label: "Translate guide button", handle: switchLanguage },
  };

  return { name: COMMAND_NAME, data: buildCountryHelpCommandData(), execute, components };
}
