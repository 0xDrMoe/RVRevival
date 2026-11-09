import { describe, expect, it, vi } from "vitest";
import { createFeedCommand } from "../src/commands/feed.js";
import { FeedStore, PENDING_FIRST_READ } from "../src/feeds/feedStore.js";
import { CHECK_EVERY_MS, createFeedPoller, LIVE_CHECK_EVERY_MS as YOUTUBE_LIVE_EVERY_MS } from "../src/feeds/feedPoller.js";
import { addFeed, buildFeedPost } from "../src/feeds/feeds.js";
import { kickSlug, resolveSource, twitchLogin } from "../src/feeds/fetchFeed.js";
import { createKickApi } from "../src/feeds/kick.js";
import { createLiveApis } from "../src/feeds/liveApis.js";
import { createLivePoller, LIVE_CHECK_EVERY_MS } from "../src/feeds/livePoller.js";
import { parseFeed } from "../src/feeds/parseFeed.js";
import { createTwitchApi } from "../src/feeds/twitch.js";
import { readLivePage } from "../src/feeds/youtubeLive.js";
import { Status } from "../src/logs/actionLog.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OTHER_GUILD = "900000000000000002";
const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000001";
const USER_ID = "300000000000000001";

describe("Bluesky, Mastodon and Twitch sources", () => {
  it("finds Bluesky accounts by handle, link or DID", async () => {
    const feed = { url: "https://bsky.app/profile/rabble.bsky.social/rss", name: "@rabble.bsky.social" };
    for (const input of ["rabble.bsky.social", "@Rabble.bsky.social", "https://bsky.app/profile/rabble.bsky.social", "https://bsky.app/profile/rabble.bsky.social/"]) {
      expect(await resolveSource("bluesky", input)).toEqual(feed);
    }
    expect(await resolveSource("bluesky", "cedartechsolutions.ca")).toEqual({ url: "https://bsky.app/profile/cedartechsolutions.ca/rss", name: "@cedartechsolutions.ca" });
    const did = "did:plc:z72i7hdynmk6r22z27h6tvur";
    expect(await resolveSource("bluesky", `https://bsky.app/profile/${did}`)).toEqual({ url: `https://bsky.app/profile/${did}/rss`, name: null });
    for (const bad of ["localhost", "just words", "https://evil.example/profile/a.b", "a/b.c"]) {
      await expect(resolveSource("bluesky", bad)).rejects.toMatchObject({ reason: "bad-source" });
    }
  });

  it("finds Mastodon accounts as @name@server or a profile link", async () => {
    const feed = { url: "https://mastodon.social/@Rabble.rss", name: "@Rabble@mastodon.social" };
    expect(await resolveSource("mastodon", "@Rabble@mastodon.social")).toEqual(feed);
    expect(await resolveSource("mastodon", "Rabble@Mastodon.Social")).toEqual(feed);
    expect(await resolveSource("mastodon", "https://mastodon.social/@Rabble")).toEqual(feed);
    for (const bad of ["@rabble", "rabble@localhost", "https://mastodon.social/users/rabble", "@a@b@c"]) {
      await expect(resolveSource("mastodon", bad)).rejects.toMatchObject({ reason: "bad-source" });
    }
  });

  it("reads Twitch channel names and links", async () => {
    expect(twitchLogin("Shroud")).toBe("shroud");
    expect(twitchLogin("https://www.twitch.tv/Shroud/")).toBe("shroud");
    expect(twitchLogin("twitch.tv/some_name")).toBe("some_name");
    expect(twitchLogin("ab")).toBeNull();
    expect(twitchLogin("https://evil.example/shroud")).toBeNull();
    expect(await resolveSource("twitch", "twitch.tv/Shroud")).toEqual({ url: "https://www.twitch.tv/shroud", name: null, login: "shroud" });
    await expect(resolveSource("twitch", "not a name")).rejects.toMatchObject({ reason: "bad-source" });
  });

  it("uses a post's text as its title when it has none", () => {
    const long = "word ".repeat(80);
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>@rabble.bsky.social - Rabble</title>
      <item><link>https://bsky.app/profile/rabble.bsky.social/post/1</link><description>We&#39;re live!</description><pubDate>04 Nov 2026 04:03 +0000</pubDate><guid isPermaLink="false">at://did:plc:x/app.bsky.feed.post/1</guid></item>
      <item><link>https://mastodon.social/@rabble/2</link><description>&lt;p&gt;${long}&lt;/p&gt;</description><guid>https://mastodon.social/@rabble/2</guid></item>
      </channel></rss>`;
    const [first, second] = parseFeed(xml).items;
    expect(first).toMatchObject({ id: "at://did:plc:x/app.bsky.feed.post/1", title: "We're live!", link: "https://bsky.app/profile/rabble.bsky.social/post/1" });
    expect(first.publishedAt).toBe(Date.parse("2026-11-04T04:03:00Z"));
    expect(second.title).toHaveLength(200);
    expect(second.title.endsWith("…")).toBe(true);
    expect(second.title).not.toContain("<p>");
  });
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Twitch API", () => {
  it("gets one app token, reuses it and gets a new one on 401 or expiry", async () => {
    let time = 0;
    let tokens = 0;
    let rejectNext = false;
    const fetchImpl = vi.fn(async (url, init) => {
      const link = String(url);
      if (link.startsWith("https://id.twitch.tv/oauth2/token")) {
        expect(init.method).toBe("POST");
        expect(String(init.body)).toContain("grant_type=client_credentials");
        tokens += 1;
        return json({ access_token: `token${tokens}`, expires_in: 3600 });
      }
      expect(init.headers["Client-Id"]).toBe("client");
      if (rejectNext) {
        rejectNext = false;
        return json({ message: "Invalid OAuth token" }, 401);
      }
      const logins = new URL(link).searchParams.getAll("user_login");
      return json({ data: logins.map((login) => ({ id: `s-${login}`, user_login: login, user_name: init.headers.Authorization, type: "live" })) });
    });
    const twitch = createTwitchApi({ clientId: "client", clientSecret: "secret", fetchImpl, now: () => time });

    const [a, b] = await Promise.all([twitch.streams(["one"]), twitch.streams(["two"])]);
    expect(tokens).toBe(1);
    expect(a[0]).toMatchObject({ id: "s-one", login: "one", name: "Bearer token1" });
    expect(b[0].name).toBe("Bearer token1");

    rejectNext = true;
    expect((await twitch.streams(["one"]))[0].name).toBe("Bearer token2");

    time += 3600 * 1000;
    expect((await twitch.streams(["one"]))[0].name).toBe("Bearer token3");
  });

  it("asks for 100 logins at a time, once each, and keeps only live streams", async () => {
    const asked = [];
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("oauth2")) {
        return json({ access_token: "t", expires_in: 3600 });
      }
      const logins = new URL(String(url)).searchParams.getAll("user_login");
      asked.push(logins.length);
      return json({ data: logins.map((login, index) => ({ id: login, user_login: login, type: index === 0 ? "" : "live" })) });
    });
    const twitch = createTwitchApi({ clientId: "c", clientSecret: "s", fetchImpl });
    const logins = Array.from({ length: 150 }, (_, i) => `user${i}`);
    const live = await twitch.streams([...logins, "user1"]);
    expect(asked).toEqual([100, 50]);
    expect(live).toHaveLength(148);
  });

  it("reports refused keys and outages without the secret", async () => {
    const refused = createTwitchApi({ clientId: "c", clientSecret: "hunter2", fetchImpl: async () => json({}, 403) });
    const error = await refused.channels(["x"]).catch((caught) => caught);
    expect(error).toMatchObject({ reason: "unreachable" });
    expect(error.message).not.toContain("hunter2");
    const down = createTwitchApi({
      clientId: "c",
      clientSecret: "s",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await expect(down.streams(["x"])).rejects.toMatchObject({ reason: "unreachable" });
  });
});

describe("Kick API", () => {
  it("reads channels and live streams, 50 slugs at a time", async () => {
    const asked = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url) === "https://id.kick.com/oauth/token") {
        return json({ access_token: "kick-token", expires_in: 3600 });
      }
      expect(init.headers.Authorization).toBe("Bearer kick-token");
      const slugs = new URL(String(url)).searchParams.getAll("slug");
      asked.push(slugs.length);
      return json({
        data: slugs.map((slug, index) => ({
          broadcaster_user_id: 1000 + index,
          slug: slug === "rabble" ? "Rabble" : slug,
          stream_title: "Speedruns",
          category: { name: "Just Chatting" },
          stream: { is_live: slug === "rabble", start_time: "2026-11-08T10:00:00Z" },
        })),
      });
    });
    const kick = createKickApi({ clientId: "c", clientSecret: "s", fetchImpl });
    expect(await kick.channels(["rabble"])).toEqual([{ login: "rabble", name: "Rabble" }]);
    const slugs = ["rabble", ...Array.from({ length: 60 }, (_, i) => `user${i}`)];
    expect(await kick.streams(slugs)).toEqual([{ id: "1000:2026-11-08T10:00:00Z", login: "rabble", name: "Rabble", title: "Speedruns", game: "Just Chatting" }]);
    expect(asked).toEqual([1, 50, 11]);
  });

  it("only creates the APIs that have keys", () => {
    expect(Object.keys(createLiveApis({}))).toEqual([]);
    expect(Object.keys(createLiveApis({ kick: { clientId: "a", clientSecret: "b" } }))).toEqual(["kick"]);
  });
});

// A Twitch or Kick API with the given channels, and who's live right now.
function fakeTwitch(users, live = {}) {
  return {
    live,
    channels: vi.fn(async (logins) => logins.filter((login) => users.includes(login)).map((login) => ({ login, name: login.toUpperCase() }))),
    streams: vi.fn(async (logins) => logins.filter((login) => live[login]).map((login) => ({ id: live[login], login, name: login.toUpperCase(), title: "Ranked grind", game: "Chess" }))),
  };
}

const base = { guildId: GUILD_ID, channelId: CHANNEL_ID, createdBy: USER_ID };

describe("adding Twitch channels", () => {
  it("needs Twitch keys and a real channel, and doesn't announce a stream that's already on", async () => {
    const store = new FeedStore();
    await expect(addFeed({ ...base, store, kind: "twitch", source: "shroud" })).rejects.toMatchObject({ reason: "not-configured" });
    const twitch = fakeTwitch(["shroud"], { shroud: "stream-1" });
    await expect(addFeed({ ...base, store, kind: "twitch", source: "nobody_here", live: { twitch } })).rejects.toMatchObject({ reason: "no-account" });
    await expect(addFeed({ ...base, store, kind: "kick", source: "shroud", live: { twitch } })).rejects.toMatchObject({ reason: "not-configured" });
    const feed = await addFeed({ ...base, store, kind: "twitch", source: "https://twitch.tv/Shroud", live: { twitch } });
    expect(feed).toMatchObject({ kind: "twitch", source: "shroud", url: "https://www.twitch.tv/shroud", name: "SHROUD", seen: ["stream-1"] });
  });

  it("writes the live post with {game}", () => {
    const feed = { kind: "twitch", name: "SHROUD", roleId: ROLE_ID, message: null };
    const item = { id: "s", title: "Ranked", link: "https://www.twitch.tv/shroud", author: "Shroud", game: "Chess" };
    expect(buildFeedPost(feed, item, "en").content).toBe(`<@&${ROLE_ID}> 🔴 **Shroud** is live on Twitch: **Ranked**\nhttps://www.twitch.tv/shroud`);
    expect(buildFeedPost({ ...feed, roleId: null, message: "{author} plays {game}: {link}" }, item, "en").content).toBe("Shroud plays Chess: https://www.twitch.tv/shroud");
    expect(buildFeedPost({ kind: "bluesky", name: "@a.bsky.social", message: null }, { id: "1", title: "hi", link: "https://bsky.app/x" }, "en").content).toContain("**@a.bsky.social** on Bluesky");
  });
});

