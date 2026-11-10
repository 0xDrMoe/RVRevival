// Sends each Discord interaction to the right command (or button, form or menu),
// makes sure the user always gets an answer, even if it crashes, and records
// every use in the server's logs channel.
//
// Each person gets at most ACTIONS_PER_WINDOW commands, buttons and menus per
// ACTIONS_WINDOW_MS; past that they're asked to slow down and nothing runs.
// Someone mashing a role button or a command can't make the bot flood Discord
// with requests on their behalf. Forms (modals) aren't counted: they follow a
// button that already was.

import { MessageFlags } from "discord.js";
import { pickLanguage, translate } from "./i18n/i18n.js";
import { noActionLog, result, Status } from "./logs/actionLog.js";
import { commandVerdict, withGrant } from "./permissions/commandRules.js";
import { isExpiredInteractionError } from "./utils/discordErrors.js";
import { errorReference } from "./utils/errorReference.js";
import { guardAcknowledgement } from "./utils/ackWatchdog.js";
import { createRateLimiter } from "./utils/rateLimits.js";

export const ACTIONS_PER_WINDOW = 10;
export const ACTIONS_WINDOW_MS = 10_000;

// `guildSettings` holds each server's command rules (permissions/commandRules.js);
// without it every command runs as Discord allows.
// ackOptions: options for guardAcknowledgement (tests).
export function createInteractionHandler({ commands, logger, forcedLanguage, actionLog = noActionLog, guildSettings, now = Date.now, ackOptions = {} }) {
  const perUser = createRateLimiter({ limit: ACTIONS_PER_WINDOW, windowMs: ACTIONS_WINDOW_MS, now });

  // True (after telling them) when this person is going too fast.
  async function tooFast(interaction) {
    if (perUser.take(interaction.user.id)) {
      return false;
    }
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const seconds = Math.max(1, Math.ceil(perUser.waitTime(interaction.user.id) / 1000));
    await interaction
      .reply({ content: translate(language, "slowDown", { seconds }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
      .catch(() => {});
    return true;
  }
  // Buttons, forms and menus by custom ID, collected from every command.
  const components = new Map(
    [...commands.values()].flatMap((command) => Object.entries(command.components ?? {})),
  );
  // Buttons whose custom ID starts with a prefix and carries data after it
  // (role panel buttons: "rp:<panel>:<role>").
  const prefixed = [...commands.values()].flatMap((command) => Object.entries(command.componentPrefixes ?? {}));
  const componentFor = (customId) =>
    components.get(customId) ?? prefixed.find(([prefix]) => customId.startsWith(prefix))?.[1];

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

    const verdict = commandVerdict(interaction, command, guildSettings);
    if (verdict.refusal) {
      const language = pickLanguage(interaction.locale, forcedLanguage);
      await interaction
        .reply({ content: translate(language, verdict.refusal, verdict.values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
        .catch((error) => logger.warn("Couldn't tell someone a command is limited here", { error }));
      await actionLog.logCommand(interaction, result(Status.REFUSED, verdict.refusal, verdict.values));
      return;
    }
    if (verdict.grant) {
      // A role allowed this command: the command's own checks see the permission it needs.
      interaction.memberPermissions = withGrant(interaction.memberPermissions, verdict.grant);
    } else if (verdict.only !== undefined) {
      // Discord permissions don't count here: the command sees only what the bot's roles give.
      interaction.memberPermissions = withGrant(0n, verdict.only);
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
      const ref = errorReference();
      logger.error("Command crashed", {
        ref,
        command: interaction.commandName,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error,
      });
      await sendErrorReply(interaction, ref);
      await actionLog.logCommand(interaction, {
        status: Status.ERROR,
        note: `The command crashed. Search the bot's console log for ${ref}.`,
      });
      return;
    }
    await actionLog.logCommand(interaction, outcome ?? { status: Status.SUCCESS });
  }

  async function handleComponent(interaction) {
    const component = componentFor(interaction.customId);
    if (!component) {
      // Buttons on old messages can outlive the feature that posted them.
      logger.warn("Got a button or form the bot doesn't know", { customId: interaction.customId });
      await sendErrorReply(interaction);
      return;
    }
    const action = { label: component.label };

    let outcome;
    try {
      outcome = await component.handle(interaction);
    } catch (error) {
      if (isExpiredInteractionError(error)) {
        logger.warn("The interaction expired before the bot could answer", { customId: interaction.customId });
        await actionLog.logCommand(interaction, {
          status: Status.FAILED,
          note: "Discord cancelled the request before the bot could answer.",
          action,
        });
        return;
      }
      const ref = errorReference();
      logger.error("Button or form crashed", {
        ref,
        customId: interaction.customId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error,
      });
      await sendErrorReply(interaction, ref);
      await actionLog.logCommand(interaction, {
        status: Status.ERROR,
        note: `It crashed. Search the bot's console log for ${ref}.`,
        action,
      });
      return;
    }
    // Intermediate steps (opening the form, showing the list) return nothing.
    if (outcome) {
      await actionLog.logCommand(interaction, { action, ...outcome });
    }
  }

  // Shows the generic "something went wrong" message, never error details.
  // With a reference, the message gives it so staff can find the log line.
  async function sendErrorReply(interaction, ref = null) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const content = ref ? translate(language, "unexpectedRef", { ref }) : translate(language, "unexpected");
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

  async function dispatch(interaction) {
    if (interaction.isChatInputCommand()) {
      if (!(await tooFast(interaction))) {
        await handleCommand(interaction);
      }
    } else if (interaction.isContextMenuCommand?.()) {
      // Right-click apps (commands/contextMenus.js) go through the same checks.
      if (!(await tooFast(interaction))) {
        await handleCommand(interaction);
      }
    } else if (interaction.isModalSubmit?.()) {
      await handleComponent(interaction);
    } else if (interaction.isButton() || interaction.isAnySelectMenu()) {
      if (!(await tooFast(interaction))) {
        await handleComponent(interaction);
      }
    }
  }

  return async function handleInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    // Work that waits on Discord's rate limits can't make the interaction fail.
    const stop = guardAcknowledgement(interaction, { logger, ...ackOptions });
    try {
      await dispatch(interaction);
    } finally {
      stop();
    }
  };
}
