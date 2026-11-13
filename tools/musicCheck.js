// Checks every music library from this machine, to find out why songs aren't
// found. Run it on the VPS:
//
//   npm run music:check
//   npm run music:check -- "artist title"
//
// It prints what each library answered (or the error) and what /play and
// /search would pick. Nothing is saved or posted.

import { createAudius } from "../src/music/audius.js";
import { createBandcamp } from "../src/music/bandcamp.js";
import { createJamendo } from "../src/music/jamendo.js";
import { createLibrary } from "../src/music/library.js";
import { createLyrics } from "../src/music/lyrics.js";
import { cleanQuery } from "../src/music/match.js";
import { fetchText } from "../src/music/net.js";
import { createSoundCloud } from "../src/music/soundcloud.js";
import { createResolver } from "../src/music/sources.js";
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

await check("soundcloud", async () => {
  const home = await fetchText("https://soundcloud.com/");
  return `home page ${home.length} bytes, ${(home.match(/sndcdn\.com\/assets\/[^"']+\.js/g) ?? []).length} scripts`;
});

const soundcloud = createSoundCloud({ clientId: process.env.SOUNDCLOUD_CLIENT_ID || null });
await check("soundcloud", async () => {
  const found = await soundcloud.find(cleanQuery(query), { limit: 5 });
  const names = found.tracks.map((track) => `${track.title} [${track.policy}]`).join(" | ");
  return `${found.tracks.length} free, ${found.previews} Go+ previews only. ${names}`;
});
const audius = createAudius();
await check("audius", async () => {
  const found = await audius.search(cleanQuery(query), { limit: 5 });
  return `${found.length} found. ${found.map(trackLabel).join(" | ")}`;
});
await check("audius", async () => {
  const [first] = await audius.search(cleanQuery(query), { limit: 1 });
  return first ? `stream address ${await audius.streamFor(first.stream.id)}` : "no track to stream";
});

const bandcamp = createBandcamp();
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
