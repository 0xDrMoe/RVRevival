// Every slash command the bot has. To add a command, create a file like
// country.js and add it to the list below.

import { CountryRoleService } from "../roles/countryRoles.js";
import { createCaseCommand, createClearWarnsCommand, createModlogsCommand } from "./cases.js";
import { createChannelToolCommands } from "./channelTools.js";
import { createCountryCommand } from "./country.js";
import { createCountryHelpCommand } from "./countryHelp.js";
import { createCountryStaffCommand } from "./countryStaff.js";
import { createGiveawayCommand } from "./giveaway.js";
import { createMemberToolCommands } from "./memberTools.js";
import { createModerationCommands } from "./moderation.js";
import { createPurgeCommand } from "./purge.js";
import { createRemindCommand } from "./remind.js";
import { createRolePanelCommand } from "./rolePanel.js";
import { createSettingsCommand } from "./settings.js";
import { createTagCommands } from "./tags.js";
import { createWelcomeCommand } from "./welcome.js";

// Each command is { name, data, execute(interaction), autocomplete?(interaction),
// components?, componentPrefixes? }. `components` maps a button, form or menu
// custom ID to { label, handle(interaction) } (see countryPicker.js);
// `componentPrefixes` does the same for IDs that start with a prefix (rolePanel.js).
//
// `moderation` (moderation/moderationService.js), `modLog` and `botDeletions`
// are only needed to run the moderation commands, `reminders`
// (reminders/reminderStore.js) to run /remind and `giveaways`
// (giveaways/giveawayStore.js) to run /giveaway, not to register them.
export function createCommands({
  logger,
  guildSettings,
  forcedLanguage,
  moderation,
  modLog,
  botDeletions,
  reminders,
  giveaways,
}) {
  // Shared, so /country and /country-staff can't change the same member at the same time.
  const roleService = new CountryRoleService(logger);
  const moderationOptions = { logger, guildSettings, forcedLanguage, moderation };
  const commands = [
    createCountryCommand({ logger, guildSettings, forcedLanguage, roleService }),
    createCountryStaffCommand({ logger, guildSettings, forcedLanguage, roleService }),
    createCountryHelpCommand({ guildSettings, forcedLanguage }),
    createSettingsCommand({ guildSettings, forcedLanguage }),
    ...createModerationCommands(moderationOptions),
    createPurgeCommand({ guildSettings, forcedLanguage, modLog, botDeletions }),
    createCaseCommand(moderationOptions),
    createModlogsCommand(moderationOptions),
    createClearWarnsCommand({ moderation, modLog, forcedLanguage }),
    ...createChannelToolCommands({ guildSettings, modLog, forcedLanguage }),
    ...createMemberToolCommands({ guildSettings, modLog, forcedLanguage }),
    createWelcomeCommand({ guildSettings, forcedLanguage }),
    createRolePanelCommand({ guildSettings, logger, forcedLanguage }),
    ...createTagCommands({ guildSettings, forcedLanguage }),
    createRemindCommand({ reminders, forcedLanguage }),
    createGiveawayCommand({ giveaways, guildSettings, logger, forcedLanguage }),
  ];
  return new Map(commands.map((command) => [command.name, command]));
}
