// Internet radio from radio-browser.info, a free, community-run directory of
// about 50,000 stations that publish their own streams. Search answers are
// kept for a few minutes, since /radio suggests stations as people type.

import { makeTrack, Source } from "./track.js";
import { fetchJson as defaultFetchJson, MusicError } from "./net.js";

const SERVERS = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info", "https://fi1.api.radio-browser.info"];
const CACHE_MS = 5 * 60_000;
const MAX_CACHED = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isStationId = (text) => UUID.test(String(text ?? ""));

// A radio-browser station → { id, name, url, country, codec, bitrate, homepage, favicon, tags }.
export function toStation(item) {
  const url = typeof item?.url_resolved === "string" && /^https?:\/\//.test(item.url_resolved) ? item.url_resolved : item?.url;
  if (!item?.stationuuid || typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return null;
  }
  return {
    id: item.stationuuid,
    name: String(item.name ?? "").trim() || "Radio",
    url,
    country: String(item.country ?? "").trim(),
    codec: String(item.codec ?? "").trim(),
    bitrate: Number(item.bitrate) || 0,
    homepage: typeof item.homepage === "string" ? item.homepage : null,
    favicon: typeof item.favicon === "string" ? item.favicon : null,
    tags: String(item.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 3),
  };
}

export const stationTrack = (station) =>
  makeTrack({
    title: station.name,
    artist: [station.country, ...station.tags].filter(Boolean).join(" · "),
    url: station.homepage,
    artworkUrl: station.favicon,
    source: Source.RADIO,
    live: true,
    stream: { url: station.url },
  });

// "Name · Country · 128 kbps", for suggestions (Discord allows 100 characters).
export const stationLabel = (station) => [station.name, station.country, station.bitrate ? `${station.bitrate} kbps` : station.codec].filter(Boolean).join(" · ").slice(0, 100);

// Options: fetchJson and now (tests).
export function createRadio({ fetchJson = defaultFetchJson, now = Date.now } = {}) {
  const cache = new Map();

  async function ask(path) {
    let lastError;
    for (const server of SERVERS) {
      try {
        return await fetchJson(`${server}${path}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new MusicError("unreachable", "The radio directory didn't answer.");
  }

  return {
    // Stations whose name matches, most listened first.
    async search(text, { limit = 10 } = {}) {
      const query = String(text ?? "").trim().toLowerCase().slice(0, 100);
      if (!query) {
        return [];
      }
      const key = `${query}:${limit}`;
      const kept = cache.get(key);
      if (kept && now() - kept.at < CACHE_MS) {
        return kept.stations;
      }
      const params = new URLSearchParams({ name: query, limit: String(limit), hidebroken: "true", order: "clickcount", reverse: "true" });
      const answer = await ask(`/json/stations/search?${params}`);
      const stations = (Array.isArray(answer) ? answer : []).map(toStation).filter(Boolean);
      if (cache.size >= MAX_CACHED) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(key, { at: now(), stations });
      return stations;
    },

    // One station by its radio-browser ID, or null.
    async byId(id) {
      if (!isStationId(id)) {
        return null;
      }
      const answer = await ask(`/json/stations/byuuid/${id.toLowerCase()}`);
      return (Array.isArray(answer) ? answer : []).map(toStation).find(Boolean) ?? null;
    },
  };
}
