// Opens a track's audio and turns it into what Discord plays: ffmpeg decodes
// anything (MP3, AAC, Opus, FLAC, radio streams, video files) into 48 kHz
// stereo PCM, and @discordjs/voice encodes that to Opus with the volume
// applied on the fly.
//
// The bot downloads the audio itself (through net.js, so nothing on the
// VPS's own network is reachable) and feeds it to ffmpeg, HLS included
// (music/hls.js). ffmpeg never goes online: the static build crashes when
// it looks up a host name.
//
// ffmpeg comes from the ffmpeg-static package; FFMPEG_PATH picks another one.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { audioFilter } from "./filters.js";
import { openHls } from "./hls.js";
import { MusicError, openUrl as defaultOpenUrl } from "./net.js";
import { Source } from "./track.js";

const require = createRequire(import.meta.url);

export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // Not installed: use the system's.
  }
  return "ffmpeg";
}

// Whether ffmpeg runs: { ok, path, version } or { ok: false, path, error }.
export function checkFfmpeg({ spawnImpl = spawn, path = ffmpegPath() } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawnImpl(path, ["-hide_banner", "-version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, path, error: error.message });
      return;
    }
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ ok: false, path, error: error.code === "ENOENT" ? "not installed" : error.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true, path, version: output.split("\n")[0].trim() } : { ok: false, path, error: `exit ${code}` }));
  });
}

// The last check, redone a minute after a failure (ffmpeg may have been
// installed since).
let ffmpegCheck = null;
async function requireFfmpeg() {
  if (!ffmpegCheck || (ffmpegCheck.result && !ffmpegCheck.result.ok && Date.now() - ffmpegCheck.at > 60_000)) {
    const entry = { at: Date.now(), result: null };
    entry.promise = checkFfmpeg().then((result) => (entry.result = result));
    ffmpegCheck = entry;
  }
  const result = await ffmpegCheck.promise;
  if (!result.ok) {
    throw new MusicError("no-ffmpeg", `ffmpeg (${result.path}) didn't run: ${result.error}.`);
  }
}

// ffmpeg's arguments. `input` is "pipe:0" for audio the bot feeds it, or an
// HTTPS address for HLS.
// `startMs` skips the start of the song (a seek): ffmpeg decodes and drops
// it, which works on any input, including a piped download. `filter` names
// an audio filter (music/filters.js).
export function ffmpegArgs(input, { live = false, startMs = 0, filter = "off" } = {}) {
  const af = audioFilter(filter, live ? 0 : startMs);
  // HLS: only HTTPS, so any segment name can be allowed (SoundCloud's Opus
  // segments end in .opus, which ffmpeg blocks by default).
  const network = input === "pipe:0" ? [] : ["-protocol_whitelist", "https,tls,tcp,hls,crypto", "-allowed_extensions", "ALL", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...(live ? ["-fflags", "nobuffer"] : []),
    ...network,
    "-i",
    input,
    ...(af ? ["-af", af] : []),
    "-vn",
    "-sn",
    "-dn",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ];
}

// Songs from a music library: a 404 while opening their audio means the
// stream broke, not that the song is missing.
const LIBRARY_SOURCES = new Set([Source.SOUNDCLOUD, Source.BANDCAMP, Source.AUDIUS, Source.JAMENDO]);

// Opens a SoundCloud stream to be sure it loads before it's chosen, and
// keeps it open to be played: a file download, or an HLS playlist read by
// the bot (music/hls.js).
async function checkSoundCloudStream(stream, openUrl) {
  if (stream.protocol === "hls") {
    return openHls(stream.url, { openUrl });
  }
  const opened = await openUrl(stream.url);
  return { stream: opened.response.body ? Readable.fromWeb(opened.response.body) : null, abort: opened.abort };
}

// Where to read a ready track's audio: { url } for the bot to download, or
// { opened } when it's already open ({ stream, abort }). `soundcloud`,
// `bandcamp` and `audius` come from the resolver.
export async function audioAddress(track, { soundcloud, bandcamp, audius, openUrl = defaultOpenUrl }) {
  switch (track.source) {
    case Source.SOUNDCLOUD: {
      const stream = await soundcloud.streamFor(track.stream.id, { check: (found) => checkSoundCloudStream(found, openUrl) });
      if (stream.checked) {
        return { opened: stream.checked };
      }
      if (!/^https:\/\//.test(stream.url)) {
        throw new MusicError("unreachable", "That stream isn't on HTTPS.");
      }
      return stream.protocol === "hls" ? { opened: await openHls(stream.url, { openUrl }) } : { url: stream.url };
    }
    case Source.BANDCAMP:
      return { url: await bandcamp.streamFor(track.stream) };
    case Source.AUDIUS:
      return { url: await audius.streamFor(track.stream.id) };
    case Source.JAMENDO:
    case Source.RADIO:
    case Source.LINK:
    case Source.FILE:
      return { url: track.stream.url };
    default:
      throw new MusicError("not-found", "This song has no audio.");
  }
}

// The audio as { stream, abort }: a Node stream for ffmpeg's input.
async function openSource(track, { soundcloud, bandcamp, audius, openUrl }) {
  try {
    const address = await audioAddress(track, { soundcloud, bandcamp, audius, openUrl });
    if (address.opened) {
      return address.opened;
    }
    const download = await openUrl(address.url);
    return { stream: download.response.body ? Readable.fromWeb(download.response.body) : null, abort: download.abort };
  } catch (error) {
    if (LIBRARY_SOURCES.has(track.source) && error instanceof MusicError && error.reason === "not-found") {
      throw new MusicError("no-stream", error.message);
    }
    throw error;
  }
}

// Starts a track. Returns { stream, stop, errors }: the PCM stream for
// createAudioResource, a function that stops the download and ffmpeg, and
// ffmpeg's last error lines (for the log). The bot reads all audio itself
// and pipes it to ffmpeg, which never goes online. Options: soundcloud,
// bandcamp, audius, startMs, filter, spawnImpl and openUrl (tests).
export async function openAudio(track, { soundcloud, bandcamp, audius, spawnImpl = spawn, openUrl = defaultOpenUrl, logger, startMs = 0, filter = "off" }) {
  // Without ffmpeg nothing can play; say so instead of a vague failure.
  if (spawnImpl === spawn) {
    await requireFfmpeg();
  }
  const input = await openSource(track, { soundcloud, bandcamp, audius, openUrl });
  if (!input.stream) {
    input.abort();
    throw new MusicError("not-audio", "That link sent nothing to play.");
  }

  const ffmpeg = spawnImpl(ffmpegPath(), ffmpegArgs("pipe:0", { live: track.live, startMs, filter }), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const errors = [];
  ffmpeg.stderr?.on("data", (chunk) => {
    errors.push(String(chunk).trim());
    errors.splice(0, Math.max(0, errors.length - 5));
  });
  ffmpeg.on("error", (error) => logger?.warn("ffmpeg didn't start; is it installed?", { error }));
  ffmpeg.stdin?.on("error", () => {});

  const source = input.stream;
  source.on("error", (error) => {
    logger?.warn?.("The audio download broke off", { error: error?.message });
    ffmpeg.stdin?.end();
  });
  source.pipe(ffmpeg.stdin);

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    source.unpipe();
    source.destroy();
    input.abort();
    ffmpeg.stdin?.destroy();
    if (ffmpeg.exitCode === null) {
      ffmpeg.kill("SIGKILL");
    }
  };
  ffmpeg.on("close", () => {
    source.destroy();
    input.abort();
  });
  return { stream: ffmpeg.stdout, stop, errors };
}
