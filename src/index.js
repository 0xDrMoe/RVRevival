// Starts the bot. Slash commands are registered separately with `npm run register`.

import { Client, Events, GatewayCloseCodes, GatewayIntentBits, Partials } from "discord.js";
import { createAutomod } from "./automod/automod.js";
import { normalizeAutomod } from "./automod/config.js";
import { createCountryChannelGuard } from "./channels/countryChannelGuard.js";
import { createCommands } from "./commands/index.js";
import { ConfigError, loadBotConfig } from "./config.js";
import { createInteractionHandler } from "./interactionHandler.js";
import { createActionLog } from "./logs/actionLog.js";
import { createLogChannelPoster } from "./logs/logChannel.js";
import { RecentIds } from "./logs/recentIds.js";
import { createServerLog } from "./logs/serverLog.js";
import { CaseStore } from "./moderation/caseStore.js";
import { createExternalActionRecorder } from "./moderation/externalActions.js";
import { createModLog } from "./moderation/modLog.js";
import { createModerationService } from "./moderation/moderationService.js";
import { createTempBanScheduler } from "./moderation/tempBans.js";
import { GuildSettings, Setting } from "./settings/guildSettings.js";
import { closeDatabase, DEFAULT_DATABASE_FILE, openDatabase } from "./storage/database.js";
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
// date. GuildMessages lets the bot see new, edited and deleted messages (the
// /country channel, the server log). GuildModeration reports bans, including
// ones done outside the bot.
//
// Two are privileged and must be switched on in the Developer Portal (Bot >
// Privileged Gateway Intents): MessageContent shows what edited and deleted
// messages said; GuildMembers reports joins, leaves, nickname, role and timeout
// changes. If one is off, the bot starts without it instead of staying offline.
const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration];
const PRIVILEGED_INTENT_SETS = [
  [GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
  [GatewayIntentBits.GuildMembers],
  [GatewayIntentBits.MessageContent],
  [],
];
const INTENT_NAMES = {
  [GatewayIntentBits.GuildMembers]: "Server Members Intent",
  [GatewayIntentBits.MessageContent]: "Message Content Intent",
};

// Partials let the bot hear about messages and members it hadn't cached, such
// as a message deleted that was posted before the bot started.
const PARTIALS = [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User];

async function start() {
  const config = loadBotConfig();
  registerSecret(config.token);

  // Settings and moderation cases live in data/bot.db (SQLite).
  const db = openDatabase(DEFAULT_DATABASE_FILE);
  const guildSettings = await GuildSettings.load(db);
  const store = new CaseStore(db);
  // Pick up settings changed on the web dashboard (another process).
  const settingsReload = setInterval(() => {
    try {
      guildSettings.reloadIfChanged();
    } catch (error) {
      logger.error("Couldn't re-read the settings", { error });
    }
  }, 5_000);
  settingsReload.unref();
  const forcedLanguage = config.forcedLanguage;

  // What the bot did itself, so the events Discord sends back aren't logged twice.
  const botDeletions = new RecentIds();
  const botActions = new RecentIds();

  const poster = createLogChannelPoster({ guildSettings, logger });
  // Posts what members do with the bot in each server's logs channel (/settings logs-channel).
  const actionLog = createActionLog({ guildSettings, logger, poster });
  // Posts cases in the mod-log channel, and server events in the server-log channel.
  const modLog = createModLog({ poster, store });
  const serverLog = createServerLog({ poster, botDeletions, guildSettings });
  const moderation = createModerationService({ store, modLog, logger, forcedLanguage, botActions });
  const externalActions = createExternalActionRecorder({ moderation, botActions, logger });

  // Automod (/settings automod): spam, banned words, invites, links, mentions, capitals.
  const automod = createAutomod({ guildSettings, moderation, modLog, logger, forcedLanguage, botDeletions });

  const commands = createCommands({ logger, guildSettings, forcedLanguage, moderation, modLog, botDeletions });
  const handleInteraction = createInteractionHandler({ commands, logger, forcedLanguage, actionLog });
  const guardCountryChannel = createCountryChannelGuard({ guildSettings, logger, actionLog, botDeletions });

  // If the /country channel is deleted, allow any channel again instead of
  // leaving the command unusable. If a log channel is deleted, stop posting there.
  const CHANNEL_SETTINGS = [
    [Setting.COUNTRY_CHANNEL, "The /country channel was deleted; /country now works in any channel"],
    [Setting.LOGS_CHANNEL, "The logs channel was deleted; set a new one with /settings logs-channel"],
    [Setting.MOD_LOG_CHANNEL, "The mod-log channel was deleted; cases go to the logs channel until a new one is set"],
    [Setting.SERVER_LOG_CHANNEL, "The server-log channel was deleted; set a new one with /settings server-log-channel"],
  ];

  // Runs an event handler, logging instead of crashing if it fails.
  const safely = (what, handler) => (...args) => {
    Promise.resolve()
      .then(() => handler(...args))
      .catch((error) => logger.error(`Couldn't handle ${what}`, { error }));
  };

  // Drops a deleted role or channel from automod's exemptions.
  function forgetAutomodExemption(guildId, list, id) {
    const saved = guildId && guildSettings.get(guildId, Setting.AUTOMOD);
    if (!saved) {
      return;
    }
    const config = normalizeAutomod(saved);
    if (config[list].includes(id)) {
      guildSettings
        .set(guildId, Setting.AUTOMOD, { ...config, [list]: config[list].filter((entry) => entry !== id) })
        .catch((error) => logger.error("Couldn't remove a deleted role or channel from automod", { error }));
    }
  }

  let client;
  let tempBans;

  function connect(intents) {
    client = new Client({ intents, partials: PARTIALS });
    const readsContent = intents.includes(GatewayIntentBits.MessageContent);
    const seesMembers = intents.includes(GatewayIntentBits.GuildMembers);

    client.once(Events.ClientReady, (readyClient) => {
      logger.info("Bot is online", {
        user: readyClient.user.tag,
        servers: readyClient.guilds.cache.size,
        language: config.forcedLanguage ?? "each user's Discord language",
        messageContentInLogs: readsContent,
        memberEventsInLogs: seesMembers,
      });
      tempBans?.stop();
      tempBans = createTempBanScheduler({ client: readyClient, moderation, botActions, logger });
      tempBans.start();
    });

    client.on(Events.InteractionCreate, (interaction) => {
      handleInteraction(interaction).catch((error) => logger.error("Interaction handler crashed", { error }));
    });

    // Delete every message posted in the /country channel, except the bot's own.
    client.on(Events.MessageCreate, (message) => {
      guardCountryChannel(message).catch((error) => logger.error("Couldn't clean the /country channel", { error }));
    });
    client.on(Events.MessageCreate, safely("automod", (message) => automod.handleMessage(message)));

    // The server log (/settings server-log-channel).
    client.on(Events.MessageDelete, safely("a deleted message", (message) => serverLog.messageDeleted(message)));
    client.on(
      Events.MessageBulkDelete,
      safely("a bulk delete", (messages, channel) => serverLog.messagesBulkDeleted(messages, channel)),
    );
    client.on(Events.MessageUpdate, safely("an edited message", (before, after) => serverLog.messageEdited(before, after)));
    client.on(Events.MessageUpdate, safely("automod on an edit", (before, after) => automod.handleEdit(before, after)));
    client.on(Events.GuildMemberAdd, safely("a member joining", (member) => serverLog.memberJoined(member)));
    client.on(
      Events.GuildMemberRemove,
      safely("a member leaving", async (member) => {
        await serverLog.memberLeft(member);
        await externalActions.onMemberRemove(member);
      }),
    );
    client.on(
      Events.GuildMemberUpdate,
      safely("a member update", async (before, after) => {
        await serverLog.memberUpdated(before, after);
        await externalActions.onMemberUpdate(before, after);
      }),
    );

    // Bans and unbans done outside the bot still get a case.
    client.on(Events.GuildBanAdd, safely("a ban", (ban) => externalActions.onBan(ban)));
    client.on(Events.GuildBanRemove, safely("an unban", (ban) => externalActions.onUnban(ban)));

    client.on(Events.ChannelDelete, (channel) => {
      // A deleted channel no longer needs ignoring in the server log.
      if (channel.guildId && guildSettings.getList(channel.guildId, Setting.LOG_IGNORED_CHANNELS).includes(channel.id)) {
        guildSettings
          .toggleInList(channel.guildId, Setting.LOG_IGNORED_CHANNELS, channel.id)
          .catch((error) => logger.error("Couldn't forget a deleted ignored channel", { error }));
      }
      forgetAutomodExemption(channel.guildId, "exemptChannelIds", channel.id);
      for (const [setting, message] of CHANNEL_SETTINGS) {
        if (channel.guildId && guildSettings.get(channel.guildId, setting) === channel.id) {
          guildSettings
            .clear(channel.guildId, setting)
            .then(() => logger.info(message, { guildId: channel.guildId }))
            .catch((error) => logger.error("Couldn't clear a deleted channel from the settings", { setting, error }));
        }
      }
    });

    // Forget a deleted staff, mod or dashboard role, so settings never point at a role that is gone.
    client.on(Events.GuildRoleDelete, (role) => {
      for (const setting of [Setting.STAFF_ROLE, Setting.MOD_ROLE]) {
        if (guildSettings.get(role.guild.id, setting) === role.id) {
          guildSettings
            .clear(role.guild.id, setting)
            .then(() => logger.info("A role chosen in /settings was deleted; choose a new one", { guildId: role.guild.id, setting }))
            .catch((error) => logger.error("Couldn't clear a deleted role from the settings", { setting, error }));
        }
      }
      forgetAutomodExemption(role.guild.id, "exemptRoleIds", role.id);
      if (guildSettings.getList(role.guild.id, Setting.DASHBOARD_ROLES).includes(role.id)) {
        guildSettings
          .toggleInList(role.guild.id, Setting.DASHBOARD_ROLES, role.id)
          .catch((error) => logger.error("Couldn't remove a deleted dashboard role", { error }));
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
      tempBans?.stop();
      automod.stop();
      await client?.destroy().catch(() => {});
      closeDatabase(db);
      process.exit(0);
    });
  }

  // Try with both privileged intents first, then without whichever is switched off.
  for (const [index, privileged] of PRIVILEGED_INTENT_SETS.entries()) {
    try {
      await connect([...BASE_INTENTS, ...privileged]).login(config.token);
      const missing = PRIVILEGED_INTENT_SETS[0].filter((intent) => !privileged.includes(intent));
      if (missing.length > 0) {
        logger.warn(
          `Running without: ${missing.map((intent) => INTENT_NAMES[intent]).join(", ")}. ` +
            "Without Message Content, logs can't show what edited or deleted messages said; without Server Members, " +
            "joins, leaves, role, nickname and timeout changes aren't logged. Turn them on in the Developer Portal " +
            "(Bot > Privileged Gateway Intents) and restart the bot.",
        );
      }
      return;
    } catch (error) {
      await client.destroy().catch(() => {});
      if (!isDisallowedIntentsError(error) || index === PRIVILEGED_INTENT_SETS.length - 1) {
        throw error;
      }
    }
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
