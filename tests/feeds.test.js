import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildFeedCommandData, createFeedCommand } from "../src/commands/feed.js";
import { createFeedPoller, CHECK_EVERY_MS } from "../src/feeds/feedPoller.js";
import { FeedStore, MAX_FEEDS, SEEN_KEEP } from "../src/feeds/feedStore.js";
import { addFeed, buildFeedPost, FeedDuplicate, FeedLimit } from "../src/feeds/feeds.js";
import { FeedError, fetchFeed, isPrivateAddress, resolveSource, safeFetchText } from "../src/feeds/fetchFeed.js";
import { decodeXml, MAX_ITEMS, parseFeed } from "../src/feeds/parseFeed.js";
import { Status } from "../src/logs/actionLog.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000001";
const USER_ID = "300000000000000001";
const CHANNEL = "UC" + "a".repeat(22);

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <title>Patch &amp; News</title>
  <item><title><![CDATA[Season 2 <b>is</b> here]]></title><link>https://example.com/s2</link><guid>post-2</guid><dc:creator>Moe</dc:creator><pubDate>Fri, 16 Oct 2026 10:00:00 GMT</pubDate></item>
  <item><title>Hotfix</title><link>javascript:alert(1)</link><guid>post-1</guid></item>
</channel></rss>`;

const youtube = (ids) => `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <title>Rumble Channel</title>
  <link rel="alternate" href="https://www.youtube.com/channel/${CHANNEL}"/>
  ${ids
    .map(
      (id) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>Video ${id}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><author><name>Rumble Channel</name></author><published>2026-10-16T10:00:00+00:00</published></entry>`,
    )
    .join("\n")}
</feed>`;

// A fetch that answers from a map of URLs, and DNS that says everything is public.
function fakeNet(pages, addresses = {}) {
  const fetchImpl = vi.fn(async (url) => {
    const page = pages[String(url)];
    if (page === undefined) {
      return new Response("nope", { status: 404 });
    }
    return typeof page === "function" ? page() : new Response(page, { status: 200 });
  });
  const lookup = vi.fn(async (host) => [{ address: addresses[host] ?? "93.184.216.34" }]);
  return { fetchImpl, lookup };
}

describe("parseFeed", () => {
  it("reads RSS items", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe("Patch & News");
    expect(feed.items).toEqual([
      { id: "post-2", title: "Season 2 is here", link: "https://example.com/s2", author: "Moe", publishedAt: Date.parse("2026-10-16T10:00:00Z") },
      { id: "post-1", title: "Hotfix", link: "", author: "", publishedAt: null },
    ]);
  });

  it("reads YouTube's Atom feed", () => {
    const feed = parseFeed(youtube(["abc", "def"]));
    expect(feed.title).toBe("Rumble Channel");
    expect(feed.items[0]).toEqual({ id: "abc", title: "Video abc", link: "https://www.youtube.com/watch?v=abc", author: "Rumble Channel", publishedAt: Date.parse("2026-10-16T10:00:00Z") });
  });

  it("reads Reddit-style Atom entries without yt tags", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>newest submissions : gaming</title>
      <entry><author><name>/u/someone</name></author><id>t3_xyz</id><link href="https://www.reddit.com/r/gaming/comments/xyz/"/><updated>2026-10-16T09:00:00+00:00</updated><title>Look at this</title></entry></feed>`;
    expect(parseFeed(xml).items).toEqual([{ id: "t3_xyz", title: "Look at this", link: "https://www.reddit.com/r/gaming/comments/xyz/", author: "/u/someone", publishedAt: Date.parse("2026-10-16T09:00:00Z") }]);
  });

  it("caps the items and never throws on junk", () => {
    expect(parseFeed(youtube(Array.from({ length: 40 }, (_, i) => `v${i}`))).items).toHaveLength(MAX_ITEMS);
    expect(parseFeed("<html><body>hi</body></html>")).toEqual({ title: "", items: [] });
    expect(parseFeed(undefined)).toEqual({ title: "", items: [] });
  });

  it("decodes entities", () => {
    expect(decodeXml("a &amp; b &#39;c&#39; &#x1F600; &bogus;")).toBe("a & b 'c' 😀 &bogus;");
  });
});

describe("fetching safely", () => {
  it("spots private addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not an ip"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses private hosts, logins and other protocols", async () => {
    const net = fakeNet({}, { "internal.example": "10.0.0.5" });
    await expect(safeFetchText("http://127.0.0.1/admin", net)).rejects.toMatchObject({ reason: "blocked" });
    await expect(safeFetchText("http://[::1]/", net)).rejects.toMatchObject({ reason: "blocked" });
    await expect(safeFetchText("https://internal.example/feed", net)).rejects.toMatchObject({ reason: "blocked" });
    await expect(safeFetchText("file:///etc/passwd", net)).rejects.toMatchObject({ reason: "bad-source" });
    await expect(safeFetchText("https://user:pw@example.com/", net)).rejects.toMatchObject({ reason: "bad-source" });
    await expect(safeFetchText("not a link", net)).rejects.toMatchObject({ reason: "bad-source" });
    expect(net.fetchImpl).not.toHaveBeenCalled();
  });

  it("checks every redirect", async () => {
    const redirect = (location) => () => new Response(null, { status: 302, headers: { location } });
    const net = fakeNet({ "https://example.com/feed": redirect("http://169.254.169.254/latest"), "https://example.com/ok": redirect("/final"), "https://example.com/final": "<rss></rss>" });
    await expect(safeFetchText("https://example.com/feed", net)).rejects.toMatchObject({ reason: "blocked" });
    expect(await safeFetchText("https://example.com/ok", net)).toBe("<rss></rss>");

    const loop = fakeNet({ "https://example.com/loop": redirect("/loop") });
    await expect(safeFetchText("https://example.com/loop", loop)).rejects.toMatchObject({ reason: "unreachable" });
    expect(loop.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("stops big responses and reports errors", async () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(safeFetchText("https://example.com/big", fakeNet({ "https://example.com/big": huge }))).rejects.toMatchObject({ reason: "not-a-feed" });
    await expect(safeFetchText("https://example.com/missing", fakeNet({}))).rejects.toMatchObject({ reason: "unreachable" });
    const down = { fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")), lookup: async () => [{ address: "1.1.1.1" }] };
    await expect(safeFetchText("https://example.com/", down)).rejects.toMatchObject({ reason: "unreachable" });
    const noDns = { fetchImpl: vi.fn(), lookup: async () => Promise.reject(new Error("ENOTFOUND")) };
    await expect(safeFetchText("https://nowhere.example/", noDns)).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("says when a page isn't a feed", async () => {
    await expect(fetchFeed("https://example.com/", fakeNet({ "https://example.com/": "<html>hello</html>" }))).rejects.toBeInstanceOf(FeedError);
    expect((await fetchFeed("https://example.com/rss", fakeNet({ "https://example.com/rss": RSS }))).items).toHaveLength(2);
  });
});

describe("resolveSource", () => {
  it("turns subreddits into their newest-posts feed", async () => {
    for (const input of ["gaming", "r/gaming", "/r/gaming/", "https://www.reddit.com/r/gaming", "https://old.reddit.com/r/gaming/"]) {
      expect(await resolveSource("reddit", input)).toEqual({ url: "https://www.reddit.com/r/gaming/new/.rss", name: "r/gaming" });
    }
    await expect(resolveSource("reddit", "r/a")).rejects.toMatchObject({ reason: "bad-source" });
    await expect(resolveSource("reddit", "https://evil.example/r/gaming")).rejects.toMatchObject({ reason: "bad-source" });
  });

  it("finds YouTube channels by ID, link or handle", async () => {
    const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;
    expect(await resolveSource("youtube", CHANNEL)).toEqual({ url: feed, name: null });
    expect(await resolveSource("youtube", `https://www.youtube.com/channel/${CHANNEL}/videos`)).toEqual({ url: feed, name: null });
    const net = fakeNet({ "https://www.youtube.com/@rumble": `<script>{"externalId":"${CHANNEL}"}</script>`, "https://www.youtube.com/@empty": "<html></html>" });
    expect(await resolveSource("youtube", "https://youtube.com/@rumble", net)).toEqual({ url: feed, name: null });
    expect(await resolveSource("youtube", "@rumble", net)).toEqual({ url: feed, name: null });
    await expect(resolveSource("youtube", "@empty", net)).rejects.toMatchObject({ reason: "not-a-feed" });
    await expect(resolveSource("youtube", "some words")).rejects.toMatchObject({ reason: "bad-source" });
  });

  it("takes RSS links as they are", async () => {
    expect(await resolveSource("rss", " https://example.com/feed.xml ")).toEqual({ url: "https://example.com/feed.xml", name: null });
    await expect(resolveSource("rss", "example.com/feed")).rejects.toMatchObject({ reason: "bad-source" });
    await expect(resolveSource("rss", "ftp://example.com/feed")).rejects.toMatchObject({ reason: "bad-source" });
    await expect(resolveSource("mastodon", "x")).rejects.toMatchObject({ reason: "bad-source" });
    await expect(resolveSource("rss", "")).rejects.toMatchObject({ reason: "bad-source" });
  });
});

