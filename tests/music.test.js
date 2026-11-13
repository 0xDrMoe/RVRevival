import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { createBandcamp, readSearchResults, readTralbum } from "../src/music/bandcamp.js";
import { createCatalogs, parseCatalogLink, readSpotifyEmbed } from "../src/music/catalogs.js";
import { checkMusic, DEFAULT_MUSIC, describeMusic, InvalidMusic, normalizeMusic } from "../src/music/config.js";
import { audiusTrack, createAudius, isAudiusUrl } from "../src/music/audius.js";
import { createJamendo } from "../src/music/jamendo.js";
import { cleanQuery, findMatch, matchQuery, matchScore, queryScore, words } from "../src/music/match.js";
import { audioFilter, filterSpeed, FILTER_NAMES } from "../src/music/filters.js";
import { cleanTitle, createLyrics, splitArtist } from "../src/music/lyrics.js";
import { MusicError } from "../src/music/net.js";
import { nowPlayingMessage, progressBar, queueMessage, sourceLabel } from "../src/music/nowPlaying.js";
import { cleanPlaylistName, MAX_PLAYLISTS, PlaylistStore, savedTrack } from "../src/music/playlistStore.js";
import { createMusic } from "../src/music/player.js";
import { createRadio, isStationId, stationLabel, stationTrack, toStation } from "../src/music/radio.js";
import { createSoundCloud, isPlayable, pickTranscoding } from "../src/music/soundcloud.js";
import { asUrl, createResolver, firstPlaylistEntry } from "../src/music/sources.js";
import { ffmpegArgs, openAudio } from "../src/music/stream.js";
import { formatTime, makeTrack, Source, trackLabel, Via } from "../src/music/track.js";
import { fakeLogger } from "./helpers/fakes.js";

const API = "https://api-v2.soundcloud.com";
const CLIENT = "a".repeat(32);

// A SoundCloud API track.
function scTrack(overrides = {}) {
  return {
    kind: "track",
    id: 1,
    title: "Song",
    user: { username: "Artist" },
    permalink_url: "https://soundcloud.com/artist/song",
    artwork_url: "https://i1.sndcdn.com/artworks-x-large.jpg",
    full_duration: 200_000,
    duration: 200_000,
    streamable: true,
    policy: "ALLOW",
    media: {
      transcodings: [
        { url: `${API}/media/soundcloud:tracks:1/a/stream/hls`, snipped: false, format: { protocol: "hls", mime_type: "audio/mpeg" } },
        { url: `${API}/media/soundcloud:tracks:1/a/stream/progressive`, snipped: false, format: { protocol: "progressive", mime_type: "audio/mpeg" } },
      ],
    },
    ...overrides,
  };
}

