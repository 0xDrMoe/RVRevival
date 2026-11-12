// Bandcamp: track and album links on <artist>.bandcamp.com. Each page carries
// its tracks as JSON in a data-tralbum attribute, with a 128 kbps MP3 for the
// ones the artist lets anyone stream. Those addresses expire, so the page is
// read again when a song starts.

import { makeTrack, Source } from "./track.js";
import { fetchText as defaultFetchText, MusicError } from "./net.js";

const PAGE = /^\/(track|album)\/[\w-]+\/?$/;
const ENTITIES = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'" };

export const isBandcampUrl = (url) => /^[a-z0-9-]+\.bandcamp\.com$/i.test(url.hostname) && PAGE.test(url.pathname);

const unescapeHtml = (text) =>
  text.replace(/&(quot|amp|lt|gt|apos|#39|#x([0-9a-f]+)|#(\d+));/gi, (whole, name, hex, decimal) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : decimal ? String.fromCodePoint(Number(decimal)) : (ENTITIES[name.toLowerCase()] ?? whole),
  );

// The data-tralbum JSON on a track or album page, or null.
export function readTralbum(html) {
  const match = html.match(/data-tralbum="([^"]+)"/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(unescapeHtml(match[1]));
  } catch {
    return null;
  }
}

const streamOf = (info) => {
  const url = info?.file?.["mp3-128"];
  return typeof url === "string" && url.startsWith("https://") ? url : null;
};

// Options: fetchText (tests).
export function createBandcamp({ fetchText = defaultFetchText } = {}) {
  async function load(page) {
    const album = readTralbum(await fetchText(page, { maxBytes: 4 * 1024 * 1024 }));
    if (!album || !Array.isArray(album.trackinfo)) {
      throw new MusicError("not-found", "That Bandcamp page has no tracks.");
    }
    return album;
  }

  return {
    // A track or album page → { tracks, skipped, name }. Throws MusicError.
    async resolve(page, { limit = 100 } = {}) {
      const album = await load(page);
      const artwork = Number.isInteger(album.art_id) ? `https://f4.bcbits.com/img/a${album.art_id}_10.jpg` : null;
      const origin = new URL(page).origin;
      const all = album.trackinfo.slice(0, limit);
      const tracks = all.filter((info) => streamOf(info)).map((info) =>
        makeTrack({
          title: info.title,
          artist: info.artist || album.artist || "",
          url: info.title_link ? `${origin}${info.title_link}` : page,
          artworkUrl: artwork,
          durationMs: Number(info.duration) * 1000,
          source: Source.BANDCAMP,
          stream: { page, trackId: info.track_id ?? info.id },
        }),
      );
      if (tracks.length === 0) {
        throw new MusicError("not-free", "Nothing on that Bandcamp page is free to stream.");
      }
      return { tracks, skipped: all.length - tracks.length, name: all.length > 1 ? (album.current?.title ?? null) : null };
    },

    // The MP3 address for a track, read fresh from its page.
    async streamFor({ page, trackId }) {
      const album = await load(page);
      const info = album.trackinfo.find((entry) => (entry.track_id ?? entry.id) === trackId);
      const url = streamOf(info);
      if (!url) {
        throw new MusicError("not-free", "That Bandcamp track can't be streamed any more.");
      }
      return url;
    },
  };
}
