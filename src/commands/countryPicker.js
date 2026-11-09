// The guide's buttons, the no-slash-command way to get a country role.
//
// /country-help posts the guide with one button per continent and a "Type my
// country" button.
//   - A continent button privately shows that continent's countries in
//     alphabetical lists (25 per list, Discord's limit); the member picks theirs.
//   - "Type my country" opens a small form. An exact match ("Germany", "USA")
//     gives the role right away; otherwise the bot shows close matches to pick.
//
// Servers that pick continents and regions instead of countries (see
// countries/options.js) get the same continent buttons, and a click gives that
// region's role. There's no "Type my country" button then. Places the server
// took off its list have no button and aren't listed.
//
// The same rules as /country apply: one country per member, and only staff can
// change it afterwards, unless the server lets members remove their own role
// ("Remove my country" button). Every custom ID is fixed, so buttons on old
// messages keep working after the bot restarts.

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
import { kindOf, normalizeCountryOptions, PlaceKind, PlaceMode, placesFor, REGION_KEYS, regionList } from "../countries/options.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status, statusForOutcome } from "../logs/actionLog.js";
import { Outcome } from "../roles/countryRoles.js";
import { Setting } from "../settings/guildSettings.js";

export const PickerId = Object.freeze({
  BUTTON: "country-picker:open",
  FORM: "country-picker:form",
  FORM_INPUT: "country",
  // Followed by the continent ("country-picker:continent:europe").
  CONTINENT: "country-picker:continent:",
  // Followed by the list's number, since IDs must be unique within a message.
  LIST: "country-picker:list:",
  // Confirm, under "Pick X?" (with confirmations on), followed by the country's code.
  CONFIRM: "country-picker:confirm:",
  // "Remove my country", and Confirm under "Remove X?".
  REMOVE: "country-picker:remove",
  REMOVE_CONFIRM: "country-picker:remove-confirm",
});

// Discord shows at most 25 options in a select menu, and 5 rows in a message.
export const MAX_CHOICES = 25;
export const MAX_LISTS = 5;

// How the picker shows up in the logs channel.
const LOG_LABEL = "Country picker buttons";

export const CONTINENT_EMOJI = {
  africa: "🌍",
  asia: "🌏",
  europe: "🌍",
  "north-america": "🌎",
  "south-america": "🌎",
  oceania: "🌏",
};

// Region roles get their own wording where the country wording would be wrong.
const REGION_MESSAGES = {
  [Outcome.ASSIGNED]: "regionAssigned",
  [Outcome.LOCKED]: "regionLocked",
  invalidCountry: "invalidRegion",
};

// The translation key for an outcome, for a place of `kind`. `removable`: the
// server lets members remove their own role, so "locked" says how.
export function placeMessageKey(outcome, kind, removable = false) {
  if (outcome === Outcome.LOCKED && removable) {
    return "placeLockedRemovable";
  }
  return (kind === PlaceKind.REGION && REGION_MESSAGES[outcome]) || outcome;
}

// The "Type my country" button. `labelKey` lets the "no match" reply reuse it as "Try again".
function typeButton(language, labelKey = "pickButtonLabel") {
  return new ButtonBuilder()
    .setCustomId(PickerId.BUTTON)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔎")
    .setLabel(translate(language, labelKey));
}

// "Remove my country" (or region).
function removeButton(language, mode) {
  return new ButtonBuilder()
    .setCustomId(PickerId.REMOVE)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🗑️")
    .setLabel(translate(language, mode === PlaceMode.REGIONS ? "pickRemoveRegionLabel" : "pickRemoveLabel"));
}

export function buildTryAgainRow(language) {
  return new ActionRowBuilder().addComponents(typeButton(language, "pickTryAgainLabel"));
}

// The continents that get a button: in regions mode the regions the server
// offers, else the continents with at least one country it offers.
export function offeredContinents(saved, lists) {
  const options = normalizeCountryOptions(saved);
  const offered = placesFor(options, lists).countries;
  if (options.mode === PlaceMode.REGIONS) {
    const codes = new Set(offered.map((region) => region.code));
    return CONTINENTS.filter((continent) => codes.has(continent));
  }
  const used = new Set(offered.map((country) => continentOf(country.code)));
  return CONTINENTS.filter((continent) => used.has(continent));
}

