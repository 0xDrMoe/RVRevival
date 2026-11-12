import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { createBandcamp, readTralbum } from "../src/music/bandcamp.js";
import { createCatalogs, parseCatalogLink, readSpotifyEmbed } from "../src/music/catalogs.js";
import { checkMusic, DEFAULT_MUSIC, describeMusic, InvalidMusic, normalizeMusic } from "../src/music/config.js";
import { findMatch, matchQuery, matchScore, words } from "../src/music/match.js";
import { MusicError } from "../src/music/net.js";
import { queueMessage, sourceLabel } from "../src/music/nowPlaying.js";
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
    expect(describeMusic(null)).toBe("no DJ role · volume 80% · queue 200 · now playing on · leaves after 3 min");
    expect(describeMusic({ djRoleId: "123456789012345678", announce: false, leaveAfterMinutes: 0 })).toBe("DJ <@&123456789012345678> · volume 80% · queue 200 · now playing off · leaves right away");
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
    expect(soundcloud.search).toHaveBeenCalledWith("Daft Punk one more time", { limit: 10 });
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

  it("searches SoundCloud for words", async () => {
    const soundcloud = { search: vi.fn(async () => [scTrack()]) };
    const found = await createResolver({ soundcloud }).resolve("song artist");
    expect(found.tracks[0].title).toBe("Song");
    await expect(createResolver({ soundcloud: { search: async () => [] } }).resolve("nothing")).rejects.toMatchObject({ reason: "not-found" });
  });

  it("plays uploaded audio files only", () => {
    const resolver = createResolver({ soundcloud: {} });
    expect(resolver.fileTrack({ contentType: "audio/mpeg", url: "https://cdn.discordapp.com/attachments/1/2/song.mp3?ex=1", name: "song.mp3", duration: 12.5 })).toMatchObject({ title: "song", source: Source.FILE, durationMs: 12_500 });
    expect(() => resolver.fileTrack({ contentType: "image/png", url: "https://cdn.discordapp.com/a.png" })).toThrow(MusicError);
  });

  it("matches Spotify songs just before they play", async () => {
    const soundcloud = { search: vi.fn(async () => [scTrack({ id: 9, title: "Song", user: { username: "Band" }, full_duration: 180_000 })]) };
    const resolver = createResolver({ soundcloud });
    const track = { ...makeTrack({ title: "Song", artist: "Band", via: Via.SPOTIFY, lookup: { title: "Song", artist: "Band", durationMs: 181_000 } }), requestedBy: "1" };
    expect(await resolver.ready(track)).toMatchObject({ id: track.id, source: Source.SOUNDCLOUD, via: Via.SPOTIFY, stream: { id: 9 }, requestedBy: "1", url: "https://soundcloud.com/artist/song" });
    await expect(createResolver({ soundcloud: { search: async () => [] } }).ready(track)).rejects.toMatchObject({ reason: "no-match" });
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

  it("skips songs that can't play and gives up after five in a row", async () => {
    const ready = async (track) => {
      throw new MusicError("no-match");
    };
    const { manager, guild, voiceChannel, textChannel } = setup({ ready });
    const player = await manager.join({ guild, channel: voiceChannel, textChannel });
    player.add(songs("A", "B", "C", "D", "E", "F"), { requestedBy: "u0" });
    await flush();
    await flush();
    const notes = textChannel.send.mock.calls.map(([payload]) => payload.content);
    expect(notes.filter((note) => note?.includes("Couldn't play"))).toHaveLength(5);
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
});
