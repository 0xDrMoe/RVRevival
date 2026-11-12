// Spotify, Apple Music and Deezer links. None of them lets other apps play
// their audio, so only the song names, artists and lengths are read here
// (from public pages and APIs). Each song is then matched to a free copy on
// SoundCloud when it's about to play (music/match.js).

import { makeTrack, Via } from "./track.js";
import { fetchJson as defaultFetchJson, fetchText as defaultFetchText, MusicError } from "./net.js";

const SPOTIFY_HOSTS = ["open.spotify.com", "play.spotify.com"];
const SPOTIFY_SHORT = ["spotify.link", "spotify.app.link"];
const DEEZER_HOSTS = ["deezer.com", "www.deezer.com"];
const DEEZER_SHORT = ["link.deezer.com", "deezer.page.link"];
const APPLE_HOSTS = ["music.apple.com", "itunes.apple.com"];

// Links that redirect to one of the above.
export const isShortCatalogLink = (url) => [...SPOTIFY_SHORT, ...DEEZER_SHORT].includes(url.hostname.toLowerCase());

// A link → { via, type: "track" | "album" | "playlist", id, country } or null.
export function parseCatalogLink(url) {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (SPOTIFY_HOSTS.includes(host)) {
    const rest = parts[0]?.startsWith("intl-") ? parts.slice(1) : parts;
    const [type, id] = rest[0] === "embed" ? rest.slice(1) : rest;
    if (["track", "album", "playlist"].includes(type) && /^[A-Za-z0-9]{22}$/.test(id ?? "")) {
      return { via: Via.SPOTIFY, type, id, country: null };
    }
    return { via: Via.SPOTIFY, type: "unsupported", id: null, country: null };
  }
  if (DEEZER_HOSTS.includes(host)) {
    const rest = /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const [type, id] = rest;
    if (["track", "album", "playlist"].includes(type) && /^\d{1,20}$/.test(id ?? "")) {
      return { via: Via.DEEZER, type, id, country: null };
    }
    return { via: Via.DEEZER, type: "unsupported", id: null, country: null };
  }
  if (APPLE_HOSTS.includes(host)) {
    const country = /^[a-z]{2}$/i.test(parts[0] ?? "") ? parts[0].toLowerCase() : "us";
    const rest = /^[a-z]{2}$/i.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const kind = rest[0];
    const id = rest.at(-1)?.replace(/^id/, "");
    const songId = url.searchParams.get("i");
    if (kind === "album" && songId && /^\d+$/.test(songId)) {
      return { via: Via.APPLE, type: "track", id: songId, country };
    }
    if ((kind === "song" || kind === "album") && /^\d+$/.test(id ?? "")) {
      return { via: Via.APPLE, type: kind === "song" ? "track" : "album", id, country };
    }
    if (kind === "playlist") {
      return { via: Via.APPLE, type: "playlist", id: rest.at(-1) ?? null, country };
    }
    return { via: Via.APPLE, type: "unsupported", id: null, country };
  }
  return null;
}

const lookupTrack = ({ title, artist, durationMs, artworkUrl = null, url = null, via }) =>
  makeTrack({ title, artist, durationMs, artworkUrl, url, via, lookup: { title: String(title ?? ""), artist: String(artist ?? ""), durationMs: Number(durationMs) || null } });

