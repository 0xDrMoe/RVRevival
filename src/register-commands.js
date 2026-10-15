// Registers the bot's slash commands with Discord. Run it once, and again
// whenever a command's name, description or options change:
//
//   npm run register                    only in DISCORD_GUILD_ID (shows up instantly)
//   npm run register -- --global        in every server the bot is in (can take an hour)
//   npm run register -- --clear-guild   remove the commands from DISCORD_GUILD_ID
//   npm run register -- --clear-global  remove the global commands
//
// Each run replaces the whole list of commands in that scope.

import { REST, Routes } from "discord.js";
import { createCommands } from "./commands/index.js";
import { ConfigError, loadRegisterConfig } from "./config.js";
import { ChannelSettings } from "./settings/channelSettings.js";
import { logger, registerSecret } from "./utils/logger.js";

const MODES = {
  "": { global: false, clear: false },
  "--global": { global: true, clear: false },
  "--clear-guild": { global: false, clear: true },
  "--clear-global": { global: true, clear: true },
};

function readMode(args) {
  const flag = args[0] ?? "";
  if (args.length > 1 || !(flag in MODES)) {
    throw new ConfigError("Use no option, or one of: --global, --clear-guild, --clear-global.");
  }
  return MODES[flag];
}

async function register() {
  const mode = readMode(process.argv.slice(2));
  const config = loadRegisterConfig(process.env, { needsGuildId: !mode.global });
  registerSecret(config.token);

  const commands = mode.clear ? [] : [...createCommands({ logger, channelSettings: new ChannelSettings() }).values()].map((command) => command.data);
  const route = mode.global
    ? Routes.applicationCommands(config.clientId)
    : Routes.applicationGuildCommands(config.clientId, config.guildId);

  await new REST().setToken(config.token).put(route, { body: commands });

  const where = mode.global ? "globally (may take up to an hour to appear)" : `in server ${config.guildId}`;
  if (mode.clear) {
    logger.info(`Removed all commands ${where}`);
  } else {
    logger.info(`Registered commands ${where}`, { commands: commands.map((command) => command.name) });
  }
}

register().catch((error) => {
  if (error instanceof ConfigError) {
    logger.error(error.message);
  } else {
    logger.error("Registering commands failed", { error });
  }
  process.exitCode = 1;
});