function fakeClient(channel) {
  const guild = { id: GUILD_ID, preferredLocale: "en-US", channels: { cache: new Map(channel ? [[CHANNEL_ID, channel]] : []) } };
  return { guilds: { cache: new Map([[GUILD_ID, guild]]) } };
}

describe("live poller", () => {
  it("announces each stream once, in every server that follows it", async () => {
    let time = 1000;
    const store = new FeedStore();
    const add = (guildId, login, seen = []) => store.add({ ...base, guildId, kind: "twitch", source: login, url: `https://www.twitch.tv/${login}`, name: login, seen, createdAt: 0 });
    add(GUILD_ID, "shroud");
    add(GUILD_ID, "quiet");
    add(OTHER_GUILD, "shroud"); // the bot isn't in this server any more
    const twitch = fakeTwitch(["shroud", "quiet"], {});
    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    const poller = createLivePoller({ client: fakeClient(channel), store, providers: { twitch }, logger: fakeLogger(), now: () => time });

    await poller.tick();
    expect(channel.send).not.toHaveBeenCalled();
    expect(twitch.streams).toHaveBeenCalledWith(["shroud", "quiet"]);

    twitch.live.shroud = "stream-1";
    time += LIVE_CHECK_EVERY_MS;
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].content).toBe("🔴 **SHROUD** is live on Twitch: **Ranked grind**\nhttps://www.twitch.tv/shroud");
    expect(store.get(1)).toMatchObject({ seen: ["stream-1"], postedAt: time });

    // Still the same stream: nothing new.
    time += LIVE_CHECK_EVERY_MS;
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Off, then a new broadcast.
    delete twitch.live.shroud;
    await poller.tick();
    twitch.live.shroud = "stream-2";
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(store.get(1).seen).toEqual(["stream-2", "stream-1"]);
    expect(store.get(3).seen).toEqual([]);
  });

  it("records Twitch outages and posting problems, and clears an outage when Twitch is back", async () => {
    const store = new FeedStore();
    store.add({ ...base, kind: "twitch", source: "shroud", url: "https://www.twitch.tv/shroud", name: "shroud", createdAt: 0 });
    const twitch = fakeTwitch(["shroud"], {});
    twitch.streams.mockRejectedValueOnce(new Error("Twitch answered 503."));
    const poller = createLivePoller({ client: fakeClient(null), store, providers: { twitch }, logger: fakeLogger() });

    await poller.tick();
    expect(store.get(1)).toMatchObject({ lastError: "Twitch answered 503.", failures: 1 });
    await poller.tick();
    expect(store.get(1)).toMatchObject({ lastError: null, failures: 0 });

    twitch.live.shroud = "stream-1";
    await poller.tick();
    expect(store.get(1)).toMatchObject({ seen: ["stream-1"], lastError: expect.stringContaining("Couldn't post") });
    // The posting problem stays until a post works.
    await poller.tick();
    expect(store.get(1).lastError).toContain("Couldn't post");
  });

  it("checks Kick with its own API", async () => {
    const store = new FeedStore();
    store.add({ ...base, kind: "kick", source: "rabble", url: "https://kick.com/rabble", name: "rabble", createdAt: 0 });
    const kick = fakeTwitch(["rabble"], { rabble: "1:start" });
    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    await createLivePoller({ client: fakeClient(channel), store, providers: { kick }, logger: fakeLogger() }).tick();
    expect(channel.send.mock.calls[0][0].content).toBe("🟢 **RABBLE** is live on Kick: **Ranked grind**\nhttps://kick.com/rabble");
  });

  it("leaves Twitch and Kick out of the feed poller's list, and checks YouTube live sooner", () => {
    const store = new FeedStore();
    store.add({ ...base, kind: "twitch", source: "shroud", url: "https://www.twitch.tv/shroud", name: "shroud", createdAt: 0 });
    store.add({ ...base, kind: "kick", source: "rabble", url: "https://kick.com/rabble", name: "rabble", createdAt: 0 });
    store.add({ ...base, kind: "rss", source: "https://example.com/rss", url: "https://example.com/rss", name: "News", createdAt: 100 });
    store.add({ ...base, kind: "youtube_live", source: "x", url: "https://www.youtube.com/channel/UCx/live", name: "Live", createdAt: 100 });
    expect(store.due(1000).map((feed) => feed.kind)).toEqual(["rss", "youtube_live"]);
    expect(store.due(50, 25, 100).map((feed) => feed.kind)).toEqual(["youtube_live"]);
    expect(store.listKind("twitch").map((feed) => feed.id)).toEqual([1]);
  });
});

