// The /country command: a member picks the country they live in and gets a
// role with that country's name.

import { MessageFlags, SlashCommandBuilder, InteractionContextType } from "discord.js";
import { countryList, MAX_NAME_LENGTH } from "../countries/countries.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { CountryRoleService } from "../roles/countryRoles.js";
import { wrapMember, wrapServer } from "../roles/discordAdapters.js";
import { isExpiredInteractionError } from "../utils/discordErrors.js";

const COMMAND_NAME = "country";
const OPTION_NAME = "country";

// Discord shows at most 25 autocomplete suggestions.
export const MAX_SUGGESTIONS = 25;

export function buildCountryCommandData() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription(translate("en", "commandDescription"))
    .setDescriptionLocalizations(discordLocalizations("commandDescription"))
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName(OPTION_NAME)
        .setDescription(translate("en", "countryOptionDescription"))
        .setDescriptionLocalizations(discordLocalizations("countryOptionDescription"))
        .setRequired(true)
        .setAutocomplete(true)
        .setMaxLength(MAX_NAME_LENGTH),
    )
    .toJSON();
}

// True if the interaction happened in `channelId`, or in a thread inside it.
function isInChannel(interaction, channelId) {
  return interaction.channelId === channelId || interaction.channel?.parentId === channelId;
}

// Options:
//   logger           required
//   channelSettings  the channel admins limited /country to, if any (ChannelSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
//   countries, roleService, wrapServer, wrapMember   replaceable in tests
export function createCountryCommand(options) {
  const {
    logger,
    channelSettings,
    forcedLanguage,
    countries = countryList,
    roleService = new CountryRoleService(logger),
    wrapServer: toServer = wrapServer,
    wrapMember: toMember = wrapMember,
  } = options;

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const message = (key, values) => ({ content: translate(language, key, values) });

    if (!interaction.inCachedGuild()) {
      await interaction.reply({ ...message("guildOnly"), flags: MessageFlags.Ephemeral });
      return;
    }

    const allowedChannelId = channelSettings?.get(interaction.guildId);
    if (allowedChannelId && !isInChannel(interaction, allowedChannelId)) {
      await interaction.reply({
        ...message("wrongChannel", { channel: `<#${allowedChannelId}>` }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Tell Discord we're working on it right away. Discord cancels commands that
    // aren't acknowledged within 3 seconds, and role changes can be slower.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const typed = interaction.options.getString(OPTION_NAME);
    const country = countries.find(typed);
    if (!country) {
      logger.debug("Rejected an unknown country", {
        userId: interaction.user.id,
        inputLength: typed?.length ?? 0,
      });
      await interaction.editReply(message("invalidCountry"));
      return;
    }

    const result = await roleService.giveCountryRole(
      toServer(interaction.guild),
      toMember(interaction.member),
      country,
    );
    await interaction.editReply(message(result.outcome, { country: country.name }));
  }

  async function autocomplete(interaction) {
    let suggestions = [];
    try {
      const typed = String(interaction.options.getFocused() ?? "");
      suggestions = countries
        .search(typed, MAX_SUGGESTIONS)
        .map((country) => ({ name: country.name, value: country.name }));
    } catch (error) {
      logger.warn("Couldn't build autocomplete suggestions", { error });
    }

    try {
      await interaction.respond(suggestions);
    } catch (error) {
      // Expected when the user keeps typing: Discord drops the older request.
      if (isExpiredInteractionError(error)) {
        logger.debug("Autocomplete request expired before we answered");
      } else {
        logger.warn("Couldn't send autocomplete suggestions", { error });
      }
    }
  }

  return { name: COMMAND_NAME, data: buildCountryCommandData(), execute, autocomplete };
}
