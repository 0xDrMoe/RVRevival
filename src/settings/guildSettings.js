// Per-server settings that admins choose with /settings. They're saved in the
// bot's SQLite database (data/bot.db, table guild_settings), one row per
// setting, so they survive restarts and a future dashboard can read them.
//
// Older versions saved settings in data/settings.json (and before that, only the
// /country channel in data/country-channels.json). The first time this version
// starts, those are copied into the database and the JSON file is renamed to
// settings.json.migrated as a backup.
//
// Settings are also kept in memory, so reading one never touches the disk. The
// dashboard changes them from another process, so call reloadIfChanged() now
// and then to pick those changes up: it re-reads only the servers whose
// settings changed (table settings_changes, kept up to date by triggers).
// Without a database (as in tests and `npm run register`) nothing is saved.
//
// Values handed out are shared, so never change one in place: build a new
// value and set() it. derived() caches what's worked out from a setting (such
// as a normalized config) until the setting changes.

import { readFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inTransaction } from "../storage/database.js";

export const DEFAULT_SETTINGS_FILE = fileURLToPath(new URL("../../data/settings.json", import.meta.url));

// Older versions only stored the /country channel, as { "<server id>": "<channel id>" }.
export const LEGACY_CHANNELS_FILE = fileURLToPath(new URL("../../data/country-channels.json", import.meta.url));

