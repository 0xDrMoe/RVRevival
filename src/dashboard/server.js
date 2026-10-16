// Starts the web dashboard (npm run dashboard). It runs next to the bot as its
// own process and shares data/bot.db with it. It only listens on this machine;
// Caddy (or nginx) puts it on the internet with HTTPS. See README > Dashboard.

import { ConfigError, loadDashboardConfig } from "../config.js";
import { CaseStore } from "../moderation/caseStore.js";
import { GuildSettings } from "../settings/guildSettings.js";
import { closeDatabase, DEFAULT_DATABASE_FILE, openDatabase } from "../storage/database.js";
import { logger, registerSecret } from "../utils/logger.js";
import { buildDashboard } from "./app.js";
import { createDiscordApi } from "./discordApi.js";

async function start() {
  const config = loadDashboardConfig();
  registerSecret(config.token);
  registerSecret(config.clientSecret);
  registerSecret(config.sessionSecret);

  const db = openDatabase(DEFAULT_DATABASE_FILE);
  // Imports data/settings.json if the bot hasn't yet (see GuildSettings.load).
  const guildSettings = await GuildSettings.load(db);
  const store = new CaseStore(db);
  const discord = createDiscordApi({ config });
  const app = await buildDashboard({ config, db, discord, guildSettings, store, logger });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      logger.info("Dashboard shutting down");
      await app.close().catch(() => {});
      closeDatabase(db);
      process.exit(0);
    });
  }

  await app.listen({ host: "127.0.0.1", port: config.port });
  logger.info("Dashboard is running", { url: config.url, listening: `http://127.0.0.1:${config.port}` });
}

start().catch((error) => {
  if (error instanceof ConfigError) {
    logger.error(error.message);
  } else {
    logger.error("The dashboard couldn't start", { error });
  }
  process.exit(1);
});
