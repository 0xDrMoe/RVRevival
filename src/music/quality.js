// How good a copy of a song sounds, used only to break near-ties: when two
// copies match what was asked for about equally well, the one with more
// audio detail plays. Match accuracy always comes first.
//
// Quality is an "MP3-equivalent" kbps estimate, so codecs can be compared:
// Opus and AAC need fewer bits than MP3 for the same sound.
//
//   Audius     320  (every upload is served as a 320 kbps MP3)
//   Jamendo    192  (the "mp32" VBR stream the search asks for)
//   SoundCloud 128 to 256, from its best free stream (see soundcloud.js)
//   Bandcamp   128  (free streams are 128 kbps MP3)

import { Source } from "./track.js";

export const SOURCE_KBPS = Object.freeze({
  [Source.AUDIUS]: 320,
  [Source.JAMENDO]: 192,
  [Source.SOUNDCLOUD]: 128,
  [Source.BANDCAMP]: 128,
});

// How much better each codec is than MP3 at the same bitrate (a rough,
// commonly used rule of thumb).
const CODEC_FACTOR = { mp3: 1, aac: 1.3, opus: 2 };

// The codec of a MIME type ("audio/mpeg", 'audio/ogg; codecs="opus"', ...).
export function codecOf(mime) {
  const type = String(mime ?? "").toLowerCase();
  if (type.includes("opus")) {
    return "opus";
  }
  if (type.includes("mp4") || type.includes("aac")) {
    return "aac";
  }
  if (type.includes("mpeg") || type.includes("mp3")) {
    return "mp3";
  }
  return null;
}

// MP3-equivalent kbps of a stream with a codec and real bitrate (kbps).
export const equivalentKbps = (codec, kbps) => Math.round((CODEC_FACTOR[codec] ?? 1) * kbps);

// A queue track's estimated quality. `known` (kbps) wins when given, for
// SoundCloud, whose streams differ from track to track.
export function trackQuality(track, known = null) {
  if (Number.isFinite(known) && known > 0) {
    return known;
  }
  return SOURCE_KBPS[track?.source] ?? 0;
}

// Word searches: copies count as tied when their scores are this close.
// That's the gap between SoundCloud's and Audius's nudges in library.js, so
// each library's own top result can tie, but not a library's 2nd or 3rd
// result (the library itself ranked those lower).
export const NEAR_TIE = 0.03;
// Spotify, Apple Music and Deezer matches (match.js matchScore): smaller
// than one step of the length check, so a closer length still wins.
export const MATCH_TIE = 0.05;

// Puts `items` ({ score, quality, ... }, any order) best first: highest score
// first, but among items within `tie` of the best remaining score, higher
// quality first (then score). Stable, so equal items keep their order.
export function rankNearTies(items, { tie = NEAR_TIE } = {}) {
  const left = items.map((item, index) => ({ item, index })).sort((a, b) => b.item.score - a.item.score || a.index - b.index);
  const ranked = [];
  while (left.length > 0) {
    const top = left[0].item.score;
    let end = 1;
    while (end < left.length && top - left[end].item.score <= tie + 1e-9) {
      end += 1;
    }
    const band = left.splice(0, end);
    band.sort((a, b) => (b.item.quality ?? 0) - (a.item.quality ?? 0) || b.item.score - a.item.score || a.index - b.index);
    ranked.push(...band.map(({ item }) => item));
  }
  return ranked;
}

// What @discordjs/voice's Opus encoder should use in a voice channel (bps):
// the channel's own bitrate, but never below 96 kbps (what the encoder
// picks by itself for music, so no channel sounds worse than before) and
// never above 128 kbps (the encoder's most; Opus is transparent there).
export const MIN_VOICE_BITRATE = 96_000;
export const MAX_VOICE_BITRATE = 128_000;

export function voiceBitrate(channelBitrate) {
  const wanted = Number(channelBitrate);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return MIN_VOICE_BITRATE;
  }
  return Math.min(MAX_VOICE_BITRATE, Math.max(MIN_VOICE_BITRATE, Math.round(wanted)));
}
