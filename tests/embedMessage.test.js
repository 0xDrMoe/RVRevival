import { describe, expect, it } from "vitest";
import { checkMessage, editableMessage, InvalidMessage, messageSummary, parseMessageLink } from "../src/messages/embedMessage.js";
import { SentMessageStore, SENT_KEEP } from "../src/messages/sentMessageStore.js";

const GUILD_ID = "900000000000000001";

describe("embed builder messages", () => {
  it("keeps only the parts that were filled in", () => {
    const body = checkMessage({
      content: "  Hi  ",
      embed: { title: "Patch", url: "https://example.com", description: "", color: 0xff0000, author: { name: "", icon_url: "https://x.test/a.png" }, footer: { text: "" }, image: { url: "" }, thumbnail: { url: "" }, fields: [{ name: "A", value: "1", inline: true }, { name: "", value: "" }] },
    });
    expect(body).toEqual({ content: "Hi", embeds: [{ title: "Patch", url: "https://example.com", color: 0xff0000, fields: [{ name: "A", value: "1", inline: true }] }] });
    expect(checkMessage({ content: "Just text", embed: { title: "", color: 5 } })).toEqual({ content: "Just text", embeds: [] });
  });

  it("refuses what Discord would refuse", () => {
    const bad = [
      {},
      { content: "" },
      { content: "x".repeat(2001) },
      { embed: { title: "x".repeat(257) } },
      { embed: { url: "https://example.com", description: "no title" } },
      { embed: { title: "T", image: { url: "javascript:alert(1)" } } },
      { embed: { title: "T", color: 0x1000000 } },
      { embed: { title: "T", fields: [{ name: "only a name", value: "" }] } },
      { embed: { title: "T", fields: Array.from({ length: 26 }, () => ({ name: "a", value: "b" })) } },
      { embed: { description: "x".repeat(4000), fields: Array.from({ length: 3 }, () => ({ name: "a", value: "x".repeat(1000) })) } },
    ];
    for (const value of bad) {
      expect(() => checkMessage(value)).toThrow(InvalidMessage);
    }
  });

  it("loads a posted message back into the editor", () => {
    const loaded = editableMessage({ content: "Hi", embeds: [{ title: "T", fields: [{ name: "a", value: "b" }] }, { title: "second" }] });
    expect(loaded).toMatchObject({ content: "Hi", embed: { title: "T", color: null, author: { name: "" }, fields: [{ name: "a", value: "b", inline: false }] }, extraEmbeds: 1 });
    expect(editableMessage({ content: "Plain" })).toEqual({ content: "Plain", embed: null, extraEmbeds: 0 });
  });

  it("reads message links and names messages", () => {
    expect(parseMessageLink("https://discord.com/channels/900000000000000001/800000000000000001/810000000000000001")).toEqual({
      guildId: GUILD_ID,
      channelId: "800000000000000001",
      messageId: "810000000000000001",
    });
    expect(parseMessageLink("https://ptb.discord.com/channels/900000000000000001/800000000000000001/810000000000000001")).not.toBeNull();
    expect(parseMessageLink("https://evil.com/channels/1/2/3")).toBeNull();
    expect(messageSummary({ content: "", embeds: [{ description: "Line one\nline two" }] })).toBe("Line one line two");
  });

  it("remembers the newest sent messages", () => {
    const store = new SentMessageStore();
    for (let index = 0; index < SENT_KEEP + 2; index += 1) {
      store.add({ guildId: GUILD_ID, channelId: "800000000000000001", messageId: String(810000000000000000n + BigInt(index)), summary: `#${index}`, sentBy: "1", sentAt: index });
    }
    const list = store.list(GUILD_ID, 200);
    expect(list).toHaveLength(SENT_KEEP);
    expect(list[0].summary).toBe(`#${SENT_KEEP + 1}`);
    expect(store.edited(GUILD_ID, list[0].messageId, { summary: "new", editedBy: "2", editedAt: 9 })).toBe(true);
    expect(store.get(GUILD_ID, list[0].messageId)).toMatchObject({ summary: "new", editedBy: "2", editedAt: 9 });
    expect(store.edited(GUILD_ID, "999999999999999999", { summary: "x", editedBy: "2" })).toBe(false);
  });
});
