// Turns SVG into PNG with resvg, compiled to WebAssembly (@resvg/resvg-wasm):
// nothing native to build or install on the server. The WebAssembly module
// can only be started once per process, so every picture the bot draws (the
// color list, quote cards) goes through here. Fonts are passed in by the
// caller; system fonts are never used, so pictures look the same everywhere.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

let ready;

// Loads the renderer once, on first use.
export function loadResvg() {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    const [{ initWasm, Resvg }, wasm] = await Promise.all([import("@resvg/resvg-wasm"), readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))]);
    await initWasm(wasm);
    return Resvg;
  })().catch((error) => {
    // Let the next call try again (a missing file is fixed by a deploy).
    ready = undefined;
    throw error;
  });
  return ready;
}

// The PNG (a Buffer) for `svg`, drawn with `fonts` (TrueType file Buffers).
export async function renderPng(svg, { fonts, defaultFontFamily }) {
  const Resvg = await loadResvg();
  const resvg = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily, loadSystemFonts: false } });
  try {
    const image = resvg.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

export const escapeXml = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);
