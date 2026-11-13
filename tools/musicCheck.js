// Checks every music library from this machine, to find out why songs aren't
// found. Run it on the VPS:
//
//   npm run music:check
//   npm run music:check -- "artist title"
//
// It prints what each library answered (or the error), what /play and
// /search would pick, and whether the first SoundCloud and Audius results'
// audio actually loads (each SoundCloud stream format separately). Nothing
// is saved or posted, and only the first bytes of the audio are read.

import { createAudius } from "../src/music/audius.js";
import { createBandcamp } from "../src/music/bandcamp.js";
import { createJamendo } from "../src/music/jamendo.js";
import { createLibrary } from "../src/music/library.js";
import { createLyrics } from "../src/music/lyrics.js";
import { cleanQuery } from "../src/music/match.js";
import { fetchText, openUrl } from "../src/music/net.js";
import { createSoundCloud, toTrack } from "../src/music/soundcloud.js";
import { createResolver } from "../src/music/sources.js";
import { checkFfmpeg, openAudio } from "../src/music/stream.js";
import { trackLabel } from "../src/music/track.js";

const query = process.argv.slice(2).join(" ").trim() || "daft punk one more time";
const line = (name, text) => console.log(`${name.padEnd(12)} ${text}`);
const failed = (error) => `FAILED: ${error?.reason ? `${error.reason}: ` : ""}${error?.message ?? error}`;

async function check(name, work) {
  const started = Date.now();
  try {
    line(name, `${await work()} (${Date.now() - started} ms)`);
  } catch (error) {
    line(name, `${failed(error)} (${Date.now() - started} ms)`);
  }
}

console.log(`Music check for "${query}" (tidied: "${cleanQuery(query)}")\n`);

await check("ffmpeg", async () => {
  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.ok) {
    throw new Error(`${ffmpeg.path}: ${ffmpeg.error}. Nothing can play without it: sudo apt install -y ffmpeg`);
  }
  return `${ffmpeg.path}: ${ffmpeg.version}`;
});

await check("soundcloud", async () => {
  const home = await fetchText("https://soundcloud.com/");
  return `home page ${home.length} bytes, ${(home.match(/sndcdn\.com\/assets\/[^"']+\.js/g) ?? []).length} scripts`;
});

const soundcloud = createSoundCloud({ clientId: process.env.SOUNDCLOUD_CLIENT_ID || null });
const audius = createAudius();
const bandcamp = createBandcamp();
await check("soundcloud", async () => {
  const found = await soundcloud.find(cleanQuery(query), { limit: 5 });
  const names = found.tracks.map((track) => `${track.title} [${track.policy}]`).join(" | ");
  return `${found.tracks.length} free, ${found.previews} Go+ previews only. ${names}`;
});
// Opens an audio address and reads its first bytes: "200 audio/mpeg".
async function probe(address) {
  const opened = await openUrl(address);
  const status = `${opened.response.status} ${opened.response.headers.get("content-type") ?? "?"}`;
  opened.abort();
  return status;
}

// Plays a track the way the bot does (download, then ffmpeg) until 3
// seconds of audio come out, then stops: "decoded 3.0 s" or what failed.
async function decode(track) {
  const audio = await openAudio(track, { soundcloud, audius, bandcamp });
  return new Promise((resolve) => {
    let bytes = 0;
    const finish = (text) => {
      clearTimeout(timer);
      audio.stop();
      resolve(text);
    };
    const timer = setTimeout(() => finish(`only ${(bytes / 192_000).toFixed(1)} s in 20 s. ffmpeg: ${audio.errors.join(" | ") || "nothing"}`), 20_000);
    audio.stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes >= 3 * 192_000) {
        finish("decoded 3.0 s");
      }
    });
    audio.stream.on("close", () => finish(bytes >= 3 * 192_000 ? "decoded 3.0 s" : `stopped after ${(bytes / 192_000).toFixed(1)} s. ffmpeg: ${audio.errors.join(" | ") || "nothing"}`));
  });
}

await check("sc stream", async () => {
  const [first] = (await soundcloud.find(cleanQuery(query), { limit: 1 })).tracks;
  if (!first) {
    return "no track to stream";
  }
  // find() answers with SoundCloud's own API tracks (id, not stream.id).
  const { policy, transcodings, report } = await soundcloud.streamReport(first.id);
  const lines = [`"${first.title}" (id ${first.id}, ${policy}, ${transcodings} formats)`];
  for (const item of report) {
    const opened = item.address ? await probe(item.address).catch((error) => failed(error)) : `FAILED: ${item.error}`;
    lines.push(`  ${item.protocol} ${item.mime || "?"}: ${opened}`);
  }
  lines.push(`  bot plays it: ${await decode(toTrack(first)).catch((error) => failed(error))}`);
  return lines.join("\n");
});

await check("audius", async () => {
  const found = await audius.search(cleanQuery(query), { limit: 5 });
  return `${found.length} found. ${found.map(trackLabel).join(" | ")}`;
});
await check("audius", async () => {
  const [first] = await audius.search(cleanQuery(query), { limit: 1 });
  if (!first) {
    return "no track to stream";
  }
  const address = await audius.streamFor(first.stream.id);
  return `stream of "${first.title}": ${await probe(address)}, bot plays it: ${await decode(first).catch((error) => failed(error))}`;
});

await check("bandcamp", async () => {
  const found = await bandcamp.search(cleanQuery(query), { limit: 5 });
  return `${found.length} found. ${found.map(trackLabel).join(" | ")}`;
});

const jamendo = createJamendo({ clientId: process.env.JAMENDO_CLIENT_ID || null });
await check("jamendo", async () => {
  if (!jamendo.enabled) {
    return "off (no JAMENDO_CLIENT_ID)";
  }
  const found = await jamendo.search(cleanQuery(query), { limit: 5 });
  return `${found.length} found. ${found.map(trackLabel).join(" | ")}`;
});

await check("lyrics", async () => {
  const found = await createLyrics().find({ title: query });
  return found ? `found: ${found.artist} - ${found.title}` : "none";
});

const library = createLibrary({ soundcloud, audius, bandcamp, jamendo });
await check("/search", async () => (await library.search(query, { limit: 5 })).map((track) => `${trackLabel(track)} (${track.source})`).join(" | "));
await check("/play", async () => {
  const track = await library.best(query);
  return `${trackLabel(track)} (${track.source})`;
});

const spotify = "https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV";
await check("spotify", async () => {
  const resolver = createResolver({ soundcloud, audius, bandcamp, jamendo });
  const { tracks } = await resolver.resolve(spotify, { limit: 1 });
  const ready = await resolver.ready(tracks[0]);
  return `${trackLabel(tracks[0])} matched to ${ready.url} (${ready.source})`;
});
