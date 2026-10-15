// Every slash command the bot has. To add a command, create a file like
// country.js and add it to the list below.

import { createCountryCommand } from "./country.js";
import { createCountryChannelCommand } from "./countryChannel.js";
import { createCountryHelpCommand } from "./countryHelp.js";

// Each command is { name, data, execute(interaction), autocomplete?(interaction) }.
export function createCommands({ logger, channelSettings, forcedLanguage }) {
  const commands = [
    createCountryCommand({ logger, channelSettings, forcedLanguage }),
    createCountryChannelCommand({ channelSettings, forcedLanguage }),
    createCountryHelpCommand({ channelSettings, forcedLanguage }),
  ];
  return new Map(commands.map((command) => [command.name, command]));
}
