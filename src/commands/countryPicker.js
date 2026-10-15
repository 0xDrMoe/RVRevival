// The guide's buttons, the no-slash-command way to get a country role.
//
// /country-help posts the guide with one button per continent and a "Type my
// country" button.
//   - A continent button privately shows that continent's countries in
//     alphabetical lists (25 per list, Discord's limit); the member picks theirs.
//   - "Type my country" opens a small form. An exact match ("Germany", "USA")
//     gives the role right away; otherwise the bot shows close matches to pick.
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
import { CONTINENTS, continentOf } from "../countries/continents.js";
import { MAX_NAME_LENGTH, normalizeName } from "../countries/countries.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status, statusForOutcome } from "../logs/actionLog.js";
import { Outcome } from "../roles/countryRoles.js";

export const PickerId = Object.freeze({
  BUTTON: "country-picker:open",
  FORM: "country-picker:form",
  FORM_INPUT: "country",
  // Followed by the continent ("country-picker:continent:europe").
  CONTINENT: "country-picker:continent:",
  // Followed by the list's number, since IDs must be unique within a message.
  LIST: "country-picker:list:",
});

// Discord shows at most 25 options in a select menu, and 5 rows in a message.
export const MAX_CHOICES = 25;
export const MAX_LISTS = 5;

// How the picker shows up in the logs channel.
const LOG_LABEL = "Country picker buttons";

const CONTINENT_KEYS = {
  africa: "continentAfrica",
  asia: "continentAsia",
  europe: "continentEurope",
  "north-america": "continentNorthAmerica",
  "south-america": "continentSouthAmerica",
  oceania: "continentOceania",
};

const CONTINENT_EMOJI = {
  africa: "🌍",
  asia: "🌏",
  europe: "🌍",
  "north-america": "🌎",
  "south-america": "🌎",
  oceania: "🌏",
};

// The "Type my country" button. `labelKey` lets the "no match" reply reuse it as "Try again".
function typeButton(language, labelKey = "pickButtonLabel") {
  return new ButtonBuilder()
    .setCustomId(PickerId.BUTTON)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔎")
    .setLabel(translate(language, labelKey));
}

export function buildTryAgainRow(language) {
  return new ActionRowBuilder().addComponents(typeButton(language, "pickTryAgainLabel"));
}

// The buttons under the guide: continents in two rows of three, then "Type my country".
export function buildGuideRows(language) {
  const continentButton = (continent) =>
    new ButtonBuilder()
      .setCustomId(PickerId.CONTINENT + continent)
      .setStyle(ButtonStyle.Primary)
      .setEmoji(CONTINENT_EMOJI[continent])
      .setLabel(translate(language, CONTINENT_KEYS[continent]));
  const half = Math.ceil(CONTINENTS.length / 2);
  return [
    new ActionRowBuilder().addComponents(CONTINENTS.slice(0, half).map(continentButton)),
    new ActionRowBuilder().addComponents(CONTINENTS.slice(half).map(continentButton)),
    new ActionRowBuilder().addComponents(typeButton(language)),
  ];
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

// "A", for the "A–E" range shown on a list. Ignores accents ("Åland" is under A).
const initialOf = (country) => normalizeName(country.name).charAt(0).toUpperCase();

// The countries as alphabetical lists of at most 25, split evenly.
export function buildChoiceRows(language, countries) {
  const lists = Math.min(Math.ceil(countries.length / MAX_CHOICES), MAX_LISTS);
  const perList = Math.ceil(countries.length / lists);
  return Array.from({ length: lists }, (_, index) => {
    const chunk = countries.slice(index * perList, (index + 1) * perList).slice(0, MAX_CHOICES);
    const range = `${initialOf(chunk[0])}–${initialOf(chunk.at(-1))}`;
    const placeholder =
      lists > 1 ? translate(language, "pickListRangePlaceholder", { range }) : translate(language, "pickListPlaceholder");
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(PickerId.LIST + index)
        .setPlaceholder(placeholder)
        .addOptions(chunk.map((country) => ({ label: country.name, value: country.name }))),
    );
  });
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

  // Members who already have a country are told as soon as they click, instead
  // of picking for nothing. Returns what to log, or null if they can pick.
  async function refuseIfLocked(interaction, language) {
    const [held] = roleService.heldCountryRoles(wrapServer(interaction.guild), wrapMember(interaction.member));
    if (!held) {
      return null;
    }
    const values = { country: held.name };
    await interaction.reply({ content: translate(language, Outcome.LOCKED, values), flags: MessageFlags.Ephemeral });
    return logged(result(Status.REFUSED, Outcome.LOCKED, values));
  }

  // A continent button: that continent's countries, privately.
  async function showContinent(interaction, continent) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    const refused = await refuseIfLocked(interaction, language);
    if (refused) {
      return refused;
    }
    const inContinent = countries.countries.filter((country) => continentOf(country.code) === continent);
    await interaction.reply({
      content: translate(language, "pickContinentChoose", { continent: translate(language, CONTINENT_KEYS[continent]) }),
      components: buildChoiceRows(language, inContinent),
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  // "Type my country": opens the form.
  async function openForm(interaction) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    const refused = await refuseIfLocked(interaction, language);
    if (refused) {
      return refused;
    }
    await interaction.showModal(buildPickForm(language));
    return null;
  }

  // What they typed in the form.
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
        components: [buildTryAgainRow(language)],
      });
      return logged(result(Status.REFUSED, "pickNoMatch"), { typed });
    }
    // Never guess: even a single close match is shown for them to confirm.
    await interaction.editReply({
      content: translate(language, "pickChoose"),
      components: buildChoiceRows(language, matches),
    });
    return null;
  }

  // The country they chose from a list (a continent's countries or close matches).
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

  const handler = (handle) => ({ label: LOG_LABEL, handle });
  return {
    [PickerId.BUTTON]: handler(openForm),
    [PickerId.FORM]: handler(readForm),
    ...Object.fromEntries(
      CONTINENTS.map((continent) => [
        PickerId.CONTINENT + continent,
        handler((interaction) => showContinent(interaction, continent)),
      ]),
    ),
    ...Object.fromEntries(Array.from({ length: MAX_LISTS }, (_, index) => [PickerId.LIST + index, handler(readChoice)])),
  };
}