// Spotify's embed page keeps what it shows in a __NEXT_DATA__ script.
export function readSpotifyEmbed(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

// "Artist One, Artist Two" → "Artist One, Artist Two"
const artists = (value) =>
  Array.isArray(value) ? value.map((artist) => artist?.name).filter(Boolean).join(", ") : String(value ?? "").replace(/ /g, " ");

const spotifyArtwork = (entity) => {
  const images = entity?.visualIdentity?.image ?? entity?.coverArt?.sources ?? [];
  const url = [...images].sort((a, b) => (b.maxWidth ?? b.width ?? 0) - (a.maxWidth ?? a.width ?? 0))[0]?.url;
  return typeof url === "string" ? url : null;
};

// Options: fetchJson/fetchText (tests).
export function createCatalogs({ fetchJson = defaultFetchJson, fetchText = defaultFetchText } = {}) {
  async function spotify({ type, id }, limit) {
    const entity = readSpotifyEmbed(await fetchText(`https://open.spotify.com/embed/${type}/${id}`, { maxBytes: 4 * 1024 * 1024 }));
    if (!entity) {
      throw new MusicError("not-found", "Couldn't read that Spotify link.");
    }
    const artwork = spotifyArtwork(entity);
    if (type === "track") {
      return {
        name: null,
        tracks: [lookupTrack({ title: entity.name ?? entity.title, artist: artists(entity.artists ?? entity.subtitle), durationMs: entity.duration, artworkUrl: artwork, url: `https://open.spotify.com/track/${id}`, via: Via.SPOTIFY })],
      };
    }
    const list = (entity.trackList ?? []).slice(0, limit);
    return {
      name: entity.name ?? entity.title ?? null,
      tracks: list.map((item) =>
        lookupTrack({
          title: item.title,
          artist: artists(item.subtitle),
          durationMs: item.duration,
          artworkUrl: artwork,
          url: typeof item.uri === "string" && item.uri.startsWith("spotify:track:") ? `https://open.spotify.com/track/${item.uri.slice(14)}` : null,
          via: Via.SPOTIFY,
        }),
      ),
    };
  }

  async function deezer({ type, id }, limit) {
    const check = (answer) => {
      if (!answer || answer.error) {
        throw new MusicError("not-found", "Couldn't find that on Deezer.");
      }
      return answer;
    };
    const toTrack = (item, artwork) =>
      lookupTrack({ title: item.title, artist: item.artist?.name, durationMs: Number(item.duration) * 1000, artworkUrl: item.album?.cover_xl ?? item.album?.cover_big ?? artwork, url: item.link, via: Via.DEEZER });
    if (type === "track") {
      return { name: null, tracks: [toTrack(check(await fetchJson(`https://api.deezer.com/track/${id}`)), null)] };
    }
    if (type === "album") {
      const album = check(await fetchJson(`https://api.deezer.com/album/${id}`));
      return { name: album.title ?? null, tracks: (album.tracks?.data ?? []).slice(0, limit).map((item) => toTrack(item, album.cover_xl ?? null)) };
    }
    const playlist = check(await fetchJson(`https://api.deezer.com/playlist/${id}`));
    const items = check(await fetchJson(`https://api.deezer.com/playlist/${id}/tracks?limit=${limit}`));
    return { name: playlist.title ?? null, tracks: (items.data ?? []).slice(0, limit).map((item) => toTrack(item, null)) };
  }

  async function apple({ type, id, country }, limit) {
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("id", id);
    url.searchParams.set("country", country ?? "us");
    if (type === "album") {
      url.searchParams.set("entity", "song");
      url.searchParams.set("limit", String(Math.min(limit, 200)));
    }
    const answer = await fetchJson(url.href);
    const results = Array.isArray(answer?.results) ? answer.results : [];
    const songs = results.filter((item) => item.wrapperType === "track" && item.kind === "song");
    if (songs.length === 0) {
      throw new MusicError("not-found", "Couldn't find that on Apple Music.");
    }
    const collection = results.find((item) => item.wrapperType === "collection");
    return {
      name: type === "album" ? (collection?.collectionName ?? null) : null,
      tracks: songs.slice(0, limit).map((item) =>
        lookupTrack({
          title: item.trackName,
          artist: item.artistName,
          durationMs: item.trackTimeMillis,
          artworkUrl: typeof item.artworkUrl100 === "string" ? item.artworkUrl100.replace("100x100", "600x600") : null,
          url: item.trackViewUrl,
          via: Via.APPLE,
        }),
      ),
    };
  }

  const READERS = { [Via.SPOTIFY]: spotify, [Via.DEEZER]: deezer, [Via.APPLE]: apple };

  return {
    // A parsed link (parseCatalogLink) → { name, tracks }, each track waiting
    // to be matched. Throws MusicError.
    async resolve(link, { limit = 100 } = {}) {
      if (link.type === "unsupported") {
        throw new MusicError("unsupported", "Link a song, album or playlist.");
      }
      if (link.via === Via.APPLE && link.type === "playlist") {
        throw new MusicError("unsupported", "Apple Music playlists can't be read; link a song or album.");
      }
      const found = await READERS[link.via](link, limit);
      const tracks = found.tracks.filter((track) => track.lookup.title);
      if (tracks.length === 0) {
        throw new MusicError("not-found", "That link has no songs.");
      }
      return { name: found.name, tracks, skipped: 0 };
    },
  };
}
