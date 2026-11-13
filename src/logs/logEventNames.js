// What each server-log event, group and option is called, in each language.
// The names are the Logging page's (dashboard/public/locales), so /settings
// and the dashboard always use the same words.

import { readFileSync } from "node:fs";
import { DISCORD_LOCALES } from "../i18n/i18n.js";

const folder = new URL("../dashboard/public/locales/", import.meta.url);
const pages = new Map();

function pageText(language) {
  if (!pages.has(language)) {
    let text = {};
    try {
      if (!/^[a-z]{2}$/.test(language)) {
        throw new Error("Not a language code");
      }
      text = JSON.parse(readFileSync(new URL(`${language}.json`, folder), "utf8"));
    } catch {
      // An unknown language falls back to English below.
    }
    pages.set(language, text);
  }
  return pages.get(language);
}

const lookUp = (language, key) => pageText(language)[key] ?? pageText("en")[key];

export const logEventName = (event, language = "en") => lookUp(language, `logEvent_${event}`) ?? event;
export const logGroupName = (group, language = "en") => lookUp(language, `logRoute_${group}`) ?? group;
export const logOptionName = (option, language = "en") => lookUp(language, `logOption_${option}`) ?? option;

// Discord's name_localizations for a name, worked out per language.
export function nameLocalizations(nameOf) {
  const localizations = {};
  for (const [language, locales] of Object.entries(DISCORD_LOCALES)) {
    for (const locale of locales) {
      localizations[locale] = nameOf(language).slice(0, 100);
    }
  }
  return localizations;
}