describe("/feed add for Twitch", () => {
  function interaction(options) {
    const channel = { id: CHANNEL_ID, type: 0, permissionsFor: () => ({ has: () => true }) };
    const state = {};
    return {
      locale: "en-US",
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, members: { me: { id: "bot" } }, channels: { cache: new Map([[CHANNEL_ID, channel]]) } },
      user: { id: USER_ID },
      memberPermissions: { has: () => true },
      inCachedGuild: () => true,
      options: { getSubcommand: () => "add", getString: (name) => options[name] ?? null, getChannel: () => channel, getRole: () => null, getInteger: () => null },
      get deferred() {
        return Boolean(state.deferred);
      },
      replied: false,
      deferReply: vi.fn(async () => {
        state.deferred = true;
      }),
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    };
  }

  it("says when Twitch isn't set up or the channel doesn't exist", async () => {
    const off = createFeedCommand({ store: new FeedStore() });
    expect(await off.execute(interaction({ type: "twitch", source: "shroud" }))).toMatchObject({ status: Status.FAILED, key: "feedErrorTwitchOff" });
    const on = createFeedCommand({ store: new FeedStore(), live: { twitch: fakeTwitch(["shroud"]) } });
    expect(await on.execute(interaction({ type: "twitch", source: "ghost_channel" }))).toMatchObject({ key: "feedErrorNoTwitchAccount" });
    expect(await on.execute(interaction({ type: "twitch", source: "shroud" }))).toMatchObject({ status: Status.SUCCESS, key: "feedAdded" });
    expect(await on.execute(interaction({ type: "kick", source: "shroud" }))).toMatchObject({ key: "feedErrorKickOff" });
    const kickOn = createFeedCommand({ store: new FeedStore(), live: { kick: fakeTwitch([]) } });
    expect(await kickOn.execute(interaction({ type: "kick", source: "ghost_channel" }))).toMatchObject({ key: "feedErrorNoKickAccount" });
  });
});

