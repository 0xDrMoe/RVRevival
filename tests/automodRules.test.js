import { describe, expect, it } from "vitest";
import {
  countMentions,
  findBannedWord,
  findBlockedLink,
  findInvites,
  countEmojis,
  countLines,
  findScamLink,
  isMostlyCaps,
  isZalgo,
  repeatKey,
  textRuleDetail,
} from "../src/automod/rules.js";

describe("findBannedWord", () => {
  it("matches whole words, ignoring capitals, accents and number swaps", () => {
    expect(findBannedWord("you are a NOOB", ["noob"])).toBe("noob");
    expect(findBannedWord("total n00b move", ["noob"])).toBe("noob");
    expect(findBannedWord("Ñoob alert", ["noob"])).toBe("noob");
    expect(findBannedWord("noobish behaviour", ["noob"])).toBeUndefined();
    expect(findBannedWord("", ["noob"])).toBeUndefined();
    expect(findBannedWord("noob", [])).toBeUndefined();
  });

  it("treats * at either end as 'longer words too'", () => {
    expect(findBannedWord("noobish behaviour", ["noob*"])).toBe("noob*");
    expect(findBannedWord("supernoob", ["*noob"])).toBe("*noob");
    expect(findBannedWord("supernoobs", ["*noob*"])).toBe("*noob*");
    expect(findBannedWord("supernoobs", ["*noob"])).toBeUndefined();
  });

  it("matches phrases across any spacing", () => {
    expect(findBannedWord("free   nitro here", ["free nitro"])).toBe("free nitro");
    expect(findBannedWord("freenitro", ["free nitro"])).toBeUndefined();
  });

  it("doesn't treat regex characters in a word as patterns", () => {
    expect(findBannedWord("a.b", ["a.b"])).toBe("a.b");
    expect(findBannedWord("axb", ["a.b"])).toBeUndefined();
  });
});

describe("findInvites", () => {
  it("finds Discord invites and shorteners", () => {
    expect(findInvites("join discord.gg/abc123 now")).toEqual([{ code: "abc123", lookup: true }]);
    expect(findInvites("https://discord.com/invite/Rumble")).toEqual([{ code: "Rumble", lookup: true }]);
    expect(findInvites("https://discordapp.com/invite/xyz")).toEqual([{ code: "xyz", lookup: true }]);
    expect(findInvites("dsc.gg/thing and discord.me/other")).toEqual([
      { code: "thing", lookup: false },
      { code: "other", lookup: false },
    ]);
    expect(findInvites("no invite here, just discord.com/channels/1/2")).toEqual([]);
  });
});

describe("findBlockedLink", () => {
  it("returns the first website that isn't allowed", () => {
    expect(findBlockedLink("see https://evil.example.com/x", [])).toBe("evil.example.com");
    expect(findBlockedLink("see www.evil.com", [])).toBe("www.evil.com");
    expect(findBlockedLink("watch https://www.youtube.com/watch?v=1", ["youtube.com"])).toBeUndefined();
    expect(findBlockedLink("watch https://youtube.com.evil.net", ["youtube.com"])).toBe("youtube.com.evil.net");
    expect(findBlockedLink("plain text with a.dot", [])).toBeUndefined();
  });

  it("always allows GIFs and Discord's own links", () => {
    expect(findBlockedLink("https://tenor.com/view/cat-123", [])).toBeUndefined();
    expect(findBlockedLink("https://discord.com/channels/1/2/3", [])).toBeUndefined();
    expect(findBlockedLink("https://media.discordapp.net/a.png", [])).toBeUndefined();
  });
});

describe("countMentions", () => {
  it("counts different members and roles once each", () => {
    expect(countMentions("<@1> <@!1> <@2> <@&3> <@&3> <#4>")).toBe(3);
    expect(countMentions("")).toBe(0);
  });
});

