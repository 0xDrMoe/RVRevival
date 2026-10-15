// The /country command: a member picks the country they live in and gets a
// role with that country's name. They can only pick once; after that, only
// staff can change it (see countryStaff.js).

import { MessageFlags, SlashCommandBuilder, InteractionContextType } from "discord.js";
import { countryList, MAX_NAME_LENGTH } from "../countries/countries.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status, statusForOutcome } from "../logs/actionLog.js";
import { CountryRoleService, Outcome } from "../roles/countryRoles.js";
import { wrapMember, wrapServer } from "../roles/discordAdapters.js";
import { Setting } from "../settings/guildSettings.js";
import { isExpiredInteractionError } from "../utils/discordErrors.js";
import { createCountryPicker } from "./countryPicker.js";

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

// Answers an autocomplete request with countries matching what was typed.
// Shared with /country-staff.
export async function suggestCountries(interaction, { countries, logger }) {
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

// Options:
//   logger           required
//   guildSettings    per-server settings, for the channel /country is limited to (GuildSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
//   countries, roleService, wrapServer, wrapMember   replaceable in tests
export function createCountryCommand(options) {
  const {
    logger,
    guildSettings,
    forcedLanguage,
    countries = countryList,
    roleService = new CountryRoleService(logger, countries),
    wrapServer: toServer = wrapServer,
    wrapMember: toMember = wrapMember,
  } = options;

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const message = (key, values) => ({ content: translate(language, key, values) });

    if (!interaction.inCachedGuild()) {
      await interaction.reply({ ...message("guildOnly"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "guildOnly");
    }

    const allowedChannelId = guildSettings?.get(interaction.guildId, Setting.COUNTRY_CHANNEL);
    if (allowedChannelId && !isInChannel(interaction, allowedChannelId)) {
      const values = { channel: `<#${allowedChannelId}>` };
      await interaction.reply({ ...message("wrongChannel", values), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "wrongChannel", values);
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
      return result(Status.REFUSED, "invalidCountry");
    }

    const { outcome, role } = await roleService.giveCountryRole(
      toServer(interaction.guild),
      toMember(interaction.member),
      country,
    );
    // When they already have a country, name the one they have.
    const values = { country: outcome === Outcome.LOCKED ? role.name : country.name };
    await interaction.editReply(message(outcome, values));
    return result(statusForOutcome(outcome), outcome, values);
  }

  const autocomplete = (interaction) => suggestCountries(interaction, { countries, logger });

  // The buttons on the /country-help guide do the same job without typing a command.
  const components = createCountryPicker({ countries, roleService, wrapServer: toServer, wrapMember: toMember, forcedLanguage });

  return { name: COMMAND_NAME, data: buildCountryCommandData(), execute, autocomplete, components };
}