describe("Kick and GitHub sources", () => {
  it("reads Kick channel names and links", async () => {
    expect(kickSlug("https://kick.com/Rabble_Live/")).toBe("rabble_live");
    expect(kickSlug("kick.com/some-name")).toBe("some-name");
    expect(kickSlug("ab")).toBeNull();
    expect(await resolveSource("kick", "Rabble")).toEqual({ url: "https://kick.com/rabble", name: null, login: "rabble" });
    await expect(resolveSource("kick", "https://evil.example/rabble")).rejects.toMatchObject({ reason: "bad-source" });
  });

  it("turns a GitHub repository into its releases feed", async () => {
    const feed = { url: "https://github.com/0xDrMoe/RVRevival/releases.atom", name: "0xDrMoe/RVRevival" };
    for (const input of ["0xDrMoe/RVRevival", "https://github.com/0xDrMoe/RVRevival", "github.com/0xDrMoe/RVRevival/releases", "https://github.com/0xDrMoe/RVRevival.git", "https://github.com/0xDrMoe/RVRevival/releases/tag/v1"]) {
      expect(await resolveSource("github", input)).toEqual(feed);
    }
    for (const bad of ["RVRevival", "https://gitlab.com/a/b", "a/b/c", "-bad/repo", "owner/.."]) {
      await expect(resolveSource("github", bad)).rejects.toMatchObject({ reason: "bad-source" });
    }
  });
});

