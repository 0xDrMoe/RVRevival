// Every slash command the bot has. To add a command, create a file like
// country.js and add it to the list below.

import { CountryRoleService } from "../roles/countryRoles.js";
import { createCountryCommand } from "./country.js";
import { createCountryHelpCommand } from "./countryHelp.js";
import { createCountryStaffCommand } from "./countryStaff.js";
import { createSettingsCommand } from "./settings.js";

// Each command is { name, data, execute(interaction), autocomplete?(interaction) }.
export function createCommands({ logger, guildSettings, forcedLanguage }) {
  // Shared, so /country and /country-staff can't change the same member at the same time.
  const roleService = new CountryRoleService(logger);
  const commands = [
    createCountryCommand({ logger, guildSettings, forcedLanguage, roleService }),
    createCountryStaffCommand({ logger, guildSettings, forcedLanguage, roleService }),
    createCountryHelpCommand({ guildSettings, forcedLanguage }),
    createSettingsCommand({ guildSettings, forcedLanguage }),
  ];
  return new Map(commands.map((command) => [command.name, command]));
}
