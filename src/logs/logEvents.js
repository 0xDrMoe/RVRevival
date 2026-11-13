// The kinds of events the server log posts, the groups they're shown in, and
// the server's log options (the dashboard's Logging page, /settings log-option).
//
// Every event can be switched off on its own (Setting.DISABLED_LOG_EVENTS) and
// sent to its own channel (logRoutes.js). The values are stored in the
// settings, so never rename one.

import { derivedSetting, Setting } from "../settings/guildSettings.js";

export const LogEvent = Object.freeze({
  // Messages
  MESSAGE_EDIT: "messageEdit",
  MESSAGE_DELETE: "messageDelete",
  BULK_DELETE: "bulkDelete",
  MESSAGE_PIN: "messagePin",
  // Members
  MEMBER_JOIN: "memberJoin",
  MEMBER_LEAVE: "memberLeave",
  MEMBER_UPDATE: "memberUpdate", // nickname, roles and timeouts
  MEMBER_PROFILE: "memberProfile", // username, display name and avatars
  MEMBER_BOOST: "memberBoost",
  // Voice
  VOICE_JOIN: "voiceJoin",
  VOICE_LEAVE: "voiceLeave",
  VOICE_MOVE: "voiceMove",
  VOICE_MODERATION: "voiceModeration", // server mute and deafen
  // Server changes (from the audit log, with who made them)
  CHANNEL_CREATE: "channelCreate",
  CHANNEL_UPDATE: "channelUpdate", // including permission overwrites
  CHANNEL_DELETE: "channelDelete",
  ROLE_CREATE: "roleCreate",
  ROLE_UPDATE: "roleUpdate",
  ROLE_DELETE: "roleDelete",
  SERVER_UPDATE: "serverUpdate",
  EMOJI_UPDATE: "emojiUpdate", // emojis, stickers and soundboard sounds
  INVITE_UPDATE: "inviteUpdate",
  WEBHOOK_UPDATE: "webhookUpdate",
  THREAD_UPDATE: "threadUpdate",
  EVENT_UPDATE: "eventUpdate", // scheduled events
  INTEGRATION_UPDATE: "integrationUpdate", // bots and apps added or removed
  AUTOMOD_RULE_UPDATE: "automodRuleUpdate", // Discord's own AutoMod rules
});
export const LOG_EVENTS = Object.freeze(Object.values(LogEvent));

// The groups, in the order the dashboard shows them. Each group's name is also
// a log route (logRoutes.js) covering every event in it.
export const LOG_EVENT_GROUPS = Object.freeze([
  {
    id: "serverMessages",
    events: [LogEvent.MESSAGE_EDIT, LogEvent.MESSAGE_DELETE, LogEvent.BULK_DELETE, LogEvent.MESSAGE_PIN],
  },
  {
    id: "serverMembers",
    events: [LogEvent.MEMBER_JOIN, LogEvent.MEMBER_LEAVE, LogEvent.MEMBER_UPDATE, LogEvent.MEMBER_PROFILE, LogEvent.MEMBER_BOOST],
  },
  {
    id: "serverVoice",
    events: [LogEvent.VOICE_JOIN, LogEvent.VOICE_LEAVE, LogEvent.VOICE_MOVE, LogEvent.VOICE_MODERATION],
  },
  {
    id: "serverChanges",
    events: [
      LogEvent.CHANNEL_CREATE,
      LogEvent.CHANNEL_UPDATE,
      LogEvent.CHANNEL_DELETE,
      LogEvent.ROLE_CREATE,
      LogEvent.ROLE_UPDATE,
      LogEvent.ROLE_DELETE,
      LogEvent.SERVER_UPDATE,
      LogEvent.EMOJI_UPDATE,
      LogEvent.INVITE_UPDATE,
      LogEvent.WEBHOOK_UPDATE,
      LogEvent.THREAD_UPDATE,
      LogEvent.EVENT_UPDATE,
      LogEvent.INTEGRATION_UPDATE,
      LogEvent.AUTOMOD_RULE_UPDATE,
    ],
  },
]);
export const groupOfEvent = (event) => LOG_EVENT_GROUPS.find((group) => group.events.includes(event))?.id;

// --- Options ---------------------------------------------------------------------

// Each option is on or off. The defaults are what a server gets without
// changing anything. The names are stored, so never rename one.
export const LogOption = Object.freeze({
  COMPACT: "compact", // shorter entries: no author line, avatar or footer
  SHOW_IDS: "showIds", // user, message and channel IDs in the footer
  LOG_BOTS: "logBots", // also log messages, voice and profile changes of bots and webhooks
  EDIT_DIFF: "editDiff", // highlight the words an edit changed
  WHO_DID_IT: "whoDidIt", // say who deleted a message, changed roles, muted… (from the audit log)
  INVITES: "invites", // say which invite a new member used (needs Manage Server)
});
export const LOG_OPTIONS = Object.freeze(Object.values(LogOption));
export const DEFAULT_LOG_OPTIONS = Object.freeze({
  compact: false,
  showIds: true,
  logBots: false,
  editDiff: true,
  whoDidIt: true,
  invites: true,
});

// The saved options with every gap filled by its default. Never throws.
export function normalizeLogOptions(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(
    LOG_OPTIONS.map((option) => [option, typeof value[option] === "boolean" ? value[option] : DEFAULT_LOG_OPTIONS[option]]),
  );
}

export class InvalidLogOptions extends Error {
  name = "InvalidLogOptions";
}

// Checks options from the dashboard: only known names, each true or false.
// Returns what to save: only the options that differ from the defaults, or
// null when none do. Throws InvalidLogOptions.
export function checkLogOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidLogOptions("Send the log options as an object.");
  }
  const changed = {};
  for (const [option, enabled] of Object.entries(value)) {
    if (!LOG_OPTIONS.includes(option)) {
      throw new InvalidLogOptions(`Unknown log option "${option}".`);
    }
    if (typeof enabled !== "boolean") {
      throw new InvalidLogOptions(`Log option "${option}" must be true or false.`);
    }
    if (enabled !== DEFAULT_LOG_OPTIONS[option]) {
      changed[option] = enabled;
    }
  }
  return Object.keys(changed).length > 0 ? changed : null;
}

export const describeLogOptions = (value) => {
  const options = normalizeLogOptions(value);
  return LOG_OPTIONS.map((option) => `${option} ${options[option] ? "on" : "off"}`).join(" · ");
};

// The server's options, worked out once per change of the setting.
export const logOptionsOf = (guildSettings, guildId) => derivedSetting(guildSettings, guildId, Setting.LOG_OPTIONS, normalizeLogOptions);
