// HLS (.m3u8) streams, read by the bot itself and fed to ffmpeg as one
// stream: the init section (EXT-X-MAP) if any, then each segment in order.
// That works for MP3, AAC (MPEG-TS or fragmented MP4) and Opus segments.
//
// ffmpeg never touches the network: the static ffmpeg build crashes when it
// looks up a host name, and this way every address goes through net.js's
// private-network checks like any other download.

import { Readable } from "node:stream";
import { MusicError, openUrl as defaultOpenUrl } from "./net.js";

const MAX_PLAYLIST_BYTES = 1024 * 1024;
const MAX_NESTING = 2;
// Live playlists: how many reloads in a row may bring nothing new.
const MAX_EMPTY_RELOADS = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The attributes of a tag line: 'URI="a.mp4",BANDWIDTH=1' → { URI, BANDWIDTH }.
function attributes(text) {
  const found = {};
  for (const match of text.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) {
    found[match[1]] = match[3] ?? match[2];
  }
  return found;
}

// A playlist's text → { variants } for a master playlist (best bandwidth
// first), else { map, segments: [{ url, sequence }], encrypted, ended,
// targetMs }. Addresses are made absolute against `base`.
export function parsePlaylist(text, base) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") {
    throw new MusicError("not-audio", "That stream isn't an HLS playlist.");
  }
  const resolve = (address) => new URL(address, base).href;
  const variants = [];
  const segments = [];
  let map = null;
  let encrypted = false;
  let ended = false;
  let targetMs = 6000;
  let sequence = 0;
  let pendingVariant = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = Number(attributes(line.slice(18)).BANDWIDTH) || 0;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const uri = attributes(line.slice(11)).URI;
      map = uri ? resolve(uri) : null;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      encrypted = (attributes(line.slice(11)).METHOD ?? "NONE") !== "NONE";
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetMs = Math.max(1, Number(line.slice(22)) || 6) * 1000;
    } else if (line === "#EXT-X-ENDLIST") {
      ended = true;
    } else if (!line.startsWith("#")) {
      if (pendingVariant !== null) {
        variants.push({ url: resolve(line), bandwidth: pendingVariant });
        pendingVariant = null;
      } else {
        segments.push({ url: resolve(line), sequence });
        sequence += 1;
      }
    }
  }
  if (variants.length > 0) {
    return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth).map((variant) => variant.url) };
  }
  return { map, segments, encrypted, ended, targetMs };
}

async function readText(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks = [];
  let total = 0;
  while (total <= MAX_PLAYLIST_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  if (total > MAX_PLAYLIST_BYTES) {
    throw new MusicError("not-audio", "That HLS playlist is too big.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The media playlist at an address (following a master playlist).
async function loadPlaylist(address, openUrl, depth = 0) {
  const { url, response } = await openUrl(address);
  const playlist = parsePlaylist(await readText(response), url);
  if (playlist.variants) {
    if (depth >= MAX_NESTING) {
      throw new MusicError("not-audio", "That HLS playlist has no audio in it.");
    }
    return loadPlaylist(playlist.variants[0], openUrl, depth + 1);
  }
  if (playlist.encrypted) {
    throw new MusicError("no-stream", "That HLS stream is encrypted.");
  }
  return { ...playlist, url: url.href };
}

// Opens an HLS stream. Returns { stream, abort }: a Node stream of the
// joined segments, and a function that stops it. The playlist is read
// before this returns, so a broken stream fails here, not in ffmpeg.
export async function openHls(address, { openUrl = defaultOpenUrl, wait = sleep } = {}) {
  let playlist = await loadPlaylist(address, openUrl);
  if (playlist.segments.length === 0 && playlist.ended) {
    throw new MusicError("no-stream", "That HLS stream has no segments.");
  }
  let stopped = false;
  let current = null;

  async function* parts() {
    if (playlist.map) {
      current = await openUrl(playlist.map);
      yield* current.response.body;
    }
    let next = playlist.segments[0]?.sequence ?? 0;
    let empty = 0;
    while (!stopped) {
      const fresh = playlist.segments.filter((segment) => segment.sequence >= next);
      for (const segment of fresh) {
        if (stopped) {
          return;
        }
        current = await openUrl(segment.url);
        yield* current.response.body;
        next = segment.sequence + 1;
      }
      if (playlist.ended) {
        return;
      }
      // A live stream: wait for new segments.
      empty = fresh.length === 0 ? empty + 1 : 0;
      if (empty >= MAX_EMPTY_RELOADS) {
        return;
      }
      await wait(playlist.targetMs / 2);
      if (!stopped) {
        playlist = await loadPlaylist(playlist.url, openUrl);
      }
    }
  }

  const stream = Readable.from(parts(), { objectMode: false });
  return {
    stream,
    abort() {
      stopped = true;
      current?.abort();
      stream.destroy();
    },
  };
}
