// What the dashboard accepts for each setting: the same rules /settings
// enforces through Discord's option types, checked here against the server's
// real channels and roles.

import { ChannelType } from "discord.js";
import { LogEvent } from "../logs/serverLog.js";
import { Setting } from "../settings/guildSettings.js";

export class InvalidSetting extends Error {
  name = "InvalidSetting";
  constructor(setting, message) {
    super(message);
    this.setting = setting;
  }
}

const POSTING_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const IGNORABLE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
];
const MAX_IGNORED_CHANNELS = 100;
const LOG_EVENTS = Object.values(LogEvent);

// Each setting: the kind of value, and (for lists) what each item may be.
export const SETTING_RULES = Object.freeze({
  [Setting.STAFF_ROLE]: { kind: "role", label: "Staff role" },
  [Setting.MOD_ROLE]: { kind: "role", label: "Mod role" },
  [Setting.COUNTRY_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "/country channel" },
  [Setting.LOGS_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Logs channel" },
  [Setting.MOD_LOG_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Mod-log channel" },
  [Setting.SERVER_LOG_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Server-log channel" },
  [Setting.DISABLED_LOG_EVENTS]: { kind: "events", label: "Switched-off log events" },
  [Setting.LOG_IGNORED_CHANNELS]: { kind: "channels", types: IGNORABLE_CHANNELS, label: "Ignored log channels" },
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
  const channelOk = (id, types) => channels.some((channel) => channel.id === id && types.includes(channel.type));

  switch (rule.kind) {
    case "role":
      if (typeof value !== "string" || value === guildId || !roles.some((role) => role.id === value)) {
        throw new InvalidSetting(setting, "Pick a role from this server (not @everyone).");
      }
      return value;
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

// "<@&123>", "<#456>", "Edited messages, Members joining" or "none", for the log entry.
export function describeValue(setting, value) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return "*none*";
  }
  switch (SETTING_RULES[setting]?.kind) {
    case "role":
      return `<@&${value}>`;
    case "channel":
      return `<#${value}>`;
    case "channels":
      return value.map((id) => `<#${id}>`).join(", ");
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}
