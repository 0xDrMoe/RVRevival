// The /country-staff command: staff change or remove a member's country role.
//
//   /country-staff set member:@someone country:Canada   make Canada their only country role
//   /country-staff remove member:@someone               remove their country role
//
// Only members with the staff role chosen in /settings can use it. Discord
// can't hide a command by role, so everyone sees it, but the bot refuses
// anyone without the staff role. Admins can also hide it in Server Settings >
// Integrations.

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { countryList, MAX_NAME_LENGTH } from "../countries/countries.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status, statusForOutcome } from "../logs/actionLog.js";
import { CountryRoleService, Outcome } from "../roles/countryRoles.js";
import { wrapMember, wrapServer } from "../roles/discordAdapters.js";
import { Setting } from "../settings/guildSettings.js";
import { suggestCountries } from "./country.js";

const COMMAND_NAME = "country-staff";
const MEMBER_OPTION = "member";
const COUNTRY_OPTION = "country";

// Outcomes whose /country wording ("your role") doesn't fit staff acting on
// someone else. The rest use the outcome's own message.
export const STAFF_MESSAGES = {
  [Outcome.ASSIGNED]: "staffAssigned",
  [Outcome.ALREADY_ASSIGNED]: "staffAlreadyAssigned",
  [Outcome.HIERARCHY]: "staffHierarchy",
  [Outcome.CREATED_BUT_NOT_ASSIGNED]: "staffAssignFailed",
  [Outcome.ASSIGN_FAILED]: "staffAssignFailed",
  [Outcome.UNEXPECTED]: "staffUnexpected",
};

// Shorthand for an English description plus its translations.
function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildCountryStaffCommandData() {
  const command = new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild);
  const memberOption = (option) =>
    withDescription(option.setName(MEMBER_OPTION), "staffMemberOptionDescription").setRequired(true);

  return withDescription(command, "staffCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "staffSetDescription")
        .addUserOption(memberOption)
        .addStringOption((option) =>
          withDescription(option.setName(COUNTRY_OPTION), "staffCountryOptionDescription")
            .setRequired(true)
            .setAutocomplete(true)
            .setMaxLength(MAX_NAME_LENGTH),
        ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "staffRemoveDescription").addUserOption(memberOption))
    .toJSON();
}

// Options:
//   logger           required
//   guildSettings    per-server settings, for the staff role (GuildSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
//   countries, roleService, wrapServer, wrapMember   replaceable in tests
export function createCountryStaffCommand(options) {
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
    const message = (key, values) => ({
      content: translate(language, key, values),
      // Replies mention the member and the staff role; never ping them.
      allowedMentions: { parse: [] },
    });
    // Answers privately and reports the command as refused.
    const refuse = async (key, values) => {
      await interaction.reply({ ...message(key, values), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, key, values);
    };

    if (!interaction.inCachedGuild()) {
      return refuse("guildOnly");
    }

    const staffRoleId = guildSettings?.get(interaction.guildId, Setting.STAFF_ROLE);
    if (!staffRoleId) {
      return refuse("staffRoleNotSet");
    }
    if (!interaction.member.roles.cache.has(staffRoleId)) {
      return refuse("staffOnly", { role: `<@&${staffRoleId}>` });
    }

    const target = interaction.options.getMember(MEMBER_OPTION);
    if (!target) {
      return refuse("staffMemberNotFound");
    }
    const memberMention = `<@${target.id}>`;

    const subcommand = interaction.options.getSubcommand();
    let country;
    if (subcommand === "set") {
      country = countries.find(interaction.options.getString(COUNTRY_OPTION));
      if (!country) {
        return refuse("invalidCountry");
      }
    }

    // Role changes can take longer than Discord's 3-second limit.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const server = toServer(interaction.guild);
    const member = toMember(target);
    const staffUserId = interaction.user.id;
    const change =
      subcommand === "set"
        ? await roleService.setCountryRole(server, member, country, staffUserId)
        : await roleService.removeCountryRoles(server, member, staffUserId);

    if (change.outcome === Outcome.ASSIGNED || change.outcome === Outcome.REMOVED) {
      logger.info("Staff changed a member's country role", {
        guildId: interaction.guildId,
        staffUserId,
        userId: target.id,
        action: subcommand,
        country: country?.name,
        removedRoleIds: change.removed?.map((role) => role.id),
      });
    }

    const key = STAFF_MESSAGES[change.outcome] ?? change.outcome;
    // Name the roles actually involved: all removed ones, or the one that failed.
    const shownCountry =
      change.outcome === Outcome.REMOVED
        ? change.removed.map((role) => role.name).join(", ")
        : (change.role?.name ?? country?.name ?? "");
    const values = { member: memberMention, country: shownCountry };
    await interaction.editReply(message(key, values));
    return result(statusForOutcome(change.outcome), key, values);
  }

  const autocomplete = (interaction) => suggestCountries(interaction, { countries, logger });

  return { name: COMMAND_NAME, data: buildCountryStaffCommandData(), execute, autocomplete };
}
