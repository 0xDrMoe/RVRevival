// Highlights: get a DM when someone says one of your words.
//
//   /highlight add word      add a word (up to 10)
//   /highlight remove word   remove one
//   /highlight list          your words
//   /highlight clear         remove all of them
//
// Everyone can use it. See highlights/highlights.js.

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { normalizeWord } from "../highlights/highlights.js";
import { MAX_HIGHLIGHTS, MAX_WORD_LENGTH, MIN_WORD_LENGTH } from "../highlights/highlightStore.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "highlight";

export function buildHighlightCommandData() {
  const wordOption = (option) => withDescription(option.setName("word"), "highlightWordOptionDescription").setRequired(true).setMinLength(MIN_WORD_LENGTH).setMaxLength(MAX_WORD_LENGTH);
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "highlightCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("add"), "highlightAddDescription").addStringOption(wordOption))
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "highlightRemoveDescription").addStringOption((option) => wordOption(option).setAutocomplete(true)))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "highlightListDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("clear"), "highlightClearDescription"))
    .toJSON();
}

// Options: store (highlights/highlightStore.js), highlights (highlights/highlights.js), forcedLanguage
export function createHighlightCommand({ store, highlights, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: translate(language, key, values), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const { guildId } = interaction;
    const userId = interaction.user.id;
    switch (interaction.options.getSubcommand()) {
      case "add": {
        const word = normalizeWord(interaction.options.getString("word", true));
        if (!word) {
          return answer(Status.REFUSED, "highlightBadWord", { min: MIN_WORD_LENGTH, max: MAX_WORD_LENGTH });
        }
        const words = store.words(guildId, userId);
        if (words.includes(word)) {
          return answer(Status.REFUSED, "highlightAlready", { word });
        }
        if (words.length >= MAX_HIGHLIGHTS) {
          return answer(Status.REFUSED, "highlightFull", { max: MAX_HIGHLIGHTS });
        }
        store.add(guildId, userId, word);
        highlights?.changed(guildId);
        return answer(Status.SUCCESS, "highlightAdded", { word });
      }
      case "remove": {
        const word = normalizeWord(interaction.options.getString("word", true));
        if (!word || !store.remove(guildId, userId, word)) {
          return answer(Status.REFUSED, "highlightNotFound", { word: word ?? "" });
        }
        highlights?.changed(guildId);
        return answer(Status.SUCCESS, "highlightRemoved", { word });
      }
      case "list": {
        const words = store.words(guildId, userId);
        if (words.length === 0) {
          return answer(Status.SUCCESS, "highlightListEmpty");
        }
        return answer(Status.SUCCESS, "highlightList", { count: words.length, max: MAX_HIGHLIGHTS, list: words.map((word) => `\`${word}\``).join(", ") });
      }
      case "clear": {
        const removed = store.clear(guildId, userId);
        highlights?.changed(guildId);
        return answer(Status.SUCCESS, "highlightCleared", { count: removed });
      }
    }
    return undefined;
  }

  // Suggests your own words for /highlight remove.
  async function autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const words = interaction.guildId ? store.words(interaction.guildId, interaction.user.id) : [];
    await interaction.respond(
      words
        .filter((word) => word.includes(typed))
        .slice(0, 25)
        .map((word) => ({ name: word, value: word })),
    );
  }

  return { name: COMMAND_NAME, data: buildHighlightCommandData(), execute, autocomplete };
}
