// Starts the bot. Slash commands are registered separately with `npm run register`.

import { Client, Events, GatewayCloseCodes, GatewayIntentBits } from "discord.js";
import { createCountryChannelGuard } from "./channels/countryChannelGuard.js";
import { createCommands } from "./commands/index.js";
import { ConfigError, loadBotConfig } from "./config.js";
import { createInteractionHandler } from "./interactionHandler.js";
import { createActionLog } from "./logs/actionLog.js";
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

// Guilds keeps servers, roles, channels and the bot's own member info up to
// date. GuildMessages lets the bot see new messages, so it can keep the
// /country channel clean. MessageContent (privileged, switched on in the
// Developer Portal) lets the logs channel show what deleted messages said.
const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
const ALL_INTENTS = [...BASE_INTENTS, GatewayIntentBits.MessageContent];

async function start() {
  const config = loadBotConfig();
  registerSecret(config.token);

  const guildSettings = await GuildSettings.load();
  const commands = createCommands({ logger, guildSettings, forcedLanguage: config.forcedLanguage });
  // Posts what members do with the bot in each server's logs channel (/settings logs-channel).
  const actionLog = createActionLog({ guildSettings, logger });
  const handleInteraction = createInteractionHandler({ commands, logger, forcedLanguage: config.forcedLanguage, actionLog });
  const guardCountryChannel = createCountryChannelGuard({ guildSettings, logger, actionLog });

  // If the /country channel is deleted, allow any channel again instead of
  // leaving the command unusable. If the logs channel is deleted, stop logging.
  const CHANNEL_SETTINGS = [
    [Setting.COUNTRY_CHANNEL, "The /country channel was deleted; /country now works in any channel"],
    [Setting.LOGS_CHANNEL, "The logs channel was deleted; set a new one with /settings logs-channel"],
  ];

  let client;

  function connect(intents) {
    client = new Client({ intents });
    const readsContent = intents.includes(GatewayIntentBits.MessageContent);

    client.once(Events.ClientReady, (readyClient) => {
      logger.info("Bot is online", {
        user: readyClient.user.tag,
        servers: readyClient.guilds.cache.size,
        language: config.forcedLanguage ?? "each user's Discord language",
        messageContentInLogs: readsContent,
      });
    });

    client.on(Events.InteractionCreate, (interaction) => {
      handleInteraction(interaction).catch((error) => logger.error("Interaction handler crashed", { error }));
    });

    // Delete every message posted in the /country channel, except the bot's own.
    client.on(Events.MessageCreate, (message) => {
      guardCountryChannel(message).catch((error) => logger.error("Couldn't clean the /country channel", { error }));
    });

    client.on(Events.ChannelDelete, (channel) => {
      for (const [setting, message] of CHANNEL_SETTINGS) {
        if (channel.guildId && guildSettings.get(channel.guildId, setting) === channel.id) {
          guildSettings
            .clear(channel.guildId, setting)
            .then(() => logger.info(message, { guildId: channel.guildId }))
            .catch((error) => logger.error("Couldn't clear a deleted channel from the settings", { setting, error }));
        }
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

    return client;
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      logger.info("Shutting down");
      await client?.destroy().catch(() => {});
      process.exit(0);
    });
  }

  try {
    await connect(ALL_INTENTS).login(config.token);
  } catch (error) {
    if (!isDisallowedIntentsError(error)) {
      throw error;
    }
    // Message Content isn't switched on in the Developer Portal. Run without it
    // instead of staying offline; deleted messages are then logged without their text.
    logger.warn(
      "Message Content intent is off, so the logs channel can't show what deleted messages said. " +
        "Turn it on in the Developer Portal (Bot > Privileged Gateway Intents > Message Content Intent) and restart the bot.",
    );
    await client.destroy().catch(() => {});
    await connect(BASE_INTENTS).login(config.token);
  }
}

// Discord closes the connection with code 4014 when a privileged intent isn't enabled.
function isDisallowedIntentsError(error) {
  return error?.code === GatewayCloseCodes.DisallowedIntents || /disallowed intents/i.test(error?.message ?? "");
}

start().catch((error) => {
  if (error instanceof ConfigError) {
    logger.error(error.message);
  } else {
    logger.error("The bot couldn't start", { error });
  }
  process.exit(1);
});
