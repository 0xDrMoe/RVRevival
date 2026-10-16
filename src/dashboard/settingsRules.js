// What the dashboard accepts for each setting: the same rules /settings
// enforces through Discord's option types, checked here against the server's
// real channels and roles.

import { ChannelType } from "discord.js";
import { activeRules, checkAutomod, InvalidAutomod, normalizeAutomod, RULE_LABELS } from "../automod/config.js";
import { cleanEmoji } from "../community/rolePanels.js";
import { MAX_THRESHOLD, MIN_THRESHOLD } from "../community/starboard.js";
import { cleanTagContent, cleanTagName, MAX_TAG_LENGTH, MAX_TAGS, sortTags } from "../community/tags.js";
import { MAX_AUTOROLES, MAX_MESSAGE_LENGTH } from "../community/welcome.js";
import { checkLeveling, InvalidLeveling, normalizeLeveling } from "../leveling/config.js";
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
const MAX_IGNORED_CHANNELS = 100;
const MAX_DASHBOARD_ROLES = 25;
const LOG_EVENTS = Object.values(LogEvent);
// Roles new members must never get automatically: Administrator and Manage Server.
const AUTOROLE_FORBIDDEN = (1n << 3n) | (1n << 5n);

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
  [Setting.WELCOME_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Welcome channel" },
  [Setting.WELCOME_MESSAGE]: { kind: "text", label: "Welcome message" },
  [Setting.LEAVE_CHANNEL]: { kind: "channel", types: POSTING_CHANNELS, label: "Leave channel" },
  [Setting.LEAVE_MESSAGE]: { kind: "text", label: "Leave message" },
  [Setting.WELCOME_DM]: { kind: "text", label: "Welcome DM" },
  [Setting.AUTOROLES]: { kind: "autoroles", label: "Autoroles" },
  [Setting.TAGS]: { kind: "tags", label: "Custom commands" },
  [Setting.STARBOARD]: { kind: "starboard", types: POSTING_CHANNELS, label: "Starboard" },
  [Setting.LEVELING]: { kind: "leveling", label: "Leveling" },
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
    case "text": {
      if (typeof value !== "string") {
        throw new InvalidSetting(setting, "Send the message as text.");
      }
      const text = value.replace(/\r\n?/g, "\n").trim();
      if (text.length > MAX_MESSAGE_LENGTH) {
        throw new InvalidSetting(setting, `Keep the message under ${MAX_MESSAGE_LENGTH} characters.`);
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
        return roleOk(id) && !role.managed && (BigInt(role.permissions ?? 0) & AUTOROLE_FORBIDDEN) === 0n;
      };
      if (!ids.every(allowed)) {
        throw new InvalidSetting(setting, "Pick roles from this server that aren't bot roles or admin roles.");
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
    case "leveling": {
      // Reward roles: not @everyone, bot roles or roles with Administrator or Manage Server.
      const isRewardRole = (id) => {
        const role = roles.find((entry) => entry.id === id);
        return roleOk(id) && !role.managed && (BigInt(role.permissions ?? 0) & AUTOROLE_FORBIDDEN) === 0n;
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
    case "autoroles":
      return value.map((id) => `<@&${id}>`).join(", ");
    case "tags":
      return value.map((tag) => `\`${tag.name}\``).join(", ");
    case "starboard":
      return `<#${value.channelId}> · ${value.emoji} ${value.threshold}`;
    case "text":
      return `"${value.length > 80 ? `${value.slice(0, 80)}…` : value}"`.replace(/\n/g, " ");
    case "leveling": {
      const config = normalizeLeveling(value);
      const rewards = config.rewards.map((reward) => `${reward.level}: <@&${reward.roleId}>`);
      return `${config.enabled ? "on" : "off"} · announce ${config.announce}${rewards.length > 0 ? ` · rewards ${rewards.join(", ")}` : ""}`;
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
