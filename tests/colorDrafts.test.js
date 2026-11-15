import { describe, expect, it } from "vitest";
import { checkNewColors, insertColors, MAX_DRAFTS, nearestName, parseColorLines } from "../src/colors/drafts.js";
import { MAX_COLORS } from "../src/colors/colors.js";

const color = (name, hex) => ({ roleId: `7000000000000000${String(name.length).padStart(2, "0")}`, name, hex, hex2: null, made: true, addedAt: 0 });

describe("new color drafts", () => {
  it("reads pasted lines in any order, with or without #", () => {
    expect(parseColorLines("Sky #4fc3f7\n\n  #ff7043 #ab47bc Sunset \nff0000\nDeep Sea, 123456\n#1 #2 #3 Too many")).toEqual([
      { line: 1, name: "Sky", hex: "#4fc3f7", hex2: null, extra: false },
      { line: 3, name: "Sunset", hex: "#ff7043", hex2: "#ab47bc", extra: false },
      { line: 4, name: "", hex: "ff0000", hex2: null, extra: false },
      { line: 5, name: "Deep Sea", hex: "123456", hex2: null, extra: false },
      { line: 6, name: "Too many", hex: "#1", hex2: "#2", extra: true },
    ]);
    // A word that only looks like hex ("bad", "Beef") stays part of the name.
    expect(parseColorLines("Bad Beef #abc")[0]).toMatchObject({ name: "Bad Beef", hex: "#abc" });
  });

  it("names unnamed colors after the closest pack colour, numbering repeats", () => {
    const { colors, problems } = checkNewColors([color("Red", "#e53935")], [{ hex: "#e53935" }, { hex: "#e53936" }, { name: "  Sky  ", hex: "#4fc3f7" }]);
    expect(problems).toEqual([]);
    expect(colors.map((entry) => entry.name)).toEqual(["Red 2", "Red 3", "Sky"]);
    expect(nearestName("#e53935")).toBe("Red");
  });

  it("reports every problem with its index and keeps the rest", () => {
    const list = [color("Sky", "#4fc3f7")];
    const { colors, problems } = checkNewColors(list, [
      { name: "A", hex: "nope" },
      { name: "B", hex: "#fff", hex2: "nope" },
      { name: "C", hex: "#fff", hex2: "#000" },
      { name: "sky", hex: "#fff" },
      { name: "D", hex: "#fff" },
      { name: "d", hex: "#000" },
      { name: "E", hex: "#1", hex2: "#2", extra: true },
    ]);
    expect(problems.map((problem) => [problem.index, problem.problem])).toEqual([
      [0, "hex"],
      [1, "hex2"],
      [2, "gradient"],
      [3, "name-taken"],
      [5, "duplicate"],
      [6, "extra"],
    ]);
    expect(colors).toEqual([{ name: "D", hex: "#ffffff", hex2: null }]);
  });

  it("keeps gradients only where allowed, and drops a gradient to itself", () => {
    expect(checkNewColors([], [{ name: "Fade", hex: "#f00", hex2: "#00f" }], { gradients: true }).colors[0]).toEqual({ name: "Fade", hex: "#ff0000", hex2: "#0000ff" });
    expect(checkNewColors([], [{ name: "Same", hex: "#f00", hex2: "#ff0000" }], { gradients: true }).colors[0].hex2).toBeNull();
  });

  it("stops at the list's room and at the draft limit", () => {
    const full = Array.from({ length: MAX_COLORS - 1 }, (_, index) => ({ ...color(`C${index}`, "#000000"), roleId: String(700000000000000000n + BigInt(index)) }));
    const { colors, problems } = checkNewColors(full, [{ name: "X", hex: "#111" }, { name: "Y", hex: "#222" }]);
    expect(colors.map((entry) => entry.name)).toEqual(["X"]);
    expect(problems).toEqual([{ index: 1, problem: "full" }]);
    const many = Array.from({ length: MAX_DRAFTS + 5 }, (_, index) => ({ name: `N${index}`, hex: "#123456" }));
    expect(checkNewColors([], many).colors).toHaveLength(MAX_DRAFTS);
  });

  it("inserts at a position, or at the end", () => {
    const list = ["a", "b", "c"];
    expect(insertColors(list, ["x", "y"], 1)).toEqual(["x", "y", "a", "b", "c"]);
    expect(insertColors(list, ["x"], 3)).toEqual(["a", "b", "x", "c"]);
    expect(insertColors(list, ["x"], 99)).toEqual(["a", "b", "c", "x"]);
    expect(insertColors(list, ["x"], null)).toEqual(["a", "b", "c", "x"]);
    expect(insertColors(list, ["x"], 0)).toEqual(["a", "b", "c", "x"]);
  });
});
