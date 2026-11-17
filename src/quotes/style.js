// How a quote card looks (quotes/card.js), saved with each quote and changed
// with the buttons and menus under the card:
//
//   theme   a colour theme from THEMES ("mono" is black and white)
//   light   true: the light version of the theme (dark text on a light card)
//   color   true: the avatar in colour, false: in greyscale
//   bold    true: the quote in the font's bold weight
//   font    a font from FONTS
//
// Servers pick the look new cards start with on the dashboard's Quotes page.

// Every theme has a dark and a light version: the card's background, the
// quote's colour and the colour of the name, username and mark under it.
export const THEMES = Object.freeze({
  mono: { dark: { background: "#000000", text: "#ffffff", muted: "#a3a3a3" }, light: { background: "#ffffff", text: "#111111", muted: "#5c5c5c" } },
  rabble: { dark: { background: "#1c1030", text: "#fbeaff", muted: "#d59cf0" }, light: { background: "#fbf0ff", text: "#3a1458", muted: "#9b4fbf" } },
  ocean: { dark: { background: "#071a2c", text: "#e4f3ff", muted: "#7fb6dd" }, light: { background: "#eaf6ff", text: "#0b2f4d", muted: "#3f7aa6" } },
  forest: { dark: { background: "#0c1d12", text: "#e6f6e9", muted: "#86bf93" }, light: { background: "#eef8ef", text: "#163b20", muted: "#4d8a5c" } },
  sunset: { dark: { background: "#2a0f0a", text: "#ffece2", muted: "#f2a07e" }, light: { background: "#fff1ea", text: "#5a1d0c", muted: "#c0603b" } },
  rose: { dark: { background: "#2b0b19", text: "#ffe8f1", muted: "#f08bb4" }, light: { background: "#fff0f5", text: "#5b1030", muted: "#c04b7b" } },
});

// Fonts bundled in src/quotes/fonts (SIL Open Font License). `italic` is
// used for the "- Name" line when the font has one; `bold` is null for a
// font with a single weight (the bold button then does nothing).
export const FONTS = Object.freeze({
  sans: { family: "Noto Sans", regular: "NotoSans-Regular.ttf", bold: "../../colors/fonts/NotoSans-Bold.ttf", italic: "NotoSans-Italic.ttf" },
  serif: { family: "Noto Serif", regular: "NotoSerif-Regular.ttf", bold: "NotoSerif-Bold.ttf", italic: "NotoSerif-Italic.ttf" },
  mono: { family: "Noto Sans Mono", regular: "NotoSansMono-Regular.ttf", bold: "NotoSansMono-Bold.ttf", italic: null },
  hand: { family: "Kalam", regular: "Kalam-Regular.ttf", bold: "Kalam-Bold.ttf", italic: null },
  round: { family: "Varela Round", regular: "VarelaRound-Regular.ttf", bold: null, italic: null },
});

export const THEME_NAMES = Object.freeze(Object.keys(THEMES));
export const FONT_NAMES = Object.freeze(Object.keys(FONTS));

export const DEFAULT_STYLE = Object.freeze({ theme: "mono", light: false, color: false, bold: false, font: "sans" });

const STYLE_KEYS = Object.keys(DEFAULT_STYLE);

// A saved or sent style with every default filled in. `base` is the
// server's default look. Never throws.
export function normalizeStyle(saved, base = DEFAULT_STYLE) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const fallback = base === DEFAULT_STYLE ? DEFAULT_STYLE : normalizeStyle(base);
  return {
    theme: THEME_NAMES.includes(value.theme) ? value.theme : fallback.theme,
    light: typeof value.light === "boolean" ? value.light : fallback.light,
    color: typeof value.color === "boolean" ? value.color : fallback.color,
    bold: typeof value.bold === "boolean" ? value.bold : fallback.bold,
    font: FONT_NAMES.includes(value.font) ? value.font : fallback.font,
  };
}

// Whether a style is exactly the defaults (saved as no value).
export const isDefaultStyle = (style) => STYLE_KEYS.every((key) => style[key] === DEFAULT_STYLE[key]);

// For the logs: "mono, dark, greyscale avatar, regular, sans".
export function describeStyle(value) {
  const style = normalizeStyle(value);
  return [style.theme, style.light ? "light" : "dark", style.color ? "colour avatar" : "greyscale avatar", style.bold ? "bold" : "regular", style.font].join(", ");
}
