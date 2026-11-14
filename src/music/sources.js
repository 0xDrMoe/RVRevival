// Turns what a member gave /play into tracks:
//
//   SoundCloud track or playlist link     plays from SoundCloud
//   Bandcamp track or album link          plays from Bandcamp
//   Audius track or playlist link         plays from Audius
//   Spotify, Apple Music or Deezer link   read for names, matched to a free copy
//                                         (SoundCloud, then Audius and Jamendo)
//   any other link to audio or a stream   played as is (MP3, OGG, AAC, radio
//                                         streams, .m3u and .pls playlists)
//   an uploaded audio or video file       played as is
//   words                                 the best match across SoundCloud,
//                                         Audius, Bandcamp and Jamendo
//                                         (music/library.js)
//
// YouTube links are refused: YouTube doesn't allow other apps to play it.

import { createAudius, isAudiusUrl } from "./audius.js";
import { createBandcamp, isBandcampUrl } from "./bandcamp.js";
import { createCatalogs, isShortCatalogLink, parseCatalogLink } from "./catalogs.js";
import { createJamendo } from "./jamendo.js";
import { createLibrary } from "./library.js";
import { findOtherMatch, findOtherScoredMatch, findScoredMatch } from "./match.js";
import { expandLink as defaultExpandLink, MusicError, openUrl as defaultOpenUrl } from "./net.js";
import { MATCH_TIE, rankNearTies, trackQuality } from "./quality.js";
import { createSoundCloud, isSoundCloudUrl, soundCloudQuality, toTrack } from "./soundcloud.js";
import { makeTrack, Source } from "./track.js";

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const PLAYLIST_TYPES = ["audio/x-mpegurl", "audio/mpegurl", "application/x-mpegurl", "application/vnd.apple.mpegurl", "audio/x-scpls", "application/pls+xml"];
const AUDIO_TYPES = ["application/ogg", "application/octet-stream", "binary/octet-stream", "application/x-flac", ""];
const MAX_PLAYLIST_BYTES = 64 * 1024;
const MAX_NESTING = 2;

// A link the member typed, with or without https://, or null for words.
export function asUrl(text) {
  const trimmed = String(text ?? "").trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : /^[\w-]+(\.[\w-]+)+\/\S*$/.test(trimmed) ? `https://${trimmed}` : null;
  if (!withScheme || /\s/.test(withScheme)) {
    return null;
  }
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

async function readSmallText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    return "";
  }
  const chunks = [];
  let total = 0;
  while (total < MAX_PLAYLIST_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_PLAYLIST_BYTES);
}

// The first stream in an .m3u or .pls playlist, or null.
export function firstPlaylistEntry(text) {
  if (/#EXT-X-/.test(text)) {
    return { hls: true, url: null };
  }
  const pls = text.match(/^File\d+\s*=\s*(https?:\/\/\S+)/im)?.[1];
  const m3u = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line));
  return { hls: false, url: pls ?? m3u ?? null };
}

// "My%20Song.mp3" → "My Song"
function fileTitle(url) {
  const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let name;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_+]/g, " ").trim() || url.hostname;
}

