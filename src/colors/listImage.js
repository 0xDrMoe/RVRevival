// The color list as a picture: every color numbered and written in its own
// colour, in up to three columns on a transparent background, so it reads on
// Discord's dark and light themes. Gradient colors are drawn as gradients.
//
// The picture is built as SVG and turned into a PNG by resvg, compiled to
// WebAssembly (@resvg/resvg-wasm): nothing native to build or install on the
// server. The font (Noto Sans Bold, SIL Open Font License) ships in
// src/colors/fonts, so the picture looks the same everywhere. Characters the
// font can't draw (emoji, Chinese, Japanese...) are left out of the picture.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { readFontMetrics } from "./fontMetrics.js";

const FONT_FILE = new URL("./fonts/NotoSans-Bold.ttf", import.meta.url);
const FONT_FAMILY = "Noto Sans";

export const LAYOUT = Object.freeze({
  fontSize: 36,
  rowHeight: 57,
  padding: 16,
  columnGap: 40,
  // A column is never wider than this; longer names end in "…".
  maxColumnWidth: 430,
  maxColumns: 3,
});

let ready;

// Loads the font and the WebAssembly renderer once, on first use.
function load() {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    const [{ initWasm, Resvg }, wasm, font] = await Promise.all([
      import("@resvg/resvg-wasm"),
      readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")),
      readFile(FONT_FILE),
    ]);
    await initWasm(wasm);
    return { Resvg, font, metrics: readFontMetrics(font) };
  })().catch((error) => {
    // Let the next call try again (a missing file is fixed by a deploy).
    ready = undefined;
    throw error;
  });
  return ready;
}

const escapeXml = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);

// The label a color gets: "3. Gold", without characters the font lacks, cut
// with "…" to fit `maxWidth`.
// A name with nothing the font can draw shows `fallback` (the colour's hex).
export function fitLabel(number, name, metrics, { fontSize, maxColumnWidth } = LAYOUT, fallback = "?") {
  const drawable = [...name].filter((char) => metrics.has(char)).join("").replace(/\s+/g, " ").trim();
  const prefix = `${number}. `;
  let text = drawable || fallback;
  if (metrics.width(prefix + text, fontSize) <= maxColumnWidth) {
    return prefix + text;
  }
  const chars = [...text];
  while (chars.length > 1 && metrics.width(`${prefix}${chars.join("").trimEnd()}…`, fontSize) > maxColumnWidth) {
    chars.pop();
  }
  text = `${chars.join("").trimEnd()}…`;
  return prefix + text;
}

// How many columns: one for a short list, three for a long one.
export const columnsFor = (count) => (count <= 6 ? 1 : count <= 16 ? 2 : LAYOUT.maxColumns);

// The SVG for `colors` ([{ name, hex, hex2 }], color 1 first), and its size.
export function buildListSvg(colors, metrics, layout = LAYOUT) {
  const columns = columnsFor(colors.length);
  const rows = Math.max(1, Math.ceil(colors.length / columns));
  const labels = colors.map((color, index) => ({ ...color, text: fitLabel(index + 1, color.name, metrics, layout, color.hex) }));
  // Each column as wide as its widest label, so short lists stay compact.
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.ceil(Math.max(0, ...labels.filter((_, index) => index % columns === column).map((label) => metrics.width(label.text, layout.fontSize)))),
  );
  const width = layout.padding * 2 + widths.reduce((sum, value) => sum + value, 0) + layout.columnGap * (columns - 1);
  const height = layout.padding * 2 + rows * layout.rowHeight;
  const gradients = [];
  const texts = labels.map((label, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = layout.padding + widths.slice(0, column).reduce((sum, value) => sum + value, 0) + layout.columnGap * column;
    // The baseline, about three quarters down the row.
    const y = layout.padding + row * layout.rowHeight + Math.round(layout.rowHeight * 0.72);
    let fill = label.hex;
    if (label.hex2) {
      gradients.push(`<linearGradient id="g${index}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${label.hex}"/><stop offset="1" stop-color="${label.hex2}"/></linearGradient>`);
      fill = `url(#g${index})`;
    }
    return `<text x="${x}" y="${y}" fill="${fill}">${escapeXml(label.text)}</text>`;
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    gradients.length > 0 ? `<defs>${gradients.join("")}</defs>` : "",
    `<g font-family="${FONT_FAMILY}" font-weight="700" font-size="${layout.fontSize}">`,
    ...texts,
    "</g></svg>",
  ].join("");
  return { svg, width, height };
}

// The PNG (a Buffer) for the color list. Throws if there are no colors.
export async function renderColorList(colors) {
  if (colors.length === 0) {
    throw new Error("No colors to draw");
  }
  const { Resvg, font, metrics } = await load();
  const { svg } = buildListSvg(colors, metrics);
  const resvg = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: FONT_FAMILY, loadSystemFonts: false } });
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

// For tests and the dashboard preview: the font's metrics without the renderer.
export async function listFontMetrics() {
  return readFontMetrics(await readFile(FONT_FILE));
}
