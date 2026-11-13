// Audius (audius.co): a free, open music platform whose public API lets any
// app search and stream full tracks, no key needed. Used as a second library
// next to SoundCloud: word searches look here too, and audius.co links play.
//
// The API is served by many "discovery" hosts; https://api.audius.co lists
// them. One is picked and kept for an hour, with a known host as fallback.

import { fetchJson as defaultFetchJson, MusicError } from "./net.js";
import { makeTrack, Source } from "./track.js";

const DIRECTORY = "https://api.audius.co";
const FALLBACK_HOST = "https://discoveryprovider.audius.co";
const APP_NAME = "Rabble";
const HOST_HOURS = 1;
export const AUDIUS_HOSTS = ["audius.co", "www.audius.co"];

export const isAudiusUrl = (url) => AUDIUS_HOSTS.includes(url.hostname.toLowerCase()) && url.pathname.split("/").filter(Boolean).length >= 2;

// An Audius API track → a queue track, or null for one that can't be streamed.
export function audiusTrack(track) {
  if (!track || typeof track.id !== "string" || track.is_streamable === false || track.is_delete === true || track.is_stream_gated === true) {
    return null;
  }
  const artwork = track.artwork?.["480x480"] ?? track.artwork?.["150x150"] ?? null;
  return makeTrack({
    title: track.title,
    artist: track.user?.name || track.user?.handle || "",
    url: typeof track.permalink === "string" ? `https://audius.co${track.permalink}` : null,
    artworkUrl: artwork,
    durationMs: Number(track.duration) * 1000,
    source: Source.AUDIUS,
    stream: { id: track.id },
  });
}

// Options: fetchJson and now (tests).
export function createAudius({ fetchJson = defaultFetchJson, now = Date.now } = {}) {
  let picked = null;

  async function host() {
    if (picked && now() - picked.at < HOST_HOURS * 3_600_000) {
      return picked.url;
    }
    let url = FALLBACK_HOST;
    try {
      const listed = (await fetchJson(DIRECTORY))?.data;
      const hosts = Array.isArray(listed) ? listed.filter((entry) => typeof entry === "string" && /^https:\/\/[\w.-]+$/.test(entry)) : [];
      if (hosts.length > 0) {
        url = hosts[Math.floor(Math.random() * hosts.length)];
      }
    } catch {
      // The directory didn't answer: use the known host.
    }
    picked = { url, at: now() };
    return url;
  }

  // GETs an API path; a host that fails is dropped so the next call picks another.
  async function api(path, params = {}) {
    const base = await host();
    const url = new URL(`${base}/v1${path}`);
    for (const [key, value] of Object.entries({ ...params, app_name: APP_NAME })) {
      url.searchParams.set(key, String(value));
    }
    try {
      return await fetchJson(url.href);
    } catch (error) {
      picked = null;
      throw error;
    }
  }

  return {
    // Up to `limit` streamable tracks for words, best match first.
    async search(query, { limit = 10 } = {}) {
      const found = await api("/tracks/search", { query, limit: Math.min(Math.max(limit * 2, 10), 50) });
      return (Array.isArray(found?.data) ? found.data : []).map(audiusTrack).filter(Boolean).slice(0, limit);
    },

    // An audius.co track or playlist link → { tracks, skipped, name }. Throws MusicError.
    async resolve(link, { limit = 100 } = {}) {
      const found = (await api("/resolve", { url: link }))?.data;
      const item = Array.isArray(found) ? found[0] : found;
      if (item && typeof item.title === "string" && typeof item.id === "string") {
        const track = audiusTrack(item);
        if (!track) {
          throw new MusicError("not-free", "That Audius track can't be streamed.");
        }
        return { tracks: [track], skipped: 0, name: null };
      }
      if (item && typeof item.playlist_name === "string" && typeof item.id === "string") {
        const listed = (await api(`/playlists/${encodeURIComponent(item.id)}/tracks`))?.data;
        const all = (Array.isArray(listed) ? listed : []).slice(0, limit);
        const tracks = all.map(audiusTrack).filter(Boolean);
        if (tracks.length === 0) {
          throw new MusicError("not-free", "Nothing in that Audius playlist can be streamed.");
        }
        return { tracks, skipped: all.length - tracks.length, name: item.playlist_name };
      }
      throw new MusicError("not-found", "Nothing at that Audius link.");
    },

    // The address to download a track's audio from (it redirects to the file).
    async streamFor(id) {
      if (typeof id !== "string" || !/^[\w-]{1,32}$/.test(id)) {
        throw new MusicError("not-found", "That Audius track has no audio.");
      }
      return `${await host()}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${APP_NAME}`;
    },
  };
}
