// Starts the bot. Slash commands are registered separately with `npm run register`.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { createCommands } from "./commands/index.js";
import { ConfigError, loadBotConfig } from "./config.js";
import { createInteractionHandler } from "./interactionHandler.js";
import { ChannelSettings } from "./settings/channelSettings.js";
import { logger, registerSecret } from "./utils/logger.js";

// Log unexpected errors instead of letting them silently kill the bot.
process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection", { error });
});
process.on("uncaughtException", (error) => {
  logger.error("Unexpected crash, shutting down", { error });
  process.exit(1);
});

async function start() {
  const config = loadBotConfig();
  registerSecret(config.token);

  // The Guilds intent is all the bot needs: it keeps servers, roles and the
  // bot's own member info up to date. No privileged intents.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const channelSettings = await ChannelSettings.load();
  const commands = createCommands({ logger, channelSettings, forcedLanguage: config.forcedLanguage });
  const handleInteraction = createInteractionHandler({ commands, logger, forcedLanguage: config.forcedLanguage });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info("Bot is online", {
      user: readyClient.user.tag,
      servers: readyClient.guilds.cache.size,
      language: config.forcedLanguage ?? "each user's Discord language",
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction).catch((error) => logger.error("Interaction handler crashed", { error }));
  });

  // If the channel /country was limited to is deleted, allow any channel again
  // instead of leaving the command unusable.
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.guildId && channelSettings.get(channel.guildId) === channel.id) {
      channelSettings
        .clear(channel.guildId)
        .then(() => logger.info("The /country channel was deleted; /country now works in any channel", { guildId: channel.guildId }))
        .catch((error) => logger.error("Couldn't clear the deleted /country channel", { error }));
    }
  });

  client.on(Events.Error, (error) => logger.error("Discord client error", { error }));
  client.on(Events.Warn, (message) => logger.warn("Discord client warning", { message }));

  // discord.js waits and retries automatically when Discord rate-limits us.
  client.rest.on("rateLimited", (info) => {
    logger.warn("Rate limited by Discord; retrying automatically", {
      route: info.route,
      retryAfterMs: info.retryAfter,
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      logger.info("Shutting down");
      await client.destroy().catch(() => {});
      process.exit(0);
    });
  }

  await client.login(config.token);
}

start().catch((error) => {
  if (error instanceof ConfigError) {
    logger.error(error.message);
  } else {
    logger.error("The bot couldn't start", { error });
  }
  process.exit(1);
});
