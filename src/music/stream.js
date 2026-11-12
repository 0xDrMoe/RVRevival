// Opens a track's audio and turns it into what Discord plays: ffmpeg decodes
// anything (MP3, AAC, Opus, FLAC, radio streams, video files) into 48 kHz
// stereo PCM, and @discordjs/voice encodes that to Opus with the volume
// applied on the fly.
//
// The bot downloads the audio itself (through net.js, so nothing on the
// VPS's own network is reachable) and feeds it to ffmpeg. Only SoundCloud's
// HLS streams are fetched by ffmpeg directly, limited to HTTPS.
//
// ffmpeg comes from the ffmpeg-static package; FFMPEG_PATH picks another one.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
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

// ffmpeg's arguments. `input` is "pipe:0" for audio the bot feeds it, or an
// HTTPS address for HLS.
export function ffmpegArgs(input, { live = false } = {}) {
  const network = input === "pipe:0" ? [] : ["-protocol_whitelist", "https,tls,tcp,hls,crypto", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...(live ? ["-fflags", "nobuffer"] : []),
    ...network,
    "-i",
    input,
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

// Where to read a ready track's audio: { url } for the bot to download, or
// { hls } for ffmpeg. `soundcloud` and `bandcamp` come from the resolver.
export async function audioAddress(track, { soundcloud, bandcamp }) {
  switch (track.source) {
    case Source.SOUNDCLOUD: {
      const stream = await soundcloud.streamFor(track.stream.id);
      return stream.protocol === "hls" ? { hls: stream.url } : { url: stream.url };
    }
    case Source.BANDCAMP:
      return { url: await bandcamp.streamFor(track.stream) };
    case Source.RADIO:
    case Source.LINK:
    case Source.FILE:
      return { url: track.stream.url };
    default:
      throw new MusicError("not-found", "This song has no audio.");
  }
}

// Starts a track. Returns { stream, stop, errors }: the PCM stream for
// createAudioResource, a function that stops the download and ffmpeg, and
// ffmpeg's last error lines (for the log). Options: soundcloud, bandcamp,
// spawnImpl and openUrl (tests).
export async function openAudio(track, { soundcloud, bandcamp, spawnImpl = spawn, openUrl = defaultOpenUrl, logger }) {
  const address = await audioAddress(track, { soundcloud, bandcamp });
  let download = null;
  if (address.url) {
    download = await openUrl(address.url);
    if (!download.response.body) {
      download.abort();
      throw new MusicError("not-audio", "That link sent nothing to play.");
    }
  } else if (!/^https:\/\//.test(address.hls)) {
    throw new MusicError("unreachable", "That stream isn't on HTTPS.");
  }

  const ffmpeg = spawnImpl(ffmpegPath(), ffmpegArgs(address.url ? "pipe:0" : address.hls, { live: track.live }), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const errors = [];
  ffmpeg.stderr?.on("data", (chunk) => {
    errors.push(String(chunk).trim());
    errors.splice(0, Math.max(0, errors.length - 5));
  });
  ffmpeg.on("error", (error) => logger?.warn("ffmpeg didn't start; is it installed?", { error }));
  ffmpeg.stdin?.on("error", () => {});

  let source = null;
  if (download) {
    source = Readable.fromWeb(download.response.body);
    source.on("error", () => ffmpeg.stdin?.end());
    source.pipe(ffmpeg.stdin);
  }

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    source?.unpipe();
    source?.destroy();
    download?.abort();
    ffmpeg.stdin?.destroy();
    if (ffmpeg.exitCode === null) {
      ffmpeg.kill("SIGKILL");
    }
  };
  ffmpeg.on("close", () => {
    source?.destroy();
    download?.abort();
  });
  return { stream: ffmpeg.stdout, stop, errors };
}
