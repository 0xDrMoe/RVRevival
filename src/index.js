// Starts the bot. Slash commands are registered separately with `npm run register`.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { createCountryChannelGuard } from "./channels/countryChannelGuard.js";
import { createCommands } from "./commands/index.js";
import { ConfigError, loadBotConfig } from "./config.js";
import { createInteractionHandler } from "./interactionHandler.js";
import { GuildSettings, Setting } from "./settings/guildSettings.js";
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

  // Guilds keeps servers, roles, channels and the bot's own member info up to
  // date. GuildMessages lets the bot see (but not read) new messages, so it can
  // keep the /country channel clean. No privileged intents.
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  const guildSettings = await GuildSettings.load();
  const commands = createCommands({ logger, guildSettings, forcedLanguage: config.forcedLanguage });
  const handleInteraction = createInteractionHandler({ commands, logger, forcedLanguage: config.forcedLanguage });
  const guardCountryChannel = createCountryChannelGuard({ guildSettings, logger });

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

  // Delete every message posted in the /country channel, except the bot's own.
  client.on(Events.MessageCreate, (message) => {
    guardCountryChannel(message).catch((error) => logger.error("Couldn't clean the /country channel", { error }));
  });

  // If the channel /country was limited to is deleted, allow any channel again
  // instead of leaving the command unusable.
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.guildId && guildSettings.get(channel.guildId, Setting.COUNTRY_CHANNEL) === channel.id) {
      guildSettings
        .clear(channel.guildId, Setting.COUNTRY_CHANNEL)
        .then(() => logger.info("The /country channel was deleted; /country now works in any channel", { guildId: channel.guildId }))
        .catch((error) => logger.error("Couldn't clear the deleted /country channel", { error }));
    }
  });

  // Forget a deleted staff role, so /settings show never points at a role that is gone.
  client.on(Events.GuildRoleDelete, (role) => {
    if (guildSettings.get(role.guild.id, Setting.STAFF_ROLE) === role.id) {
      guildSettings
        .clear(role.guild.id, Setting.STAFF_ROLE)
        .then(() => logger.info("The staff role was deleted; set a new one with /settings staff-role", { guildId: role.guild.id }))
        .catch((error) => logger.error("Couldn't clear the deleted staff role", { error }));
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
