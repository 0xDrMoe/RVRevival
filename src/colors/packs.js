// Ready-made color lists, added with /color pack or from the dashboard. A pack
// only adds colors whose names the server doesn't have yet, up to MAX_COLORS.

export const PACKS = Object.freeze({
  // A full rainbow, each hue in a deep, a normal and a light shade, then greys.
  classic: [
    ["Deep Red", "#9b1c1c"], ["Red", "#e53935"], ["Light Red", "#ef8a8a"],
    ["Deep Orange", "#b3540f"], ["Orange", "#fb8c00"], ["Light Orange", "#ffbe7a"],
    ["Deep Yellow", "#a88a00"], ["Yellow", "#fdd835"], ["Light Yellow", "#fff59d"],
    ["Deep Lime", "#5f8a12"], ["Lime", "#9ccc3c"], ["Light Lime", "#d4ec9a"],
    ["Deep Green", "#1f7a3a"], ["Green", "#43a047"], ["Light Green", "#91d69a"],
    ["Deep Teal", "#00695c"], ["Teal", "#26a69a"], ["Light Teal", "#8fd8cf"],
    ["Deep Sky", "#0b6e99"], ["Sky", "#29b6f6"], ["Light Sky", "#9edcf8"],
    ["Deep Blue", "#173f99"], ["Blue", "#3d6fe0"], ["Light Blue", "#9db8f2"],
    ["Deep Violet", "#4a1f8f"], ["Violet", "#7e57c2"], ["Light Violet", "#bba3e6"],
    ["Deep Magenta", "#8e1a73"], ["Magenta", "#d040a8"], ["Light Magenta", "#eba3d8"],
    ["Deep Pink", "#a8175a"], ["Pink", "#ec5f99"], ["Light Pink", "#f7b3cf"],
    ["Deep Brown", "#4e2c17"], ["Brown", "#8d5a37"], ["Light Brown", "#c49a78"],
    ["White", "#f5f5f5"], ["Silver", "#bdbdbd"], ["Gray", "#8a8a8a"], ["Charcoal", "#4a4a4a"], ["Black", "#111111"],
  ],
  pastel: [
    ["Pastel Red", "#ffadad"], ["Pastel Peach", "#ffcfa8"], ["Pastel Yellow", "#fdffb6"], ["Pastel Mint", "#caffbf"],
    ["Pastel Aqua", "#a8f0e6"], ["Pastel Sky", "#9bf6ff"], ["Pastel Blue", "#a0c4ff"], ["Pastel Lavender", "#bdb2ff"],
    ["Pastel Lilac", "#e0b3ff"], ["Pastel Pink", "#ffc6ff"], ["Pastel Rose", "#ffb3c8"], ["Pastel Sand", "#eedcc4"],
  ],
  neon: [
    ["Neon Red", "#ff073a"], ["Neon Orange", "#ff6f00"], ["Neon Yellow", "#f5ff00"], ["Neon Green", "#39ff14"], ["Neon Mint", "#00ffa3"],
    ["Neon Cyan", "#00f0ff"], ["Neon Blue", "#1f51ff"], ["Neon Purple", "#bc13fe"], ["Neon Pink", "#ff10f0"], ["Neon Rose", "#ff2e88"],
  ],
  earth: [
    ["Clay", "#b5651d"], ["Terracotta", "#c8553d"], ["Ochre", "#cc8e35"], ["Sand", "#d9c09a"], ["Olive", "#708238"],
    ["Moss", "#5a7d3a"], ["Sage", "#9caf88"], ["Bark", "#5b3a29"], ["Slate", "#5d6d7e"], ["Stone", "#a39e93"],
  ],
  jewel: [
    ["Ruby", "#c0123f"], ["Garnet", "#8b1e3f"], ["Topaz", "#e8a317"], ["Citrine", "#e4d00a"], ["Emerald", "#0f9d58"],
    ["Jade", "#00a86b"], ["Aquamarine", "#2ec4b6"], ["Sapphire", "#0f52ba"], ["Amethyst", "#9966cc"], ["Tourmaline", "#d6336c"],
  ],
  mono: [
    ["Snow", "#fafafa"], ["Pearl", "#e0e0e0"], ["Ash", "#bdbdbd"], ["Smoke", "#9e9e9e"],
    ["Steel", "#757575"], ["Graphite", "#545454"], ["Onyx", "#2f2f2f"], ["Ink", "#121212"],
  ],
  spring: [
    ["Blossom", "#f7a8c4"], ["Tulip", "#e8467c"], ["Daffodil", "#ffd93d"], ["Fresh Grass", "#7ccc63"],
    ["Mint Leaf", "#98e3b8"], ["Robin Egg", "#8fd3e8"], ["Lilac", "#c8a2c8"], ["Lavender", "#a991d4"],
  ],
  summer: [
    ["Sunshine", "#ffcc00"], ["Mango", "#ff9f1c"], ["Watermelon", "#ff4d6d"], ["Coral", "#ff7f50"],
    ["Lagoon", "#00b4d8"], ["Ocean", "#0077b6"], ["Palm", "#2a9d8f"], ["Lemonade", "#fff275"],
  ],
  autumn: [
    ["Maple", "#c1440e"], ["Pumpkin", "#e66f17"], ["Harvest Gold", "#da9100"], ["Cranberry", "#9b1b30"],
    ["Cinnamon", "#a0522d"], ["Acorn", "#7b4b2a"], ["Forest", "#3e5c33"], ["Plum", "#6a2c4f"],
  ],
  winter: [
    ["Frost", "#dff3ff"], ["Ice", "#a5d8ff"], ["Glacier", "#74b9e8"], ["Midnight", "#1b2a4a"],
    ["Pine", "#1e5945"], ["Holly", "#a4161a"], ["Silver Bell", "#c0c7d1"], ["Twilight", "#5b4b8a"],
  ],
});

export const PACK_NAMES = Object.freeze(Object.keys(PACKS));
