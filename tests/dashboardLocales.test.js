import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const folder = new URL("../src/dashboard/public/locales/", import.meta.url);
const read = (language) => JSON.parse(readFileSync(new URL(`${language}.json`, folder), "utf8"));
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const languages = readdirSync(folder).map((file) => file.replace(".json", ""));

describe("dashboard language files", () => {
  const english = read("en");

  it("has the same seven languages as the bot", () => {
    expect(languages.sort()).toEqual(["ar", "de", "en", "es", "fr", "it", "pt"]);
  });

  it.each(languages)("%s has exactly the same keys and placeholders as English", (language) => {
    const strings = read(language);
    expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(strings)) {
      expect(text.trim(), `${language}.${key}`).not.toBe("");
      expect(placeholders(text), `${language}.${key}`).toEqual(placeholders(english[key]));
    }
  });

  it("has every string the page asks for by name", () => {
    const page = readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8");
    const named = [...page.matchAll(/\bt\("(\w+)"/g), ...page.matchAll(/\bfield\("(\w+)"(?:, "(\w+)")?/g)]
      .flatMap((match) => match.slice(1))
      .filter(Boolean);
    for (const key of new Set(named)) {
      expect(english, key).toHaveProperty(key);
    }
  });
});
