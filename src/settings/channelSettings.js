// Remembers which channel each server allows /country in. Admins choose it with
// /country-channel; it's saved to a JSON file so it survives restarts:
//
//   { "<server id>": "<channel id>", ... }
//
// Without a file path (as in tests and `npm run register`) nothing is saved.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SETTINGS_FILE = fileURLToPath(new URL("../../data/country-channels.json", import.meta.url));

export class ChannelSettings {
  #file;
  #channels;

  constructor(file = undefined, channels = {}) {
    this.#file = file;
    this.#channels = new Map(Object.entries(channels));
  }

  // Reads the saved settings. A missing file just means nothing is set yet.
  static async load(file = DEFAULT_SETTINGS_FILE) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return new ChannelSettings(file);
      }
      throw error;
    }
    return new ChannelSettings(file, JSON.parse(text));
  }

  // The channel /country is limited to in this server, or undefined for any channel.
  get(guildId) {
    return this.#channels.get(guildId);
  }

  async set(guildId, channelId) {
    this.#channels.set(guildId, channelId);
    await this.#save();
  }

  async clear(guildId) {
    if (this.#channels.delete(guildId)) {
      await this.#save();
    }
  }

  async #save() {
    if (!this.#file) {
      return;
    }
    // Write a temporary file first, so a crash mid-write can't corrupt the settings.
    const temporary = `${this.#file}.tmp`;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.#channels), null, 2) + "\n");
    await rename(temporary, this.#file);
  }
}