// The settings a server can have. Most hold one ID; the comments say otherwise.
export const Setting = Object.freeze({
  COUNTRY_CHANNEL: "countryChannelId",
  STAFF_ROLE: "staffRoleId",
  MOD_ROLE: "modRoleId",
  LOGS_CHANNEL: "logsChannelId",
  MOD_LOG_CHANNEL: "modLogChannelId",
  SERVER_LOG_CHANNEL: "serverLogChannelId",
  DISABLED_LOG_EVENTS: "disabledLogEvents", // server-log events switched off, a list of names
  LOG_IGNORED_CHANNELS: "logIgnoredChannels", // channels the server log skips, a list of IDs
  DASHBOARD_ROLES: "dashboardRoleIds", // roles that may see the dashboard and manage cases, a list of IDs
  AUTOMOD: "automod", // the automod configuration, an object (see automod/config.js)
  WELCOME_CHANNEL: "welcomeChannelId",
  WELCOME_MESSAGE: "welcomeMessage", // text with {user}, {username}, {server} and {count}; unset = the default
  LEAVE_CHANNEL: "leaveChannelId",
  LEAVE_MESSAGE: "leaveMessage", // like WELCOME_MESSAGE
  WELCOME_DM: "welcomeDm", // text DMed to new members; unset = no DM (unless there's a DM embed)
  WELCOME_EMBED: "welcomeEmbed", // an embed sent with the welcome message, an object (see community/welcomeEmbeds.js)
  LEAVE_EMBED: "leaveEmbed", // like WELCOME_EMBED, for the leave message
  WELCOME_DM_EMBED: "welcomeDmEmbed", // like WELCOME_EMBED, for the welcome DM
  AUTOROLES: "autoroleIds", // roles given to every new member, a list of IDs
  ROLE_PANELS: "rolePanels", // button role panels, a list of objects (see community/rolePanels.js)
  ROLE_CONFIRM: "roleConfirmations", // false: role panels and the country picker don't ask members to confirm by default (see roles/roleConfirmations.js)
  TAGS: "tags", // custom commands for /tag, a list of { name, content } (see community/tags.js)
  STARBOARD: "starboard", // the starboard, { channelId, threshold, emoji } (see community/starboard.js)
  LEVELING: "leveling", // leveling and XP, an object (see leveling/config.js)
  WEEKLY_BOARD_CHANNEL: "weeklyBoardChannelId", // where the weekly leaderboard is posted each Monday; unset = not posted (see leveling/weeklyBoard.js)
  WEEKLY_BOARD_ROLE: "weeklyBoardRoleId", // role the week's top member holds until the next post; unset = none
  TICKETS: "tickets", // the ticket panel, { channelId, messageId, staffRoleId, title, message } (see tickets/tickets.js)
  TICKET_PANEL: "ticketPanel", // how the ticket panel looks and what tickets start with, an object (see tickets/panel.js)
  TICKET_CATEGORIES: "ticketCategories", // the panel's kinds of ticket, [{ id, label, emoji, description, staffRoleId, style, intro, nameFormat, pingStaff, questions }] (see tickets/categories.js)
  TICKET_LOG_CHANNEL: "ticketLogChannelId", // where ticket events are posted; unset = the mod-log channel (see tickets/ticketLog.js)
  DISABLED_TICKET_LOG_EVENTS: "disabledTicketLogEvents", // ticket events not posted, a list of names (they're still saved)
  TICKET_SUPPORT: "ticketSupport", // auto-close after inactivity and ratings, { autoCloseHours, ratings } (see tickets/support.js)
  WARN_THRESHOLDS: "warnThresholds", // automatic timeout, kick or ban after N /warn cases in D days, [{ count, days, action, minutes }] (see moderation/warnThresholds.js)
  JOIN_GATE: "joinGate", // new-account gate and join alerts, an object (see raid/raid.js)
  LOCKDOWN: "lockdown", // a running /raid lockdown and what to restore, an object (see raid/raid.js)
  TEMP_VOICE: "tempVoice", // join-to-create voice, { hubChannelId, categoryId, nameTemplate, userLimit } (see voice/tempVoice.js)
  BIRTHDAYS: "birthdays", // birthday greetings and role, { channelId, roleId, message, timezone } (see birthdays/config.js)
  AUTO_RESPONDERS: "autoResponders", // auto-responders, a list of { trigger, match, reply, channelId } (see community/autoResponders.js)
  APPEALS: "appeals", // ban appeals on the dashboard, { enabled, channelId, questions, cooldownDays } (see appeals/config.js)
  ROLE_PERSIST: "rolePersist", // give roles back on rejoin, { enabled, ignoredRoleIds } (see members/rolePersistence.js)
  QUARANTINE_ROLE: "quarantineRoleId", // given to quarantined members (see moderation/quarantine.js)
  ANTI_NUKE: "antiNuke", // anti-nuke limits, punishment and trusted users, an object (see raid/antiNuke.js)
  STATS_COUNTERS: "statsCounters", // server stats channels, a list of { id, template, channelId, categoryId, error } (see stats/statsCounters.js)
  MEDIA_ONLY: "mediaOnly", // media-only channels, { channelIds, allowLinks } (see community/mediaOnly.js)
  SETUP_SKIPPED: "setupSkipped", // dashboard setup steps the server chose not to do, a list of names (see dashboard/settingsRules.js)
  COMMAND_RULES: "commandRules", // per-command rules, { command: { disabled, roleIds, blockedRoleIds, channelIds } } (see permissions/commandRules.js)
  LOG_ROUTES: "logRoutes", // a log channel per kind of entry, { route: channelId } (see logs/logRoutes.js)
  PERMISSION_PRESET: "permissionPreset", // the premade permission setup last applied, a name (see permissions/presets.js)
  NATIVE_PERMISSIONS: "nativePermissions", // false: Discord permissions alone don't let members use the bot's commands (see permissions/commandRules.js)
  BOT_INVITER: "botInviterId", // who added the bot, from the audit log; may change permissions like the owner
  COUNTRY_GUIDE: "countryGuide", // the /country-help guide's wording and colour, an object (see countries/guide.js)
  COUNTRY_ROLES: "countryRoles", // what members pick (countries or regions), hidden places and self-removal, an object (see countries/options.js)
  COUNTRY_GUIDE_POST: "countryGuidePost", // the last guide posted, { channelId, messageId }, so the dashboard can update it
  BRANDING: "branding", // the bot's look in this server, { color } (see branding/branding.js)
});

