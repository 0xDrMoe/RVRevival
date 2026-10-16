import { describe, expect, it, vi } from "vitest";
import { buildHighlightCommandData, createHighlightCommand } from "../src/commands/highlight.js";
import { createHighlights, normalizeWord, wordPattern } from "../src/highlights/highlights.js";
import { HighlightStore, MAX_HIGHLIGHTS } from "../src/highlights/highlightStore.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const WATCHER_ID = "300000000000000010";
const AUTHOR_ID = "300000000000000011";
const MINUTE = 60 * 1000;

describe("highlight words", () => {
  it("normalizes words", () => {
    expect(normalizeWord("  Season   Two ")).toBe("season two");
    expect(normalizeWord("a")).toBeNull();
    expect(normalizeWord("!!!")).toBeNull();
    expect(normalizeWord("x".repeat(51))).toBeNull();
  });

  it("matches whole words only", () => {
    expect(wordPattern("cat").test("I love my Cat!")).toBe(true);
    expect(wordPattern("cat").test("category")).toBe(false);
    expect(wordPattern("season two").test("season  two is out")).toBe(true);
    expect(wordPattern("c++").test("I write C++ daily")).toBe(true);
    expect(wordPattern("café").test("le café est prêt")).toBe(true);
  });
});

function setup({ canSee = true } = {}) {
  let time = 1_000_000;
  const store = new HighlightStore();
  const highlights = createHighlights({ store, logger: fakeLogger(), now: () => time });
  const watcher = { id: WATCHER_ID, user: { bot: false }, send: vi.fn(async () => {}) };
  const guild = {
    id: GUILD_ID,
    name: "Rumbleverse",
    preferredLocale: "en-US",
    members: { cache: new Map([[WATCHER_ID, watcher]]), fetch: vi.fn(async () => null) },
  };
  const channel = { id: CHANNEL_ID, permissionsFor: () => ({ has: () => canSee }) };
  const message = (author, content, { mentions = [] } = {}) => ({
    inGuild: () => true,
    guild,
    guildId: GUILD_ID,
    channel,
    channelId: CHANNEL_ID,
    content,
    url: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/1`,
    author: { id: author, bot: false, username: "author", displayAvatarURL: () => null },
    member: { displayName: "Author" },
    mentions: { users: new Map(mentions.map((id) => [id, { id }])) },
  });
  return { store, highlights, watcher, message, advance: (ms) => (time += ms) };
}

describe("highlights", () => {
  it("DMs once per channel per few minutes, and not while the member is chatting there", async () => {
    const { store, highlights, watcher, message, advance } = setup();
    store.add(GUILD_ID, WATCHER_ID, "patch");
    highlights.changed(GUILD_ID);

    await highlights.messageCreated(message(AUTHOR_ID, "New PATCH is live"));
    expect(watcher.send).toHaveBeenCalledTimes(1);
    const [dm] = watcher.send.mock.calls[0];
    expect(dm.content).toBe(`🔔 \`patch\` was mentioned in <#${CHANNEL_ID}> on **Rumbleverse**:`);
    expect(dm.embeds[0].data.description).toContain("New PATCH is live");
    expect(dm.embeds[0].data.description).toContain("/channels/");

    await highlights.messageCreated(message(AUTHOR_ID, "patch again"));
    expect(watcher.send).toHaveBeenCalledTimes(1);

    advance(6 * MINUTE);
    await highlights.messageCreated(message(WATCHER_ID, "what patch?"));
    await highlights.messageCreated(message(AUTHOR_ID, "the patch"));
    expect(watcher.send).toHaveBeenCalledTimes(1);

    advance(6 * MINUTE);
    await highlights.messageCreated(message(AUTHOR_ID, "patch", { mentions: [WATCHER_ID] }));
    expect(watcher.send).toHaveBeenCalledTimes(1);
    await highlights.messageCreated(message(AUTHOR_ID, "patch notes"));
    expect(watcher.send).toHaveBeenCalledTimes(2);
  });

  it("skips channels the member can't see, and forgets members who leave", async () => {
    const { store, highlights, watcher, message } = setup({ canSee: false });
    store.add(GUILD_ID, WATCHER_ID, "patch");
    await highlights.messageCreated(message(AUTHOR_ID, "patch"));
    expect(watcher.send).not.toHaveBeenCalled();
    highlights.memberLeft({ guild: { id: GUILD_ID }, id: WATCHER_ID });
    expect(store.words(GUILD_ID, WATCHER_ID)).toEqual([]);
  });
});

function interaction(subcommand, word) {
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    user: { id: WATCHER_ID },
    inCachedGuild: () => true,
    options: { getSubcommand: () => subcommand, getString: () => word, getFocused: () => word ?? "" },
    reply: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

describe("/highlight", () => {
  it("builds the command", () => {
    expect(buildHighlightCommandData().options.map((option) => option.name)).toEqual(["add", "remove", "list", "clear"]);
  });

  it("adds, lists, suggests, removes and clears words", async () => {
    const store = new HighlightStore();
    const changed = vi.fn();
    const command = createHighlightCommand({ store, highlights: { changed } });
    expect(await command.execute(interaction("add", "Patch"))).toMatchObject({ key: "highlightAdded" });
    expect(await command.execute(interaction("add", "patch"))).toMatchObject({ key: "highlightAlready" });
    expect(await command.execute(interaction("add", "??"))).toMatchObject({ key: "highlightBadWord" });
    expect(changed).toHaveBeenCalledWith(GUILD_ID);

    const list = interaction("list");
    await command.execute(list);
    expect(list.reply.mock.calls[0][0].content).toContain("`patch`");

    const suggest = interaction("remove", "pa");
    await command.autocomplete(suggest);
    expect(suggest.respond).toHaveBeenCalledWith([{ name: "patch", value: "patch" }]);

    expect(await command.execute(interaction("remove", "PATCH"))).toMatchObject({ key: "highlightRemoved" });
    expect(await command.execute(interaction("remove", "patch"))).toMatchObject({ key: "highlightNotFound" });

    for (let i = 0; i < MAX_HIGHLIGHTS; i += 1) {
      store.add(GUILD_ID, WATCHER_ID, `word${i}`);
    }
    expect(await command.execute(interaction("add", "more"))).toMatchObject({ key: "highlightFull" });
    expect(await command.execute(interaction("clear"))).toMatchObject({ key: "highlightCleared", values: { count: MAX_HIGHLIGHTS } });
  });
});
