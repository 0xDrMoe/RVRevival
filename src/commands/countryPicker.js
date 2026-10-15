// The "Pick my country" button, the no-slash-command way to get a country role.
//
//   1. /country-help posts the guide with a "Pick my country" button.
//   2. Clicking it opens a small form where the member types their country.
//   3. An exact match ("Germany", "USA") gives the role right away. Otherwise
//      the bot privately shows a list of close matches to pick from.
//
// The same rules as /country apply: one country per member, and only staff can
// change it afterwards. Every custom ID is fixed, so buttons on old messages
// keep working after the bot restarts.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { MAX_NAME_LENGTH } from "../countries/countries.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status, statusForOutcome } from "../logs/actionLog.js";
import { Outcome } from "../roles/countryRoles.js";

export const PickerId = Object.freeze({
  BUTTON: "country-picker:open",
  FORM: "country-picker:form",
  FORM_INPUT: "country",
  LIST: "country-picker:list",
});

// Discord shows at most 25 options in a select menu.
export const MAX_CHOICES = 25;

// How the picker shows up in the logs channel.
const LOG_LABEL = "Pick my country button";

// The button row under the guide. `labelKey` lets the "no match" reply reuse it as "Try again".
export function buildPickButtonRow(language, labelKey = "pickButtonLabel") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PickerId.BUTTON)
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🌍")
      .setLabel(translate(language, labelKey)),
  );
}

export function buildPickForm(language) {
  return new ModalBuilder()
    .setCustomId(PickerId.FORM)
    .setTitle(translate(language, "pickFormTitle"))
    .addLabelComponents(
      new LabelBuilder().setLabel(translate(language, "pickFormLabel")).setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(PickerId.FORM_INPUT)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(translate(language, "pickFormPlaceholder"))
          .setRequired(true)
          .setMaxLength(MAX_NAME_LENGTH),
      ),
    );
}

export function buildChoiceRow(language, countries) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(PickerId.LIST)
      .setPlaceholder(translate(language, "pickListPlaceholder"))
      .addOptions(countries.slice(0, MAX_CHOICES).map((country) => ({ label: country.name, value: country.name }))),
  );
}

// Options:
//   countries, roleService, wrapServer, wrapMember   shared with /country
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
//
// Returns { [customId]: { label, handle(interaction) } }. handle() returns what
// to log, or null for steps that aren't worth a log entry (opening the form).
export function createCountryPicker({ countries, roleService, wrapServer, wrapMember, forcedLanguage }) {
  const languageOf = (interaction) => pickLanguage(interaction.locale, forcedLanguage);
  const logged = (outcome, fields = {}) => ({ ...outcome, action: { label: LOG_LABEL, fields } });

  async function refuseOutsideServer(interaction) {
    await interaction.reply({ content: translate(languageOf(interaction), "guildOnly"), flags: MessageFlags.Ephemeral });
    return logged(result(Status.REFUSED, "guildOnly"));
  }

  // Gives the role and returns the reply text and log entry.
  async function giveRole(interaction, country, language, fields) {
    const { outcome, role } = await roleService.giveCountryRole(
      wrapServer(interaction.guild),
      wrapMember(interaction.member),
      country,
    );
    const values = { country: outcome === Outcome.LOCKED ? role.name : country.name };
    return {
      content: translate(language, outcome, values),
      outcome: logged(result(statusForOutcome(outcome), outcome, values), { ...fields, country: country.name }),
    };
  }

  // Step 1: the button. Members who already have a country are told right away
  // instead of filling in the form for nothing.
  async function openForm(interaction) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    const [held] = roleService.heldCountryRoles(wrapServer(interaction.guild), wrapMember(interaction.member));
    if (held) {
      const values = { country: held.name };
      await interaction.reply({ content: translate(language, Outcome.LOCKED, values), flags: MessageFlags.Ephemeral });
      return logged(result(Status.REFUSED, Outcome.LOCKED, values));
    }
    await interaction.showModal(buildPickForm(language));
    return null;
  }

  // Step 2: what they typed.
  async function readForm(interaction) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    // Role changes can take longer than the 3 seconds Discord waits.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const typed = interaction.fields.getTextInputValue(PickerId.FORM_INPUT) ?? "";
    const country = countries.find(typed);
    if (country) {
      const { content, outcome } = await giveRole(interaction, country, language, { typed });
      await interaction.editReply({ content });
      return outcome;
    }

    const matches = countries.search(typed, MAX_CHOICES);
    if (matches.length === 0) {
      await interaction.editReply({
        content: translate(language, "pickNoMatch"),
        components: [buildPickButtonRow(language, "pickTryAgainLabel")],
      });
      return logged(result(Status.REFUSED, "pickNoMatch"), { typed });
    }
    // Never guess: even a single close match is shown for them to confirm.
    await interaction.editReply({
      content: translate(language, "pickChoose"),
      components: [buildChoiceRow(language, matches)],
    });
    return null;
  }

  // Step 3: the country they chose from the list of close matches.
  async function readChoice(interaction) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    await interaction.deferUpdate();

    // The list only holds valid names, but the value still comes from the client.
    const country = countries.find(interaction.values?.[0]);
    if (!country) {
      await interaction.editReply({ content: translate(language, "invalidCountry"), components: [] });
      return logged(result(Status.REFUSED, "invalidCountry"));
    }
    const { content, outcome } = await giveRole(interaction, country, language);
    await interaction.editReply({ content, components: [] });
    return outcome;
  }

  return {
    [PickerId.BUTTON]: { label: LOG_LABEL, handle: openForm },
    [PickerId.FORM]: { label: LOG_LABEL, handle: readForm },
    [PickerId.LIST]: { label: LOG_LABEL, handle: readChoice },
  };
}
