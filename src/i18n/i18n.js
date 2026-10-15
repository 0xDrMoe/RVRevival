// Translations for every message the bot sends.
//
// Each language lives in ./locales/<code>.json. All files use the same keys;
// "{country}" in a message is replaced with the country name.

import { readFileSync } from "node:fs";

export const DEFAULT_LANGUAGE = "en";
export const SUPPORTED_LANGUAGES = ["en", "es", "de", "fr", "pt", "it", "ar"];

// Discord's own locale codes for each language, used to translate the command
// description in Discord's UI. Discord has no Arabic locale, so Arabic can only
// be chosen with the BOT_LANGUAGE setting.
const DISCORD_LOCALES = {
  en: ["en-GB"], // en-US is the default description, so it isn't listed
  es: ["es-ES", "es-419"],
  de: ["de"],
  fr: ["fr"],
  pt: ["pt-BR"],
  it: ["it"],
  ar: [],
};

const translations = {};
for (const language of SUPPORTED_LANGUAGES) {
  const file = new URL(`./locales/${language}.json`, import.meta.url);
  translations[language] = JSON.parse(readFileSync(file, "utf8"));
}

export function getTranslations(language) {
  return translations[language];
}

// Chooses the reply language.
// 1. BOT_LANGUAGE, if the server owner set one.
// 2. The language of the user's Discord app ("es-ES" -> "es").
// 3. English.
export function pickLanguage(discordLocale, forcedLanguage) {
  if (forcedLanguage) {
    return forcedLanguage;
  }
  const language = String(discordLocale ?? "").split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
}

// Returns the message for `key` in `language`, falling back to English.
export function translate(language, key, values = {}) {
  const message = translations[language]?.[key] ?? translations[DEFAULT_LANGUAGE][key];
  if (message === undefined) {
    throw new Error(`No translation for "${key}"`);
  }
  return message.replace(/\{(\w+)\}/g, (placeholder, name) =>
    name in values ? String(values[name]) : placeholder,
  );
}

// Builds Discord's { "es-ES": "...", "de": "..." } map for a command text.
export function discordLocalizations(key) {
  const localizations = {};
  for (const [language, discordLocales] of Object.entries(DISCORD_LOCALES)) {
    for (const discordLocale of discordLocales) {
      localizations[discordLocale] = translate(language, key);
    }
  }
  return localizations;
}