// The buttons under the guide: continents in up to two rows, then "Type my
// country" (countries only), "Remove my country" (when the server allows it)
// and any `extra` buttons (the guide's "Translate this message"). `saved` is
// the server's Setting.COUNTRY_ROLES.
export function buildGuideRows(language, saved = undefined, extra = [], lists = undefined) {
  const options = normalizeCountryOptions(saved);
  const continentButton = (continent) =>
    new ButtonBuilder()
      .setCustomId(PickerId.CONTINENT + continent)
      .setStyle(ButtonStyle.Primary)
      .setEmoji(CONTINENT_EMOJI[continent])
      .setLabel(translate(language, REGION_KEYS[continent]));
  const continents = offeredContinents(options, lists);
  const half = continents.length <= 3 ? continents.length : Math.ceil(continents.length / 2);
  const tools = [
    ...(options.mode === PlaceMode.COUNTRIES ? [typeButton(language)] : []),
    ...(options.memberRemove ? [removeButton(language, options.mode)] : []),
    ...extra,
  ];
  return [continents.slice(0, half), continents.slice(half)]
    .map((row) => row.map(continentButton))
    .concat([tools])
    .filter((buttons) => buttons.length > 0)
    .map((buttons) => new ActionRowBuilder().addComponents(buttons));
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
//   guildSettings    per-server settings, for what members can pick (Setting.COUNTRY_ROLES)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
//   confirmations    roles/roleConfirmations.js; without it, a pick gives the role right away
//   regions          the region list, replaceable in tests
//
// Returns { components, componentPrefixes }: { [customId]: { label, handle(interaction) } }.
// handle() returns what to log, or null for steps that aren't worth a log entry (opening the form).
export function createCountryPicker({
  countries,
  roleService,
  wrapServer,
  wrapMember,
  guildSettings,
  forcedLanguage,
  confirmations,
  regions = regionList,
}) {
  const languageOf = (interaction) => pickLanguage(interaction.locale, forcedLanguage);
  const logged = (outcome, fields = {}) => ({ ...outcome, action: { label: LOG_LABEL, fields } });
  const optionsOf = (interaction) => normalizeCountryOptions(guildSettings?.get(interaction.guildId, Setting.COUNTRY_ROLES));
  const placesOf = (options) => placesFor(options, { countries, regions });
  const kindFor = (options) => (options.mode === PlaceMode.REGIONS ? PlaceKind.REGION : PlaceKind.COUNTRY);
  const serverOf = (interaction) => wrapServer(interaction.guild);
  const memberOf = (interaction) => wrapMember(interaction.member);

  async function refuseOutsideServer(interaction) {
    await interaction.reply({ content: translate(languageOf(interaction), "guildOnly"), flags: MessageFlags.Ephemeral });
    return logged(result(Status.REFUSED, "guildOnly"));
  }

  // The "Remove my country" button, under a "you already have X" reply.
  const removeRows = (language, options) => (options.memberRemove ? [new ActionRowBuilder().addComponents(removeButton(language, options.mode))] : []);

  // Gives the role and returns the reply (text and buttons) and log entry.
  async function giveRole(interaction, place, language, options, fields) {
    const { outcome, role } = await roleService.giveCountryRole(serverOf(interaction), memberOf(interaction), place);
    const values = { country: outcome === Outcome.LOCKED ? role.name : place.name };
    const key = placeMessageKey(outcome, kindOf(place), options.memberRemove);
    return {
      reply: { content: translate(language, key, values), components: outcome === Outcome.LOCKED ? removeRows(language, options) : [] },
      outcome: logged(result(statusForOutcome(outcome), outcome, values), { ...fields, country: place.name }),
    };
  }

  // Members who already have a country are told as soon as they click, instead
  // of picking for nothing. Returns what to log, or null if they can pick.
  async function refuseIfLocked(interaction, language, options) {
    const [held] = roleService.heldCountryRoles(serverOf(interaction), memberOf(interaction), [kindFor(options)]);
    if (!held) {
      return null;
    }
    const values = { country: held.name };
    const key = placeMessageKey(Outcome.LOCKED, kindFor(options), options.memberRemove);
    const rows = removeRows(language, options);
    await interaction.reply({ content: translate(language, key, values), ...(rows.length > 0 ? { components: rows } : {}), flags: MessageFlags.Ephemeral });
    return logged(result(Status.REFUSED, Outcome.LOCKED, values));
  }

  // Not on the server's list (taken off after the guide was posted, say).
  async function refuseNotOffered(interaction, language, name, { replied = true } = {}) {
    const content = translate(language, "placeNotOffered", { country: name });
    if (replied) {
      await interaction.editReply({ content, components: [] });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return logged(result(Status.REFUSED, "placeNotOffered", { country: name }));
  }

  // A continent button: that continent's countries, privately. When the server
  // picks regions, the region's role instead.
  async function showContinent(interaction, continent) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    const options = optionsOf(interaction);
    const refused = await refuseIfLocked(interaction, language, options);
    if (refused) {
      return refused;
    }
    const continentName = translate(language, REGION_KEYS[continent]);
    const places = placesOf(options);

    if (options.mode === PlaceMode.REGIONS) {
      const region = places.countries.find((place) => place.code === continent);
      if (!region) {
        return refuseNotOffered(interaction, language, continentName, { replied: false });
      }
      // Role changes can take longer than the 3 seconds Discord waits.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (await askFirst(interaction, region, language, options)) {
        return null;
      }
      const { reply, outcome } = await giveRole(interaction, region, language, options);
      await interaction.editReply(reply);
      return outcome;
    }

    const inContinent = places.countries.filter((country) => continentOf(country.code) === continent);
    if (inContinent.length === 0) {
      return refuseNotOffered(interaction, language, continentName, { replied: false });
    }
    await interaction.reply({
      content: translate(language, "pickContinentChoose", { continent: continentName }),
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
    const refused = await refuseIfLocked(interaction, language, optionsOf(interaction));
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
    const options = optionsOf(interaction);
    const places = placesOf(options);
    // Role changes can take longer than the 3 seconds Discord waits.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const typed = interaction.fields.getTextInputValue(PickerId.FORM_INPUT) ?? "";
    const place = places.find(typed);
    if (place) {
      if (await askFirst(interaction, place, language, options)) {
        return null;
      }
      const { reply, outcome } = await giveRole(interaction, place, language, options, { typed });
      await interaction.editReply(reply);
      return outcome;
    }
    // A real country the server took off its list.
    const known = options.mode === PlaceMode.COUNTRIES ? countries.find(typed) : regions.find(typed);
    if (known) {
      return refuseNotOffered(interaction, language, known.name);
    }

    const matches = places.search(typed, MAX_CHOICES);
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
    const options = optionsOf(interaction);
    await interaction.deferUpdate();

    // The list only holds valid names, but the value still comes from the client.
    const typed = interaction.values?.[0];
    const place = placesOf(options).find(typed);
    if (!place) {
      const known = countries.find(typed) ?? regions.find(typed);
      if (known) {
        return refuseNotOffered(interaction, language, known.name);
      }
      await interaction.editReply({ content: translate(language, "invalidCountry"), components: [] });
      return logged(result(Status.REFUSED, "invalidCountry"));
    }
    if (await askFirst(interaction, place, language, options)) {
      return null;
    }
    const { reply, outcome } = await giveRole(interaction, place, language, options);
    await interaction.editReply(reply);
    return outcome;
  }

  // With confirmations on, replaces the reply with "Pick X?" and Confirm, and
  // returns true. The question says whether the pick can be undone.
  async function askFirst(interaction, place, language, options) {
    if (!confirmations?.isOn(interaction.guildId, interaction.user.id)) {
      return false;
    }
    const key = options.memberRemove ? "roleConfirmPlaceRemovable" : kindOf(place) === PlaceKind.REGION ? "roleConfirmRegion" : "roleConfirmCountry";
    await interaction.editReply({
      content: translate(language, key, { country: place.name }),
      components: [confirmations.promptRow(language, PickerId.CONFIRM + place.code)],
    });
    return true;
  }

  // Confirm, under "Pick X?".
  async function confirmChoice(interaction) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    const options = optionsOf(interaction);
    await interaction.deferUpdate();
    const code = interaction.customId.slice(PickerId.CONFIRM.length);
    const place = placesOf(options).countries.find((entry) => entry.code === code);
    if (!place) {
      const known = [...countries.countries, ...regions.countries].find((entry) => entry.code === code);
      if (known) {
        return refuseNotOffered(interaction, language, known.name);
      }
      await interaction.editReply({ content: translate(language, "invalidCountry"), components: [] });
      return logged(result(Status.REFUSED, "invalidCountry"));
    }
    const { reply, outcome } = await giveRole(interaction, place, language, options);
    await interaction.editReply(reply);
    return outcome;
  }

  // "Remove my country": the member takes their own role off, when the server
  // allows it. Asks first when confirmations are on.
  async function removeOwn(interaction, { confirmed = false } = {}) {
    if (!interaction.inCachedGuild()) {
      return refuseOutsideServer(interaction);
    }
    const language = languageOf(interaction);
    const options = optionsOf(interaction);
    // The button can be on a private reply (changed in place) or on the guide
    // (answered privately). Role changes can take longer than 3 seconds.
    if (confirmed || interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const answer = (message) => interaction.editReply({ components: [], ...message });
    if (!options.memberRemove) {
      await answer({ content: translate(language, "selfRemoveOff") });
      return logged(result(Status.REFUSED, "selfRemoveOff"));
    }
    const kinds = [kindFor(options)];
    const held = roleService.heldCountryRoles(serverOf(interaction), memberOf(interaction), kinds);
    if (held.length === 0) {
      await answer({ content: translate(language, "selfNothingToRemove") });
      return logged(result(Status.REFUSED, "selfNothingToRemove"));
    }
    const names = held.map((role) => role.name).join(", ");
    if (!confirmed && confirmations?.isOn(interaction.guildId, interaction.user.id)) {
      await answer({
        content: translate(language, "roleConfirmSelfRemove", { country: names }),
        components: [confirmations.promptRow(language, PickerId.REMOVE_CONFIRM, { danger: true })],
      });
      return null;
    }
    const change = await roleService.removeCountryRoles(serverOf(interaction), memberOf(interaction), undefined, kinds);
    const key = change.outcome === Outcome.REMOVED ? "selfRemoved" : change.outcome === Outcome.NOTHING_TO_REMOVE ? "selfNothingToRemove" : change.outcome;
    const values = { country: change.outcome === Outcome.REMOVED ? change.removed.map((role) => role.name).join(", ") : (change.role?.name ?? names), member: `<@${interaction.user.id}>` };
    await answer({ content: translate(language, key, values), allowedMentions: { parse: [] } });
    return logged(result(statusForOutcome(change.outcome), key, values));
  }

  const handler = (handle) => ({ label: LOG_LABEL, handle });
  const components = {
    [PickerId.BUTTON]: handler(openForm),
    [PickerId.FORM]: handler(readForm),
    [PickerId.REMOVE]: handler((interaction) => removeOwn(interaction)),
    [PickerId.REMOVE_CONFIRM]: handler((interaction) => removeOwn(interaction, { confirmed: true })),
    ...Object.fromEntries(
      CONTINENTS.map((continent) => [
        PickerId.CONTINENT + continent,
        handler((interaction) => showContinent(interaction, continent)),
      ]),
    ),
    ...Object.fromEntries(Array.from({ length: MAX_LISTS }, (_, index) => [PickerId.LIST + index, handler(readChoice)])),
  };
  return { components, componentPrefixes: { [PickerId.CONFIRM]: handler(confirmChoice) } };
}
