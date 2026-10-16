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
// and then to pick those changes up. Without a database (as in tests and
// `npm run register`) nothing is saved.

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
  WELCOME_DM: "welcomeDm", // text DMed to new members; unset = no DM
  AUTOROLES: "autoroleIds", // roles given to every new member, a list of IDs
  ROLE_PANELS: "rolePanels", // button role panels, a list of objects (see community/rolePanels.js)
  TAGS: "tags", // custom commands for /tag, a list of { name, content } (see community/tags.js)
  STARBOARD: "starboard", // the starboard, { channelId, threshold, emoji } (see community/starboard.js)
  LEVELING: "leveling", // leveling and XP, an object (see leveling/config.js)
  TICKETS: "tickets", // the ticket panel, { channelId, messageId, staffRoleId } (see tickets/tickets.js)
  JOIN_GATE: "joinGate", // new-account gate and join alerts, an object (see raid/raid.js)
  LOCKDOWN: "lockdown", // a running /raid lockdown and what to restore, an object (see raid/raid.js)
  TEMP_VOICE: "tempVoice", // join-to-create voice, { hubChannelId, categoryId, nameTemplate, userLimit } (see voice/tempVoice.js)
  AUTO_RESPONDERS: "autoResponders", // auto-responders, a list of { trigger, match, reply, channelId } (see community/autoResponders.js)
});

const KNOWN_SETTINGS = new Set(Object.values(Setting));

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
        // Changes whenever another connection (the dashboard) writes to the database.
        dataVersion: db.prepare("PRAGMA data_version"),
      };
      this.#readAll();
    }
  }

  #readAll() {
    this.#dataVersion = this.#statements.dataVersion.get().data_version;
    this.#guilds.clear();
    for (const row of this.#statements.all.all()) {
      this.#remember(row.guild_id, row.key, JSON.parse(row.value));
    }
  }

  // Re-reads the settings if another process changed the database since the
  // last read. Cheap enough to call before every request. Returns whether it re-read.
  reloadIfChanged() {
    if (!this.#statements || this.#statements.dataVersion.get().data_version === this.#dataVersion) {
      return false;
    }
    this.#readAll();
    return true;
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

  #write(guildId, setting, value) {
    this.#statements?.upsert.run(guildId, setting, JSON.stringify(value));
    this.#remember(guildId, setting, value);
  }

  #remember(guildId, setting, value) {
    this.#guilds.set(guildId, { ...this.#guilds.get(guildId), [setting]: value });
  }
}
