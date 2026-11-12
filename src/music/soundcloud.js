// SoundCloud: links, search and streams through SoundCloud's web API
// (api-v2), the same one soundcloud.com uses. It needs a client ID: the one
// in SOUNDCLOUD_CLIENT_ID, or else the public one soundcloud.com's own
// scripts carry, found again when SoundCloud changes it.
//
// Only full, free streams play. Tracks SoundCloud keeps for Go+ subscribers
// come as 30-second previews ("snipped"); those are refused.

import { makeTrack, Source } from "./track.js";
import { fetchJson as defaultFetchJson, fetchText as defaultFetchText, MusicError } from "./net.js";

const API = "https://api-v2.soundcloud.com";
const HOME = "https://soundcloud.com/";
const CLIENT_ID = /client_id\s*[:=]\s*["']?([A-Za-z0-9]{32})\b/;
const SCRIPT = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
const CLIENT_ID_HOURS = 6;
const IDS_PER_REQUEST = 50;
export const SOUNDCLOUD_HOSTS = ["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"];

export const isSoundCloudUrl = (url) => SOUNDCLOUD_HOSTS.includes(url.hostname.toLowerCase());

// The stream to use, best first: a full MP3 file, then HLS (MP3, Opus, AAC).
// Returns { url, protocol } for the transcoding (its URL still needs the
// client ID), or null when only previews exist.
export function pickTranscoding(track) {
  const full = (track?.media?.transcodings ?? []).filter((item) => !item.snipped && typeof item.url === "string" && item.url.startsWith(`${API}/`));
  const rank = (item) => {
    const progressive = item.format?.protocol === "progressive";
    const mime = item.format?.mime_type ?? "";
    return (progressive ? 0 : 10) + (mime.includes("mpeg") ? 0 : mime.includes("opus") ? 1 : 2);
  };
  const best = full.filter((item) => ["progressive", "hls"].includes(item.format?.protocol)).sort((a, b) => rank(a) - rank(b))[0];
  return best ? { url: best.url, protocol: best.format.protocol } : null;
}

// Whether the whole track can be played for free.
export const isPlayable = (track) => track?.kind === "track" && track.streamable !== false && track.policy !== "BLOCK" && track.policy !== "SNIP" && pickTranscoding(track) !== null;

// A SoundCloud API track → a queue track.
export function toTrack(track) {
  const artwork = track.artwork_url ?? track.user?.avatar_url ?? null;
  return makeTrack({
    title: track.title,
    artist: track.publisher_metadata?.artist || track.user?.username || "",
    url: track.permalink_url,
    artworkUrl: typeof artwork === "string" ? artwork.replace("-large.", "-t500x500.") : null,
    durationMs: track.full_duration ?? track.duration,
    source: Source.SOUNDCLOUD,
    stream: { id: track.id },
  });
}

// Options: clientId (SOUNDCLOUD_CLIENT_ID), fetchJson/fetchText and now (tests).
export function createSoundCloud({ clientId: fixedClientId = null, fetchJson = defaultFetchJson, fetchText = defaultFetchText, now = Date.now } = {}) {
  let found = null;
  let finding = null;

  async function findClientId() {
    const home = await fetchText(HOME);
    const scripts = [...home.matchAll(SCRIPT)].map((match) => match[1]).reverse();
    for (const script of scripts.slice(0, 8)) {
      const id = (await fetchText(script, { maxBytes: 6 * 1024 * 1024 }).catch(() => ""))?.match(CLIENT_ID)?.[1];
      if (id) {
        return id;
      }
    }
    throw new MusicError("unreachable", "Couldn't find SoundCloud's client ID.");
  }

  async function clientId(refresh = false) {
    if (fixedClientId) {
      return fixedClientId;
    }
    if (!refresh && found && now() - found.at < CLIENT_ID_HOURS * 3_600_000) {
      return found.id;
    }
    finding ??= findClientId()
      .then((id) => {
        found = { id, at: now() };
        return id;
      })
      .finally(() => {
        finding = null;
      });
    return finding;
  }

  // GETs an API address with the client ID; a refused ID is looked up again once.
  async function api(address, params = {}) {
    for (const refresh of [false, true]) {
      const url = new URL(address.startsWith("http") ? address : `${API}${address}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
      url.searchParams.set("client_id", await clientId(refresh));
      try {
        return await fetchJson(url.href);
      } catch (error) {
        const refused = error instanceof MusicError && / answered (401|403)\.$/.test(error.message);
        if (!refused || refresh || fixedClientId) {
          throw error;
        }
      }
    }
    return null;
  }

  // Full track details for IDs from a playlist (SoundCloud sends only the
  // first few in full).
  async function fillIn(tracks) {
    const missing = tracks.filter((track) => !track.media).map((track) => track.id);
    const details = new Map();
    for (let index = 0; index < missing.length; index += IDS_PER_REQUEST) {
      const batch = await api("/tracks", { ids: missing.slice(index, index + IDS_PER_REQUEST).join(",") });
      for (const track of Array.isArray(batch) ? batch : []) {
        details.set(track.id, track);
      }
    }
    return tracks.map((track) => (track.media ? track : details.get(track.id))).filter(Boolean);
  }

  return {
    // A track or playlist link → { tracks, skipped, name }. `skipped` counts
    // tracks only Go+ subscribers can hear. Throws MusicError.
    async resolve(link, { limit = 100 } = {}) {
      const found = await api("/resolve", { url: link });
      if (found?.kind === "track") {
        if (!isPlayable(found)) {
          throw new MusicError("not-free", "That SoundCloud track is only a preview without Go+.");
        }
        return { tracks: [toTrack(found)], skipped: 0, name: null };
      }
      if (found?.kind === "playlist" || found?.kind === "system-playlist") {
        const all = await fillIn((found.tracks ?? []).slice(0, limit));
        const playable = all.filter(isPlayable);
        if (playable.length === 0) {
          throw new MusicError("not-free", "Nothing in that playlist is free to stream.");
        }
        return { tracks: playable.map(toTrack), skipped: all.length - playable.length, name: found.title ?? null };
      }
      if (found?.kind === "user") {
        throw new MusicError("unsupported", "That's a SoundCloud profile; link a track or playlist.");
      }
      throw new MusicError("not-found", "Nothing at that SoundCloud link.");
    },

    // Up to `limit` tracks that are free to play, best match first.
    async search(query, { limit = 10 } = {}) {
      const found = await api("/search/tracks", { q: query, limit: Math.min(limit * 2, 50) });
      return (found?.collection ?? []).filter(isPlayable).slice(0, limit);
    },

    // Free tracks SoundCloud lists as related to a track ID (for autoplay).
    async related(id, { limit = 10 } = {}) {
      const found = await api(`/tracks/${encodeURIComponent(id)}/related`, { limit: Math.min(limit * 2, 50) });
      return (found?.collection ?? []).filter(isPlayable).slice(0, limit).map(toTrack);
    },

    // The audio for a track ID, fetched just before it plays (the addresses
    // expire): { url, protocol: "progressive" | "hls" }.
    async streamFor(id) {
      const track = await api(`/tracks/${encodeURIComponent(id)}`);
      const transcoding = isPlayable(track) ? pickTranscoding(track) : null;
      if (!transcoding) {
        throw new MusicError("not-free", "That SoundCloud track can't be streamed any more.");
      }
      const params = track.track_authorization ? { track_authorization: track.track_authorization } : {};
      const answer = await api(transcoding.url, params);
      if (typeof answer?.url !== "string" || !answer.url.startsWith("https://")) {
        throw new MusicError("unreachable", "SoundCloud didn't give a stream.");
      }
      return { url: answer.url, protocol: transcoding.protocol };
    },
  };
}
