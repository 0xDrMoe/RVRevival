// What members can pick on a server: specific countries, or only continents
// and regions. Servers choose on the dashboard's Country page
// (Setting.COUNTRY_ROLES), and can also take places off the list and let
// members remove their own role.
//
// Saved as { mode, hidden, memberRemove }, every part optional:
//   mode          "countries" (the default) or "regions"
//   hidden        codes members can't pick: ISO country codes ("US"), used
//                 when picking countries, and region IDs ("europe"), used when
//                 picking regions (see continents.js)
//   memberRemove  true lets members remove their own country or region role,
//                 so they can pick again. Off by default: only staff change it.

import { CONTINENTS } from "./continents.js";
import { CountryList, countryList } from "./countries.js";
import { SUPPORTED_LANGUAGES, translate } from "../i18n/i18n.js";

export const PlaceMode = Object.freeze({
  COUNTRIES: "countries",
  REGIONS: "regions",
});
export const PLACE_MODES = Object.values(PlaceMode);

// The kind of role a place gives, so countries and regions are counted apart.
export const PlaceKind = Object.freeze({
  COUNTRY: "country",
  REGION: "region",
});

// The translation key of each region's name.
export const REGION_KEYS = Object.freeze({
  africa: "continentAfrica",
  asia: "continentAsia",
  europe: "continentEurope",
  "north-america": "continentNorthAmerica",
  "south-america": "continentSouthAmerica",
  oceania: "continentOceania",
});

// Regions as places, like countries: the English name is the role name, and
// the name in every bot language is accepted when typed.
export const regionList = new CountryList(
  CONTINENTS.map((code) => {
    const name = translate("en", REGION_KEYS[code]);
    return { code, name, kind: PlaceKind.REGION, aliases: [...new Set(SUPPORTED_LANGUAGES.map((language) => translate(language, REGION_KEYS[code])))] };
  }),
);

const COUNTRY_CODES = new Set(countryList.countries.map((country) => country.code));
const REGION_CODES = new Set(CONTINENTS);

// The kind of role a place gives (countries from countries.js have no kind).
export const kindOf = (place) => place?.kind ?? PlaceKind.COUNTRY;

export class InvalidCountryOptions extends Error {
  name = "InvalidCountryOptions";
}

// The saved options with every part present.
export function normalizeCountryOptions(saved) {
  const options = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return {
    mode: PLACE_MODES.includes(options.mode) ? options.mode : PlaceMode.COUNTRIES,
    hidden: Array.isArray(options.hidden) ? options.hidden.filter((code) => COUNTRY_CODES.has(code) || REGION_CODES.has(code)) : [],
    memberRemove: options.memberRemove === true,
  };
}

// Checks options from the dashboard. Returns what to save, or null when they
// match the defaults. Throws InvalidCountryOptions.
export function checkCountryOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCountryOptions("Send the country options as an object.");
  }
  const unknown = Object.keys(value).find((key) => !["mode", "hidden", "memberRemove"].includes(key));
  if (unknown) {
    throw new InvalidCountryOptions(`The country options have no "${unknown}" part.`);
  }
  const mode = value.mode ?? PlaceMode.COUNTRIES;
  if (!PLACE_MODES.includes(mode)) {
    throw new InvalidCountryOptions("Pick countries or regions.");
  }
  const hidden = value.hidden ?? [];
  if (!Array.isArray(hidden) || hidden.length > COUNTRY_CODES.size + REGION_CODES.size) {
    throw new InvalidCountryOptions("Send the hidden places as a list.");
  }
  const bad = hidden.find((code) => typeof code !== "string" || !(COUNTRY_CODES.has(code) || REGION_CODES.has(code)));
  if (bad !== undefined) {
    throw new InvalidCountryOptions("One of the hidden places isn't a country or region.");
  }
  if (value.memberRemove !== undefined && typeof value.memberRemove !== "boolean") {
    throw new InvalidCountryOptions("Send whether members can remove their role as true or false.");
  }
  const cleaned = { mode, hidden: [...new Set(hidden)].sort(), memberRemove: value.memberRemove === true };
  // Members must be left something to pick in the chosen mode.
  if (placesFor(cleaned).countries.length === 0) {
    throw new InvalidCountryOptions(
      mode === PlaceMode.REGIONS ? "Leave at least one region members can pick." : "Leave at least one country members can pick.",
    );
  }
  const saved = {};
  if (cleaned.mode !== PlaceMode.COUNTRIES) saved.mode = cleaned.mode;
  if (cleaned.hidden.length > 0) saved.hidden = cleaned.hidden;
  if (cleaned.memberRemove) saved.memberRemove = true;
  return Object.keys(saved).length > 0 ? saved : null;
}

// The places members can pick with these options, as a CountryList (find,
// search, countries). `lists` swaps in other base lists (tests). Filtered lists
// are cached, since every pick asks for one.
const caches = new WeakMap();
const MAX_CACHED = 200;
export function placesFor(saved, { countries = countryList, regions = regionList } = {}) {
  const options = normalizeCountryOptions(saved);
  const base = options.mode === PlaceMode.REGIONS ? regions : countries;
  const hidden = new Set(options.hidden);
  if (!base.countries.some((place) => hidden.has(place.code))) {
    return base;
  }
  let cache = caches.get(base);
  if (!cache) {
    cache = new Map();
    caches.set(base, cache);
  }
  // Only this mode's hidden places, in order, so equal lists share a cache entry.
  const key = base.countries.filter((place) => hidden.has(place.code)).map((place) => place.code).sort().join(",");
  let list = cache.get(key);
  if (!list) {
    list = new CountryList(base.countries.filter((place) => !hidden.has(place.code)));
    if (cache.size >= MAX_CACHED) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, list);
  }
  return list;
}

// For the logs channel.
export function describeCountryOptions(value) {
  const options = normalizeCountryOptions(value);
  return [
    options.mode === PlaceMode.REGIONS ? "continents and regions" : "countries",
    options.hidden.length > 0 ? `${options.hidden.length} hidden` : "none hidden",
    options.memberRemove ? "members can remove their role" : "only staff remove roles",
  ].join(" · ");
}
