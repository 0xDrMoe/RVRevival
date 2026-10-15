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
