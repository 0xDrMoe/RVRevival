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
    ]);
    for (const command of commands.values()) {
      expect(command.data.name).toBe(command.name);
      expect(command.data.description.length).toBeGreaterThan(0);
    }
  });
});
