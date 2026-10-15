// The list of countries a user can pick, and how typed text is matched to one.
//
// Names come from the ISO 3166-1 list in the i18n-iso-countries package. Each
// country has one official name (used as the role name) plus other accepted
// spellings ("USA", "UK", "Czechia").

import isoCountries from "i18n-iso-countries";

// Discord allows at most 100 characters in role names and autocomplete choices.
export const MAX_NAME_LENGTH = 100;

// A few ISO names are formal or awkward ("Taiwan, Province of China"), so these
// countries use their common name instead. The ISO name is still accepted.
const NAME_OVERRIDES = {
  BN: "Brunei",
  FK: "Falkland Islands",
  FM: "Micronesia",
  IR: "Iran",
  LA: "Laos",
  MD: "Moldova",
  MK: "North Macedonia",
  PS: "Palestine",
  RU: "Russia",
  SY: "Syria",
  TW: "Taiwan",
  TZ: "Tanzania",
  US: "United States",
  VA: "Vatican City",
  VG: "British Virgin Islands",
  VI: "U.S. Virgin Islands",
};

// Characters that separate words in a country name, for "starts a word" matches.
const WORD_SEPARATORS = /[\s,().'-]+/;

// Makes two spellings comparable: ignores case, accents, extra spaces and the
// style of apostrophe. "  CÔTE d’Ivoire " becomes "cote d'ivoire".
export function normalizeName(text) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // strip accents
    .replace(/[‘’ʼ`´]/g, "'") // curly quotes -> '
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export class CountryList {
  // `countries` is an array of { code, name, aliases }.
  constructor(countries) {
    this.countries = [...countries].sort((a, b) => a.name.localeCompare(b.name, "en"));
    this.byName = new Map();

    this.#addOfficialNames();
    this.#addAliases();
  }

  // Finds the country for what the user typed, or returns null.
  // This is the real validation; autocomplete is only a convenience.
  find(input) {
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_NAME_LENGTH * 2) {
      return null;
    }
    return this.byName.get(normalizeName(input)) ?? null;
  }

  // Returns up to `limit` countries matching `query`, best matches first.
  // An empty query returns the first countries alphabetically.
  search(query, limit) {
    if (limit <= 0) {
      return [];
    }
    const normalizedQuery = normalizeName(query.slice(0, MAX_NAME_LENGTH));
    if (!normalizedQuery) {
      return this.countries.slice(0, limit);
    }

    return this.countries
      .map((country) => ({ country, score: matchScore(country, normalizedQuery) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.country.name.localeCompare(b.country.name, "en"))
      .slice(0, limit)
      .map((match) => match.country);
  }

  #addOfficialNames() {
    for (const country of this.countries) {
      const key = normalizeName(country.name);
      if (this.byName.has(key)) {
        throw new Error(`Two countries share the name "${country.name}"`);
      }
      if (country.name.length > MAX_NAME_LENGTH) {
        throw new Error(`Country name is too long for Discord: "${country.name}"`);
      }
      this.byName.set(key, country);
    }
  }

  // Adds the other spellings. A spelling that belongs to more than one country
  // (plain "Congo") is skipped, so we never guess which one the user meant.
  #addAliases() {
    const owners = new Map();
    for (const country of this.countries) {
      for (const alias of country.aliases) {
        const key = normalizeName(alias);
        if (!key || this.byName.has(key)) {
          continue;
        }
        const owner = owners.get(key);
        owners.set(key, owner && owner !== country ? "ambiguous" : country);
      }
    }
    for (const [key, owner] of owners) {
      if (owner !== "ambiguous") {
        this.byName.set(key, owner);
      }
    }
  }
}

// Higher score = better match. 0 means no match.
function matchScore(country, query) {
  const name = normalizeName(country.name);
  const aliases = country.aliases.map(normalizeName);

  if (name === query) return 6;
  if (aliases.includes(query)) return 5;
  if (name.startsWith(query)) return 4;
  if (name.split(WORD_SEPARATORS).some((word) => word.startsWith(query))) return 3;
  if (aliases.some((alias) => alias.startsWith(query))) return 2;
  if (name.includes(query)) return 1;
  return 0;
}

// Reads the ISO list and returns [{ code: "CA", name: "Canada", aliases: [...] }, ...].
export function loadIsoCountries() {
  const namesByCode = isoCountries.getNames("en", { select: "all" });

  return Object.entries(namesByCode).map(([code, isoNames]) => {
    const cleanNames = isoNames.map((name) => name.replace(/\s+/g, " ").trim());
    const name = NAME_OVERRIDES[code] ?? cleanNames[0];
    return { code, name, aliases: [...new Set([name, ...cleanNames])] };
  });
}

export const countryList = new CountryList(loadIsoCountries());
