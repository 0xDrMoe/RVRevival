// Server changes for the server log, built from audit log entries: channels,
// permission overwrites, roles, server settings, emojis and stickers, invites,
// webhooks, threads, scheduled events, bots and apps, AutoMod rules and pins.
// Each entry says what changed (before → after) and who did it.
//
// Discord sends these to the bot as they happen (the "audit log entry create"
// event), so they need View Audit Log and nothing else: no extra intents, and
// no extra requests to Discord.

import { AuditLogEvent, ChannelType, PermissionsBitField } from "discord.js";
import { quote } from "./actionLog.js";
import { buildLogEntry, byLine, capList, formatDuration, LogColor } from "./logEntry.js";
import { DEFAULT_LOG_OPTIONS, LogEvent } from "./logEvents.js";

const A = AuditLogEvent;

// action -> [event, what it's called, verb]
const ACTIONS = new Map([
  [A.GuildUpdate, [LogEvent.SERVER_UPDATE, "Server settings", "changed"]],
  [A.ChannelCreate, [LogEvent.CHANNEL_CREATE, "Channel", "created"]],
  [A.ChannelUpdate, [LogEvent.CHANNEL_UPDATE, "Channel", "changed"]],
  [A.ChannelDelete, [LogEvent.CHANNEL_DELETE, "Channel", "deleted"]],
  [A.ChannelOverwriteCreate, [LogEvent.CHANNEL_UPDATE, "Channel permissions", "added"]],
  [A.ChannelOverwriteUpdate, [LogEvent.CHANNEL_UPDATE, "Channel permissions", "changed"]],
  [A.ChannelOverwriteDelete, [LogEvent.CHANNEL_UPDATE, "Channel permissions", "removed"]],
  [A.RoleCreate, [LogEvent.ROLE_CREATE, "Role", "created"]],
  [A.RoleUpdate, [LogEvent.ROLE_UPDATE, "Role", "changed"]],
  [A.RoleDelete, [LogEvent.ROLE_DELETE, "Role", "deleted"]],
  [A.InviteCreate, [LogEvent.INVITE_UPDATE, "Invite", "created"]],
  [A.InviteUpdate, [LogEvent.INVITE_UPDATE, "Invite", "changed"]],
  [A.InviteDelete, [LogEvent.INVITE_UPDATE, "Invite", "deleted"]],
  [A.WebhookCreate, [LogEvent.WEBHOOK_UPDATE, "Webhook", "created"]],
  [A.WebhookUpdate, [LogEvent.WEBHOOK_UPDATE, "Webhook", "changed"]],
  [A.WebhookDelete, [LogEvent.WEBHOOK_UPDATE, "Webhook", "deleted"]],
  [A.EmojiCreate, [LogEvent.EMOJI_UPDATE, "Emoji", "added"]],
  [A.EmojiUpdate, [LogEvent.EMOJI_UPDATE, "Emoji", "changed"]],
  [A.EmojiDelete, [LogEvent.EMOJI_UPDATE, "Emoji", "deleted"]],
  [A.StickerCreate, [LogEvent.EMOJI_UPDATE, "Sticker", "added"]],
  [A.StickerUpdate, [LogEvent.EMOJI_UPDATE, "Sticker", "changed"]],
  [A.StickerDelete, [LogEvent.EMOJI_UPDATE, "Sticker", "deleted"]],
  [A.SoundboardSoundCreate, [LogEvent.EMOJI_UPDATE, "Soundboard sound", "added"]],
  [A.SoundboardSoundUpdate, [LogEvent.EMOJI_UPDATE, "Soundboard sound", "changed"]],
  [A.SoundboardSoundDelete, [LogEvent.EMOJI_UPDATE, "Soundboard sound", "deleted"]],
  [A.ThreadCreate, [LogEvent.THREAD_UPDATE, "Thread", "created"]],
  [A.ThreadUpdate, [LogEvent.THREAD_UPDATE, "Thread", "changed"]],
  [A.ThreadDelete, [LogEvent.THREAD_UPDATE, "Thread", "deleted"]],
  [A.GuildScheduledEventCreate, [LogEvent.EVENT_UPDATE, "Event", "scheduled"]],
  [A.GuildScheduledEventUpdate, [LogEvent.EVENT_UPDATE, "Event", "changed"]],
  [A.GuildScheduledEventDelete, [LogEvent.EVENT_UPDATE, "Event", "cancelled"]],
  [A.BotAdd, [LogEvent.INTEGRATION_UPDATE, "Bot", "added"]],
  [A.IntegrationCreate, [LogEvent.INTEGRATION_UPDATE, "App", "added"]],
  [A.IntegrationUpdate, [LogEvent.INTEGRATION_UPDATE, "App", "changed"]],
  [A.IntegrationDelete, [LogEvent.INTEGRATION_UPDATE, "App", "removed"]],
  [A.ApplicationCommandPermissionUpdate, [LogEvent.INTEGRATION_UPDATE, "App command permissions", "changed"]],
  [A.AutoModerationRuleCreate, [LogEvent.AUTOMOD_RULE_UPDATE, "AutoMod rule", "created"]],
  [A.AutoModerationRuleUpdate, [LogEvent.AUTOMOD_RULE_UPDATE, "AutoMod rule", "changed"]],
  [A.AutoModerationRuleDelete, [LogEvent.AUTOMOD_RULE_UPDATE, "AutoMod rule", "deleted"]],
  [A.MessagePin, [LogEvent.MESSAGE_PIN, "Message", "pinned"]],
  [A.MessageUnpin, [LogEvent.MESSAGE_PIN, "Message", "unpinned"]],
]);

