// Audio filters (/music filter), applied by ffmpeg while it decodes. Each has
// an ffmpeg filter chain and how much faster (or slower) it plays the song,
// so the position shown stays right.
//
// Changing the filter restarts the song where it was, with the new chain.

export const FILTERS = Object.freeze({
  off: { chain: null, speed: 1 },
  bassboost: { chain: "bass=g=10:f=110:w=0.6", speed: 1 },
  nightcore: { chain: "aresample=48000,asetrate=48000*1.25,aresample=48000", speed: 1.25 },
  vaporwave: { chain: "aresample=48000,asetrate=48000*0.8,aresample=48000", speed: 0.8 },
  "8d": { chain: "apulsator=hz=0.08", speed: 1 },
  karaoke: { chain: "pan=stereo|c0=c0-c1|c1=c1-c0", speed: 1 },
  treble: { chain: "treble=g=6", speed: 1 },
  soft: { chain: "lowpass=f=2500", speed: 1 },
});

export const FILTER_NAMES = Object.keys(FILTERS);

export const isFilter = (name) => Object.hasOwn(FILTERS, name);

export const filterSpeed = (name) => (isFilter(name) ? FILTERS[name].speed : 1);

// ffmpeg's -af value: skips `startMs` of the song first (a seek, timed in the
// song itself, before any speed change), then the filter. Null for neither.
export function audioFilter(name, startMs = 0) {
  const parts = [];
  if (startMs > 0) {
    parts.push(`atrim=start=${(startMs / 1000).toFixed(3)}`, "asetpts=PTS-STARTPTS");
  }
  const chain = isFilter(name) ? FILTERS[name].chain : null;
  if (chain) {
    parts.push(chain);
  }
  return parts.length > 0 ? parts.join(",") : null;
}