// Options: soundcloud, bandcamp, audius, jamendo, catalogs (built from
// SOUNDCLOUD_CLIENT_ID and JAMENDO_CLIENT_ID when left out), logger,
// openUrl and expandLink (tests).
export function createResolver({
  soundcloud = createSoundCloud({ clientId: process.env.SOUNDCLOUD_CLIENT_ID || null }),
  bandcamp = createBandcamp(),
  audius = createAudius(),
  jamendo = createJamendo({ clientId: process.env.JAMENDO_CLIENT_ID || null }),
  catalogs = createCatalogs(),
  logger = null,
  openUrl = defaultOpenUrl,
  expandLink = defaultExpandLink,
} = {}) {
  const library = createLibrary({ soundcloud, audius, bandcamp, jamendo, logger });

  // A link to audio: checks it really is audio (following .m3u and .pls
  // playlists), then lets it go until the song starts.
  async function probeLink(link, depth = 0) {
    const { url, response, abort } = await openUrl(link);
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const looksLikePlaylist = PLAYLIST_TYPES.includes(type) || /\.(m3u8?|pls)$/i.test(url.pathname);
    if (looksLikePlaylist) {
      const entry = firstPlaylistEntry(await readSmallText(response));
      abort();
      if (entry.hls) {
        throw new MusicError("unsupported", "HLS (.m3u8) streams can't be played; link the stream itself.");
      }
      if (!entry.url || depth >= MAX_NESTING) {
        throw new MusicError("not-audio", "That playlist has no stream in it.");
      }
      return probeLink(entry.url, depth + 1);
    }
    abort();
    if (!(type.startsWith("audio/") || type.startsWith("video/") || AUDIO_TYPES.includes(type))) {
      throw new MusicError("not-audio", "That link isn't audio.");
    }
    const header = (name) => response.headers.get(name)?.trim() || null;
    const live = Boolean(header("icy-name") || header("icy-br") || header("icy-metaint")) || !header("content-length");
    return makeTrack({
      title: header("icy-name") ?? fileTitle(url),
      artist: header("icy-description") ?? url.hostname,
      url: url.href,
      source: Source.LINK,
      live,
      stream: { url: url.href },
    });
  }

  async function resolveUrl(url, limit, expanded = false) {
    const host = url.hostname.toLowerCase();
    if (YOUTUBE_HOSTS.test(host)) {
      throw new MusicError("youtube", "YouTube doesn't allow other apps to play its videos.");
    }
    if (!expanded && (host === "on.soundcloud.com" || isShortCatalogLink(url))) {
      return resolveUrl(new URL(await expandLink(url.href)), limit, true);
    }
    if (isSoundCloudUrl(url)) {
      return soundcloud.resolve(url.href, { limit });
    }
    if (isBandcampUrl(url)) {
      return bandcamp.resolve(url.href, { limit });
    }
    if (audius && isAudiusUrl(url)) {
      return audius.resolve(url.href, { limit });
    }
    const catalog = parseCatalogLink(url);
    if (catalog) {
      return catalogs.resolve(catalog, { limit });
    }
    return { tracks: [await probeLink(url.href)], skipped: 0, name: null };
  }

  return {
    soundcloud,
    bandcamp,
    audius,
    jamendo,

    // What was typed in /play → { tracks, skipped, name }. `limit` caps
    // playlists. Throws MusicError.
    async resolve(query, { limit = 100 } = {}) {
      const text = String(query ?? "").trim().slice(0, 500);
      if (!text) {
        throw new MusicError("not-found", "Type a song or paste a link.");
      }
      const url = asUrl(text);
      if (url) {
        return resolveUrl(url, limit);
      }
      return { tracks: [await library.best(text)], skipped: 0, name: null };
    },

    // Up to `limit` tracks for words from every library, best match first (/search).
    async search(query, { limit = 5 } = {}) {
      const text = String(query ?? "").trim().slice(0, 200);
      if (!text) {
        throw new MusicError("not-found", "Type something to search for.");
      }
      return library.search(text, { limit });
    },

    // SoundCloud tracks related to a SoundCloud track ID (autoplay).
    related: (id) => soundcloud.related(id),

    // An uploaded file (a discord.js Attachment) → a track.
    fileTrack(attachment) {
      const type = String(attachment?.contentType ?? "").toLowerCase();
      if (!type.startsWith("audio/") && !type.startsWith("video/")) {
        throw new MusicError("not-audio", "That file isn't audio.");
      }
      return makeTrack({
        title: fileTitle(new URL(attachment.url)) || attachment.name,
        artist: "",
        url: attachment.url,
        durationMs: Number(attachment.duration) * 1000 || null,
        source: Source.FILE,
        stream: { url: attachment.url },
      });
    },

    // A Spotify, Apple Music or Deezer song, matched to a free copy
    // (SoundCloud and Audius at once, then Jamendo); other tracks as they
    // are. When both have about equally good matches, the better-sounding
    // copy plays (Audius serves 320 kbps). Throws MusicError("no-match"), or
    // SoundCloud's error when it failed and nothing else had the song.
    async ready(track) {
      if (track.source) {
        return track;
      }
      let soundcloudError = null;
      const [onSoundCloud, onAudius] = await Promise.all([
        findScoredMatch(soundcloud, track.lookup).catch((error) => {
          soundcloudError = error;
          logger?.warn?.("SoundCloud couldn't be searched for a match", { error: error?.message });
          return null;
        }),
        audius ? findOtherScoredMatch([audius], track.lookup).catch(() => null) : null,
      ]);
      const options = [
        ...(onSoundCloud ? [{ copy: toTrack(onSoundCloud.candidate), score: onSoundCloud.score, quality: soundCloudQuality(onSoundCloud.candidate) }] : []),
        ...(onAudius ? [{ copy: onAudius.candidate, score: onAudius.score, quality: trackQuality(onAudius.candidate) }] : []),
      ];
      const copy =
        options.length > 0 ? rankNearTies(options, { tie: MATCH_TIE })[0].copy : jamendo?.enabled ? await findOtherMatch([jamendo], track.lookup) : null;
      if (!copy) {
        // A SoundCloud 404 here means SoundCloud itself failed, not that the song is missing.
        if (soundcloudError instanceof MusicError && soundcloudError.reason === "not-found") {
          throw new MusicError("unreachable", soundcloudError.message);
        }
        throw soundcloudError ?? new MusicError("no-match", `No free copy of ${track.title} found.`);
      }
      return { ...track, source: copy.source, stream: copy.stream, url: copy.url, durationMs: copy.durationMs ?? track.durationMs, artworkUrl: track.artworkUrl ?? copy.artworkUrl };
    },

    // Another copy of a song whose audio wouldn't load, from the other
    // libraries (Audius, Jamendo, Bandcamp, then SoundCloud unless that's
    // the one that failed), or null. It keeps the song's own title.
    async alternative(track) {
      const lookup = track.lookup ?? { title: track.title, artist: track.artist, durationMs: track.durationMs };
      if (!lookup?.title) {
        return null;
      }
      const others = [
        [Source.AUDIUS, audius],
        [Source.JAMENDO, jamendo?.enabled ? jamendo : null],
        [Source.BANDCAMP, bandcamp],
        // SoundCloud's search answers with its own API tracks.
        [Source.SOUNDCLOUD, soundcloud && typeof soundcloud.search === "function" ? { search: async (query, options) => (await soundcloud.search(query, options)).map(toTrack) } : null],
      ]
        .filter(([source, library]) => library && typeof library.search === "function" && source !== track.source)
        .map(([, library]) => ({ search: async (query, options) => (await library.search(query, options)).filter((found) => found?.url !== track.url) }));
      const copy = await findOtherMatch(others, lookup).catch(() => null);
      if (!copy) {
        return null;
      }
      return { ...track, source: copy.source, stream: copy.stream, url: copy.url, durationMs: copy.durationMs ?? track.durationMs, artworkUrl: track.artworkUrl ?? copy.artworkUrl, lookup, fallback: true };
    },
  };
}
