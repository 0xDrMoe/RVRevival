import { describe, expect, it } from "vitest";
import { checkLook, describeLook, fillTemplate, formatThreadName, InvalidPanel, normalizeLook } from "../src/tickets/panel.js";

describe("ticket panel look", () => {
  it("fills every part in, with the defaults for what's missing or broken", () => {
    expect(normalizeLook(undefined)).toMatchObject({ title: null, layout: "buttons", buttonStyle: "primary", pingStaff: true });
    expect(normalizeLook({ title: "  Help  desk ", layout: "grid", color: -1, imageUrl: "javascript:alert(1)", pingStaff: false })).toMatchObject({
      title: "Help desk",
      layout: "buttons",
      color: null,
      imageUrl: null,
      pingStaff: false,
    });
  });

  it("checks dashboard input and saves nothing for the defaults", () => {
    expect(checkLook({})).toBeNull();
    expect(checkLook({ title: "", layout: "buttons", pingStaff: true })).toBeNull();
    const look = checkLook({
      title: "Support",
      description: "Pick one:\n- bugs\n- reports",
      color: 0xff0000,
      authorName: "Rabble",
      authorIconUrl: "https://example.com/a.png",
      imageUrl: "https://example.com/banner.png",
      thumbnailUrl: "https://example.com/t.png",
      footer: "We answer within a day",
      layout: "menu",
      menuPlaceholder: "What's up?",
      buttonLabel: "Get help",
      buttonEmoji: "🆘",
      buttonStyle: "success",
      intro: "Hi {user}, {staff} is on it.",
      nameFormat: "{category}-{number}",
      pingStaff: false,
    });
    expect(look).toMatchObject({ description: "Pick one:\n- bugs\n- reports", layout: "menu", buttonStyle: "success", pingStaff: false });

    const bad = [
      "nope",
      { title: "x".repeat(257) },
      { description: "x".repeat(4097) },
      { imageUrl: "not a link" },
      { thumbnailUrl: "ftp://example.com/t.png" },
      { color: "red" },
      { layout: "grid" },
      { buttonStyle: "pink" },
      { buttonEmoji: "help" },
      { intro: "x".repeat(1501) },
      { nameFormat: "x".repeat(91) },
      { pingStaff: "yes" },
      { title: "x".repeat(256), description: "x".repeat(4096), footer: "x".repeat(2048) },
    ];
    for (const value of bad) {
      expect(() => checkLook(value), JSON.stringify(value).slice(0, 60)).toThrow(InvalidPanel);
    }
  });

  it("describes a look for the log", () => {
    expect(describeLook(null)).toBe("default title · buttons");
    expect(describeLook({ title: "Support", layout: "menu", imageUrl: "https://x.y/z.png", intro: "Hi", pingStaff: false })).toBe(
      'title "Support" · dropdown · images · own intro · no staff ping',
    );
  });

  it("fills placeholders and builds thread names within Discord's limit", () => {
    expect(fillTemplate("{user} #{number} {nope}", { user: "<@1>", number: "7" })).toBe("<@1> #7 {nope}");
    expect(formatThreadName("{category}-{number}", { category: "bugs", number: "0007" })).toBe("bugs-0007");
    expect(formatThreadName(null, { number: "0007", user: "Rumbler" })).toBe("🎫 0007 · Rumbler");
    expect(formatThreadName("{username}", { username: "", number: "0007", user: "Rumbler" })).toBe("🎫 0007 · Rumbler");
    expect(formatThreadName("{user}", { user: "x".repeat(150) })).toHaveLength(100);
  });
});
