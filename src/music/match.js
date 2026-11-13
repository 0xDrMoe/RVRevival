// Finds a free copy of a song read from Spotify, Apple Music or Deezer
// (SoundCloud first, then the other libraries), and ranks word searches. The search is "artist title"; each result is scored on how much of
// the title it has, whether it names the artist, and how close its length is.
// Covers, remixes and sped-up versions lose points unless the song itself is
// one. Below MIN_SCORE nothing is picked, rather than playing the wrong song.

export const MIN_SCORE = 0.55;
const VARIANTS = ["cover", "remix", "nightcore", "sped", "slowed", "reverb", "8d", "karaoke", "instrumental", "live", "acoustic", "mashup", "bootleg", "edit", "loop", "hour"];

// Lowercase words without accents, punctuation or "(feat. …)".
export function words(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([](?:feat|ft|with|prod)\.?[^)\]]*[)\]]/g, " ")
    .replace(/\s-\s.*(?:remaster|version|edit|mix).*$/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// Tags at the end of what people type or paste from video titles, which no
// music library has: "official video", "lyrics", "HD"… Only at the end, so
// "Video Killed the Radio Star" keeps its words.
const TRAILING_NOISE = /(?:\s+(?:official|music|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k|mv|m\/v|explicit|clean|remaster(?:ed)?|full\s+song))+\s*$/i;

// A typed search tidied for the libraries: tags like "(Official Video)" and
// "ft. Someone" dropped, quotes and symbols turned to spaces. Words in other
// scripts are kept.
export function cleanQuery(text) {
  const tidy = String(text ?? "")
    .normalize("NFKC")
    .replace(/[([{](?:[^)\]}]*?)(?:official|lyric|audio|video|visuali[sz]er|hd|hq|4k|mv|explicit|remaster)[^)\]}]*[)\]}]/gi, " ")
    .replace(/\s(?:feat|ft|featuring)\.?\s[^-([|]*/gi, " ")
    .replace(/["“”«»|•~*_#@!?]+/g, " ")
    .replace(TRAILING_NOISE, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return tidy || String(text ?? "").trim();
}

// 0 to 1: how much of what was typed is in a track's title and artist, minus
// points for a cover, remix or sped-up version nobody asked for.
export function queryScore(query, track) {
  const wanted = [...new Set(words(cleanQuery(query)))];
  if (wanted.length === 0) {
    return 0;
  }
  const have = new Set([...words(track.title), ...words(track.artist ?? track.user?.username ?? "")]);
  const matched = wanted.filter((word) => have.has(word)).length / wanted.length;
  const titleWords = words(track.title);
  const variant = VARIANTS.some((word) => titleWords.includes(word) && !wanted.includes(word));
  return matched - (variant ? 0.3 : 0);
}

// The search to run for a song.
export function matchQuery({ title, artist }) {
  const firstArtist = String(artist ?? "").split(/,|&| x | feat\.? /i)[0].trim();
  return `${firstArtist} ${words(title).join(" ")}`.trim();
}

// 0 to 1 (or below, for a cover of a song that isn't one): how well a
// SoundCloud track ({ title, user: { username }, full_duration }) matches.
export function matchScore(lookup, candidate) {
  const wanted = words(lookup.title);
  const name = words(candidate.title);
  const uploader = words(candidate.artist ?? candidate.user?.username ?? candidate.publisher_metadata?.artist ?? "");
  const found = new Set([...name, ...uploader]);
  const titleScore = wanted.length > 0 ? wanted.filter((word) => name.includes(word)).length / wanted.length : 0;
  const artistWords = words(String(lookup.artist ?? "").split(/,|&/)[0]);
  const artistScore = artistWords.length > 0 && artistWords.every((word) => found.has(word)) ? 1 : 0;

  let durationScore = 0.5;
  const length = candidate.durationMs ?? candidate.full_duration ?? candidate.duration;
  if (lookup.durationMs && length) {
    const off = Math.abs(lookup.durationMs - length);
    durationScore = off <= 3_000 ? 1 : off <= 10_000 ? 0.7 : off <= 30_000 ? 0.3 : off <= 60_000 ? 0 : -0.5;
  }
  const lookupWords = new Set(words(lookup.title));
  const variant = VARIANTS.some((word) => name.includes(word) && !lookupWords.has(word));
  return 0.5 * titleScore + 0.25 * artistScore + 0.25 * durationScore - (variant ? 0.5 : 0);
}

// The best candidate for a song, or null.
function bestOf(lookup, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const score = matchScore(lookup, candidate);
    if (score >= MIN_SCORE && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

// The best SoundCloud track for a song (a SoundCloud API track), or null.
// `soundcloud` is createSoundCloud(). Tries the song's title without its
// tags too, when that's different.
export async function findMatch(soundcloud, lookup) {
  const query = matchQuery(lookup);
  const found = bestOf(lookup, await soundcloud.search(query, { limit: 20 }));
  if (found) {
    return found;
  }
  const tidy = cleanQuery(query);
  return tidy !== query ? bestOf(lookup, await soundcloud.search(tidy, { limit: 20 })) : null;
}

// The best copy in other libraries (each with search(query) → queue tracks),
// tried in order, or null. Failures are skipped.
export async function findOtherMatch(libraries, lookup) {
  for (const library of libraries) {
    const candidates = await library.search(matchQuery(lookup), { limit: 10 }).catch(() => []);
    const found = bestOf(lookup, candidates);
    if (found) {
      return found;
    }
  }
  return null;
}
