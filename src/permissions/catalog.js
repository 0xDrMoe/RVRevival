// The bot's commands as the dashboard lists them (see commandCatalog in
// commandRules.js), built once from the same command list the bot registers.

import { createCommands } from "../commands/index.js";
import { GuildSettings } from "../settings/guildSettings.js";
import { commandCatalog } from "./commandRules.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let catalog;

export function botCommandCatalog() {
  catalog ??= Object.freeze(commandCatalog(createCommands({ logger: quiet, guildSettings: new GuildSettings() })));
  return catalog;
}
