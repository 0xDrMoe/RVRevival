// Per-server settings that admins choose with /settings. They're saved to a
// JSON file so they survive restarts:
//
//   { "<server id>": { "countryChannelId": "<channel id>", "staffRoleId": "<role id>", "logsChannelId": "<channel id>" }, ... }
//
// Without a file path (as in tests and `npm run register`) nothing is saved.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SETTINGS_FILE = fileURLToPath(new URL("../../data/settings.json", import.meta.url));

// Older versions only stored the /country channel, as { "<server id>": "<channel id>" }.
export const LEGACY_CHANNELS_FILE = fileURLToPath(new URL("../../data/country-channels.json", import.meta.url));

// The settings a server can have.
export const Setting = Object.freeze({
  COUNTRY_CHANNEL: "countryChannelId",
  STAFF_ROLE: "staffRoleId",
  LOGS_CHANNEL: "logsChannelId",
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
  #file;
  #guilds;

  constructor(file = undefined, guilds = {}) {
    this.#file = file;
    this.#guilds = new Map(Object.entries(guilds).map(([guildId, values]) => [guildId, { ...values }]));
  }

  // Reads the saved settings. A missing file just means nothing is set yet. If
  // only the older country-channels file exists, its channels are carried over.
  static async load(file = DEFAULT_SETTINGS_FILE, legacyFile = LEGACY_CHANNELS_FILE) {
    const saved = await readJson(file);
    if (saved !== undefined) {
      return new GuildSettings(file, saved);
    }

    const settings = new GuildSettings(file);
    const legacy = legacyFile ? await readJson(legacyFile) : undefined;
    if (legacy) {
      for (const [guildId, channelId] of Object.entries(legacy)) {
        settings.#guilds.set(guildId, { [Setting.COUNTRY_CHANNEL]: channelId });
      }
      await settings.#save();
    }
    return settings;
  }

  // The value of `setting` in this server, or undefined if it isn't set.
  get(guildId, setting) {
    return this.#guilds.get(guildId)?.[setting];
  }

  async set(guildId, setting, value) {
    if (!KNOWN_SETTINGS.has(setting)) {
      throw new Error(`Unknown setting "${setting}"`);
    }
    this.#guilds.set(guildId, { ...this.#guilds.get(guildId), [setting]: value });
    await this.#save();
  }

  async clear(guildId, setting) {
    const values = this.#guilds.get(guildId);
    if (!values || !(setting in values)) {
      return;
    }
    const { [setting]: _removed, ...rest } = values;
    if (Object.keys(rest).length > 0) {
      this.#guilds.set(guildId, rest);
    } else {
      this.#guilds.delete(guildId);
    }
    await this.#save();
  }

  async #save() {
    if (!this.#file) {
      return;
    }
    // Write a temporary file first, so a crash mid-write can't corrupt the settings.
    const temporary = `${this.#file}.tmp`;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.#guilds), null, 2) + "\n");
    await rename(temporary, this.#file);
  }
}
