// Every slash command the bot has. To add a command, create a file like
// country.js and add it to the list below.

import { CountryRoleService } from "../roles/countryRoles.js";
import { createCaseCommand, createClearWarnsCommand, createModlogsCommand } from "./cases.js";
import { createChannelToolCommands } from "./channelTools.js";
import { createCountryCommand } from "./country.js";
import { createCountryHelpCommand } from "./countryHelp.js";
import { createCountryStaffCommand } from "./countryStaff.js";
import { createGiveawayCommand } from "./giveaway.js";
import { createGuideCommand } from "./guide.js";
import { createDashboardCommand } from "./dashboard.js";
import { createLevelCommands } from "./levels.js";
import { createMemberToolCommands } from "./memberTools.js";
import { createModerationCommands } from "./moderation.js";
import { createPurgeCommand } from "./purge.js";
import { createRemindCommand } from "./remind.js";
import { createRolePanelCommand } from "./rolePanel.js";
import { createRoleConfirmations, RoleConfirmStore } from "../roles/roleConfirmations.js";
import { createSettingsCommand } from "./settings.js";
import { createStarboardCommand } from "./starboard.js";
import { createTagCommands } from "./tags.js";
import { createRaidCommand } from "./raid.js";
import { createAntiNukeCommand } from "./antiNuke.js";
import { createQuarantineCommand } from "./quarantine.js";
import { createTempRoleCommand } from "./tempRole.js";
import { createTicketsCommand } from "./tickets.js";
import { createVoiceCommand } from "./voice.js";
import { createAutoResponderCommand } from "./autoResponder.js";
import { createScheduleCommand } from "./schedule.js";
import { createFeedCommand } from "./feed.js";
import { createStatsCommand } from "./stats.js";
import { createAfkCommand } from "./afk.js";
import { createStickyCommand } from "./sticky.js";
import { createHighlightCommand } from "./highlight.js";
import { createMediaOnlyCommand } from "./mediaOnly.js";
import { createBirthdayCommand } from "./birthday.js";
import { createWelcomeCommand } from "./welcome.js";
import { createServerInfoCommand } from "./serverInfo.js";
import { createInfoCommands } from "./infoCommands.js";
import { createBotInfoCommands } from "./botInfo.js";
import { createFunCommands } from "./fun.js";
import { createEmbedCommand } from "./embed.js";
import { createMassRoleCommand } from "./massRole.js";
import { createMemberLoader } from "../guilds/memberCache.js";
import { createContextMenus } from "./contextMenus.js";

