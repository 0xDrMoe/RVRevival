import { describe, expect, it } from "vitest";
import {
  CountryList,
  MAX_NAME_LENGTH,
  countryList,
  normalizeName,
} from "../src/countries/countries.js";

describe("country dataset", () => {
  it("contains the ISO 3166-1 countries with unique canonical names within Discord's limits", () => {
    expect(countryList.countries.length).toBeGreaterThanOrEqual(249);
    const keys = new Set(countryList.countries.map((c) => normalizeName(c.name)));
    expect(keys.size).toBe(countryList.countries.length);
    for (const country of countryList.countries) {
      expect(country.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(country.name).toBe(country.name.trim());
    }
  });

  it("uses common short names instead of awkward ISO forms", () => {
    expect(countryList.find("Taiwan, Province of China")?.name).toBe("Taiwan");
    expect(countryList.find("United States of America")?.name).toBe("United States");
    expect(countryList.find("Moldova, Republic of")?.name).toBe("Moldova");
  });
});

describe("countryList.find", () => {
  it("accepts a valid country and returns its canonical name", () => {
    expect(countryList.find("Canada")).toMatchObject({ code: "CA", name: "Canada" });
  });

  it.each(["canada", "Canada", "CANADA", "  canada  ", "\tCaNaDa\n"])(
    "normalizes %j to Canada",
    (input) => {
      expect(countryList.find(input)?.name).toBe("Canada");
    },
  );

  it("collapses internal whitespace and ignores diacritics and apostrophe style", () => {
    expect(countryList.find("united    KINGDOM")?.name).toBe("United Kingdom");
    expect(countryList.find("cote d’ivoire")?.code).toBe("CI");
    expect(countryList.find("CÔTE D'IVOIRE")?.code).toBe("CI");
  });

  it("accepts dataset aliases but resolves them to the canonical name", () => {
    expect(countryList.find("usa")?.name).toBe("United States");
    expect(countryList.find("UK")?.name).toBe("United Kingdom");
    expect(countryList.find("Turkey")?.code).toBe("TR");
  });

  it.each(["Atlantis", "Canadaa", "Narnia", "DROP TABLE roles", "@everyone", "<@&123456789012345678>"])(
    "rejects unknown country %j",
    (input) => {
      expect(countryList.find(input)).toBeNull();
    },
  );

  it("handles malformed input without throwing", () => {
    expect(countryList.find("")).toBeNull();
    expect(countryList.find("    ")).toBeNull();
    expect(countryList.find(null)).toBeNull();
    expect(countryList.find(undefined)).toBeNull();
    expect(countryList.find(42)).toBeNull();
    expect(countryList.find({ name: "Canada" })).toBeNull();
    expect(countryList.find("x".repeat(10_000))).toBeNull();
    expect(countryList.find("\u0000Canada")).toBeNull();
  });

  it("does not resolve aliases shared by multiple countries", () => {
    // "Congo" is an ISO alias of both CG and CD.
    expect(countryList.find("Congo")).toBeNull();
    expect(countryList.find("Republic of the Congo")?.code).toBe("CG");
    expect(countryList.find("Democratic Republic of the Congo")?.code).toBe("CD");
  });

  it("rejects duplicate canonical names when building a registry", () => {
    expect(
      () =>
        new CountryList([
          { code: "AA", name: "Same", aliases: ["Same"] },
          { code: "BB", name: " same ", aliases: [" same "] },
        ]),
    ).toThrow(/share the name/);
  });
});

describe("countryList.search", () => {
  it("ranks prefix matches first", () => {
    const names = countryList.search("can", 25).map((c) => c.name);
    expect(names[0]).toBe("Canada");
  });

  it("matches aliases", () => {
    expect(countryList.search("uk", 25)[0]?.name).toBe("United Kingdom");
    expect(countryList.search("usa", 25)[0]?.name).toBe("United States");
  });

  it("is case and whitespace insensitive", () => {
    expect(countryList.search("  GERM ", 25)[0]?.name).toBe("Germany");
  });

  it("respects the limit and returns alphabetical results for an empty query", () => {
    const results = countryList.search("", 25);
    expect(results).toHaveLength(25);
    expect(results[0]?.name).toBe("Afghanistan");
    expect(countryList.search("a", 3)).toHaveLength(3);
    expect(countryList.search("a", 0)).toHaveLength(0);
  });

  it("returns nothing for gibberish", () => {
    expect(countryList.search("zzzzqqq", 25)).toEqual([]);
  });
});