const sample = (overrides = {}) => ({
  guildId: GUILD_ID,
  kind: "rss",
  source: "https://example.com/rss",
  url: "https://example.com/rss",
  name: "Patch News",
  channelId: CHANNEL_ID,
  createdBy: USER_ID,
  createdAt: 1000,
  ...overrides,
});

describe("FeedStore", () => {
  it("saves, finds, checks and deletes feeds", () => {
    const store = new FeedStore();
    const feed = store.add(sample({ seen: ["a", "b"] }));
    expect(feed).toMatchObject({ id: 1, seen: ["a", "b"], checkedAt: 1000, failures: 0, roleId: null });
    expect(store.count(GUILD_ID)).toBe(1);
    expect(store.find(GUILD_ID, feed.url, CHANNEL_ID)?.id).toBe(1);
    expect(store.find(GUILD_ID, feed.url, "800000000000000009")).toBeUndefined();

    expect(store.due(999)).toEqual([]);
    expect(store.due(1000).map((due) => due.id)).toEqual([1]);

    store.failed(1, { error: "boom", checkedAt: 2000 });
    store.failed(1, { error: "boom", checkedAt: 3000 });
    expect(store.get(1)).toMatchObject({ lastError: "boom", failures: 2, checkedAt: 3000 });
    store.checked(1, { seen: Array.from({ length: 150 }, (_, i) => `id${i}`), checkedAt: 4000, postedAt: 4000 });
    expect(store.get(1)).toMatchObject({ lastError: null, failures: 0, postedAt: 4000 });
    expect(store.get(1).seen).toHaveLength(SEEN_KEEP);
    store.checked(1, { seen: [], checkedAt: 5000 });
    expect(store.get(1).postedAt).toBe(4000);

    expect(store.delete("900000000000000002", 1)).toBe(false);
    expect(store.delete(GUILD_ID, 1)).toBe(true);
    expect(store.list(GUILD_ID)).toEqual([]);
  });
});

