// Just enough of a TrueType reader to measure text: which characters the font
// has (cmap) and how wide each one is (hmtx). The color list picture uses it
// to fit names in their column and to drop characters the font can't draw.
// Kerning is ignored, so widths are a pixel or two generous at most.

function tables(view) {
  const count = view.getUint16(4);
  const found = {};
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    found[tag] = view.getUint32(at + 8);
  }
  return found;
}

// code point -> glyph index, from the best Unicode subtable (format 12, else 4).
function readCmap(view, start) {
  const count = view.getUint16(start + 2);
  const subtables = [];
  for (let index = 0; index < count; index += 1) {
    const at = start + 4 + index * 8;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const offset = start + view.getUint32(at + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode) {
      subtables.push({ offset, format: view.getUint16(offset) });
    }
  }
  const glyphs = new Map();
  const full = subtables.find((table) => table.format === 12);
  if (full) {
    const groups = view.getUint32(full.offset + 12);
    for (let index = 0; index < groups; index += 1) {
      const at = full.offset + 16 + index * 12;
      const first = view.getUint32(at);
      const last = view.getUint32(at + 4);
      const glyph = view.getUint32(at + 8);
      for (let code = first; code <= last; code += 1) {
        glyphs.set(code, glyph + code - first);
      }
    }
    return glyphs;
  }
  const basic = subtables.find((table) => table.format === 4);
  if (!basic) {
    throw new Error("The font has no Unicode character map");
  }
  const at = basic.offset;
  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let index = 0; index < segments; index += 1) {
    const end = view.getUint16(ends + index * 2);
    const begin = view.getUint16(starts + index * 2);
    const delta = view.getInt16(deltas + index * 2);
    const rangeAt = ranges + index * 2;
    const range = view.getUint16(rangeAt);
    for (let code = begin; code <= end && code !== 0xffff; code += 1) {
      let glyph;
      if (range === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const raw = view.getUint16(rangeAt + range + (code - begin) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) {
        glyphs.set(code, glyph);
      }
    }
  }
  return glyphs;
}

// Reads a .ttf file's bytes. Returns { has(char), width(text, size) }.
export function readFontMetrics(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = tables(view);
  for (const tag of ["head", "hhea", "hmtx", "cmap"]) {
    if (found[tag] === undefined) {
      throw new Error(`The font has no ${tag} table`);
    }
  }
  const unitsPerEm = view.getUint16(found.head + 18);
  const longMetrics = view.getUint16(found.hhea + 34);
  const advance = (glyph) => view.getUint16(found.hmtx + Math.min(glyph, longMetrics - 1) * 4);
  const glyphs = readCmap(view, found.cmap);
  const missingWidth = advance(0);

  return {
    has: (char) => glyphs.has(char.codePointAt(0)),
    // Width in pixels at `size` px.
    width(text, size) {
      let units = 0;
      for (const char of text) {
        const glyph = glyphs.get(char.codePointAt(0));
        units += glyph === undefined ? missingWidth : advance(glyph);
      }
      return (units / unitsPerEm) * size;
    },
  };
}
