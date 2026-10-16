// /afk [message]: say you're away. Mentions of you get an answer with your
// message, and your next message marks you back. See afk/afk.js.

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { MAX_AFK_MESSAGE_LENGTH } from "../afk/afk.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "afk";

export function buildAfkCommandData() {
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "afkCommandDescription")
    .addStringOption((option) => withDescription(option.setName("message"), "afkMessageOptionDescription").setMaxLength(MAX_AFK_MESSAGE_LENGTH))
    .toJSON();
}

// Options: afk (afk/afk.js), forcedLanguage
export function createAfkCommand({ afk, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: translate(language, key, values), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    // Mentions and line breaks would make the notices noisy.
    const message =
      interaction.options
        .getString("message")
        ?.replace(/\s+/g, " ")
        .replace(/@(everyone|here)/g, "@​$1")
        .trim()
        .slice(0, MAX_AFK_MESSAGE_LENGTH) || null;
    await afk.setAway(interaction.member, message);
    return answer(Status.SUCCESS, message ? "afkSet" : "afkSetNoMessage", { message: message ?? "" });
  }

  return { name: COMMAND_NAME, data: buildAfkCommandData(), execute };
}
