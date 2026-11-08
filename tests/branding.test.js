import { describe, expect, it } from "vitest";
import { accentColor, checkImage, InvalidBranding, MAX_IMAGE_BYTES, normalizeBranding, planBrandingChange } from "../src/branding/branding.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64")}`;
const NONE = { color: null, bio: null };

describe("branding", () => {
  it("keeps only a usable colour and bio", () => {
    expect(normalizeBranding(undefined)).toEqual(NONE);
    expect(normalizeBranding({ color: 0x7c5cff, bio: "Hi" })).toEqual({ color: 0x7c5cff, bio: "Hi" });
    expect(normalizeBranding({ color: -1, bio: "  " })).toEqual(NONE);
    expect(normalizeBranding({ color: 0x1000000, bio: 5 })).toEqual(NONE);
  });

  it("uses the server's colour, else the embed's own", async () => {
    const settings = new GuildSettings();
    expect(accentColor(settings, GUILD_ID, 0x5865f2)).toBe(0x5865f2);
    expect(accentColor(settings, GUILD_ID)).toBeUndefined();
    await settings.set(GUILD_ID, Setting.BRANDING, { color: 0xff0000, bio: null });
    expect(accentColor(settings, GUILD_ID, 0x5865f2)).toBe(0xff0000);
  });

  it("accepts real images only", () => {
    expect(checkImage(PNG, "avatar")).toBe(PNG);
    expect(() => checkImage("https://example.com/a.png", "avatar")).toThrow(InvalidBranding);
    expect(() => checkImage("data:image/svg+xml;base64,PHN2Zz4=", "avatar")).toThrow(InvalidBranding);
    // Says PNG, but the bytes are a JPEG.
    const lying = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]).toString("base64")}`;
    expect(() => checkImage(lying, "avatar")).toThrow(/isn't a real PNG/);
    const huge = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_IMAGE_BYTES)]).toString("base64")}`;
    expect(() => checkImage(huge, "banner")).toThrow(/too big/);
  });

  it("sends Discord only what changed and saves the colour and bio", () => {
    expect(planBrandingChange({ nickname: "  Butterfly  ", avatar: PNG }, NONE)).toEqual({
      profile: { nick: "Butterfly", avatar: PNG },
      saved: NONE,
    });
    expect(planBrandingChange({ bio: "Hello", color: 0x7c5cff }, NONE)).toEqual({
      profile: { bio: "Hello" },
      saved: { color: 0x7c5cff, bio: "Hello" },
    });
    // Empty text and null put things back to the bot's default.
    expect(planBrandingChange({ nickname: "", bio: " ", banner: null, color: null }, { color: 1, bio: "Old" })).toEqual({
      profile: { nick: null, bio: "", banner: null },
      saved: NONE,
    });
    // Only the colour: nothing for Discord.
    expect(planBrandingChange({ color: 0x123456 }, NONE).profile).toEqual({});
  });

  it("refuses bad changes", () => {
    expect(() => planBrandingChange(null, NONE)).toThrow(InvalidBranding);
    expect(() => planBrandingChange({}, NONE)).toThrow("Nothing to change.");
    expect(() => planBrandingChange({ color: 0x123456 }, { color: 0x123456, bio: null })).toThrow("Nothing to change.");
    expect(() => planBrandingChange({ nickname: "x".repeat(33) }, NONE)).toThrow(/at most 32/);
    expect(() => planBrandingChange({ bio: "x".repeat(191) }, NONE)).toThrow(/at most 190/);
    expect(() => planBrandingChange({ nickname: 5 }, NONE)).toThrow(/must be text/);
    expect(() => planBrandingChange({ color: "#fff" }, NONE)).toThrow(/colour/);
    expect(() => planBrandingChange({ avatar: "nope" }, NONE)).toThrow(/PNG, JPEG, GIF or WebP/);
  });
});
