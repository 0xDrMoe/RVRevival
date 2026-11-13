// Jamendo (jamendo.com): about 600,000 Creative Commons songs that artists
// share for free, with full streams. Its API needs a free client ID
// (devportal.jamendo.com); without JAMENDO_CLIENT_ID this library is skipped.

import { fetchJson as defaultFetchJson } from "./net.js";
import { makeTrack, Source } from "./track.js";

const API = "https://api.jamendo.com/v3.0";

// A Jamendo API track → a queue track, or null without a stream.
export function jamendoTrack(track) {
  if (!track || typeof track.audio !== "string" || !track.audio.startsWith("https://")) {
    return null;
  }
  return makeTrack({
    title: track.name,
    artist: track.artist_name ?? "",
    url: track.shareurl ?? null,
    artworkUrl: track.image ?? track.album_image ?? null,
    durationMs: Number(track.duration) * 1000,
    source: Source.JAMENDO,
    stream: { url: track.audio },
  });
}

// Options: clientId (JAMENDO_CLIENT_ID), fetchJson (tests).
export function createJamendo({ clientId = null, fetchJson = defaultFetchJson } = {}) {
  return {
    enabled: Boolean(clientId),

    // Up to `limit` tracks for words, best match first ([] when there's no client ID).
    async search(query, { limit = 10 } = {}) {
      if (!clientId) {
        return [];
      }
      const url = new URL(`${API}/tracks/`);
      for (const [key, value] of Object.entries({ client_id: clientId, format: "json", limit: Math.min(limit * 2, 50), search: query, audioformat: "mp32", order: "relevance" })) {
        url.searchParams.set(key, String(value));
      }
      const found = await fetchJson(url.href);
      return (Array.isArray(found?.results) ? found.results : []).map(jamendoTrack).filter(Boolean).slice(0, limit);
    },
  };
}
