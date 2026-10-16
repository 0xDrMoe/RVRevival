// What the dashboard accepts for each setting: the same rules /settings
// enforces through Discord's option types, checked here against the server's
// real channels and roles.

import { ChannelType } from "discord.js";
import { activeRules, checkAutomod, InvalidAutomod, normalizeAutomod, RULE_LABELS } from "../automod/config.js";
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
const MAX_DASHBOARD_ROLES = 25;
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
  [Setting.DASHBOARD_ROLES]: { kind: "roles", label: "Dashboard access roles" },
  [Setting.AUTOMOD]: { kind: "automod", label: "Automod" },
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
    case "roles":
      return value.map((id) => `<@&${id}>`).join(", ");
    case "automod": {
      const config = normalizeAutomod(value);
      const rules = activeRules(config).map((rule) => `${RULE_LABELS[rule]} (${config.rules[rule].action})`);
      return `${config.enabled ? "on" : "off"}${rules.length > 0 ? ` · ${rules.join(", ")}` : ""}`;
    }
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}