describe("isMostlyCaps", () => {
  const limits = { percent: 70, minLength: 10 };

  it("catches shouting", () => {
    expect(isMostlyCaps("WHY IS NOBODY PLAYING", limits)).toBe(true);
    expect(isMostlyCaps("Why is nobody playing", limits)).toBe(false);
  });

  it("ignores short messages, links, mentions and scripts without capitals", () => {
    expect(isMostlyCaps("GG EZ", limits)).toBe(false);
    expect(isMostlyCaps("lol https://EXAMPLE.COM/ABCDEFGHIJK", limits)).toBe(false);
    expect(isMostlyCaps("<:PEPEHYPE:123> ok", limits)).toBe(false);
    expect(isMostlyCaps("مرحبا بكم جميعا في الخادم", limits)).toBe(false);
  });
});

describe("repeatKey", () => {
  it("ignores capitals and spacing", () => {
    expect(repeatKey("  Hello   THERE ")).toBe(repeatKey("hello there"));
    expect(repeatKey(undefined)).toBe("");
  });
});

describe("scam links, emoji, lines and glitched text", () => {
  it("catches look-alike Discord and Steam sites", () => {
    expect(findScamLink("free nitro https://discord-nitro.gift/abc")).toMatch(/discord/);
    expect(findScamLink("https://dlscord.com/x")).toMatch(/dlscord/);
    expect(findScamLink("https://d1scord.gg/abc")).toMatch(/d1scord/);
    expect(findScamLink("https://steamcommunlty.com/tradeoffer/new")).toMatch(/steamcommunity/);
    expect(findScamLink("https://disc0rd-app.com")).toMatch(/discordapp/);
    expect(findScamLink("https://www.xn--dscord-p9a.com")).toMatch(/look-alike/);
  });

  it("leaves the real sites and well-known look-alikes alone", () => {
    for (const link of ["https://discord.com/x", "https://discord.gift/abc", "https://cdn.discordapp.com/a.png", "https://store.steampowered.com", "https://steamcommunity.com/id/me", "https://disboard.org", "https://discords.com", "https://steamgifts.com", "https://discord.js.org", "https://youtube.com/watch?v=1"]) {
      expect(findScamLink(link), link).toBeUndefined();
    }
  });

  it("catches links whose text shows another website, and free Nitro bait", () => {
    expect(findScamLink("[discord.com/gifts](https://evil.example/claim)")).toMatch(/shows discord.com/);
    expect(findScamLink("[https://steamcommunity.com](https://steamcommunity.com/id/me)")).toBeUndefined();
    expect(findScamLink("[click here](https://example.com)")).toBeUndefined();
    expect(findScamLink("Get free Nitro for 3 months https://bit.ly/abc")).toMatch(/bait/);
    expect(findScamLink("I bought nitro yesterday, love it")).toBeUndefined();
  });

  it("counts emoji, with families, flags and custom emoji once each", () => {
    expect(countEmojis("hi 😀😀 👨‍👩‍👧 🇨🇦 <:wave:123456789012345678> ✅")).toBe(6);
    expect(countEmojis("plain text :)")).toBe(0);
    expect(textRuleDetail("emojis", "😀".repeat(10), { limit: 10 })).toBe("10 emoji");
    expect(textRuleDetail("emojis", "😀".repeat(9), { limit: 10 })).toBeUndefined();
  });

  it("counts lines, ignoring trailing line breaks", () => {
    expect(countLines("a\nb\n\nc\n\n")).toBe(4);
    expect(countLines("")).toBe(0);
    expect(textRuleDetail("lines", "x\n".repeat(15), { limit: 15 })).toBe("15 lines");
  });

  it("spots stacked accent marks without catching real languages", () => {
    expect(isZalgo("H̷̡̢̛e̵̡͠l̸̢̛l̴̨̛ó̶̢")).toBe(true);
    expect(isZalgo(`a${"́".repeat(9)}`)).toBe(true);
    for (const text of ["Tiếng Việt có dấu", "नमस्ते दुनिया", "مَرْحَبًا بِكُمْ", "สวัสดีครับ", "Ça va? Ñandú!"]) {
      expect(isZalgo(text), text).toBe(false);
    }
  });
});
