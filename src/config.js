// Reads settings from environment variables. `npm start` and `npm run register`
// load them from the .env file.

import { SUPPORTED_LANGUAGES } from "./i18n/i18n.js";

export class ConfigError extends Error {
  name = "ConfigError";
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is missing. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function discordId(env, name) {
  const value = required(env, name);
  if (!/^\d{17,20}$/.test(value)) {
    throw new ConfigError(`${name} should be a Discord ID: 17 to 20 digits.`);
  }
  return value;
}

function botToken(env) {
  const token = required(env, "DISCORD_TOKEN");
  const looksLikeToken = !token.startsWith("Bot ") && !/\s/.test(token) && token.split(".").length === 3;
  if (!looksLikeToken) {
    // Never repeat the value back: it might be a real token with a typo.
    throw new ConfigError('DISCORD_TOKEN doesn\'t look like a bot token. Paste it without quotes or a "Bot " prefix.');
  }
  return token;
}

function botLanguage(env) {
  const language = env.BOT_LANGUAGE?.trim().toLowerCase();
  if (!language) {
    return undefined;
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new ConfigError(`BOT_LANGUAGE must be one of: ${SUPPORTED_LANGUAGES.join(", ")}.`);
  }
  return language;
}

// Settings for running the bot.
export function loadBotConfig(env = process.env) {
  return {
    token: botToken(env),
    forcedLanguage: botLanguage(env),
  };
}

// Settings for registering slash commands.
export function loadRegisterConfig(env = process.env, { needsGuildId }) {
  return {
    token: botToken(env),
    clientId: discordId(env, "DISCORD_CLIENT_ID"),
    guildId: needsGuildId ? discordId(env, "DISCORD_GUILD_ID") : undefined,
  };
}

function dashboardUrl(env) {
  const value = required(env, "DASHBOARD_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("DASHBOARD_URL should be the dashboard's address, like https://rumbleverse.example.com");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new ConfigError("DASHBOARD_URL must start with https:// (http:// is only allowed for localhost).");
  }
  return url.origin;
}

function dashboardPort(env) {
  const value = env.DASHBOARD_PORT?.trim() || "3080";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("DASHBOARD_PORT should be a port number, like 3080.");
  }
  return port;
}

function sessionSecret(env) {
  const secret = required(env, "DASHBOARD_SESSION_SECRET");
  if (secret.length < 32) {
    throw new ConfigError("DASHBOARD_SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32");
  }
  return secret;
}

// Settings for running the web dashboard (npm run dashboard).
export function loadDashboardConfig(env = process.env) {
  return {
    token: botToken(env),
    clientId: discordId(env, "DISCORD_CLIENT_ID"),
    clientSecret: required(env, "DISCORD_CLIENT_SECRET"),
    url: dashboardUrl(env),
    port: dashboardPort(env),
    sessionSecret: sessionSecret(env),
    // The language of the default welcome and leave messages shown on the Community page.
    forcedLanguage: botLanguage(env),
  };
}
