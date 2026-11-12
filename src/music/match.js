// Finds a free copy on SoundCloud of a song read from Spotify, Apple Music or
// Deezer. The search is "artist title"; each result is scored on how much of
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
  const uploader = words(candidate.user?.username ?? candidate.publisher_metadata?.artist ?? "");
  const found = new Set([...name, ...uploader]);
  const titleScore = wanted.length > 0 ? wanted.filter((word) => name.includes(word)).length / wanted.length : 0;
  const artistWords = words(String(lookup.artist ?? "").split(/,|&/)[0]);
  const artistScore = artistWords.length > 0 && artistWords.every((word) => found.has(word)) ? 1 : 0;

  let durationScore = 0.5;
  const length = candidate.full_duration ?? candidate.duration;
  if (lookup.durationMs && length) {
    const off = Math.abs(lookup.durationMs - length);
    durationScore = off <= 3_000 ? 1 : off <= 10_000 ? 0.7 : off <= 30_000 ? 0.3 : off <= 60_000 ? 0 : -0.5;
  }
  const lookupWords = new Set(words(lookup.title));
  const variant = VARIANTS.some((word) => name.includes(word) && !lookupWords.has(word));
  return 0.5 * titleScore + 0.25 * artistScore + 0.25 * durationScore - (variant ? 0.5 : 0);
}

// The best SoundCloud track for a song, or null. `soundcloud` is createSoundCloud().
export async function findMatch(soundcloud, lookup) {
  const candidates = await soundcloud.search(matchQuery(lookup), { limit: 10 });
  let best = null;
  for (const candidate of candidates) {
    const score = matchScore(lookup, candidate);
    if (score >= MIN_SCORE && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}
