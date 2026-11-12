// Song lyrics (/music lyrics) from LRCLIB (lrclib.net), a free, open lyrics
// database that needs no key. Looks up the exact song first (title, artist and
// length), then searches.

import { fetchJson as defaultFetchJson, MusicError } from "./net.js";

const API = "https://lrclib.net/api";
// Lengths within this much count as the same recording.
const LENGTH_SLACK_S = 4;

// "Song (Official Video) [HD]" → "Song"; "feat." parts dropped.
export function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s*[([](?:official|lyric|lyrics|audio|video|hd|hq|visuali[sz]er|explicit|clean|remaster(?:ed)?|\d{4} remaster)[^)\]]*[)\]]/gi, "")
    .replace(/\s*[([]?\b(?:feat|ft)\.?\s[^)\]]*[)\]]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits "Artist - Title" when the artist is in the title (common on SoundCloud).
export function splitArtist(title, artist) {
  const match = String(title ?? "").match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { artist: String(artist ?? "").trim(), title: String(title ?? "").trim() };
}

const pickText = (entry) => (typeof entry?.plainLyrics === "string" && entry.plainLyrics.trim() ? entry.plainLyrics.trim() : null);

// Options: fetchJson (tests).
export function createLyrics({ fetchJson = defaultFetchJson } = {}) {
  return {
    // { title, artist, lyrics } for a song, or null when LRCLIB doesn't have
    // it. `instrumental` is true for songs marked as having no words.
    // Throws MusicError("unreachable") when LRCLIB doesn't answer.
    async find({ title, artist = "", durationMs = null }) {
      const parts = splitArtist(cleanTitle(title), artist);
      if (!parts.title) {
        throw new MusicError("not-found", "No song to look up.");
      }
      const query = (params) => new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "" && value !== null && value !== undefined)).toString();
      if (parts.artist) {
        const exact = await fetchJson(`${API}/get?${query({ track_name: parts.title, artist_name: parts.artist, duration: durationMs ? Math.round(durationMs / 1000) : null })}`).catch((error) => {
          if (error instanceof MusicError && error.reason === "not-found") {
            return null;
          }
          throw error;
        });
        if (pickText(exact) || exact?.instrumental) {
          return { title: exact.trackName ?? parts.title, artist: exact.artistName ?? parts.artist, lyrics: pickText(exact), instrumental: Boolean(exact.instrumental) };
        }
      }
      const found = await fetchJson(`${API}/search?${query({ q: [parts.artist, parts.title].filter(Boolean).join(" ") })}`);
      const entries = (Array.isArray(found) ? found : []).filter((entry) => pickText(entry));
      const seconds = durationMs ? durationMs / 1000 : null;
      const best = (seconds && entries.find((entry) => Math.abs((entry.duration ?? 0) - seconds) <= LENGTH_SLACK_S)) || entries[0];
      return best ? { title: best.trackName ?? parts.title, artist: best.artistName ?? parts.artist, lyrics: pickText(best), instrumental: false } : null;
    },
  };
}
