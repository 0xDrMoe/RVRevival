// "To GIF": a quote card with the member's animated avatar moving, for
// members whose Discord avatar is a GIF.
//
// The card is drawn as usual with the avatar's square left see-through
// (quotes/card.js, cutout), then ffmpeg (the same ffmpeg-static the music
// player uses, music/stream.js) lays it over the animated avatar and makes a
// GIF. ffmpeg only ever reads local files: the bot downloads the avatar itself
// (ffmpeg-static crashes on network lookups, see music/hls.js).
//
// Kept cheap: at most GIF_LIMITS.seconds of the avatar at GIF_LIMITS.fps,
// GIF_LIMITS.width pixels wide, one GIF at a time for the whole bot, a time
// limit on ffmpeg, and per person and per server limits (quotes/quotes.js).

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath } from "../music/stream.js";
import { CARD, fetchAvatar, renderQuoteCard } from "./card.js";
import { normalizeStyle, THEMES } from "./style.js";

export const GIF_LIMITS = Object.freeze({
  seconds: 6,
  fps: 15,
  width: 800,
  // A smaller second try when the first GIF is too big to upload.
  smallWidth: 560,
  smallFps: 10,
  colors: 128,
  // Discord's upload limit for a server with no boosts.
  maxBytes: 10 * 1024 * 1024,
  avatarBytes: 4 * 1024 * 1024,
  timeoutMs: 25_000,
});

export class QuoteGifError extends Error {
  name = "QuoteGifError";
  // reason: no-avatar | failed | too-big
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
  }
}

// One GIF at a time for the whole bot: each waits for the one before.
let queue = Promise.resolve();
function oneAtATime(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

// ffmpeg's arguments: avatar.gif under card.png, as out.gif.
export function gifArgs({ avatarFile, cardFile, outFile, background, grey, width = GIF_LIMITS.width, fps = GIF_LIMITS.fps }) {
  const size = CARD.height;
  const avatar = [
    `fps=${fps}`,
    `scale=${size}:${size}:force_original_aspect_ratio=increase`,
    `crop=${size}:${size}`,
    ...(grey ? ["hue=s=0"] : []),
    "format=rgba",
    `pad=${CARD.width}:${CARD.height}:0:0:color=${background.replace("#", "0x")}`,
  ].join(",");
  const filter = [
    `[0:v]${avatar}[a]`,
    `[a][1:v]overlay=0:0:format=auto,scale=${width}:-2:flags=lanczos,split[x][y]`,
    `[x]palettegen=max_colors=${GIF_LIMITS.colors}:stats_mode=diff[p]`,
    "[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  ].join(";");
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-t", String(GIF_LIMITS.seconds), "-i", avatarFile,
    "-i", cardFile,
    "-filter_complex", filter,
    "-t", String(GIF_LIMITS.seconds),
    "-loop", "0",
    "-y", outFile,
  ];
}

function runFfmpeg(args, { spawnImpl = spawn, timeoutMs = GIF_LIMITS.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors = (errors + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new QuoteGifError("failed", `ffmpeg stopped (${signal ?? code}): ${errors.trim()}`));
      }
    });
  });
}

// The GIF as a Buffer. `quote` is what renderQuoteCard takes; `animatedUrl`
// is the member's animated avatar (a .gif on Discord's CDN).
export async function renderQuoteGif(quote, rawStyle, animatedUrl, { fetchImpl, spawnImpl } = {}) {
  const style = normalizeStyle(rawStyle);
  const avatar = await fetchAvatar(animatedUrl, { fetchImpl, types: ["image/gif"], maxBytes: GIF_LIMITS.avatarBytes });
  if (!avatar) {
    throw new QuoteGifError("no-avatar");
  }
  const card = await renderQuoteCard(quote, style, { cutout: true });
  return oneAtATime(async () => {
    const folder = await mkdtemp(join(tmpdir(), "rabble-quote-"));
    try {
      const files = { avatarFile: join(folder, "avatar.gif"), cardFile: join(folder, "card.png"), outFile: join(folder, "out.gif") };
      await Promise.all([writeFile(files.avatarFile, avatar.bytes), writeFile(files.cardFile, card)]);
      const common = { ...files, background: THEMES[style.theme][style.light ? "light" : "dark"].background, grey: !style.color };
      await runFfmpeg(gifArgs(common), { spawnImpl });
      let gif = await readFile(files.outFile);
      if (gif.length > GIF_LIMITS.maxBytes) {
        await runFfmpeg(gifArgs({ ...common, width: GIF_LIMITS.smallWidth, fps: GIF_LIMITS.smallFps }), { spawnImpl });
        gif = await readFile(files.outFile);
      }
      if (gif.length > GIF_LIMITS.maxBytes) {
        throw new QuoteGifError("too-big");
      }
      return gif;
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  });
}
