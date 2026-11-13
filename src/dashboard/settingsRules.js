// What the dashboard accepts for each setting: the same rules /settings
// enforces through Discord's option types, checked here against the server's
// real channels and roles.

import { ChannelType } from "discord.js";
import { activeRules, checkAutomod, InvalidAutomod, normalizeAutomod, RULE_LABELS } from "../automod/config.js";
import { isValidTimeZone, MAX_BIRTHDAY_MESSAGE_LENGTH } from "../birthdays/birthdays.js";
import { checkResponders, InvalidResponders } from "../community/autoResponders.js";
import { cleanEmoji } from "../community/rolePanels.js";
import { MAX_THRESHOLD, MIN_THRESHOLD } from "../community/starboard.js";
import { cleanTagContent, cleanTagName, MAX_TAG_LENGTH, MAX_TAGS, sortTags } from "../community/tags.js";
import { MAX_AUTOROLES, MAX_MESSAGE_LENGTH } from "../community/welcome.js";
import { checkWelcomeEmbed, describeWelcomeEmbed } from "../community/welcomeEmbeds.js";
import { checkMilestones, describeMilestones, InvalidMilestones, normalizeMilestones } from "../community/milestones.js";
import { InvalidMessage } from "../messages/embedMessage.js";
import { checkLeveling, DEFAULT_LEVELING, InvalidLeveling, normalizeLeveling } from "../leveling/config.js";
import { checkAntiNuke, describeAntiNuke, InvalidAntiNuke, normalizeAntiNuke } from "../raid/antiNuke.js";
import { checkRolePersist, InvalidRolePersist, normalizeRolePersist } from "../members/rolePersistence.js";
import { checkMediaOnly, describeMediaOnly, InvalidMediaOnly } from "../community/mediaOnly.js";
import { checkAppeals, InvalidAppeals, normalizeAppeals } from "../appeals/config.js";
import { checkCategories, describeCategories, InvalidCategories, normalizeCategories } from "../tickets/categories.js";
import { checkLook, describeLook, InvalidPanel, normalizeLook } from "../tickets/panel.js";
import { checkTicketSupport, describeTicketSupport, InvalidTicketSupport, normalizeTicketSupport } from "../tickets/support.js";
import { checkWarnThresholds, describeWarnThresholds, InvalidWarnThresholds, normalizeWarnThresholds } from "../moderation/warnThresholds.js";
import { checkJoinGate, InvalidJoinGate } from "../raid/raid.js";
import { checkGuide, describeGuide, InvalidGuide } from "../countries/guide.js";
import { checkCountryOptions, describeCountryOptions, InvalidCountryOptions, normalizeCountryOptions } from "../countries/options.js";
import { checkLogOptions, describeLogOptions, InvalidLogOptions, LOG_EVENTS, normalizeLogOptions } from "../logs/logEvents.js";
import { TICKET_EVENTS } from "../tickets/ticketLog.js";
import { changeLines, diffValues, serverMention } from "../logs/changeDiff.js";
import { checkLogRoutes, describeLogRoutes, InvalidLogRoutes, normalizeLogRoutes } from "../logs/logRoutes.js";
import { botCommandCatalog } from "../permissions/catalog.js";
import { checkCommandRules, describeCommandRules, InvalidCommandRules, normalizeCommandRules } from "../permissions/commandRules.js";
import { isModeratorRole } from "../permissions/moderatorPermissions.js";
import { CUSTOM, PRESETS } from "../permissions/presets.js";
import { checkMusic, describeMusic, InvalidMusic, normalizeMusic } from "../music/config.js";
import { channelTypesFor, checkAutomation, describeAutomation, InvalidAutomation, normalizeAutomation } from "../channels/automation.js";
import { Setting } from "../settings/guildSettings.js";
import { variableError } from "./public/variables.js";

export class InvalidSetting extends Error {
  name = "InvalidSetting";
  constructor(setting, message) {
    super(message);
    this.setting = setting;
  }
}