// The server-log event an audit log entry belongs to, or undefined if the
// server log doesn't post it (bans, kicks and the like are moderation cases).
export const eventOfAuditEntry = (entry) => ACTIONS.get(entry?.action)?.[0];

const COLORS = {
  created: LogColor.created,
  added: LogColor.created,
  scheduled: LogColor.created,
  deleted: LogColor.deleted,
  removed: LogColor.deleted,
  cancelled: LogColor.deleted,
  pinned: LogColor.pinned,
  unpinned: LogColor.pinned,
};

// --- Values -----------------------------------------------------------------------

const CHANNEL_TYPES = {
  [ChannelType.GuildText]: "Text",
  [ChannelType.GuildVoice]: "Voice",
  [ChannelType.GuildCategory]: "Category",
  [ChannelType.GuildAnnouncement]: "Announcement",
  [ChannelType.AnnouncementThread]: "Announcement thread",
  [ChannelType.PublicThread]: "Thread",
  [ChannelType.PrivateThread]: "Private thread",
  [ChannelType.GuildStageVoice]: "Stage",
  [ChannelType.GuildForum]: "Forum",
  [ChannelType.GuildMedia]: "Media",
};
const VERIFICATION_LEVELS = ["None", "Low", "Medium", "High", "Highest"];
const CONTENT_FILTER = ["Off", "Members without roles", "Everyone"];
const NOTIFICATIONS = ["All messages", "Only mentions"];
const MFA_LEVELS = ["Off", "2FA required for moderators"];

// Readable names for change keys. Anything else is "some_key" -> "Some key".
const LABELS = {
  name: "Name",
  topic: "Topic",
  nsfw: "Age-restricted",
  rate_limit_per_user: "Slowmode",
  default_thread_rate_limit_per_user: "Thread slowmode",
  bitrate: "Bitrate",
  user_limit: "User limit",
  parent_id: "Category",
  position: "Position",
  type: "Type",
  rtc_region: "Voice region",
  video_quality_mode: "Video quality",
  default_auto_archive_duration: "Threads hide after",
  auto_archive_duration: "Hides after",
  archived: "Archived",
  locked: "Locked",
  invitable: "Members can invite",
  color: "Colour",
  hoist: "Shown separately",
  mentionable: "Mentionable",
  permissions: "Permissions",
  allow: "Allowed",
  deny: "Denied",
  icon_hash: "Icon",
  unicode_emoji: "Emoji icon",
  splash_hash: "Invite background",
  discovery_splash_hash: "Discovery background",
  banner_hash: "Banner",
  avatar_hash: "Avatar",
  owner_id: "Owner",
  afk_channel_id: "AFK channel",
  afk_timeout: "AFK timeout",
  mfa_level: "2FA for moderators",
  verification_level: "Verification level",
  explicit_content_filter: "Media filter",
  default_message_notifications: "Default notifications",
  vanity_url_code: "Vanity link",
  system_channel_id: "System messages channel",
  rules_channel_id: "Rules channel",
  public_updates_channel_id: "Community updates channel",
  safety_alerts_channel_id: "Safety alerts channel",
  widget_enabled: "Widget",
  widget_channel_id: "Widget channel",
  preferred_locale: "Language",
  premium_progress_bar_enabled: "Boost progress bar",
  description: "Description",
  code: "Code",
  channel_id: "Channel",
  inviter_id: "Created by",
  max_uses: "Max uses",
  uses: "Uses",
  max_age: "Expires after",
  temporary: "Temporary membership",
  tags: "Related emoji",
  format_type: "Format",
  available: "Available",
  location: "Location",
  scheduled_start_time: "Starts",
  scheduled_end_time: "Ends",
  status: "Status",
  entity_type: "Where",
  privacy_level: "Privacy",
  enabled: "Enabled",
  event_type: "Runs on",
  trigger_type: "Trigger",
  trigger_metadata: "Words and settings",
  actions: "Actions",
  exempt_roles: "Exempt roles",
  exempt_channels: "Exempt channels",
  emoji_name: "Emoji",
  volume: "Volume",
  flags: "Flags",
  available_tags: "Forum tags",
  applied_tags: "Tags",
  default_reaction_emoji: "Default reaction",
  default_sort_order: "Sort order",
  default_forum_layout: "Layout",
  sound_id: "Sound",
};
// Keys that say nothing useful on their own.
const SKIPPED = new Set(["id", "guild_id", "permission_overwrites", "deny_new", "allow_new", "nsfw_level", "system_channel_flags"]);
const MAX_CHANGES = 15;

