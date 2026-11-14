// Word searches across every free library at once: SoundCloud (the biggest),
// Audius, Bandcamp and Jamendo (with JAMENDO_CLIENT_ID). Results are ranked
// together on how much of what was typed is in their title and artist. When
// copies match about equally well, the better-sounding one comes first
// (music/quality.js), then SoundCloud, the library most likely to play. A
// library that fails or is slow is left out rather than failing the search.

import { cleanQuery, queryScore, words } from "./match.js";
import { MusicError } from "./net.js";
import { rankNearTies, trackQuality } from "./quality.js";
import { soundCloudQuality, toTrack } from "./soundcloud.js";
import { Source } from "./track.js";

// Small nudges toward the library most likely to play, so it wins exact
// ties and a clearly better match elsewhere still beats it.
const SOURCE_BONUS = { [Source.SOUNDCLOUD]: 0.05, [Source.AUDIUS]: 0.02, [Source.JAMENDO]: 0, [Source.BANDCAMP]: -0.02 };
const RANK_STEP = 0.01;
// How many Bandcamp picks /play checks before giving up on them.
const BANDCAMP_CHECKS = 3;

const sameSong = (track) => `${words(track.artist).join(" ")}|${words(track.title).join(" ")}`;

// Options: soundcloud, audius, bandcamp, jamendo (any can be left out), logger.
export function createLibrary({ soundcloud, audius = null, bandcamp = null, jamendo = null, logger = null }) {
  // Every library's results for a query, ranked.
  async function gather(query, limit) {
    const typed = String(query ?? "").trim();
    const tidy = cleanQuery(typed);
    const each = Math.max(limit, 10);
    const searches = [
      ["soundcloud", soundcloud.find(tidy, { limit: each })],
      ...(tidy !== typed ? [["soundcloud", soundcloud.find(typed, { limit: each })]] : []),
      ...(audius ? [["audius", audius.search(tidy, { limit: each })]] : []),
      ...(bandcamp?.search ? [["bandcamp", bandcamp.search(tidy, { limit: Math.min(each, 10) })]] : []),
      ...(jamendo?.enabled ? [["jamendo", jamendo.search(tidy, { limit: each })]] : []),
    ];
    const answers = await Promise.allSettled(searches.map(([, search]) => search));
    let previews = 0;
    const failed = [];
    const scored = [];
    answers.forEach((answer, index) => {
      const name = searches[index][0];
      if (answer.status === "rejected") {
        failed.push(answer.reason);
        logger?.warn?.("A music library search failed", { library: name, error: answer.reason?.message });
        return;
      }
      const value = answer.value;
      const tracks = name === "soundcloud" ? value.tracks.map((raw) => ({ track: toTrack(raw), kbps: soundCloudQuality(raw) })) : value.map((track) => ({ track, kbps: null }));
      if (name === "soundcloud") {
        previews = Math.max(previews, value.previews);
      }
      tracks.forEach(({ track, kbps }, rank) => {
        scored.push({ track, quality: trackQuality(track, kbps), score: queryScore(typed, track) + (SOURCE_BONUS[track.source] ?? 0) - rank * RANK_STEP });
      });
    });
    // Best match first; among near-ties, the best-sounding copy. Duplicates
    // below keep that copy.
    const ranked = rankNearTies(scored);
    const seen = new Set();
    const tracks = [];
    for (const { track } of ranked) {
      const keys = [track.url, sameSong(track)].filter(Boolean);
      if (keys.some((key) => seen.has(key))) {
        continue;
      }
      keys.forEach((key) => seen.add(key));
      tracks.push(track);
    }
    // `tracks`: one copy of each song (for /search); `all`: every result, best first.
    return { tracks, all: ranked.map(({ track }) => track), previews, failed, everyFailed: failed.length === searches.length };
  }

  const nothing = (typed, { previews, failed, everyFailed }) => {
    if (everyFailed) {
      throw new MusicError("unreachable", failed.map((error) => error?.message).join(" | ") || "No music library answered.");
    }
    if (previews > 0) {
      throw new MusicError("not-free", `Only Go+ previews of "${typed}" were found.`);
    }
    throw new MusicError("no-results", `No free songs found for "${typed}".`);
  };

  return {
    // Up to `limit` tracks for words, best first (/search). Throws MusicError.
    async search(query, { limit = 5 } = {}) {
      const found = await gather(query, limit);
      if (found.tracks.length === 0) {
        nothing(query, found);
      }
      return found.tracks.slice(0, limit);
    },

    // The one track to play for words (/play). A Bandcamp pick is checked
    // first, since not every Bandcamp track can be streamed. Throws MusicError.
    async best(query) {
      const found = await gather(query, 5);
      let checks = 0;
      for (const track of found.all) {
        if (track.source !== Source.BANDCAMP) {
          return track;
        }
        if (checks >= BANDCAMP_CHECKS) {
          continue;
        }
        checks += 1;
        const checked = await bandcamp.resolve(track.url, { limit: 1 }).catch(() => null);
        if (checked?.tracks?.[0]) {
          return checked.tracks[0];
        }
      }
      return nothing(query, found);
    },
  };
}