// Each command is { name, data, execute(interaction), autocomplete?(interaction),
// components?, componentPrefixes? }. `components` maps a button, form or menu
// custom ID to { label, handle(interaction) } (see countryPicker.js);
// `componentPrefixes` does the same for IDs that start with a prefix (rolePanel.js).
//
// `moderation` (moderation/moderationService.js), `modLog` and `botDeletions`
// are only needed to run the moderation commands, `reminders`
// (reminders/reminderStore.js) to run /remind, `giveaways`
// (giveaways/giveawayStore.js) to run /giveaway, `tickets`
// (tickets/ticketStore.js) with `ticketLog` (tickets/ticketLog.js) to run /tickets, and `levels` (leveling/levelStore.js)
// with `leveling` (leveling/leveling.js) to run /rank, /leaderboard and /levels,
// `tempVoice` (voice/tempVoiceStore.js) to run /voice, `scheduledMessages`
// (scheduled/scheduledMessageStore.js) to run /schedule, `birthdays`
// (birthdays/birthdayStore.js) to run /birthday, `quarantine`
// (moderation/quarantine.js) to run /quarantine, `tempRoles`
// (tempRoles/tempRoleStore.js) to run /temprole, `feeds` (feeds/feedStore.js)
// to run /feed, `statsUpdater` (stats/statsUpdater.js) to run /stats, `afk` (afk/afk.js)
// to run /afk, `stickyStore` (sticky/stickyStore.js) with `stickies`
// (sticky/stickies.js) to run /sticky, `highlightStore`
// (highlights/highlightStore.js) with `highlights` (highlights/highlights.js)
// to run /highlight, not to register them. `dashboardUrl` adds dashboard links
// to /guide and /dashboard. `roleConfirmations` (roles/roleConfirmations.js)
// makes role panels and the country picker ask before changing roles.
// `sentMessages` (messages/sentMessageStore.js) lists /embed posts on the
// dashboard's Embed builder page. `reports` (moderation/reports.js) keeps
// messages reported with the Report message app.
export function createCommands({
  logger,
  guildSettings,
  forcedLanguage,
  moderation,
  modLog,
  botDeletions,
  reminders,
  giveaways,
  tickets,
  ticketLog,
  levels,
  leveling,
  tempVoice,
  scheduledMessages,
  birthdays,
  quarantine,
  tempRoles,
  feeds,
  live,
  statsUpdater,
  afk,
  stickyStore,
  stickies,
  highlightStore,
  highlights,
  sentMessages,
  reports,
  roleConfirmations = createRoleConfirmations({ guildSettings, store: new RoleConfirmStore(), forcedLanguage }),
  dashboardUrl,
}) {
  // Shared, so /country and /country-staff can't change the same member at the same time.
  const roleService = new CountryRoleService(logger);
  const moderationOptions = { logger, guildSettings, forcedLanguage, moderation };
  // Shared, so /roleinfo and /massrole load a server's member list only once.
  const memberLoader = createMemberLoader();
  const commands = [
    createCountryCommand({ logger, guildSettings, forcedLanguage, roleService, confirmations: roleConfirmations }),
    createCountryStaffCommand({ logger, guildSettings, forcedLanguage, roleService }),
    createCountryHelpCommand({ guildSettings, forcedLanguage }),
    createSettingsCommand({ guildSettings, forcedLanguage }),
    createGuideCommand({ forcedLanguage, dashboardUrl }),
    createDashboardCommand({ forcedLanguage, dashboardUrl }),
    ...createModerationCommands(moderationOptions),
    createPurgeCommand({ guildSettings, forcedLanguage, modLog, botDeletions }),
    createCaseCommand(moderationOptions),
    createModlogsCommand(moderationOptions),
    createClearWarnsCommand({ moderation, modLog, forcedLanguage }),
    ...createChannelToolCommands({ guildSettings, modLog, forcedLanguage }),
    ...createMemberToolCommands({ guildSettings, modLog, forcedLanguage }),
    createMassRoleCommand({ guildSettings, modLog, forcedLanguage, memberLoader }),
    createWelcomeCommand({ guildSettings, forcedLanguage }),
    createRolePanelCommand({ guildSettings, logger, forcedLanguage, confirmations: roleConfirmations }),
    ...createTagCommands({ guildSettings, forcedLanguage }),
    createEmbedCommand({ guildSettings, forcedLanguage, sentMessages }),
    createRemindCommand({ reminders, forcedLanguage }),
    createGiveawayCommand({ giveaways, guildSettings, logger, forcedLanguage }),
    createStarboardCommand({ guildSettings, forcedLanguage }),
    createTicketsCommand({ tickets, guildSettings, logger, forcedLanguage, ticketLog }),
    createRaidCommand({ guildSettings, modLog, forcedLanguage }),
    createAntiNukeCommand({ guildSettings, forcedLanguage }),
    createQuarantineCommand({ guildSettings, quarantine, forcedLanguage }),
    createTempRoleCommand({ guildSettings, store: tempRoles, modLog, forcedLanguage }),
    createVoiceCommand({ guildSettings, store: tempVoice, forcedLanguage }),
    createAutoResponderCommand({ guildSettings, forcedLanguage }),
    createScheduleCommand({ store: scheduledMessages, forcedLanguage }),
    createFeedCommand({ store: feeds, live, forcedLanguage, logger }),
    createStatsCommand({ guildSettings, updater: statsUpdater, forcedLanguage, logger }),
    createAfkCommand({ afk, forcedLanguage }),
    createServerInfoCommand({ guildSettings, forcedLanguage }),
    ...createInfoCommands({ guildSettings, forcedLanguage, memberLoader }),
    ...createBotInfoCommands({ guildSettings, forcedLanguage, dashboardUrl, commandCount: () => commands.filter((command) => !command.data.type || command.data.type === 1).length }),
    ...createFunCommands({ forcedLanguage }),
    createStickyCommand({ store: stickyStore, stickies, forcedLanguage }),
    createHighlightCommand({ store: highlightStore, highlights, forcedLanguage }),
    createMediaOnlyCommand({ guildSettings, forcedLanguage }),
    createBirthdayCommand({ guildSettings, store: birthdays, forcedLanguage }),
    ...createLevelCommands({ levels, leveling, guildSettings, forcedLanguage }),
    // Right-click apps: Report message, User info, Moderation history.
    ...createContextMenus({ guildSettings, reports, moderation, forcedLanguage, logger }),
  ];
  return new Map(commands.map((command) => [command.name, command]));
}