const labelOf = (key) => LABELS[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1).replace(/_/g, " ")}`;
const none = "*none*";

// "ManageMessages" -> "Manage Messages"
const permissionName = (name) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
export function permissionNames(bits) {
  try {
    return new PermissionsBitField(BigInt(bits ?? 0)).toArray().map(permissionName);
  } catch {
    return [];
  }
}

function seconds(value, { zero = "Off" } = {}) {
  const number = Number(value);
  return number > 0 ? formatDuration(number * 1000) : zero;
}

function listOf(ids, mention) {
  return Array.isArray(ids) && ids.length > 0 ? capList(ids.map(mention), { separator: " " }) : none;
}

function formatValue(key, value, entry) {
  if (value === undefined || value === null || value === "") {
    return none;
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  switch (key) {
    case "color":
      return Number(value) === 0 ? "Default" : `#${Number(value).toString(16).padStart(6, "0")}`;
    case "type":
      return entry.targetType === "Channel" || entry.targetType === "Thread" ? (CHANNEL_TYPES[value] ?? String(value)) : String(value);
    case "rate_limit_per_user":
    case "default_thread_rate_limit_per_user":
      return seconds(value);
    case "afk_timeout":
      return seconds(value);
    case "max_age":
      return seconds(value, { zero: "Never" });
    case "max_uses":
      return Number(value) === 0 ? "No limit" : String(value);
    case "default_auto_archive_duration":
    case "auto_archive_duration":
      return formatDuration(Number(value) * 60 * 1000);
    case "bitrate":
      return `${Math.round(Number(value) / 1000)} kbps`;
    case "user_limit":
      return Number(value) === 0 ? "No limit" : String(value);
    case "verification_level":
      return VERIFICATION_LEVELS[value] ?? String(value);
    case "explicit_content_filter":
      return CONTENT_FILTER[value] ?? String(value);
    case "default_message_notifications":
      return NOTIFICATIONS[value] ?? String(value);
    case "mfa_level":
      return MFA_LEVELS[value] ?? String(value);
    case "exempt_roles":
      return listOf(value, (id) => `<@&${id}>`);
    case "exempt_channels":
      return listOf(value, (id) => `<#${id}>`);
    case "scheduled_start_time":
    case "scheduled_end_time": {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : quote(value);
    }
    default:
      break;
  }
  if (key.endsWith("_hash")) {
    return "*image*";
  }
  if (key.endsWith("_id")) {
    if (key.includes("channel") || key === "parent_id") {
      return `<#${value}>`;
    }
    if (key === "owner_id" || key === "inviter_id") {
      return `<@${value}>`;
    }
    return quote(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? none : `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    return "*changed*";
  }
  return quote(value);
}

// One line per change. Permission changes list what was added and removed.
function describeChange(change, entry, created) {
  const { key } = change;
  if (key === "permissions" || key === "allow" || key === "deny") {
    const before = new Set(permissionNames(change.old));
    const after = permissionNames(change.new);
    const added = after.filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.includes(name));
    const label = labelOf(key);
    const lines = [];
    if (added.length > 0) {
      lines.push(`**${label}${created ? "" : " added"}:** ${capList(added)}`);
    }
    if (removed.length > 0) {
      lines.push(`**${label} removed:** ${capList(removed)}`);
    }
    return lines;
  }
  if (Array.isArray(change.old) || Array.isArray(change.new)) {
    const listKey = key === "exempt_roles" || key === "exempt_channels";
    if (!listKey) {
      const count = (value) => (Array.isArray(value) ? value.length : 0);
      return [`**${labelOf(key)}:** ${count(change.old)} → ${count(change.new)}`];
    }
  }
  if (created || !("old" in change)) {
    return [`**${labelOf(key)}:** ${formatValue(key, change.new, entry)}`];
  }
  if (!("new" in change)) {
    return [`**${labelOf(key)}:** ${formatValue(key, change.old, entry)} → ${none}`];
  }
  return [`**${labelOf(key)}:** ${formatValue(key, change.old, entry)} → ${formatValue(key, change.new, entry)}`];
}

// The value of `key` in the entry's changes (after the change, else before).
const changed = (entry, key) => {
  const change = entry.changes?.find((item) => item.key === key);
  return change ? (change.new ?? change.old) : undefined;
};

// --- What it's about -----------------------------------------------------------

// The channel an entry is about (for ignored channels), or undefined.
export function channelOfAuditEntry(entry, guild) {
  if (entry.targetType === "Channel" || entry.targetType === "Thread") {
    const channel = guild?.channels?.cache.get(entry.targetId);
    return channel ?? { id: entry.targetId, parentId: changed(entry, "parent_id") ?? null };
  }
  const channelId = entry.extra?.channel?.id ?? changed(entry, "channel_id");
  if (channelId) {
    return guild?.channels?.cache.get(channelId) ?? { id: channelId };
  }
  return undefined;
}

function subjectOf(entry, guild) {
  const name = changed(entry, "name");
  const id = entry.targetId;
  switch (entry.targetType) {
    case "Channel":
    case "Thread": {
      const exists = guild?.channels?.cache.has(id);
      return exists ? `<#${id}>${name ? ` (${quote(name)})` : ""}` : quote(`#${name ?? entry.target?.name ?? id}`);
    }
    case "Role": {
      const exists = guild?.roles?.cache.has(id);
      return exists ? `<@&${id}>` : quote(name ?? entry.target?.name ?? id);
    }
    case "Emoji": {
      const emojiName = name ?? entry.target?.name;
      const exists = guild?.emojis?.cache.get(id);
      return exists ? `${exists.toString()} ${quote(emojiName ?? id)}` : quote(emojiName ?? id);
    }
    case "Invite": {
      const code = changed(entry, "code") ?? entry.target?.code;
      return code ? `discord.gg/${code}` : "";
    }
    case "User":
      return id ? `<@${id}>` : "";
    case "Guild":
      return "";
    case "Message": {
      const channelId = entry.extra?.channel?.id;
      const messageId = entry.extra?.messageId;
      const link = channelId && messageId && guild ? ` · [Jump to message](https://discord.com/channels/${guild.id}/${channelId}/${messageId})` : "";
      return `${id ? `from <@${id}> ` : ""}in <#${channelId}>${link}`;
    }
    default:
      return quote(name ?? entry.target?.name ?? id ?? "");
  }
}

