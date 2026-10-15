import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LANGUAGES,
  discordLocalizations,
  getTranslations,
  pickLanguage,
  translate,
} from "../src/i18n/i18n.js";
import { STAFF_MESSAGES } from "../src/commands/countryStaff.js";
import { Outcome } from "../src/roles/countryRoles.js";

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("language files", () => {
  const english = getTranslations("en");

  it("has a file for every supported language and no others", () => {
    const files = readdirSync(new URL("../src/i18n/locales/", import.meta.url)).map((file) => file.replace(".json", ""));
    expect(files.sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "es", "de", "fr", "pt", "it", "ar"]);
  });

  it.each(SUPPORTED_LANGUAGES)("%s has exactly the same keys and placeholders as English", (language) => {
    const messages = getTranslations(language);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(messages)) {
      expect(text.trim(), `${language}.${key}`).not.toBe("");
      expect(placeholders(text), `${language}.${key}`).toEqual(placeholders(english[key]));
    }
  });

  it("has a message for every possible outcome", () => {
    for (const outcome of Object.values(Outcome)) {
      expect(english).toHaveProperty(outcome);
    }
    for (const key of Object.values(STAFF_MESSAGES)) {
      expect(english).toHaveProperty(key);
    }
  });

  it("keeps command descriptions within Discord's 100-character limit", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(translate(language, "commandDescription").length).toBeLessThanOrEqual(100);
      expect(translate(language, "countryOptionDescription").length).toBeLessThanOrEqual(100);
      for (const key of Object.keys(getTranslations("en")).filter((key) => key.endsWith("Description"))) {
        expect(translate(language, key).length, `${language}.${key}`).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("translate", () => {
  it("fills in placeholders", () => {
    expect(translate("en", "assigned", { country: "Canada" })).toBe("Your country role has been set to Canada.");
    expect(translate("de", "assigned", { country: "Kanada" })).toBe("Deine Länderrolle wurde auf Kanada gesetzt.");
    expect(translate("ar", "alreadyAssigned", { country: "Canada" })).toContain("Canada");
  });

  it("falls back to English for an unknown language", () => {
    expect(translate("xx", "guildOnly")).toBe(translate("en", "guildOnly"));
  });

  it("throws for a key that doesn't exist", () => {
    expect(() => translate("en", "noSuchKey")).toThrow(/noSuchKey/);
  });
});

describe("pickLanguage", () => {
  it.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["es-ES", "es"],
    ["es-419", "es"],
    ["de", "de"],
    ["fr", "fr"],
    ["pt-BR", "pt"],
    ["it", "it"],
    ["ja", "en"],
    [undefined, "en"],
  ])("maps Discord locale %s to %s", (discordLocale, language) => {
    expect(pickLanguage(discordLocale)).toBe(language);
  });

  it("uses the forced language for everyone when one is set", () => {
    expect(pickLanguage("de", "ar")).toBe("ar");
    expect(pickLanguage(undefined, "ar")).toBe("ar");
  });
});

describe("discordLocalizations", () => {
  it("maps Discord's locale codes to the translated text", () => {
    const localized = discordLocalizations("commandDescription");
    expect(localized["es-ES"]).toBe(translate("es", "commandDescription"));
    expect(localized["es-419"]).toBe(translate("es", "commandDescription"));
    expect(localized["pt-BR"]).toBe(translate("pt", "commandDescription"));
    expect(Object.keys(localized).sort()).toEqual(["de", "en-GB", "es-419", "es-ES", "fr", "it", "pt-BR"]);
  });
});
