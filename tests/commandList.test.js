import { describe, expect, it } from "vitest";
import { createCommands } from "../src/commands/index.js";
import { GuildSettings } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

describe("command list", () => {
  it("builds every command for registration, without a database", () => {
    const commands = createCommands({ logger: fakeLogger(), guildSettings: new GuildSettings() });
    expect([...commands.keys()]).toEqual([
      "country",
      "country-staff",
      "country-help",
      "settings",
      "ban",
      "unban",
      "kick",
      "timeout",
      "untimeout",
      "softban",
      "note",
      "warn",
      "purge",
      "case",
      "modlogs",
      "clearwarns",
      "lock",
      "unlock",
      "slowmode",
      "role",
      "nick",
      "welcome",
      "rolepanel",
      "tag",
      "tags",
      "remind",
      "giveaway",
      "starboard",
      "tickets",
      "raid",
      "antinuke",
      "quarantine",
      "temprole",
      "voice",
      "autoresponder",
      "schedule",
      "feed",
      "stats",
      "afk",
      "sticky",
      "highlight",
      "mediaonly",
      "birthday",
      "rank",
      "leaderboard",
      "levels",
    ]);
    for (const command of commands.values()) {
      expect(command.data.name).toBe(command.name);
      expect(command.data.description.length).toBeGreaterThan(0);
    }
  });

  // Discord refuses a command whose names, descriptions and choices add up to
  // more than 4000 characters, counted for each language separately.
  it("keeps every command within Discord's size limit in every language", () => {
    const commands = createCommands({ logger: fakeLogger(), guildSettings: new GuildSettings() });
    for (const locale of [undefined, "en-GB", "es-ES", "es-419", "de", "fr", "pt-BR", "it"]) {
      const localized = (text, translations) => (locale && translations?.[locale]) || text || "";
      const size = (entry) =>
        entry.name.length +
        localized(entry.description, entry.description_localizations).length +
        (entry.choices ?? []).reduce((total, choice) => total + localized(choice.name, choice.name_localizations).length + String(choice.value).length, 0) +
        (entry.options ?? []).reduce((total, option) => total + size(option), 0);
      for (const command of commands.values()) {
        expect(size(command.data), `${command.name} in ${locale ?? "en-US"}`).toBeLessThanOrEqual(4000);
      }
    }
  });
});