describe("music settings", () => {
  it("fills in the defaults and drops anything unusable", () => {
    expect(normalizeMusic(undefined)).toEqual(DEFAULT_MUSIC);
    expect(normalizeMusic({ djRoleId: "nope", defaultVolume: 999, maxQueue: 3, announce: "yes", leaveAfterMinutes: -1 })).toEqual(DEFAULT_MUSIC);
    expect(normalizeMusic({ djRoleId: "123456789012345678", defaultVolume: 50, announce: false })).toMatchObject({ djRoleId: "123456789012345678", defaultVolume: 50, announce: false });
  });

  it("checks input and saves nothing for the defaults", () => {
    const isRole = (id) => id === "123456789012345678";
    expect(checkMusic({ ...DEFAULT_MUSIC }, { isRole })).toBeNull();
    expect(checkMusic({ djRoleId: "123456789012345678", leaveAfterMinutes: 0 }, { isRole })).toEqual({ ...DEFAULT_MUSIC, djRoleId: "123456789012345678", leaveAfterMinutes: 0 });
    expect(() => checkMusic({ djRoleId: "999999999999999999" }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic({ defaultVolume: 151 }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic({ defaultVolume: 50.5 }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic({ maxQueue: 9 }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic({ leaveAfterMinutes: 61 }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic({ announce: 1 }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic({ extra: true }, { isRole })).toThrow(InvalidMusic);
    expect(() => checkMusic([], { isRole })).toThrow(InvalidMusic);
  });

  it("describes them for the logs", () => {
    expect(describeMusic(null)).toBe("no DJ role · vote skip 50% · any length · volume 80% · queue 200 · now playing on · leaves after 3 min");
    expect(describeMusic({ djRoleId: "123456789012345678", announce: false, leaveAfterMinutes: 0 })).toBe(
      "DJ <@&123456789012345678> · vote skip 50% · any length · volume 80% · queue 200 · now playing off · leaves right away",
    );
    expect(describeMusic({ djRoleId: "123456789012345678", djOnly: true, voteSkipPercent: 0, maxSongMinutes: 10, stay247: true })).toBe(
      "DJ <@&123456789012345678> · DJ only · vote skip off · songs up to 10 min · volume 80% · queue 200 · now playing on · 24/7",
    );
  });
});

describe("tracks", () => {
  it("cleans what sources send", () => {
    const track = makeTrack({ title: "  A\n song ", url: "javascript:alert(1)", artworkUrl: "http://x/a.jpg", durationMs: -5 });
    expect(track).toMatchObject({ title: "A song", url: null, artworkUrl: null, durationMs: null, live: false });
    expect(track.id).toMatch(/^[0-9a-f]{8}$/);
    expect(makeTrack({ title: "" }).title).toBe("Untitled");
  });

  it("formats times and labels", () => {
    expect(formatTime(185_000)).toBe("3:05");
    expect(formatTime(3_723_000)).toBe("1:02:03");
    expect(formatTime(Number.NaN)).toBe("?:??");
    expect(trackLabel({ title: "Song", artist: "Band" })).toBe("Band - Song");
    expect(trackLabel({ title: "Band - Song", artist: "Band" })).toBe("Band - Song");
    expect(sourceLabel({ source: Source.SOUNDCLOUD, via: Via.SPOTIFY })).toBe("Spotify → SoundCloud");
  });
});

describe("matching songs to SoundCloud", () => {
  it("cleans titles into words", () => {
    expect(words("Blinding Lights (feat. Someone) - 2020 Remaster")).toEqual(["blinding", "lights"]);
    expect(words("Café del Mar")).toEqual(["cafe", "del", "mar"]);
    expect(matchQuery({ title: "One More Time", artist: "Daft Punk, Romanthony" })).toBe("Daft Punk one more time");
  });

  it("prefers the original over covers and songs of another length", () => {
    const lookup = { title: "One More Time", artist: "Daft Punk", durationMs: 320_000 };
    const original = { title: "One More Time", user: { username: "Daft Punk" }, full_duration: 321_000 };
    const cover = { title: "One More Time (piano cover)", user: { username: "Pianist" }, full_duration: 300_000 };
    const other = { title: "Something Else", user: { username: "Daft Punk" }, full_duration: 320_000 };
    expect(matchScore(lookup, original)).toBeGreaterThan(0.9);
    expect(matchScore(lookup, cover)).toBeLessThan(0.55);
    expect(matchScore(lookup, other)).toBeLessThan(0.55);
  });

  it("picks the best match or none", async () => {
    const lookup = { title: "One More Time", artist: "Daft Punk", durationMs: 320_000 };
    const soundcloud = { search: vi.fn(async () => [{ title: "One More Time (cover)", user: { username: "X" }, full_duration: 1 }, { id: 7, title: "Daft Punk - One More Time", user: { username: "fan" }, full_duration: 322_000 }]) };
    expect((await findMatch(soundcloud, lookup)).id).toBe(7);
    expect(soundcloud.search).toHaveBeenCalledWith("Daft Punk one more time", { limit: 20 });
    expect(await findMatch({ search: async () => [] }, lookup)).toBeNull();
  });
});

describe("SoundCloud", () => {
  it("picks a full MP3 file first and refuses previews", () => {
    expect(pickTranscoding(scTrack())).toEqual({ url: `${API}/media/soundcloud:tracks:1/a/stream/progressive`, protocol: "progressive" });
    const previews = scTrack({ media: { transcodings: scTrack().media.transcodings.map((item) => ({ ...item, snipped: true })) } });
    expect(pickTranscoding(previews)).toBeNull();
    expect(isPlayable(previews)).toBe(false);
    expect(isPlayable(scTrack({ policy: "SNIP" }))).toBe(false);
    expect(isPlayable(scTrack({ streamable: false }))).toBe(false);
    // Only SoundCloud's own API addresses are followed.
    expect(pickTranscoding(scTrack({ media: { transcodings: [{ url: "https://evil.test/x", format: { protocol: "progressive" } }] } }))).toBeNull();
  });

  it("finds the client ID in soundcloud.com's scripts and looks it up again when refused", async () => {
    const fetchText = vi.fn(async (url) => {
      if (url === "https://soundcloud.com/") {
        return '<script crossorigin src="https://a-v2.sndcdn.com/assets/0-a.js"></script><script crossorigin src="https://a-v2.sndcdn.com/assets/1-b.js"></script>';
      }
      return url.endsWith("1-b.js") ? `({client_id:"${CLIENT}"})` : "";
    });
    let refusals = 1;
    const fetchJson = vi.fn(async (url) => {
      expect(new URL(url).searchParams.get("client_id")).toBe(CLIENT);
      if (refusals-- > 0) {
        throw new MusicError("unreachable", "api-v2.soundcloud.com answered 401.");
      }
      return scTrack();
    });
    const soundcloud = createSoundCloud({ fetchText, fetchJson });
    const found = await soundcloud.resolve("https://soundcloud.com/artist/song");
    expect(found.tracks[0]).toMatchObject({ title: "Song", artist: "Artist", source: Source.SOUNDCLOUD, stream: { id: 1 }, artworkUrl: "https://i1.sndcdn.com/artworks-x-t500x500.jpg", durationMs: 200_000 });
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchText.mock.calls.filter(([url]) => url === "https://soundcloud.com/")).toHaveLength(2);
  });

  it("fills in playlists and leaves out Go+ tracks", async () => {
    const fetchJson = vi.fn(async (url) => {
      const address = new URL(url);
      if (address.pathname === "/resolve") {
        return { kind: "playlist", title: "Mix", tracks: [scTrack({ id: 1 }), { id: 2, kind: "track" }, { id: 3, kind: "track" }] };
      }
      expect(address.pathname).toBe("/tracks");
      expect(address.searchParams.get("ids")).toBe("2,3");
      return [scTrack({ id: 2, title: "Two" }), scTrack({ id: 3, policy: "SNIP" })];
    });
    const found = await createSoundCloud({ clientId: CLIENT, fetchJson }).resolve("https://soundcloud.com/a/sets/mix");
    expect(found.name).toBe("Mix");
    expect(found.tracks.map((track) => track.stream.id)).toEqual([1, 2]);
    expect(found.skipped).toBe(1);
  });

  it("refuses profiles and preview-only tracks", async () => {
    const answer = (value) => createSoundCloud({ clientId: CLIENT, fetchJson: async () => value });
    await expect(answer({ kind: "user" }).resolve("https://soundcloud.com/a")).rejects.toMatchObject({ reason: "unsupported" });
    await expect(answer(scTrack({ policy: "SNIP" })).resolve("https://soundcloud.com/a/b")).rejects.toMatchObject({ reason: "not-free" });
  });

  it("gets a fresh stream address with the track's authorization", async () => {
    const fetchJson = vi.fn(async (url) => {
      const address = new URL(url);
      if (address.pathname === "/tracks/1") {
        return scTrack({ track_authorization: "auth" });
      }
      expect(address.searchParams.get("track_authorization")).toBe("auth");
      return { url: "https://cf-media.sndcdn.com/abc.mp3?x=1" };
    });
    expect(await createSoundCloud({ clientId: CLIENT, fetchJson }).streamFor(1)).toEqual({ url: "https://cf-media.sndcdn.com/abc.mp3?x=1", protocol: "progressive" });
  });
});

describe("Bandcamp", () => {
  const page = (trackinfo) => `<div data-tralbum="${JSON.stringify({ artist: "Band", art_id: 42, current: { title: "Album" }, trackinfo }).replace(/"/g, "&quot;")}"></div>`;

  it("reads the tracks anyone can stream", async () => {
    expect(readTralbum("<html></html>")).toBeNull();
    const html = page([
      { title: "One &amp; Two", duration: 61.5, track_id: 1, title_link: "/track/one", file: { "mp3-128": "https://t4.bcbits.com/stream/1" } },
      { title: "Locked", duration: 100, track_id: 2, file: null },
    ]);
    const bandcamp = createBandcamp({ fetchText: async () => html });
    const found = await bandcamp.resolve("https://band.bandcamp.com/album/album");
    expect(found.tracks).toHaveLength(1);
    expect(found.tracks[0]).toMatchObject({ title: "One & Two", artist: "Band", url: "https://band.bandcamp.com/track/one", durationMs: 61_500, artworkUrl: "https://f4.bcbits.com/img/a42_10.jpg" });
    expect(found).toMatchObject({ skipped: 1, name: "Album" });
    expect(await bandcamp.streamFor(found.tracks[0].stream)).toBe("https://t4.bcbits.com/stream/1");
  });
});

describe("Spotify, Apple Music and Deezer links", () => {
  it("recognises song, album and playlist links", () => {
    const parse = (link) => parseCatalogLink(new URL(link));
    expect(parse("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x")).toEqual({ via: Via.SPOTIFY, type: "track", id: "4uLU6hMCjMI75M1A2tKUQC", country: null });
    expect(parse("https://open.spotify.com/artist/4uLU6hMCjMI75M1A2tKUQC").type).toBe("unsupported");
    expect(parse("https://www.deezer.com/fr/album/302127")).toMatchObject({ via: Via.DEEZER, type: "album", id: "302127" });
    expect(parse("https://music.apple.com/gb/album/abbey-road/1441164426?i=1441164430")).toEqual({ via: Via.APPLE, type: "track", id: "1441164430", country: "gb" });
    expect(parse("https://music.apple.com/us/album/abbey-road/1441164426")).toMatchObject({ type: "album", id: "1441164426" });
    expect(parse("https://music.apple.com/us/playlist/x/pl.123")).toMatchObject({ type: "playlist" });
    expect(parse("https://example.com/track/1")).toBeNull();
  });

  it("reads Spotify's embed page", async () => {
    const data = { props: { pageProps: { state: { data: { entity: { name: "Playlist", trackList: [{ title: "Song", subtitle: "A, B", duration: 180_000, uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }] } } } } } };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    expect(readSpotifyEmbed(html).name).toBe("Playlist");
    const catalogs = createCatalogs({ fetchText: vi.fn(async () => html) });
    const found = await catalogs.resolve({ via: Via.SPOTIFY, type: "playlist", id: "x".repeat(22) });
    expect(found.name).toBe("Playlist");
    expect(found.tracks[0]).toMatchObject({ title: "Song", artist: "A, B", source: null, via: Via.SPOTIFY, url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", lookup: { title: "Song", artist: "A, B", durationMs: 180_000 } });
  });

  it("reads Deezer's and Apple's public APIs", async () => {
    const deezer = createCatalogs({
      fetchJson: async (url) => (url.endsWith("/track/1") ? { title: "Song", duration: 200, artist: { name: "Band" }, link: "https://www.deezer.com/track/1" } : { error: { code: 800 } }),
    });
    expect((await deezer.resolve({ via: Via.DEEZER, type: "track", id: "1" })).tracks[0]).toMatchObject({ title: "Song", artist: "Band", durationMs: 200_000 });
    await expect(deezer.resolve({ via: Via.DEEZER, type: "album", id: "2" })).rejects.toMatchObject({ reason: "not-found" });

    const apple = createCatalogs({
      fetchJson: async (url) => {
        expect(new URL(url).searchParams.get("entity")).toBe("song");
        return { results: [{ wrapperType: "collection", collectionName: "Abbey Road" }, { wrapperType: "track", kind: "song", trackName: "Something", artistName: "The Beatles", trackTimeMillis: 182_000 }] };
      },
    });
    const album = await apple.resolve({ via: Via.APPLE, type: "album", id: "1", country: "us" });
    expect(album.name).toBe("Abbey Road");
    expect(album.tracks[0].lookup).toEqual({ title: "Something", artist: "The Beatles", durationMs: 182_000 });
    await expect(apple.resolve({ via: Via.APPLE, type: "playlist", id: "pl.1" })).rejects.toMatchObject({ reason: "unsupported" });
  });
});

describe("radio", () => {
  const item = { stationuuid: "96062a7b-0601-11e8-ae97-52543be04c81", name: " Radio One ", url: "http://x/stream", url_resolved: "https://x/stream.mp3", country: "UK", bitrate: 128, tags: "pop,rock,news,talk", homepage: "https://radio.one" };

  it("turns stations into tracks", () => {
    const station = toStation(item);
    expect(station).toMatchObject({ name: "Radio One", url: "https://x/stream.mp3", tags: ["pop", "rock", "news"] });
    expect(stationLabel(station)).toBe("Radio One · UK · 128 kbps");
    expect(stationTrack(station)).toMatchObject({ live: true, source: Source.RADIO, stream: { url: "https://x/stream.mp3" } });
    expect(toStation({ stationuuid: "x", url: "ftp://nope" })).toBeNull();
    expect(isStationId(item.stationuuid)).toBe(true);
    expect(isStationId("Radio One")).toBe(false);
  });

  it("searches, keeps answers for a while and tries another server", async () => {
    let calls = 0;
    const fetchJson = vi.fn(async (url) => {
      calls += 1;
      if (url.startsWith("https://de1.")) {
        throw new MusicError("unreachable");
      }
      return [item];
    });
    const radio = createRadio({ fetchJson });
    expect((await radio.search("radio one"))[0].name).toBe("Radio One");
    await radio.search("Radio One");
    expect(calls).toBe(2);
    expect(await radio.search("  ")).toEqual([]);
    expect(await radio.byId("not an id")).toBeNull();
  });
});

describe("what /play takes", () => {
  const audio = (headers) => async (link) => ({ url: new URL(link), response: new Response("x", { headers }), abort: vi.fn() });

  it("tells links from words", () => {
    expect(asUrl("lofi beats")).toBeNull();
    expect(asUrl("soundcloud.com/a/b").href).toBe("https://soundcloud.com/a/b");
    expect(asUrl("https://x.test/a b")).toBeNull();
    expect(firstPlaylistEntry("#EXTM3U\n#EXTINF:-1,Radio\nhttp://radio.test/live\n")).toEqual({ hls: false, url: "http://radio.test/live" });
    expect(firstPlaylistEntry("[playlist]\nFile1=https://radio.test/a\n").url).toBe("https://radio.test/a");
    expect(firstPlaylistEntry("#EXTM3U\n#EXT-X-VERSION:3\n").hls).toBe(true);
  });

  it("refuses YouTube without asking it anything", async () => {
    const openUrl = vi.fn();
    const resolver = createResolver({ soundcloud: {}, openUrl });
    for (const link of ["https://www.youtube.com/watch?v=x", "youtu.be/x", "https://music.youtube.com/watch?v=x"]) {
      await expect(resolver.resolve(link)).rejects.toMatchObject({ reason: "youtube" });
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("plays links to audio and refuses web pages", async () => {
    const stream = await createResolver({ soundcloud: {}, openUrl: audio({ "content-type": "audio/mpeg", "icy-name": "Cool FM" }) }).resolve("https://radio.test/live");
    expect(stream.tracks[0]).toMatchObject({ title: "Cool FM", live: true, source: Source.LINK, stream: { url: "https://radio.test/live" } });
    const file = await createResolver({ soundcloud: {}, openUrl: audio({ "content-type": "audio/ogg", "content-length": "1000" }) }).resolve("https://files.test/My%20Song.ogg");
    expect(file.tracks[0]).toMatchObject({ title: "My Song", live: false });
    await expect(createResolver({ soundcloud: {}, openUrl: audio({ "content-type": "text/html" }) }).resolve("https://example.com")).rejects.toMatchObject({ reason: "not-audio" });
  });

  it("follows .m3u playlists to the stream", async () => {
    const openUrl = vi.fn(async (link) =>
      link.endsWith(".m3u")
        ? { url: new URL(link), response: new Response("#EXTM3U\nhttps://radio.test/stream\n", { headers: { "content-type": "audio/x-mpegurl" } }), abort: vi.fn() }
        : { url: new URL(link), response: new Response("x", { headers: { "content-type": "audio/aacp" } }), abort: vi.fn() },
    );
    const found = await createResolver({ soundcloud: {}, openUrl }).resolve("https://radio.test/listen.m3u");
    expect(found.tracks[0].stream.url).toBe("https://radio.test/stream");
  });

  it("searches every library for words and ranks the results together", async () => {
    const soundcloud = { find: vi.fn(async () => ({ tracks: [scTrack({ title: "Song (sped up)" })], previews: 0 })) };
    const audius = { search: vi.fn(async () => [makeTrack({ title: "Song", artist: "Artist", source: Source.AUDIUS, stream: { id: "a1" }, url: "https://audius.co/artist/song" })]) };
    const resolver = createResolver({ soundcloud, audius, bandcamp: {}, jamendo: null });
    const found = await resolver.resolve("Artist - Song (Official Video)");
    expect(soundcloud.find).toHaveBeenCalledWith("Artist Song", { limit: 10 });
    expect(soundcloud.find).toHaveBeenCalledWith("Artist - Song (Official Video)", { limit: 10 });
    expect(audius.search).toHaveBeenCalledWith("Artist Song", { limit: 10 });
    expect(found.tracks[0]).toMatchObject({ title: "Song", source: Source.AUDIUS });
    expect((await resolver.search("Artist Song")).map((track) => track.source)).toEqual([Source.AUDIUS, Source.SOUNDCLOUD]);

    const none = createResolver({ soundcloud: { find: async () => ({ tracks: [], previews: 0 }) }, audius: { search: async () => [] }, bandcamp: {} });
    await expect(none.resolve("nothing")).rejects.toMatchObject({ reason: "no-results" });
    const previews = createResolver({ soundcloud: { find: async () => ({ tracks: [], previews: 4 }) }, audius: null, bandcamp: {} });
    await expect(previews.resolve("hit song")).rejects.toMatchObject({ reason: "not-free" });
  });

  it("carries on when a library fails, and says so when they all do", async () => {
    const broken = { find: async () => Promise.reject(new MusicError("not-found", "api-v2.soundcloud.com answered 404.")) };
    const audius = { search: async () => [makeTrack({ title: "Song", artist: "Band", source: Source.AUDIUS, stream: { id: "a1" } })] };
    const logger = fakeLogger();
    expect((await createResolver({ soundcloud: broken, audius, bandcamp: {}, logger }).resolve("band song")).tracks[0].source).toBe(Source.AUDIUS);
    expect(logger.warn).toHaveBeenCalled();
    await expect(createResolver({ soundcloud: broken, audius: null, bandcamp: {} }).resolve("band song")).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("checks a Bandcamp pick can stream before playing it", async () => {
    const soundcloud = { find: async () => ({ tracks: [], previews: 0 }) };
    const result = (name) => makeTrack({ title: "Song", artist: "Band", source: Source.BANDCAMP, url: `https://${name}.bandcamp.com/track/song`, stream: { page: `https://${name}.bandcamp.com/track/song`, trackId: null } });
    const playable = makeTrack({ title: "Song", artist: "Band", source: Source.BANDCAMP, durationMs: 1000, stream: { page: "https://b.bandcamp.com/track/song", trackId: 2 } });
    const bandcamp = {
      search: async () => [result("a"), result("b")],
      resolve: vi.fn(async (url) => (url.startsWith("https://a.") ? Promise.reject(new MusicError("not-free")) : { tracks: [playable], skipped: 0, name: null })),
    };
    const found = await createResolver({ soundcloud, audius: null, bandcamp }).resolve("band song");
    expect(bandcamp.resolve).toHaveBeenCalledTimes(2);
    expect(found.tracks[0].stream).toEqual({ page: "https://b.bandcamp.com/track/song", trackId: 2 });
  });

  it("plays uploaded audio files only", () => {
    const resolver = createResolver({ soundcloud: {} });
    expect(resolver.fileTrack({ contentType: "audio/mpeg", url: "https://cdn.discordapp.com/attachments/1/2/song.mp3?ex=1", name: "song.mp3", duration: 12.5 })).toMatchObject({ title: "song", source: Source.FILE, durationMs: 12_500 });
    expect(() => resolver.fileTrack({ contentType: "image/png", url: "https://cdn.discordapp.com/a.png" })).toThrow(MusicError);
  });

  it("matches Spotify songs just before they play", async () => {
    const soundcloud = { search: vi.fn(async () => [scTrack({ id: 9, title: "Song", user: { username: "Band" }, full_duration: 180_000 })]) };
    const resolver = createResolver({ soundcloud, audius: null });
    const track = { ...makeTrack({ title: "Song", artist: "Band", via: Via.SPOTIFY, lookup: { title: "Song", artist: "Band", durationMs: 181_000 } }), requestedBy: "1" };
    expect(await resolver.ready(track)).toMatchObject({ id: track.id, source: Source.SOUNDCLOUD, via: Via.SPOTIFY, stream: { id: 9 }, requestedBy: "1", url: "https://soundcloud.com/artist/song" });
    await expect(createResolver({ soundcloud: { search: async () => [] }, audius: null }).ready(track)).rejects.toMatchObject({ reason: "no-match" });

    // No copy on SoundCloud (or SoundCloud failing): Audius is tried.
    const audius = { search: vi.fn(async () => [makeTrack({ title: "Song", artist: "Band", durationMs: 180_000, source: Source.AUDIUS, stream: { id: "x" }, url: "https://audius.co/band/song" })]) };
    const failing = { search: async () => Promise.reject(new MusicError("not-found", "api-v2.soundcloud.com answered 404.")) };
    expect(await createResolver({ soundcloud: failing, audius }).ready(track)).toMatchObject({ source: Source.AUDIUS, stream: { id: "x" }, via: Via.SPOTIFY });
    await expect(createResolver({ soundcloud: failing, audius: { search: async () => [] } }).ready(track)).rejects.toMatchObject({ reason: "unreachable" });
  });
});

describe("audio", () => {
  it("lets ffmpeg reach only HTTPS for HLS", () => {
    expect(ffmpegArgs("pipe:0")).not.toContain("-protocol_whitelist");
    const hls = ffmpegArgs("https://cdn.test/a.m3u8");
    expect(hls[hls.indexOf("-protocol_whitelist") + 1]).toBe("https,tls,tcp,hls,crypto");
    expect(hls.slice(-7)).toEqual(["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"]);
  });

  it("feeds downloads to ffmpeg and stops both", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn() });
    const spawnImpl = vi.fn(() => child);
    const abort = vi.fn();
    const openUrl = vi.fn(async () => ({ url: new URL("https://files.test/a.mp3"), response: new Response("abc"), abort }));
    const audio = await openAudio({ source: Source.LINK, stream: { url: "https://files.test/a.mp3" }, live: false }, { openUrl, spawnImpl });
    expect(spawnImpl.mock.calls[0][1]).toContain("pipe:0");
    expect(audio.stream).toBe(child.stdout);
    audio.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(abort).toHaveBeenCalled();
  });

  it("refuses HLS that isn't HTTPS", async () => {
    const soundcloud = { streamFor: async () => ({ url: "http://cdn.test/a.m3u8", protocol: "hls" }) };
    await expect(openAudio({ source: Source.SOUNDCLOUD, stream: { id: 1 } }, { soundcloud, spawnImpl: vi.fn() })).rejects.toMatchObject({ reason: "unreachable" });
  });
});

// --- The player --------------------------------------------------------------------

function fakeVoice() {
  const players = [];
  const voice = {
    joinVoiceChannel: vi.fn(() => {
      const connection = Object.assign(new EventEmitter(), { state: { status: VoiceConnectionStatus.Ready }, subscribe: vi.fn(), destroy: vi.fn(() => (connection.state = { status: VoiceConnectionStatus.Destroyed })) });
      voice.connection = connection;
      return connection;
    }),
    createAudioPlayer: vi.fn(() => {
      const player = new EventEmitter();
      player.status = AudioPlayerStatus.Idle;
      player.play = vi.fn((resource) => {
        player.resource = resource;
        const before = { status: player.status };
        player.status = AudioPlayerStatus.Playing;
        player.emit("stateChange", before, { status: AudioPlayerStatus.Playing, resource });
      });
      // Ends the song: Playing → Idle.
      player.finish = () => {
        const resource = player.resource;
        player.status = AudioPlayerStatus.Idle;
        player.emit("stateChange", { status: AudioPlayerStatus.Playing, resource }, { status: AudioPlayerStatus.Idle });
      };
      player.stop = vi.fn(() => {
        if (player.status !== AudioPlayerStatus.Idle) {
          player.finish();
        }
        return true;
      });
      player.pause = vi.fn(() => true);
      player.unpause = vi.fn(() => true);
      players.push(player);
      return player;
    }),
    createAudioResource: vi.fn((stream, { metadata }) => ({ stream, metadata, playbackDuration: 60_000, volume: { setVolume: vi.fn() } })),
    entersState: vi.fn(async () => {}),
    players,
  };
  return voice;
}

function fakeGuild({ humans = 1 } = {}) {
  const members = new Map(Array.from({ length: humans }, (_, index) => [`u${index}`, { user: { bot: false } }]));
  members.set("bot", { user: { bot: true } });
  const voiceChannel = { id: "vc", type: 2, members };
  const sent = [];
  const textChannel = { send: vi.fn(async (payload) => {
    const message = { payload, edit: vi.fn(async () => {}), delete: vi.fn(async () => {}), channelId: "tc" };
    sent.push(message);
    return message;
  }), sent };
  const guild = {
    id: "g1",
    preferredLocale: "en-US",
    voiceAdapterCreator: () => ({}),
    channels: { cache: new Map([["vc", voiceChannel]]) },
    members: { me: { id: "bot" } },
  };
  return { guild, voiceChannel, textChannel };
}

const settings = (music = null) => ({ get: (guildId, key) => (key === "music" ? music : null) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ music = null, ready = async (track) => ({ ...track, source: track.source ?? Source.SOUNDCLOUD }), openAudio: open, maxPlayers = 25, humans = 1 } = {}) {
  const voice = fakeVoice();
  const timers = [];
  const manager = createMusic({
    guildSettings: settings(music),
    logger: fakeLogger(),
    resolver: { ready: vi.fn(ready), soundcloud: {}, bandcamp: {} },
    radio: {},
    voice,
    openAudio: open ?? vi.fn(async () => ({ stream: new PassThrough(), stop: vi.fn(), errors: [] })),
    maxPlayers,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => timers.splice(timers.indexOf(timer), 1),
  });
  const server = fakeGuild({ humans });
  return { voice, manager, timers, ...server };
}

const songs = (...titles) => titles.map((title) => makeTrack({ title, source: Source.SOUNDCLOUD, stream: { id: title } }));

describe("music player", () => {
  it("joins, plays the queue in order and posts Now playing", async () => {
    const { voice, manager, guild, voiceChannel, textChannel } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    expect(voice.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({ channelId: "vc", guildId: "g1", selfDeaf: true }));
    expect(player.add(songs("A", "B"), { requestedBy: "u0" })).toBe(2);
    await flush();
    expect(player.current.title).toBe("A");
    expect(player.queue.map((track) => track.title)).toEqual(["B"]);
    expect(textChannel.sent[0].payload.embeds[0].data.title).toBe("A");
    expect(voice.createAudioResource.mock.results[0].value.volume.setVolume).toHaveBeenCalledWith(0.8);

    voice.players[0].finish();
    await flush();
    expect(player.current.title).toBe("B");
    expect(textChannel.sent[0].delete).toHaveBeenCalled();
  });

  it("adds songs next, caps the queue and refuses when too many servers play", async () => {
    const { manager, guild, voiceChannel, textChannel } = setup({ music: { maxQueue: 10 }, maxPlayers: 1 });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A"), { requestedBy: "u0" });
    await flush();
    player.add(songs("B", "C"), { requestedBy: "u0" });
    player.add(songs("D"), { next: true, requestedBy: "u0" });
    expect(player.queue.map((track) => track.title)).toEqual(["D", "B", "C"]);
    expect(player.add(songs(...Array.from({ length: 20 }, (_, index) => `x${index}`)), { requestedBy: "u0" })).toBe(7);
    const other = fakeGuild();
    await expect(manager.join({ guild: { ...other.guild, id: "g2" }, channel: other.voiceChannel })).rejects.toMatchObject({ reason: "busy" });
  });

  it("loops the song or the queue, and skips past a looping song", async () => {
    const { voice, manager, guild, voiceChannel, textChannel } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A", "B", "C"), { requestedBy: "u0" });
    await flush();
    player.setLoop("track");
    voice.players[0].finish();
    await flush();
    expect(player.current.title).toBe("A");
    player.skip();
    await flush();
    expect(player.current.title).toBe("B");
    player.setLoop("queue");
    voice.players[0].finish();
    await flush();
    expect(player.current.title).toBe("C");
    expect(player.queue.map((track) => track.title)).toEqual(["B"]);
  });

  it("skips songs that can't play in one message and gives up after twelve in a row", async () => {
    const ready = async (track) => {
      throw new MusicError("no-match");
    };
    const { manager, guild, voiceChannel, textChannel } = setup({ ready });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs(...Array.from({ length: 14 }, (_, index) => `S${index}`)), { requestedBy: "u0" });
    await flush();
    await flush();
    const notes = textChannel.send.mock.calls.map(([payload]) => payload.content);
    // The first 10 go in one message, edited as they fail; then a new one.
    expect(notes.filter((note) => note?.includes("Couldn't play"))).toHaveLength(2);
    expect(textChannel.sent[0].edit.mock.calls.at(-1)[0].content.split("\n")).toHaveLength(10);
    expect(notes.at(-1)).toContain("Several songs in a row");
    expect(player.destroyed).toBe(true);
    expect(manager.get("g1")).toBeNull();
  });

  it("pauses when everyone leaves, picks up when they're back, and leaves after the wait", async () => {
    const { voice, manager, guild, voiceChannel, textChannel, timers } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A"), { requestedBy: "u0" });
    await flush();
    voiceChannel.members.delete("u0");
    manager.voiceStateUpdate({ id: "u0", channelId: "vc", guild }, { id: "u0", channelId: null, guild });
    expect(voice.players[0].pause).toHaveBeenCalled();
    expect(player.paused).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(3 * 60_000);

    voiceChannel.members.set("u0", { user: { bot: false } });
    manager.voiceStateUpdate({ id: "u0", channelId: null, guild }, { id: "u0", channelId: "vc", guild });
    expect(voice.players[0].unpause).toHaveBeenCalled();
    expect(player.paused).toBe(false);
    expect(timers).toHaveLength(0);

    voiceChannel.members.delete("u0");
    manager.voiceStateUpdate({ id: "u0", channelId: "vc", guild }, { id: "u0", channelId: null, guild });
    timers[0].fn();
    expect(player.destroyed).toBe(true);
    expect(voice.connection.destroy).toHaveBeenCalled();
    expect(textChannel.send.mock.calls.at(-1)[0].content).toContain("nobody was listening");
  });

  it("leaves when the queue is done, at once with leaveAfterMinutes 0", async () => {
    const { voice, manager, guild, voiceChannel, textChannel } = setup({ music: { leaveAfterMinutes: 0 } });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A"), { requestedBy: "u0" });
    await flush();
    voice.players[0].finish();
    await flush();
    expect(player.destroyed).toBe(true);
  });

  it("stops when the bot is disconnected", async () => {
    const { manager, guild, voiceChannel, textChannel } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    manager.voiceStateUpdate({ id: "bot", channelId: "vc", guild }, { id: "bot", channelId: null, guild });
    expect(player.destroyed).toBe(true);
  });

  it("changes volume, shuffles, removes and moves", async () => {
    const { voice, manager, guild, voiceChannel, textChannel } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A", "B", "C", "D"), { requestedBy: "u0" });
    await flush();
    player.setVolume(120);
    expect(voice.createAudioResource.mock.results[0].value.volume.setVolume).toHaveBeenLastCalledWith(1.2);
    expect(player.move(3, 1).title).toBe("D");
    expect(player.queue.map((track) => track.title)).toEqual(["D", "B", "C"]);
    expect(player.remove(2).title).toBe("B");
    expect(player.remove(9)).toBeNull();
    expect(player.clear()).toBe(2);
    const page = queueMessage(player.state(), { language: "en", guildSettings: settings() });
    expect(page.embeds[0].data.description).toContain("Nothing is waiting");
  });

  it("goes back, seeks, skips ahead and cleans the queue", async () => {
    const openAudio = vi.fn(async () => ({ stream: new PassThrough(), stop: vi.fn(), errors: [] }));
    const { voice, manager, guild, voiceChannel, textChannel } = setup({ openAudio, humans: 2 });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A", "B", "C", "B", "D"), { requestedBy: "u0" });
    await flush();
    expect(player.back()).toBeNull();
    player.skip();
    await flush();
    expect(player.current.title).toBe("B");
    expect(player.history.map((track) => track.title)).toEqual(["A"]);

    expect(player.back().title).toBe("A");
    await flush();
    expect(player.current.title).toBe("A");
    expect(player.queue.map((track) => track.title)).toEqual(["B", "C", "B", "D"]);

    expect(player.seek(90_000)).toBe(true);
    await flush();
    expect(player.current.title).toBe("A");
    expect(openAudio.mock.calls.at(-1)[1]).toMatchObject({ startMs: 90_000 });
    expect(player.positionMs).toBe(150_000);
    expect(textChannel.sent.at(-1).edit).toHaveBeenCalled();

    expect(player.removeDuplicates()).toBe(1);
    expect(player.queue.map((track) => track.title)).toEqual(["B", "C", "D"]);
    player.queue[1].requestedBy = "gone";
    expect(player.removeAbsent()).toBe(1);
    expect(player.skipTo(2).title).toBe("D");
    await flush();
    expect(player.current.title).toBe("D");
    expect(player.queue).toEqual([]);
    expect(voice.players).toHaveLength(1);
  });

  it("refuses to seek in live streams", async () => {
    const { manager, guild, voiceChannel, textChannel } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add([makeTrack({ title: "Radio", source: Source.RADIO, live: true, stream: { url: "https://radio.test/" } })], { requestedBy: "u0" });
    await flush();
    expect(player.seek(1000)).toBe(false);
    expect(player.forward(10_000)).toBeNull();
  });

  it("keeps the place when the filter changes", async () => {
    const openAudio = vi.fn(async () => ({ stream: new PassThrough(), stop: vi.fn(), errors: [] }));
    const { manager, guild, voiceChannel, textChannel } = setup({ openAudio });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A"), { requestedBy: "u0" });
    await flush();
    player.setFilter("nightcore");
    await flush();
    expect(openAudio.mock.calls.at(-1)[1]).toMatchObject({ startMs: 60_000, filter: "nightcore" });
    expect(player.current.title).toBe("A");
    // 60 s in, then 60 s more at 1.25×.
    expect(player.positionMs).toBe(135_000);
    expect(player.state().filter).toBe("nightcore");
    expect(player.forward(-200_000)).toBe(0);
  });

  it("skips when enough listeners vote", async () => {
    const { manager, guild, voiceChannel, textChannel } = setup({ humans: 3 });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A", "B"), { requestedBy: "u0" });
    await flush();
    expect(player.voteSkip("u1", 50)).toEqual({ votes: 1, needed: 2, skipped: false });
    expect(player.voteSkip("u1", 50)).toEqual({ votes: 1, needed: 2, skipped: false });
    expect(player.voteSkip("u2", 50)).toEqual({ votes: 2, needed: 2, skipped: true });
    await flush();
    expect(player.current.title).toBe("B");
    expect(player.votes.size).toBe(0);
  });

  it("adds a related song when autoplay is on and the queue runs out", async () => {
    const { voice, manager, guild, voiceChannel, textChannel } = setup();
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    manager.resolver.related = vi.fn(async () => [...songs("A"), ...songs("Related")]);
    player.add(songs("A"), { requestedBy: "u0" });
    await flush();
    player.setAutoplay(true);
    voice.players[0].finish();
    await flush();
    expect(manager.resolver.related).toHaveBeenCalledWith("A");
    expect(player.current).toMatchObject({ title: "Related", autoplay: true, requestedBy: null });
  });

  it("stays in the channel 24/7", async () => {
    const { voice, manager, guild, voiceChannel, textChannel, timers } = setup({ music: { stay247: true, leaveAfterMinutes: 0 } });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A"), { requestedBy: "u0" });
    await flush();
    voice.players[0].finish();
    await flush();
    voiceChannel.members.delete("u0");
    manager.voiceStateUpdate({ id: "u0", channelId: "vc", guild }, { id: "u0", channelId: null, guild });
    expect(player.destroyed).toBe(false);
    expect(timers).toHaveLength(0);
  });
});

describe("filters", () => {
  it("builds ffmpeg's -af value with the seek first", () => {
    expect(audioFilter("off")).toBeNull();
    expect(audioFilter("off", 1500)).toBe("atrim=start=1.500,asetpts=PTS-STARTPTS");
    expect(audioFilter("bassboost", 0)).toBe("bass=g=10:f=110:w=0.6");
    expect(audioFilter("nope")).toBeNull();
    expect(filterSpeed("nightcore")).toBe(1.25);
    expect(filterSpeed("nope")).toBe(1);
    expect(FILTER_NAMES).toContain("8d");
    const args = ffmpegArgs("pipe:0", { startMs: 2000, filter: "vaporwave" });
    expect(args[args.indexOf("-af") + 1]).toBe("atrim=start=2.000,asetpts=PTS-STARTPTS,aresample=48000,asetrate=48000*0.8,aresample=48000");
    expect(ffmpegArgs("pipe:0", { live: true, startMs: 2000 })).not.toContain("-af");
  });

  it("shows how far the song is", () => {
    expect(progressBar(0, 100_000, 4)).toBe("🔘▬▬▬");
    expect(progressBar(99_000, 100_000, 4)).toBe("▬▬▬🔘");
    expect(progressBar(5, null)).toBeNull();
    const track = makeTrack({ title: "A", artist: "Band", durationMs: 100_000, source: Source.SOUNDCLOUD });
    const message = nowPlayingMessage({ guildId: "g", current: track, queue: [], loop: "off", paused: false, volume: 80, positionMs: 50_000, filter: "nightcore" }, { language: "en", guildSettings: settings() });
    expect(message.embeds[0].data.description).toContain("🔘");
    expect(message.embeds[0].data.footer.text).toContain("Nightcore");
  });
});

describe("lyrics", () => {
  it("tidies titles before looking them up", () => {
    expect(cleanTitle("Song (Official Video) [HD]")).toBe("Song");
    expect(cleanTitle("Song (feat. Someone)")).toBe("Song");
    expect(splitArtist("Band - Song", "uploader")).toEqual({ artist: "Band", title: "Song" });
    expect(splitArtist("Song", "Band")).toEqual({ artist: "Band", title: "Song" });
  });

  it("tries the exact song, then a search close in length", async () => {
    const fetchJson = vi.fn(async (url) => {
      if (url.includes("/api/get")) {
        throw new MusicError("not-found");
      }
      return [
        { trackName: "Song", artistName: "Band", duration: 300, plainLyrics: "wrong one" },
        { trackName: "Song", artistName: "Band", duration: 181, plainLyrics: "right one" },
      ];
    });
    const found = await createLyrics({ fetchJson }).find({ title: "Band - Song (Official Audio)", artist: "uploader", durationMs: 180_000 });
    expect(fetchJson.mock.calls[0][0]).toBe("https://lrclib.net/api/get?track_name=Song&artist_name=Band&duration=180");
    expect(fetchJson.mock.calls[1][0]).toBe("https://lrclib.net/api/search?q=Band+Song");
    expect(found).toEqual({ title: "Song", artist: "Band", lyrics: "right one", instrumental: false });
    await expect(createLyrics({ fetchJson: async () => [] }).find({ title: "Nothing" })).resolves.toBeNull();
  });
});

describe("playlists", () => {
  it("tidies names", () => {
    expect(cleanPlaylistName("  Road   trip ")).toBe("Road trip");
    expect(cleanPlaylistName("")).toBeNull();
    expect(cleanPlaylistName("x".repeat(51))).toBeNull();
  });

  it("saves what's needed to play songs again, but not uploads", () => {
    const store = new PlaylistStore();
    store.create("u1", "Mix");
    const sc = makeTrack({ title: "A", source: Source.SOUNDCLOUD, stream: { id: 5, extra: { nested: true } }, durationMs: 1000 });
    const spotify = makeTrack({ title: "B", via: Via.SPOTIFY, lookup: { title: "B", artist: "Band", durationMs: 2000 } });
    const upload = makeTrack({ title: "C", source: Source.FILE, stream: { url: "https://cdn.discordapp.com/x.mp3" } });
    expect(savedTrack(upload)).toBeNull();
    expect(store.add("u1", "mix", [{ ...sc, requestedBy: "u1" }, spotify, upload])).toEqual({ added: 2, skipped: 1 });
    const [first, second] = store.get("u1", "MIX").tracks;
    expect(first).toMatchObject({ title: "A", source: Source.SOUNDCLOUD, stream: { id: 5 }, durationMs: 1000 });
    expect(first.requestedBy ?? null).toBeNull();
    expect(first.id).not.toBe(sc.id);
    expect(second).toMatchObject({ title: "B", source: null, via: Via.SPOTIFY, lookup: { artist: "Band" } });
    expect(store.list("u1")).toEqual([{ name: "Mix", size: 2, updatedAt: expect.any(Number) }]);
    expect(store.list("u2")).toEqual([]);
  });

  it("limits how many playlists a member has", () => {
    const store = new PlaylistStore();
    for (let index = 0; index < MAX_PLAYLISTS; index += 1) {
      store.create("u1", `List ${index}`);
    }
    expect(() => store.create("u1", "One more")).toThrow(expect.objectContaining({ reason: "too-many" }));
    expect(() => store.create("u1", "list 0")).toThrow(expect.objectContaining({ reason: "exists" }));
    expect(store.delete("u1", "LIST 0")).toBe("List 0");
    expect(store.deleteUser("u1")).toBe(MAX_PLAYLISTS - 1);
  });
});

describe("finding songs", () => {
  it("tidies what people type", () => {
    expect(cleanQuery("Drake - Hotline Bling (Official Video)")).toBe("Drake Hotline Bling");
    expect(cleanQuery("Blinding Lights ft. Someone [Lyrics]")).toBe("Blinding Lights");
    expect(cleanQuery('"Shape of You" | Ed Sheeran')).toBe("Shape of You Ed Sheeran");
    expect(cleanQuery("eminem lose yourself lyrics")).toBe("eminem lose yourself");
    expect(cleanQuery("Video Killed the Radio Star")).toBe("Video Killed the Radio Star");
    expect(cleanQuery("lyrics")).toBe("lyrics");
  });

  it("scores results on the words typed, and remixes nobody asked for lower", () => {
    expect(queryScore("daft punk one more time", { title: "One More Time", artist: "Daft Punk" })).toBe(1);
    expect(queryScore("daft punk one more time", { title: "One More Time (Remix)", artist: "Daft Punk" })).toBeCloseTo(0.7);
    expect(queryScore("one more time remix", { title: "One More Time (Remix)", artist: "DJ" })).toBe(1);
    expect(queryScore("", { title: "x" })).toBe(0);
  });

  it("asks SoundCloud for 50 results and counts the previews", async () => {
    const fetchJson = vi.fn(async () => ({ collection: [scTrack({ id: 1 }), scTrack({ id: 2, policy: "SNIP" }), scTrack({ id: 3 })] }));
    const soundcloud = createSoundCloud({ clientId: CLIENT, fetchJson });
    expect(await soundcloud.find("song", { limit: 1 })).toEqual({ tracks: [expect.objectContaining({ id: 1 })], previews: 1 });
    expect(new URL(fetchJson.mock.calls[0][0]).searchParams.get("limit")).toBe("50");
  });

  it("looks the client ID up again when SoundCloud answers 404, and tries other pages", async () => {
    const fetchText = vi.fn(async (url) => {
      if (url === "https://soundcloud.com/") {
        throw new MusicError("not-found", "soundcloud.com answered 404.");
      }
      if (url.endsWith("/discover")) {
        return '<script crossorigin src="https://a-v2.sndcdn.com/assets/1-abc.js"></script>';
      }
      return `client_id:"${CLIENT}"`;
    });
    let calls = 0;
    const fetchJson = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new MusicError("not-found", "api-v2.soundcloud.com answered 404.");
      }
      return { collection: [scTrack()] };
    });
    const soundcloud = createSoundCloud({ fetchText, fetchJson });
    expect(await soundcloud.search("song")).toHaveLength(1);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchText.mock.calls.some(([url]) => url === "https://soundcloud.com/discover")).toBe(true);
  });

  it("reads Audius tracks and playlists", async () => {
    expect(isAudiusUrl(new URL("https://audius.co/artist/song-123"))).toBe(true);
    expect(isAudiusUrl(new URL("https://audius.co/artist"))).toBe(false);
    const api = { id: "D7KyD", title: "Song", user: { name: "Band" }, duration: 200, permalink: "/band/song", artwork: { "480x480": "https://img.audius.test/a.jpg" } };
    expect(audiusTrack(api)).toMatchObject({ title: "Song", artist: "Band", durationMs: 200_000, source: Source.AUDIUS, stream: { id: "D7KyD" }, url: "https://audius.co/band/song" });
    expect(audiusTrack({ ...api, is_streamable: false })).toBeNull();
    expect(audiusTrack({ ...api, is_stream_gated: true })).toBeNull();

    const fetchJson = vi.fn(async (url) => {
      if (url === "https://api.audius.co") {
        return { data: ["https://node.audius.test"] };
      }
      if (url.includes("/tracks/search")) {
        return { data: [api, { ...api, id: "x", is_streamable: false }] };
      }
      if (url.includes("/resolve")) {
        return { data: { id: "P1", playlist_name: "Mix" } };
      }
      return { data: [api] };
    });
    const audius = createAudius({ fetchJson });
    expect(await audius.search("song")).toHaveLength(1);
    expect(fetchJson.mock.calls[1][0]).toBe("https://node.audius.test/v1/tracks/search?query=song&limit=20&app_name=Rabble");
    expect(await audius.resolve("https://audius.co/band/playlist/mix-1")).toMatchObject({ name: "Mix", tracks: [expect.objectContaining({ title: "Song" })] });
    expect(await audius.streamFor("D7KyD")).toBe("https://node.audius.test/v1/tracks/D7KyD/stream?app_name=Rabble");
    await expect(audius.streamFor("../x")).rejects.toMatchObject({ reason: "not-found" });

    const down = createAudius({ fetchJson: async () => Promise.reject(new MusicError("unreachable")) });
    await expect(down.search("x")).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reads Bandcamp search results", () => {
    const html = `<ul>
      <li class="searchresult data-search">
        <img src="https://f4.bcbits.com/img/a1_7.jpg">
        <div class="itemtype"> TRACK </div>
        <div class="heading"><a href="https://band.bandcamp.com/track/song?from=search">Song &amp; More</a></div>
        <div class="subhead"> from Album by The Band </div>
        <div class="itemurl"><a href="x">https://band.bandcamp.com/track/song</a></div>
      </li>
      <li class="searchresult data-search">
        <div class="itemtype">ALBUM</div>
        <div class="itemurl"><a href="x">https://band.bandcamp.com/album/a</a></div>
      </li>
      <li class="searchresult data-search">
        <div class="itemtype">TRACK</div>
        <div class="itemurl"><a href="x">https://evil.test/track/x</a></div>
      </li>
    </ul>`;
    expect(readSearchResults(html)).toEqual([{ title: "Song & More", artist: "The Band", url: "https://band.bandcamp.com/track/song", artworkUrl: "https://f4.bcbits.com/img/a1_7.jpg" }]);
  });

  it("searches Jamendo only with a client ID", async () => {
    expect(await createJamendo().search("x")).toEqual([]);
    const fetchJson = vi.fn(async () => ({ results: [{ id: "1", name: "Song", artist_name: "Band", duration: 100, audio: "https://prod.jamendo.test/a.mp3", shareurl: "https://www.jamendo.com/track/1" }, { id: "2", name: "No audio" }] }));
    const found = await createJamendo({ clientId: "abc", fetchJson }).search("song");
    expect(found).toEqual([expect.objectContaining({ title: "Song", source: Source.JAMENDO, stream: { url: "https://prod.jamendo.test/a.mp3" } })]);
    expect(new URL(fetchJson.mock.calls[0][0]).searchParams.get("client_id")).toBe("abc");
  });
});
