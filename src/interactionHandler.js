// Sends each Discord interaction to the right command, makes sure the user
// always gets an answer, even if the command crashes, and records every command
// use in the server's logs channel.

import { MessageFlags } from "discord.js";
import { pickLanguage, translate } from "./i18n/i18n.js";
import { noActionLog, Status } from "./logs/actionLog.js";
import { isExpiredInteractionError } from "./utils/discordErrors.js";

export function createInteractionHandler({ commands, logger, forcedLanguage, actionLog = noActionLog }) {
  async function handleAutocomplete(interaction) {
    const command = commands.get(interaction.commandName);
    try {
      if (command?.autocomplete) {
        await command.autocomplete(interaction);
        return;
      }
    } catch (error) {
      logger.error("Autocomplete crashed", { command: interaction.commandName, error });
    }
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => {});
    }
  }

  async function handleCommand(interaction) {
    const command = commands.get(interaction.commandName);
    if (!command) {
      logger.warn("Got a command the bot doesn't know. Re-run `npm run register`.", {
        command: interaction.commandName,
      });
      await sendErrorReply(interaction);
      await actionLog.logCommand(interaction, {
        status: Status.ERROR,
        note: "The bot doesn't know this command. Re-run `npm run register`.",
      });
      return;
    }

    let outcome;
    try {
      outcome = await command.execute(interaction);
    } catch (error) {
      if (isExpiredInteractionError(error)) {
        logger.warn("The interaction expired before the bot could answer", { command: interaction.commandName });
        await actionLog.logCommand(interaction, {
          status: Status.FAILED,
          note: "Discord cancelled the command before the bot could answer.",
        });
        return;
      }
      logger.error("Command crashed", {
        command: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error,
      });
      await sendErrorReply(interaction);
      await actionLog.logCommand(interaction, {
        status: Status.ERROR,
        note: "The command crashed. The details are in the bot's console log.",
      });
      return;
    }
    await actionLog.logCommand(interaction, outcome ?? { status: Status.SUCCESS });
  }

  // Shows the generic "something went wrong" message, never error details.
  async function sendErrorReply(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const content = translate(language, "unexpected");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.warn("Couldn't send the error message to the user", { error });
    }
  }

  return async function handleInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    }
  };
}
