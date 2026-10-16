import { describe, expect, it } from "vitest";
import {
  countMentions,
  findBannedWord,
  findBlockedLink,
  findInvites,
  isMostlyCaps,
  repeatKey,
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
