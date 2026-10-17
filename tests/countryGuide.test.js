import { describe, expect, it } from "vitest";
import { checkGuide, DEFAULT_GUIDE_COLOR, describeGuide, GUIDE_LIMITS, InvalidGuide, normalizeGuide } from "../src/countries/guide.js";

describe("country guide wording", () => {
  it("keeps only the parts that differ from the built-in guide", () => {
    expect(checkGuide({ title: "  Pick your flag  ", intro: "", steps: null, color: 0xeb459e })).toEqual({ title: "Pick your flag", color: 0xeb459e });
    expect(checkGuide({ notes: "a\r\nb" })).toEqual({ notes: "a\nb" });
  });

  it("saves nothing when everything is the built-in text and colour", () => {
    expect(checkGuide({ title: "", color: DEFAULT_GUIDE_COLOR })).toBeNull();
    expect(checkGuide({})).toBeNull();
  });

  it("refuses buttons and anything else it doesn't know", () => {
    expect(() => checkGuide({ buttons: [{ label: "Hacked" }] })).toThrow(InvalidGuide);
    expect(() => checkGuide({ components: [] })).toThrow(/buttons can't be changed/);
  });

  it("refuses text that's too long, not text, or a bad colour", () => {
    expect(() => checkGuide({ title: "x".repeat(GUIDE_LIMITS.title + 1) })).toThrow(InvalidGuide);
    expect(() => checkGuide({ notes: "x".repeat(GUIDE_LIMITS.notes + 1) })).toThrow(InvalidGuide);
    expect(() => checkGuide({ intro: 5 })).toThrow(InvalidGuide);
    expect(() => checkGuide({ color: 0x1000000 })).toThrow(InvalidGuide);
    expect(() => checkGuide({ color: "red" })).toThrow(InvalidGuide);
    expect(() => checkGuide([])).toThrow(InvalidGuide);
  });

  it("fills in every part when reading a saved guide", () => {
    expect(normalizeGuide({ title: "Hi" })).toEqual({ title: "Hi", intro: null, stepsTitle: null, steps: null, notesTitle: null, notes: null, color: null });
    expect(normalizeGuide(undefined).title).toBeNull();
  });

  it("describes which parts are customised, for the logs channel", () => {
    expect(describeGuide({ title: "Hi", color: 0xeb459e })).toBe("custom title · colour #eb459e");
    expect(describeGuide(null)).toBe("built-in");
  });
});