const POSTING_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const NO_XP_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
];
const IGNORABLE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
];
const RESPONDER_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory];
const MAX_IGNORED_CHANNELS = 100;
const MAX_DASHBOARD_ROLES = 25;
// The steps on the dashboard's Setup card, in the order it shows them.
export const SETUP_STEPS = Object.freeze(["logs", "serverLog", "modLog", "modRole", "country", "dashboard", "automod", "welcome"]);

// Each setting: the kind of value, and (for lists) what each item may be.
export const SETTING_RULES = Object.freeze({
  [Setting.STAFF_ROLE]: { kind: "role", label: "Staff role" },
  [Setting.MOD_ROLE]: { kind: "role", label: "Mod role" },
  [Setting.COUNTRY_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "/country channel" },
  [Setting.COUNTRY_GUIDE]: { kind: "countryGuide", label: "Country guide" },
  [Setting.COUNTRY_ROLES]: { kind: "countryRoles", label: "Country roles" },
  [Setting.LOGS_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Logs channel" },
  [Setting.QUARANTINE_ROLE]: { kind: "role", label: "Quarantine role" },
  [Setting.MOD_LOG_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Mod-log channel" },
  [Setting.SERVER_LOG_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Server-log channel" },
  [Setting.DISABLED_LOG_EVENTS]: { kind: "events", label: "Switched-off log events" },
  [Setting.LOG_IGNORED_CHANNELS]: { kind: "channels", types: IGNORABLE_CHANNELS, label: "Ignored log channels" },
  [Setting.LOG_IGNORED_ROLES]: { kind: "roles", label: "Ignored log roles" },
  [Setting.LOG_OPTIONS]: { kind: "logOptions", label: "Log options" },
  [Setting.DASHBOARD_ROLES]: { kind: "roles", label: "Dashboard access roles" },
  [Setting.AUTOMOD]: { kind: "automod", label: "Automod" },
  [Setting.WELCOME_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Welcome channel" },
  [Setting.WELCOME_MESSAGE]: { kind: "text", variables: "welcome", label: "Welcome message" },
  [Setting.LEAVE_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Leave channel" },
  [Setting.LEAVE_MESSAGE]: { kind: "text", variables: "welcome", label: "Leave message" },
  [Setting.WELCOME_DM]: { kind: "text", variables: "welcome", label: "Welcome DM" },
  [Setting.WELCOME_EMBED]: { kind: "welcomeEmbed", label: "Welcome embed" },
  [Setting.LEAVE_EMBED]: { kind: "welcomeEmbed", label: "Leave embed" },
  [Setting.WELCOME_DM_EMBED]: { kind: "welcomeEmbed", label: "Welcome DM embed" },
  [Setting.AUTOROLES]: { kind: "autoroles", label: "Autoroles" },
  [Setting.BOT_AUTOROLES]: { kind: "autoroles", label: "Bot autoroles" },
  [Setting.MILESTONES]: { kind: "milestones", types: POSTING_CHANNELS, label: "Member milestones" },
  [Setting.INVITE_TRACKING]: { kind: "flag", label: "Invite tracking" },
  [Setting.DEHOIST]: { kind: "flag", label: "Dehoist names" },
  [Setting.ROLE_CONFIRM]: { kind: "onByDefault", label: "Role pick confirmations" },
  [Setting.ROLE_PERSIST]: { kind: "rolePersist", label: "Roles on rejoin" },
  [Setting.APPEALS]: { kind: "appeals", types: POSTING_CHANNELS, label: "Ban appeals" },
  [Setting.TAGS]: { kind: "tags", label: "Custom commands" },
  [Setting.TICKET_PANEL]: { kind: "ticketPanel", label: "Ticket panel look" },
  [Setting.TICKET_CATEGORIES]: { kind: "ticketCategories", label: "Ticket categories" },
  [Setting.TICKET_LOG_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Ticket log channel" },
  [Setting.DISABLED_TICKET_LOG_EVENTS]: { kind: "ticketEvents", label: "Switched-off ticket log events" },
  [Setting.TICKET_SUPPORT]: { kind: "ticketSupport", label: "Ticket auto-close and ratings" },
  [Setting.WARN_THRESHOLDS]: { kind: "warnThresholds", label: "Warning thresholds" },
  [Setting.STARBOARD]: { kind: "starboard", types: POSTING_CHANNELS, label: "Starboard" },
  [Setting.LEVELING]: { kind: "leveling", label: "Leveling" },
  [Setting.WEEKLY_BOARD_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Weekly leaderboard channel" },
  [Setting.WEEKLY_BOARD_ROLE]: { kind: "givableRole", label: "Weekly top member role" },
  [Setting.JOIN_GATE]: { kind: "joinGate", label: "Raid protection" },
  // Only the server owner may change this (checked by the dashboard route).
  [Setting.ANTI_NUKE]: { kind: "antiNuke", label: "Anti-nuke", ownerOnly: true },
  [Setting.BIRTHDAYS]: { kind: "birthdays", types: POSTING_CHANNELS, label: "Birthdays" },
  [Setting.AUTO_RESPONDERS]: { kind: "autoResponders", types: RESPONDER_CHANNELS, label: "Auto-responders" },
  [Setting.MEDIA_ONLY]: { kind: "mediaOnly", types: [ChannelType.GuildText, ChannelType.GuildAnnouncement], label: "Media-only channels" },
  [Setting.MUSIC]: { kind: "music", label: "Music" },
  [Setting.CHANNEL_AUTOMATION]: { kind: "channelAutomation", label: "Channel automation" },
  [Setting.SETUP_SKIPPED]: { kind: "setupSteps", label: "Skipped setup steps" },
  [Setting.LOG_ROUTES]: { kind: "logRoutes", types: POSTING_CHANNELS, label: "Log channels per log type" },
  // Only the owner or whoever added the bot may change these (checked by the dashboard route).
  [Setting.COMMAND_RULES]: { kind: "commandRules", types: IGNORABLE_CHANNELS, label: "Command permissions", permissionsOnly: true },
  [Setting.PERMISSION_PRESET]: { kind: "preset", label: "Permission setup", permissionsOnly: true },
  [Setting.NATIVE_PERMISSIONS]: { kind: "nativePermissions", label: "Discord permissions count", permissionsOnly: true },
});

// Checks one value. Returns what to save: null clears the setting, and empty
// lists become null. Throws InvalidSetting.
function checkValue(setting, value, { guildId, channels, roles }) {
  const rule = SETTING_RULES[setting];
  if (!rule) {
    throw new InvalidSetting(setting, "Unknown setting");
  }
  if (value === null) {
    return null;
  }
  const roleOk = (id) => typeof id === "string" && id !== guildId && roles.some((role) => role.id === id);
  const channelOk = (id, types) => channels.some((channel) => channel.id === id && types.includes(channel.type));

  switch (rule.kind) {
    case "role":
      if (!roleOk(value)) {
        throw new InvalidSetting(setting, "Pick a role from this server (not @everyone).");
      }
      return value;
    case "givableRole": {
      const role = roles.find((entry) => entry.id === value);
      if (!roleOk(value) || role.managed || isModeratorRole(role)) {
        throw new InvalidSetting(setting, "Pick a role from this server that isn't a bot's role and has no moderator permissions.");
      }
      return value;
    }
    case "channel":
      if (typeof value !== "string" || !channelOk(value, rule.types)) {
        throw new InvalidSetting(setting, "Pick a text or announcement channel from this server.");
      }
      return value;
    case "events": {
      if (!Array.isArray(value) || !value.every((event) => LOG_EVENTS.includes(event))) {
        throw new InvalidSetting(setting, "Unknown log event.");
      }
      const events = LOG_EVENTS.filter((event) => value.includes(event));
      return events.length > 0 ? events : null;
    }
    case "ticketEvents": {
      if (!Array.isArray(value) || !value.every((event) => TICKET_EVENTS.includes(event))) {
        throw new InvalidSetting(setting, "Unknown ticket log event.");
      }
      const events = TICKET_EVENTS.filter((event) => value.includes(event));
      return events.length > 0 ? events : null;
    }
    case "setupSteps": {
      if (!Array.isArray(value) || !value.every((step) => SETUP_STEPS.includes(step))) {
        throw new InvalidSetting(setting, "Unknown setup step.");
      }
      const steps = SETUP_STEPS.filter((step) => value.includes(step));
      return steps.length > 0 ? steps : null;
    }
    case "roles": {
      if (!Array.isArray(value) || value.length > MAX_DASHBOARD_ROLES) {
        throw new InvalidSetting(setting, `Pick at most ${MAX_DASHBOARD_ROLES} roles.`);
      }
      const ids = [...new Set(value)];
      if (!ids.every(roleOk)) {
        throw new InvalidSetting(setting, "Pick roles from this server (not @everyone).");
      }
      return ids.length > 0 ? ids : null;
    }
    case "channels": {
      if (!Array.isArray(value) || value.length > MAX_IGNORED_CHANNELS) {
        throw new InvalidSetting(setting, `Pick at most ${MAX_IGNORED_CHANNELS} channels.`);
      }
      const ids = [...new Set(value)];
      if (!ids.every((id) => typeof id === "string" && channelOk(id, rule.types))) {
        throw new InvalidSetting(setting, "Pick channels or categories from this server.");
      }
      return ids.length > 0 ? ids : null;
    }
    case "text": {
      if (typeof value !== "string") {
        throw new InvalidSetting(setting, "Send the message as text.");
      }
      const text = value.replace(/\r\n?/g, "\n").trim();
      if (text.length > MAX_MESSAGE_LENGTH) {
        throw new InvalidSetting(setting, `Keep the message under ${MAX_MESSAGE_LENGTH} characters.`);
      }
      const variableProblem = rule.variables && variableError(text, rule.variables);
      if (variableProblem) {
        throw new InvalidSetting(setting, variableProblem);
      }
      return text || null;
    }
    case "autoroles": {
      if (!Array.isArray(value) || value.length > MAX_AUTOROLES) {
        throw new InvalidSetting(setting, `Pick at most ${MAX_AUTOROLES} roles.`);
      }
      const ids = [...new Set(value)];
      const allowed = (id) => {
        const role = roles.find((entry) => entry.id === id);
        return roleOk(id) && !role.managed && !isModeratorRole(role);
      };
      if (!ids.every(allowed)) {
        throw new InvalidSetting(setting, "Pick roles from this server that aren't bot roles or roles with moderator permissions.");
      }
      return ids.length > 0 ? ids : null;
    }
    case "tags": {
      if (!Array.isArray(value) || value.length > MAX_TAGS) {
        throw new InvalidSetting(setting, `Add at most ${MAX_TAGS} custom commands.`);
      }
      const tags = value.map((tag) => ({ name: cleanTagName(tag?.name), content: cleanTagContent(tag?.content) }));
      const bad = tags.find((tag) => !tag.name);
      if (bad) {
        throw new InvalidSetting(setting, "Custom command names can only use letters, numbers and dashes (up to 32).");
      }
      const empty = tags.find((tag) => !tag.content || tag.content.length > MAX_TAG_LENGTH);
      if (empty) {
        throw new InvalidSetting(setting, `"${empty.name}" needs a text of 1 to ${MAX_TAG_LENGTH} characters.`);
      }
      const names = tags.map((tag) => tag.name);
      const duplicate = names.find((name, index) => names.indexOf(name) !== index);
      if (duplicate) {
        throw new InvalidSetting(setting, `There are two custom commands called "${duplicate}".`);
      }
      return tags.length > 0 ? sortTags(tags) : null;
    }
    case "starboard": {
      if (typeof value !== "object" || Array.isArray(value) || !channelOk(value.channelId, rule.types)) {
        throw new InvalidSetting(setting, "Pick a text or announcement channel from this server for the starboard.");
      }
      if (!Number.isInteger(value.threshold) || value.threshold < MIN_THRESHOLD || value.threshold > MAX_THRESHOLD) {
        throw new InvalidSetting(setting, `The starboard needs ${MIN_THRESHOLD} to ${MAX_THRESHOLD} stars.`);
      }
      const emoji = cleanEmoji(value.emoji);
      if (!emoji) {
        throw new InvalidSetting(setting, "Use one emoji for the starboard, like ⭐ or a custom emoji from this server.");
      }
      return { channelId: value.channelId, threshold: value.threshold, emoji };
    }
    case "birthdays": {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new InvalidSetting(setting, "Send the birthday settings as an object.");
      }
      const channelId = value.channelId || null;
      const roleId = value.roleId || null;
      if (channelId && !channelOk(channelId, rule.types)) {
        throw new InvalidSetting(setting, "Pick a text or announcement channel from this server for birthday greetings.");
      }
      const role = roles.find((entry) => entry.id === roleId);
      if (roleId && (!roleOk(roleId) || role.managed || isModeratorRole(role))) {
        throw new InvalidSetting(setting, "Pick a birthday role without moderator permissions that isn't a bot role.");
      }
      const timezone = value.timezone || "UTC";
      if (!isValidTimeZone(timezone)) {
        throw new InvalidSetting(setting, "Pick a time zone from the list, like Europe/London.");
      }
      const message = typeof value.message === "string" ? value.message.replace(/\r\n?/g, "\n").trim() : "";
      if (message.length > MAX_BIRTHDAY_MESSAGE_LENGTH) {
        throw new InvalidSetting(setting, `Keep the birthday message under ${MAX_BIRTHDAY_MESSAGE_LENGTH} characters.`);
      }
      const variableProblem = variableError(message, "birthday");
      if (variableProblem) {
        throw new InvalidSetting(setting, variableProblem);
      }
      return channelId || roleId ? { channelId, roleId, message: message || null, timezone } : null;
    }
    case "autoResponders":
      try {
        return checkResponders(value, (id) => channelOk(id, rule.types));
      } catch (error) {
        if (error instanceof InvalidResponders) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "ticketPanel":
      try {
        return checkLook(value);
      } catch (error) {
        if (error instanceof InvalidPanel) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "ticketCategories":
      try {
        return checkCategories(value, { isRole: (id) => roleOk(id) && !roles.find((role) => role.id === id).managed });
      } catch (error) {
        if (error instanceof InvalidCategories) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "appeals":
      try {
        return checkAppeals(value, { isChannel: (id) => typeof id === "string" && channelOk(id, rule.types) });
      } catch (error) {
        if (error instanceof InvalidAppeals) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "channelAutomation":
      try {
        return checkAutomation(value, {
          // Threads aren't in the dashboard's channel list, so an unknown ID kept
          // open with /automate keep-alive is taken as one of the server's threads.
          isChannel: (id, kind) =>
            typeof id === "string" && (channelOk(id, channelTypesFor(kind)) || (kind === "keepAlive" && /^\d{17,20}$/.test(id) && !channels.some((channel) => channel.id === id))),
          isRole: (id) => roleOk(id),
        });
      } catch (error) {
        if (error instanceof InvalidAutomation) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "mediaOnly":
      try {
        return checkMediaOnly(value, { isChannel: (id) => typeof id === "string" && channelOk(id, rule.types) });
      } catch (error) {
        if (error instanceof InvalidMediaOnly) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "welcomeEmbed":
      try {
        return checkWelcomeEmbed(value);
      } catch (error) {
        if (error instanceof InvalidMessage) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "music":
      try {
        return checkMusic(value, { isRole: roleOk });
      } catch (error) {
        if (error instanceof InvalidMusic) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "rolePersist":
      try {
        return checkRolePersist(value, { isRole: roleOk });
      } catch (error) {
        if (error instanceof InvalidRolePersist) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "antiNuke":
      try {
        return checkAntiNuke(value);
      } catch (error) {
        if (error instanceof InvalidAntiNuke) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "joinGate":
      try {
        return checkJoinGate(value);
      } catch (error) {
        if (error instanceof InvalidJoinGate) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "leveling": {
      // Reward roles: not @everyone, bot roles or roles with moderator permissions.
      const isRewardRole = (id) => {
        const role = roles.find((entry) => entry.id === id);
        return roleOk(id) && !role.managed && !isModeratorRole(role);
      };
      try {
        const leveling = checkLeveling(value, {
          isRole: roleOk,
          isRewardRole,
          isChannel: (id) => typeof id === "string" && channelOk(id, NO_XP_CHANNELS),
        });
        // No-XP channels may be categories or voice channels; level-ups need a text channel.
        if (leveling.announceChannelId && !channelOk(leveling.announceChannelId, POSTING_CHANNELS)) {
          throw new InvalidLeveling("Pick a text channel for level-up messages.");
        }
        return leveling;
      } catch (error) {
        if (error instanceof InvalidLeveling) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    }
    case "logOptions":
      try {
        return checkLogOptions(value);
      } catch (error) {
        if (error instanceof InvalidLogOptions) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "logRoutes":
      try {
        return checkLogRoutes(value, { isChannel: (id) => channelOk(id, rule.types) });
      } catch (error) {
        if (error instanceof InvalidLogRoutes) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "commandRules":
      try {
        return checkCommandRules(value, {
          catalog: botCommandCatalog(),
          isRole: (id) => roleOk(id) && !roles.find((role) => role.id === id).managed,
          isChannel: (id) => channelOk(id, rule.types),
        });
      } catch (error) {
        if (error instanceof InvalidCommandRules) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "warnThresholds":
      try {
        return checkWarnThresholds(value);
      } catch (error) {
        if (error instanceof InvalidWarnThresholds) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "ticketSupport":
      try {
        return checkTicketSupport(value);
      } catch (error) {
        if (error instanceof InvalidTicketSupport) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "flag":
      if (typeof value !== "boolean") {
        throw new InvalidSetting(setting, "Send true or false.");
      }
      // Off is the default, so it's saved as no value.
      return value || null;
    case "milestones":
      try {
        const checked = checkMilestones(value, { channelOk: (id) => channelOk(id, rule.types) });
        const variableProblem = checked?.message && variableError(checked.message, "welcome");
        if (variableProblem) {
          throw new InvalidSetting(setting, variableProblem);
        }
        return checked;
      } catch (error) {
        if (error instanceof InvalidMilestones) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "onByDefault":
      if (typeof value !== "boolean") {
        throw new InvalidSetting(setting, "Send true or false.");
      }
      // On is the default, so it's saved as no value.
      return value ? null : false;
    case "nativePermissions":
      if (typeof value !== "boolean") {
        throw new InvalidSetting(setting, "Send whether Discord permissions count as true or false.");
      }
      // On is the default, so it's saved as no value.
      return value ? null : false;
    case "preset":
      if (![...PRESETS, CUSTOM].includes(value)) {
        throw new InvalidSetting(setting, "Unknown permission setup.");
      }
      return value;
    case "countryRoles":
      try {
        return checkCountryOptions(value);
      } catch (error) {
        if (error instanceof InvalidCountryOptions) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "countryGuide":
      try {
        return checkGuide(value);
      } catch (error) {
        if (error instanceof InvalidGuide) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
    case "automod":
      try {
        return checkAutomod(value, {
          isRole: roleOk,
          isChannel: (id) => typeof id === "string" && channelOk(id, IGNORABLE_CHANNELS),
        });
      } catch (error) {
        if (error instanceof InvalidAutomod) {
          throw new InvalidSetting(setting, error.message);
        }
        throw error;
      }
  }
  throw new InvalidSetting(setting, "Unknown setting");
}

// Checks every setting in `changes` ({ setting: value }) and returns the cleaned
// values. Nothing is saved if any of them is invalid.
export function checkSettingChanges(changes, server) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new InvalidSetting(undefined, "Send the settings as an object.");
  }
  return Object.fromEntries(Object.entries(changes).map(([setting, value]) => [setting, checkValue(setting, value, server)]));
}

// "<@&123>", "<#456>", "<@&1>, <@&2>", "Edited messages, Members joining" or "none", for the log entry.
export function describeValue(setting, value) {
  if (SETTING_RULES[setting]?.kind === "countryRoles") {
    return describeCountryOptions(value);
  }
  if (SETTING_RULES[setting]?.kind === "nativePermissions") {
    return value === false ? "off (the bot's roles only)" : "on";
  }
  if (SETTING_RULES[setting]?.kind === "warnThresholds") {
    return describeWarnThresholds(value);
  }
  if (SETTING_RULES[setting]?.kind === "ticketSupport") {
    return describeTicketSupport(value);
  }
  if (SETTING_RULES[setting]?.kind === "onByDefault") {
    return value === false ? "off" : "on";
  }
  if (SETTING_RULES[setting]?.kind === "flag") {
    return value ? "on" : "off";
  }
  if (SETTING_RULES[setting]?.kind === "milestones") {
    return describeMilestones(value);
  }
  if (SETTING_RULES[setting]?.kind === "logOptions") {
    return describeLogOptions(value);
  }
  if (SETTING_RULES[setting]?.kind === "music") {
    return describeMusic(value);
  }
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return "*none*";
  }
  switch (SETTING_RULES[setting]?.kind) {
    case "role":
    case "givableRole":
      return `<@&${value}>`;
    case "channel":
      return `<#${value}>`;
    case "channels":
      return value.map((id) => `<#${id}>`).join(", ");
    case "roles":
    case "autoroles":
      return value.map((id) => `<@&${id}>`).join(", ");
    case "tags":
      return value.map((tag) => `\`${tag.name}\``).join(", ");
    case "birthdays":
      return `${value.channelId ? `<#${value.channelId}>` : "no greetings"} · ${value.roleId ? `<@&${value.roleId}>` : "no role"} · ${value.timezone}`;
    case "autoResponders":
      return value.map((responder) => `\`${responder.trigger}\``).join(", ");
    case "starboard":
      return `<#${value.channelId}> · ${value.emoji} ${value.threshold}`;
    case "antiNuke":
      return describeAntiNuke(value);
    case "logRoutes":
      return describeLogRoutes(value);
    case "commandRules":
      return describeCommandRules(value);
    case "ticketCategories":
      return describeCategories(value);
    case "ticketPanel":
      return describeLook(value);
    case "appeals":
      return `${value.enabled ? "open" : "closed"} · ${value.channelId ? `<#${value.channelId}>` : "mod-log channel"} · ${value.questions.length} question(s) · wait ${value.cooldownDays} days after a denial`;
    case "countryGuide":
      return describeGuide(value);
    case "channelAutomation":
      return describeAutomation(value);
    case "mediaOnly":
      return value.channelIds.length > 0 ? describeMediaOnly(value) : `none · links ${value.allowLinks ? "allowed" : "not allowed"}`;
    case "rolePersist":
      return `${value.enabled ? "given back" : "not given back"}${value.ignoredRoleIds.length > 0 ? ` · ignoring ${value.ignoredRoleIds.map((id) => `<@&${id}>`).join(", ")}` : ""}`;
    case "joinGate":
      return [
        value.minAgeDays ? `${value.action} accounts under ${value.minAgeDays} days` : "no account-age gate",
        value.alertJoins ? `alert at ${value.alertJoins} joins a minute` : "no join alerts",
      ].join(" · ");
    case "welcomeEmbed":
      return describeWelcomeEmbed(value);
    case "text":
      return `"${value.length > 80 ? `${value.slice(0, 80)}…` : value}"`.replace(/\n/g, " ");
    case "leveling": {
      const config = normalizeLeveling(value);
      const rewards = config.rewards.map((reward) => `${reward.level}: <@&${reward.roleId}>`);
      // XP rates and the curve only when they're not the defaults, so the log stays short.
      const ratesChanged = ["xpMin", "xpMax", "cooldownSeconds", "voiceXpPerMinute"].some((key) => config[key] !== DEFAULT_LEVELING[key]);
      const rates = ratesChanged ? ` · ${config.xpMin}-${config.xpMax} XP every ${config.cooldownSeconds}s, voice ${config.voiceXpPerMinute}/min` : "";
      const curve = config.levelFormula ? ` · curve ${config.levelFormula}` : "";
      return `${config.enabled ? "on" : "off"} · announce ${config.announce}${rates}${curve}${rewards.length > 0 ? ` · rewards ${rewards.join(", ")}` : ""}`;
    }
    case "automod": {
      const config = normalizeAutomod(value);
      const rules = activeRules(config).map((rule) => `${RULE_LABELS[rule]} (${config.rules[rule].action})`);
      return `${config.enabled ? "on" : "off"}${rules.length > 0 ? ` · ${rules.join(", ")}` : ""}`;
    }
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

// Settings that are one value (a channel, a role, some text, on or off): their
// change is "before → after". Every other setting lists only what changed in it.
const WHOLE_VALUE_KINDS = new Set(["role", "givableRole", "channel", "text", "flag", "onByDefault", "nativePermissions", "preset"]);

// What a saved value means when compared, so unset and the defaults compare equal.
const NORMALIZE = {
  automod: normalizeAutomod,
  leveling: normalizeLeveling,
  logRoutes: normalizeLogRoutes,
  logOptions: normalizeLogOptions,
  commandRules: normalizeCommandRules,
  music: normalizeMusic,
  channelAutomation: normalizeAutomation,
  milestones: normalizeMilestones,
  ticketSupport: normalizeTicketSupport,
  antiNuke: normalizeAntiNuke,
  countryRoles: normalizeCountryOptions,
  warnThresholds: normalizeWarnThresholds,
  appeals: normalizeAppeals,
  ticketPanel: normalizeLook,
  ticketCategories: normalizeCategories,
  rolePersist: normalizeRolePersist,
};

// What the IDs in a list setting are, for settings that are a bare list.
const LIST_KEYS = { channels: "channelIds", roles: "roleIds", autoroles: "roleIds" };

// Better names than the keys give, for the first level of some settings.
const KEY_LABELS = {
  commandRules: (key, depth) => (depth === 0 ? `/${key}` : undefined),
  automod: (key, depth, path) => (depth === 1 && path === "rules" ? RULE_LABELS[key] : undefined),
};

// What changed in `setting`, as at most a few short lines ("**Bans:** none →
// #bans"). `server` ({ channels, roles }) shows IDs as channels and roles.
export function describeChange(setting, before, after, server = {}) {
  const kind = SETTING_RULES[setting]?.kind;
  if (WHOLE_VALUE_KINDS.has(kind)) {
    return [`${describeValue(setting, before)} → ${describeValue(setting, after)}`];
  }
  const normalize = NORMALIZE[kind] ?? ((value) => value);
  const safely = (value) => {
    try {
      return normalize(value ?? null);
    } catch {
      return value ?? null;
    }
  };
  const mention = serverMention({
    channelIds: (server.channels ?? []).map((channel) => channel.id),
    roleIds: (server.roles ?? []).map((role) => role.id),
  });
  const listKey = LIST_KEYS[kind];
  const labelOf = KEY_LABELS[kind];
  let parent;
  const changes = diffValues(safely(before), safely(after), {
    mention: (id, key) => mention(id, key ?? listKey),
    label: (key, depth) => {
      const name = labelOf?.(key, depth, parent);
      if (depth === 0) {
        parent = key;
      }
      return name;
    },
  });
  if (changes.length === 0) {
    // Only defaults filled in, or a change these lines can't show.
    return ["updated"];
  }
  return changeLines(changes);
}