const CHANNEL = "UC" + "a".repeat(22);
const REST = CHANNEL.slice(2);
const atom = (title, ids) => `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom"><title>${title}</title>
  ${ids.map((id) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>Video ${id}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><author><name>Rabble</name></author></entry>`).join("")}</feed>`;

// A fetch that answers from a map of URLs, and DNS that says everything is public.
function fakeNet(pages) {
  return {
    fetchImpl: vi.fn(async (url) => {
      const page = pages[String(url)];
      return page === undefined ? new Response("nope", { status: 404 }) : new Response(page, { status: 200 });
    }),
    lookup: vi.fn(async () => [{ address: "93.184.216.34" }]),
    retryDelayMs: 0,
  };
}

const livePage = (videoId, { live = true } = {}) => `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"><meta name="title" content="Finals &amp; chill"></head>
  <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${videoId}","title":"Finals & chill","author":"Rabble"},"microformat":{"playerMicroformatRenderer":{"ownerChannelName":"Rabble \\u0026 Co","liveBroadcastDetails":{"isLiveNow":${live}}}}};</script></html>`;

describe("YouTube videos, Shorts and live", () => {
  const channelFeed = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;

  it("follows long videos, falling back to all uploads, and names the feed after the channel", async () => {
    const store = new FeedStore();
    const videos = `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${REST}`;
    const net = fakeNet({ [videos]: atom("Videos", ["v1"]), [channelFeed]: atom("Rabble", ["v1", "s1"]) });
    const feed = await addFeed({ ...base, store, kind: "youtube", source: CHANNEL, fetchOptions: net });
    expect(feed).toMatchObject({ url: videos, name: "Rabble", seen: ["v1"] });

    const fallback = await addFeed({ ...base, store, guildId: OTHER_GUILD, kind: "youtube", source: CHANNEL, fetchOptions: fakeNet({ [channelFeed]: atom("Rabble", ["v1", "s1"]) }) });
    expect(fallback).toMatchObject({ url: channelFeed, name: "Rabble", seen: ["v1", "s1"] });
    // The same channel's uploads in the same channel: a duplicate either way.
    await expect(addFeed({ ...base, store, guildId: OTHER_GUILD, kind: "youtube", source: CHANNEL, fetchOptions: net })).rejects.toThrow(/already posts/);
  });

  it("follows Shorts", async () => {
    const store = new FeedStore();
    const shorts = `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${REST}`;
    const feed = await addFeed({ ...base, store, kind: "youtube_shorts", source: CHANNEL, fetchOptions: fakeNet({ [shorts]: atom("Shorts", ["s1"]), [channelFeed]: atom("Rabble", []) }) });
    expect(feed).toMatchObject({ url: shorts, name: "Rabble", seen: ["s1"] });
  });

  it("tries YouTube's flaky feed server again before giving up", async () => {
    const store = new FeedStore();
    const shorts = `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${REST}`;
    const net = fakeNet({ [shorts]: atom("Shorts", ["s1"]), [channelFeed]: atom("Rabble", []) });
    const answers = [404, 500];
    const real = net.fetchImpl.getMockImplementation();
    net.fetchImpl.mockImplementation(async (url, init) => (String(url) === shorts && answers.length ? new Response("oops", { status: answers.shift() }) : real(url, init)));
    const feed = await addFeed({ ...base, store, kind: "youtube_shorts", source: CHANNEL, fetchOptions: net });
    expect(feed).toMatchObject({ url: shorts, seen: ["s1"] });
    expect(net.fetchImpl.mock.calls.filter(([url]) => String(url) === shorts)).toHaveLength(3);
  });

  it("saves Shorts YouTube won't serve yet and posts only Shorts made after", async () => {
    const store = new FeedStore();
    const shorts = `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH${REST}`;
    const feed = await addFeed({ ...base, store, kind: "youtube_shorts", source: CHANNEL, fetchOptions: fakeNet({ [channelFeed]: atom("Rabble", ["v1", "s1"]) }), now: () => 1000 });
    expect(feed).toMatchObject({ url: shorts, name: "Rabble", seen: [PENDING_FIRST_READ, "v1", "s1"] });

    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    let time = CHECK_EVERY_MS + 1000;
    const item = (id, publishedAt) => ({ id, title: `Short ${id}`, link: `https://www.youtube.com/shorts/${id}`, author: "Rabble", publishedAt });
    const read = vi.fn(async () => ({ title: "Shorts", items: [item("new", 2000), item("old", 500), item("s1", 400), item("undated", null)] }));
    const poller = createFeedPoller({ client: fakeClient(channel), store, logger: fakeLogger(), fetchFeed: read, now: () => time });
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].content).toContain("https://www.youtube.com/shorts/new");
    expect(store.get(feed.id).seen).toEqual(["new", "old", "undated", "v1", "s1"]);

    // After that first read it's an ordinary feed.
    read.mockResolvedValue({ title: "Shorts", items: [item("older-but-unseen", 100), item("new", 2000)] });
    time += CHECK_EVERY_MS;
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("says so when YouTube won't answer at all", async () => {
    const store = new FeedStore();
    await expect(addFeed({ ...base, store, kind: "youtube_shorts", source: CHANNEL, fetchOptions: fakeNet({}) })).rejects.toMatchObject({ reason: "unreachable" });
    expect(store.count(GUILD_ID)).toBe(0);
  });

  it("reads the /live page", () => {
    expect(readLivePage(livePage("abcdefghijk"))).toEqual({
      title: "Rabble & Co",
      items: [{ id: "abcdefghijk", title: "Finals & chill", link: "https://www.youtube.com/watch?v=abcdefghijk", author: "Rabble & Co", publishedAt: null }],
    });
    expect(readLivePage(livePage("abcdefghijk", { live: false })).items).toEqual([]);
    expect(readLivePage("<html>channel page</html>").items).toEqual([]);
    expect(readLivePage(undefined).items).toEqual([]);
  });

  it("announces each YouTube stream once, every 3 minutes", async () => {
    const store = new FeedStore();
    const liveUrl = `https://www.youtube.com/channel/${CHANNEL}/live`;
    const pages = { [liveUrl]: "<html>not live</html>", [channelFeed]: atom("Rabble", []) };
    const net = fakeNet(pages);
    const feed = await addFeed({ ...base, store, kind: "youtube_live", source: CHANNEL, fetchOptions: net, now: () => 0 });
    expect(feed).toMatchObject({ url: liveUrl, name: "Rabble", seen: [] });
    // The page is fetched with the consent cookie.
    expect(net.fetchImpl.mock.calls.find(([url]) => String(url) === liveUrl)[1].headers.Cookie).toContain("SOCS");

    let time = 0;
    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    const read = vi.fn(async (url, kind) => (kind === "youtube_live" ? readLivePage(pages[url]) : { title: "", items: [] }));
    const poller = createFeedPoller({ client: fakeClient(channel), store, logger: fakeLogger(), fetchFeed: read, now: () => time });

    pages[liveUrl] = livePage("abcdefghijk");
    time += YOUTUBE_LIVE_EVERY_MS - 1;
    await poller.tick();
    expect(read).not.toHaveBeenCalled();
    time += 1;
    await poller.tick();
    expect(channel.send.mock.calls[0][0].content).toBe("🔴 **Rabble & Co** is live on YouTube: **Finals & chill**\nhttps://www.youtube.com/watch?v=abcdefghijk");
    time += YOUTUBE_LIVE_EVERY_MS;
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("posts GitHub releases with their own default message", () => {
    const post = buildFeedPost({ kind: "github", name: "0xDrMoe/RVRevival", message: null }, { id: "1", title: "v2.0", link: "https://github.com/0xDrMoe/RVRevival/releases/tag/v2.0" }, "en");
    expect(post.content).toBe("📦 New release of **0xDrMoe/RVRevival**: **v2.0**\nhttps://github.com/0xDrMoe/RVRevival/releases/tag/v2.0");
  });
});