describe("adding feeds", () => {
  it("marks what's already there as seen and refuses duplicates and too many", async () => {
    const store = new FeedStore();
    const fetchOptions = fakeNet({ "https://example.com/rss": RSS });
    const options = { store, guildId: GUILD_ID, kind: "rss", source: "https://example.com/rss", channelId: CHANNEL_ID, createdBy: USER_ID, fetchOptions, now: () => 5000 };
    const feed = await addFeed({ ...options, message: "  New: {title}  " });
    expect(feed).toMatchObject({ name: "Patch & News", seen: ["post-2", "post-1"], message: "New: {title}", createdAt: 5000 });
    await expect(addFeed(options)).rejects.toBeInstanceOf(FeedDuplicate);

    for (let i = 1; i < MAX_FEEDS; i += 1) {
      store.add(sample({ url: `https://example.com/${i}` }));
    }
    await expect(addFeed({ ...options, channelId: "800000000000000009" })).rejects.toBeInstanceOf(FeedLimit);
  });

  it("names Reddit feeds after the subreddit", async () => {
    const store = new FeedStore();
    const fetchOptions = fakeNet({ "https://www.reddit.com/r/gaming/new/.rss": youtube(["x"]) });
    const feed = await addFeed({ store, guildId: GUILD_ID, kind: "reddit", source: "gaming", channelId: CHANNEL_ID, createdBy: USER_ID, fetchOptions });
    expect(feed.name).toBe("r/gaming");
  });

  it("writes the post with the default or custom message", () => {
    const item = { id: "1", title: "Season 2", link: "https://example.com/s2", author: "" };
    expect(buildFeedPost(sample({ kind: "youtube", roleId: null, message: null }), item, "en")).toEqual({
      content: expect.stringContaining("https://example.com/s2"),
      allowedMentions: { parse: [], roles: [] },
    });
    const post = buildFeedPost(sample({ roleId: ROLE_ID, message: "{feed} by {author}: {title} {link} {other}" }), item, "en");
    expect(post).toEqual({ content: `<@&${ROLE_ID}> Patch News by Patch News: Season 2 https://example.com/s2 {other}`, allowedMentions: { parse: [], roles: [ROLE_ID] } });
  });
});

function fakeClient(channel) {
  const guild = { id: GUILD_ID, preferredLocale: "en-US", channels: { cache: new Map(channel ? [[CHANNEL_ID, channel]] : []) } };
  return { guilds: { cache: new Map([[GUILD_ID, guild]]) } };
}

