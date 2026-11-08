import { describe, expect, it, vi } from "vitest";
import { createFeedCommand } from "../src/commands/feed.js";
import { FeedStore } from "../src/feeds/feedStore.js";
import { addFeed, buildFeedPost } from "../src/feeds/feeds.js";
import { resolveSource, twitchLogin } from "../src/feeds/fetchFeed.js";
import { parseFeed } from "../src/feeds/parseFeed.js";
import { createTwitchApi } from "../src/feeds/twitch.js";
import { createTwitchPoller, TWITCH_CHECK_EVERY_MS } from "../src/feeds/twitchPoller.js";
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
      return json({ data: logins.map((login) => ({ id: `s-${login}`, user_login: login, type: "live", auth: init.headers.Authorization })) });
    });
    const twitch = createTwitchApi({ clientId: "client", clientSecret: "secret", fetchImpl, now: () => time });

    const [a, b] = await Promise.all([twitch.streams(["one"]), twitch.streams(["two"])]);
    expect(tokens).toBe(1);
    expect(a[0]).toMatchObject({ id: "s-one", auth: "Bearer token1" });
    expect(b[0].auth).toBe("Bearer token1");

    rejectNext = true;
    expect((await twitch.streams(["one"]))[0].auth).toBe("Bearer token2");

    time += 3600 * 1000;
    expect((await twitch.streams(["one"]))[0].auth).toBe("Bearer token3");
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
    const error = await refused.users(["x"]).catch((caught) => caught);
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

// A Twitch API with the given channels, and who's live right now.
function fakeTwitch(users, live = {}) {
  return {
    live,
    users: vi.fn(async (logins) => logins.filter((login) => users.includes(login)).map((login) => ({ id: `u-${login}`, login, display_name: login.toUpperCase() }))),
    streams: vi.fn(async (logins) => logins.filter((login) => live[login]).map((login) => ({ id: live[login], user_login: login, user_name: login.toUpperCase(), title: "Ranked grind", game_name: "Chess", type: "live" }))),
  };
}

const base = { guildId: GUILD_ID, channelId: CHANNEL_ID, createdBy: USER_ID };

describe("adding Twitch channels", () => {
  it("needs Twitch keys and a real channel, and doesn't announce a stream that's already on", async () => {
    const store = new FeedStore();
    await expect(addFeed({ ...base, store, kind: "twitch", source: "shroud" })).rejects.toMatchObject({ reason: "not-configured" });
    const twitch = fakeTwitch(["shroud"], { shroud: "stream-1" });
    await expect(addFeed({ ...base, store, kind: "twitch", source: "nobody_here", twitch })).rejects.toMatchObject({ reason: "no-account" });
    const feed = await addFeed({ ...base, store, kind: "twitch", source: "https://twitch.tv/Shroud", twitch });
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

describe("Twitch poller", () => {
  it("announces each stream once, in every server that follows it", async () => {
    let time = 1000;
    const store = new FeedStore();
    const add = (guildId, login, seen = []) => store.add({ ...base, guildId, kind: "twitch", source: login, url: `https://www.twitch.tv/${login}`, name: login, seen, createdAt: 0 });
    add(GUILD_ID, "shroud");
    add(GUILD_ID, "quiet");
    add(OTHER_GUILD, "shroud"); // the bot isn't in this server any more
    const twitch = fakeTwitch(["shroud", "quiet"], {});
    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    const poller = createTwitchPoller({ client: fakeClient(channel), store, twitch, logger: fakeLogger(), now: () => time });

    await poller.tick();
    expect(channel.send).not.toHaveBeenCalled();
    expect(twitch.streams).toHaveBeenCalledWith(["shroud", "quiet"]);

    twitch.live.shroud = "stream-1";
    time += TWITCH_CHECK_EVERY_MS;
    await poller.tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].content).toBe("🔴 **SHROUD** is live on Twitch: **Ranked grind**\nhttps://www.twitch.tv/shroud");
    expect(store.get(1)).toMatchObject({ seen: ["stream-1"], postedAt: time });

    // Still the same stream: nothing new.
    time += TWITCH_CHECK_EVERY_MS;
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
    const poller = createTwitchPoller({ client: fakeClient(null), store, twitch, logger: fakeLogger() });

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

  it("leaves Twitch out of the feed poller's list", () => {
    const store = new FeedStore();
    store.add({ ...base, kind: "twitch", source: "shroud", url: "https://www.twitch.tv/shroud", name: "shroud", createdAt: 0 });
    store.add({ ...base, kind: "rss", source: "https://example.com/rss", url: "https://example.com/rss", name: "News", createdAt: 0 });
    expect(store.due(10).map((feed) => feed.kind)).toEqual(["rss"]);
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
    const on = createFeedCommand({ store: new FeedStore(), twitch: fakeTwitch(["shroud"]) });
    expect(await on.execute(interaction({ type: "twitch", source: "ghost_channel" }))).toMatchObject({ key: "feedErrorNoTwitchAccount" });
    expect(await on.execute(interaction({ type: "twitch", source: "shroud" }))).toMatchObject({ status: Status.SUCCESS, key: "feedAdded" });
  });
});