// The embed for an audit log entry, or undefined when the server log doesn't
// post that kind of entry.
export function buildServerChangeEmbed(entry, guild, options = DEFAULT_LOG_OPTIONS) {
  const known = ACTIONS.get(entry?.action);
  if (!known) {
    return undefined;
  }
  const [, what, verb] = known;
  const created = ["created", "added", "scheduled"].includes(verb);
  const subject = subjectOf(entry, guild);
  const lines = [];

  // Whose permissions a channel overwrite is for.
  if (entry.action === A.ChannelOverwriteCreate || entry.action === A.ChannelOverwriteUpdate || entry.action === A.ChannelOverwriteDelete) {
    const target = entry.extra;
    const isRole = target && (target.type === 0 || target.type === "0" || target.permissions !== undefined || target.name !== undefined);
    if (target?.id) {
      const who = target.id === guild?.id ? "@everyone" : isRole ? `<@&${target.id}>` : `<@${target.id}>`;
      lines.push(`**For:** ${who}`);
    }
  }
  if (entry.action === A.BotAdd && entry.targetId) {
    lines.push(`**Bot:** <@${entry.targetId}>`);
  }

  const changes = (entry.changes ?? []).filter((change) => !SKIPPED.has(change.key));
  // A created or deleted thing lists what it was made with; its name is in the title already.
  const shown = changes.filter((change) => !((created || verb === "deleted" || verb === "removed") && change.key === "name"));
  const details = shown.slice(0, MAX_CHANGES).flatMap((change) => describeChange(change, entry, created));
  if (shown.length > MAX_CHANGES) {
    details.push(`*…and ${shown.length - MAX_CHANGES} more changes.*`);
  }
  const by = byLine(entry);
  if (by) {
    lines.push(by);
  }

  const ids = [];
  if (entry.executorId) {
    ids.push(`By ID ${entry.executorId}`);
  }
  if (entry.targetId && entry.targetType !== "Guild") {
    ids.push(`${entry.targetType === "Message" ? "Author" : what.split(" ")[0]} ID ${entry.targetId}`);
  }
  return buildLogEntry(
    {
      color: COLORS[verb] ?? LogColor.changed,
      title: `**${what} ${verb}**${subject ? ` · ${subject}` : ""}`,
      // Changes are the point of an update, so they stay in compact entries.
      lines: verb === "changed" ? [...lines, ...details] : lines,
      details: verb === "changed" ? [] : details,
      user: entry.executor ?? undefined,
      ids,
    },
    options,
  );
}