describe("feed poller", () => {
  it("posts only new items, oldest first, at most three", async () => {
    let time = 10_000;
    const store = new FeedStore();
    store.add(sample({ seen: ["old"], createdAt: time }));
    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    const items = ["e", "d", "c", "b", "old"].map((id) => ({ id, title: `Post ${id}`, link: `https://example.com/${id}`, author: "" }));
    const fetchFeed = vi.fn(async () => ({ title: "x", items }));
    const poller = createFeedPoller({ client: fakeClient(channel), store, logger: fakeLogger(), fetchFeed, now: () => time });

    await poller.tick();
    expect(fetchFeed).not.toHaveBeenCalled(); // checked when added

    time += CHECK_EVERY_MS;
    await poller.tick();
    expect(channel.send.mock.calls.map(([post]) => post.content)).toEqual([
      expect.stringContaining("Post c"),
      expect.stringContaining("Post d"),
      expect.stringContaining("Post e"),
    ]);
    expect(store.get(1)).toMatchObject({ seen: ["e", "d", "c", "b", "old"], postedAt: time, checkedAt: time });

    time += CHECK_EVERY_MS;
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(3);
  });

  it("records failures without posting a backlog later", async () => {
    let time = CHECK_EVERY_MS;
    const store = new FeedStore();
    store.add(sample({ seen: [], createdAt: 0 }));
    const fetchFeed = vi.fn().mockRejectedValueOnce(new FeedError("unreachable", "down")).mockResolvedValue({ title: "x", items: [{ id: "a", title: "A", link: "", author: "" }] });
    const poller = createFeedPoller({ client: fakeClient(null), store, logger: fakeLogger(), fetchFeed, now: () => time });

    await poller.tick();
    expect(store.get(1)).toMatchObject({ lastError: "down", failures: 1 });

    time += CHECK_EVERY_MS;
    await poller.tick();
    expect(store.get(1)).toMatchObject({ seen: ["a"], failures: 1, lastError: expect.stringContaining("Couldn't post") });
  });
});

function interaction(subcommand, options = {}, { canPost = true } = {}) {
  const channel = { id: CHANNEL_ID, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => canPost }) };
  const replyState = {};
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, members: { me: { id: "bot" } }, channels: { cache: new Map([[CHANNEL_ID, channel]]) } },
    user: { id: USER_ID },
    memberPermissions: { has: () => true },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getChannel: () => channel,
      getRole: () => options.role ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    get deferred() {
      return Boolean(replyState.deferred);
    },
    replied: false,
    deferReply: vi.fn(async () => {
      replyState.deferred = true;
    }),
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  };
}

describe("/feed", () => {
  it("builds the command", () => {
    expect(buildFeedCommandData().options.map((option) => option.name)).toEqual(["add", "remove", "list"]);
  });

  it("adds, lists and removes feeds", async () => {
    const store = new FeedStore();
    const command = createFeedCommand({ store, fetchOptions: fakeNet({ "https://example.com/rss": RSS }) });
    expect(await command.execute(interaction("add", { type: "rss", source: "https://example.com/rss" }))).toMatchObject({ status: Status.SUCCESS, key: "feedAdded" });
    expect(await command.execute(interaction("add", { type: "rss", source: "https://example.com/rss" }))).toMatchObject({ key: "feedDuplicate" });
    expect(await command.execute(interaction("add", { type: "rss", source: "https://example.com/missing" }))).toMatchObject({ status: Status.FAILED, key: "feedErrorUnreachable" });
    expect(await command.execute(interaction("add", { type: "rss", source: "http://10.0.0.1/" }))).toMatchObject({ key: "feedErrorBlocked" });
    expect(await command.execute(interaction("add", { type: "rss", source: "https://example.com/rss", role: { id: GUILD_ID } }))).toMatchObject({ key: "feedRoleEveryone" });
    expect(await command.execute(interaction("add", { type: "rss", source: "https://example.com/rss" }, { canPost: false }))).toMatchObject({ key: "feedCannotPost" });

    const list = interaction("list");
    expect(await command.execute(list)).toMatchObject({ key: "feedList" });
    expect(list.reply.mock.calls[0][0].content).toContain("**Patch & News**");

    expect(await command.execute(interaction("remove", { id: 9 }))).toMatchObject({ key: "feedNoSuch" });
    expect(await command.execute(interaction("remove", { id: 1 }))).toMatchObject({ key: "feedRemoved" });
    expect(await command.execute(interaction("list"))).toMatchObject({ key: "feedListEmpty" });
  });
});