const KNOWN_SETTINGS = new Set(Object.values(Setting));

// guildSettings.derived(), or a plain derive(get()) for stand-ins without it (tests).
export function derivedSetting(guildSettings, guildId, setting, derive) {
  return typeof guildSettings?.derived === "function"
    ? guildSettings.derived(guildId, setting, derive)
    : derive(guildSettings?.get(guildId, setting));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

// Parsed JSON, or undefined if the file doesn't exist. A corrupted file throws,
// so the bot refuses to start instead of silently dropping settings.
async function readJson(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(text);
}

export class GuildSettings {
  #db;
  #statements;
  // PRAGMA data_version when the settings were last read.
  #dataVersion;
  // server ID -> { setting: value }
  #guilds = new Map();
  // settings_version when the settings were last read.
  #settingsVersion = 0;
  // derive function -> "<server>:<setting>" -> { raw, value }
  #derived = new Map();

  // `db` is an open database (see storage/database.js), or undefined to keep
  // settings in memory only.
  constructor(db = undefined) {
    this.#db = db;
    if (db) {
      this.#statements = {
        all: db.prepare("SELECT guild_id, key, value FROM guild_settings"),
        upsert: db.prepare(`
          INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?)
          ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value`),
        delete: db.prepare("DELETE FROM guild_settings WHERE guild_id = ? AND key = ?"),
        count: db.prepare("SELECT COUNT(*) AS total FROM guild_settings"),
        guild: db.prepare("SELECT key, value FROM guild_settings WHERE guild_id = ?"),
        // Changes whenever another connection (the dashboard) writes to the database.
        dataVersion: db.prepare("PRAGMA data_version"),
        // Changes whenever anyone writes a setting (database.js migration 29).
        settingsVersion: db.prepare("SELECT version FROM settings_version WHERE id = 1"),
        changedSince: db.prepare("SELECT guild_id FROM settings_changes WHERE version > ?"),
      };
      this.#readAll();
    }
  }

  #currentSettingsVersion() {
    return Number(this.#statements.settingsVersion.get()?.version ?? 0);
  }

  #readAll() {
    this.#dataVersion = this.#statements.dataVersion.get().data_version;
    this.#settingsVersion = this.#currentSettingsVersion();
    this.#guilds.clear();
    for (const row of this.#statements.all.all()) {
      this.#remember(row.guild_id, row.key, JSON.parse(row.value));
    }
  }

  #readGuild(guildId) {
    const values = {};
    for (const row of this.#statements.guild.all(guildId)) {
      values[row.key] = JSON.parse(row.value);
    }
    if (Object.keys(values).length > 0) {
      this.#guilds.set(guildId, values);
    } else {
      this.#guilds.delete(guildId);
    }
  }

  // Re-reads the servers whose settings another process changed since the last
  // read. Cheap enough to call before every request: when nothing else wrote to
  // the database it's one PRAGMA, and when only other tables changed (XP,
  // logins) it's one more tiny query. Returns whether any settings were re-read.
  reloadIfChanged() {
    if (!this.#statements) {
      return false;
    }
    const dataVersion = this.#statements.dataVersion.get().data_version;
    if (dataVersion === this.#dataVersion) {
      return false;
    }
    this.#dataVersion = dataVersion;
    const settingsVersion = this.#currentSettingsVersion();
    if (settingsVersion === this.#settingsVersion) {
      return false;
    }
    const changed = this.#statements.changedSince.all(this.#settingsVersion);
    this.#settingsVersion = settingsVersion;
    for (const { guild_id: guildId } of changed) {
      this.#readGuild(guildId);
    }
    return changed.length > 0;
  }

  // What `derive(value)` gives for this server's setting, worked out once and
  // kept until the setting changes. For hot paths such as automod, which would
  // otherwise normalize the same config on every message. The result is frozen,
  // since every caller shares it.
  derived(guildId, setting, derive) {
    const raw = this.get(guildId, setting);
    let cache = this.#derived.get(derive);
    if (!cache) {
      cache = new Map();
      this.#derived.set(derive, cache);
    }
    const key = `${guildId}:${setting}`;
    const entry = cache.get(key);
    if (entry && entry.raw === raw) {
      return entry.value;
    }
    const value = deepFreeze(derive(raw));
    cache.set(key, { raw, value });
    return value;
  }

  // Every setting of one server, as { setting: value }.
  all(guildId) {
    return { ...this.#guilds.get(guildId) };
  }

  // Reads the saved settings, first copying in any from older versions' JSON files.
  static async load(db, { jsonFile = DEFAULT_SETTINGS_FILE, legacyFile = LEGACY_CHANNELS_FILE } = {}) {
    const settings = new GuildSettings(db);
    if (!db || settings.#statements.count.get().total > 0) {
      return settings;
    }

    const saved = jsonFile ? await readJson(jsonFile) : undefined;
    const legacy = saved === undefined && legacyFile ? await readJson(legacyFile) : undefined;
    const imported = saved ?? Object.fromEntries(
      Object.entries(legacy ?? {}).map(([guildId, channelId]) => [guildId, { [Setting.COUNTRY_CHANNEL]: channelId }]),
    );
    const rows = Object.entries(imported).flatMap(([guildId, values]) =>
      Object.entries(values)
        .filter(([key]) => KNOWN_SETTINGS.has(key))
        .map(([key, value]) => [guildId, key, value]),
    );
    if (rows.length > 0) {
      inTransaction(db, () => {
        for (const [guildId, key, value] of rows) {
          settings.#write(guildId, key, value);
        }
      });
    }
    if (saved !== undefined) {
      // Keep the old file as a backup, but stop reading it.
      await rename(jsonFile, `${jsonFile}.migrated`);
    }
    return settings;
  }

  // The value of `setting` in this server, or undefined if it isn't set.
  get(guildId, setting) {
    return this.#guilds.get(guildId)?.[setting];
  }

  // A list setting (such as LOG_IGNORED_CHANNELS); empty if it isn't set.
  getList(guildId, setting) {
    return this.get(guildId, setting) ?? [];
  }

  async set(guildId, setting, value) {
    if (!KNOWN_SETTINGS.has(setting)) {
      throw new Error(`Unknown setting "${setting}"`);
    }
    this.#write(guildId, setting, value);
  }

  // Adds `item` to a list setting, or removes it if it's already there.
  // Returns true if it was added.
  async toggleInList(guildId, setting, item) {
    const list = this.getList(guildId, setting);
    const added = !list.includes(item);
    const next = added ? [...list, item] : list.filter((entry) => entry !== item);
    if (next.length > 0) {
      await this.set(guildId, setting, next);
    } else {
      await this.clear(guildId, setting);
    }
    return added;
  }

  async clear(guildId, setting) {
    const values = this.#guilds.get(guildId);
    if (!values || !(setting in values)) {
      return;
    }
    this.#statements?.delete.run(guildId, setting);
    const { [setting]: _removed, ...rest } = values;
    if (Object.keys(rest).length > 0) {
      this.#guilds.set(guildId, rest);
    } else {
      this.#guilds.delete(guildId);
    }
  }

  // Keeps a copy, as read back from JSON, so the caller changing its own object
  // later can't change the saved setting behind derived()'s back.
  #write(guildId, setting, value) {
    const json = JSON.stringify(value);
    this.#statements?.upsert.run(guildId, setting, json);
    this.#remember(guildId, setting, json === undefined ? value : JSON.parse(json));
  }

  #remember(guildId, setting, value) {
    this.#guilds.set(guildId, { ...this.#guilds.get(guildId), [setting]: value });
  }
}
