import { describe, expect, it } from "vitest";
import {
  buildCurve,
  CURVE_PRESETS,
  InvalidFormula,
  MAX_CURVE_LEVEL,
  progressOnCurve,
  STANDARD_FORMULA,
  standardCurve,
  tryBuildCurve,
} from "../src/dashboard/public/levelCurve.js";
import { checkLeveling, curveFor, InvalidLeveling, levelForXp, levelProgress, MAX_LEVEL, normalizeLeveling, totalXpForLevel, xpToNextLevel } from "../src/leveling/config.js";

const steps = (formula, count = 4) => buildCurve(formula).steps.slice(0, count);
const serverChecks = { isRole: () => true, isRewardRole: () => true, isChannel: () => true };
const base = { enabled: true, announce: "here", announceChannelId: null, message: null, rewards: [], stackRewards: true, noXpChannelIds: [], noXpRoleIds: [] };

describe("level formulas", () => {
  it("matches the old standard curve exactly", () => {
    expect(MAX_CURVE_LEVEL).toBe(MAX_LEVEL);
    for (let level = 0; level < MAX_LEVEL; level += 1) {
      expect(standardCurve.steps[level]).toBe(xpToNextLevel(level));
    }
    expect(standardCurve.totals[0]).toBe(0);
    expect(standardCurve.totals[2]).toBe(255);
  });

  it("follows the usual order of operations", () => {
    expect(steps("1 + 2 * 3")[0]).toBe(7);
    expect(steps("(1 + 2) * 3")[0]).toBe(9);
    expect(steps("2^3^2")[0]).toBe(512); // right to left
    expect(steps("-2^2 + 10")[0]).toBe(6); // -(2^2)
    expect(steps("2^-1 * 10")[0]).toBe(5);
    expect(steps("10 % 4")[0]).toBe(2);
    expect(steps("100 + level * 10")).toEqual([100, 110, 120, 130]);
    expect(steps("LEVEL + 1")).toEqual([1, 2, 3, 4]);
  });

  it("knows the listed functions and rounds every step", () => {
    expect(steps("max(level, 2) * 10")).toEqual([20, 20, 20, 30]);
    expect(steps("min(100, 50, 75)")[0]).toBe(50);
    expect(steps("sqrt(level + 1) * 100")).toEqual([100, 141, 173, 200]);
    expect(steps("floor(level / 2) + 1")).toEqual([1, 1, 2, 2]);
    expect(steps("ceil(level / 2) + 1")).toEqual([1, 2, 2, 3]);
    expect(steps("round(ln(level + 1) * 10) + 1")[1]).toBe(8);
    expect(steps("log10(level + 10) * 100")[0]).toBe(100);
    expect(steps("abs(level - 2) + 1")).toEqual([3, 2, 1, 2]);
    expect(steps("33.4")[0]).toBe(33);
  });

  it("explains bad formulas instead of running them", () => {
    const bad = [
      ["", /Write a formula/],
      ["level +", /ends too early/],
      ["(level + 1", /never closed/],
      ["level + 1)", /wrong place/],
      ["foo(level)", /isn't known/],
      ["sqrt level", /Put brackets/],
      ["sqrt(1, 2)", /takes 1 value/],
      ["level; process.exit()", /can't be used/],
      ["constructor", /isn't known/],
      ["__proto__", /can't be used/],
      ["level - 100", /at least 1 XP/],
      ["1 / level", /doesn't give a number/],
      ["sqrt(-1 - level)", /doesn't give a number/],
      ["2^level", /more than 10,000,000 XP/],
      ["x".repeat(201), /under 200 characters/],
      [`${"(".repeat(30)}1${")".repeat(30)}`, /too many brackets/],
    ];
    for (const [formula, message] of bad) {
      expect(() => buildCurve(formula), formula).toThrow(InvalidFormula);
      expect(() => buildCurve(formula), formula).toThrow(message);
      expect(tryBuildCurve(formula)).toBeNull();
    }
  });

  it("names the level where a formula goes wrong", () => {
    expect(() => buildCurve("100 - level")).toThrow("At level 100 the formula gives 0 XP");
  });

  it("has presets that all work, standard first", () => {
    expect(CURVE_PRESETS[0]).toEqual({ id: "standard", formula: STANDARD_FORMULA });
    for (const preset of CURVE_PRESETS) {
      expect(() => buildCurve(preset.formula), preset.id).not.toThrow();
    }
  });

  it("finds the level for any amount of XP", () => {
    const curve = buildCurve("100");
    expect(progressOnCurve(curve, 0)).toEqual({ level: 0, current: 0, needed: 100 });
    expect(progressOnCurve(curve, 250)).toEqual({ level: 2, current: 50, needed: 100 });
    expect(progressOnCurve(curve, -5).level).toBe(0);
    expect(progressOnCurve(curve, Number.NaN).level).toBe(0);
    expect(progressOnCurve(curve, 1e12).level).toBe(MAX_CURVE_LEVEL);
    for (const level of [1, 7, 199, 500]) {
      expect(progressOnCurve(standardCurve, standardCurve.totals[level]).level).toBe(level);
      expect(progressOnCurve(standardCurve, standardCurve.totals[level] - 1).level).toBe(level - 1);
    }
  });
});

describe("leveling settings with rates and a curve", () => {
  it("defaults to 15-25 XP, a 60 second cooldown, 10 voice XP and the standard curve", () => {
    expect(normalizeLeveling({})).toMatchObject({ xpMin: 15, xpMax: 25, cooldownSeconds: 60, voiceXpPerMinute: 10, levelFormula: null });
  });

  it("keeps saved values in range and drops broken formulas", () => {
    expect(normalizeLeveling({ xpMin: 40, xpMax: 10, cooldownSeconds: 5, voiceXpPerMinute: 2.5, levelFormula: "1 / 0" })).toMatchObject({
      xpMin: 10,
      xpMax: 40,
      cooldownSeconds: 60,
      voiceXpPerMinute: 10,
      levelFormula: null,
    });
    expect(normalizeLeveling({ levelFormula: ` ${STANDARD_FORMULA} ` }).levelFormula).toBeNull();
    expect(normalizeLeveling({ levelFormula: " 100 " }).levelFormula).toBe("100");
  });

  it("refuses rates out of range and bad formulas from the dashboard", () => {
    const refuse = (changes, message) => expect(() => checkLeveling({ ...base, ...changes }, serverChecks)).toThrow(message);
    refuse({ xpMin: 0 }, /1 to 100/);
    refuse({ xpMax: 101 }, /1 to 100/);
    refuse({ xpMin: 1.5 }, /whole numbers/);
    refuse({ xpMin: 30, xpMax: 20 }, /can't be more than the highest/);
    refuse({ cooldownSeconds: 9 }, /10 to 600 seconds/);
    refuse({ voiceXpPerMinute: 51 }, /1 to 50/);
    refuse({ levelFormula: "level +" }, /Level formula: The formula ends too early/);
    refuse({ levelFormula: 5 }, InvalidLeveling);
    expect(checkLeveling({ ...base, xpMin: 1, xpMax: 100, cooldownSeconds: 600, voiceXpPerMinute: 50, levelFormula: "100 + 40 * level" }, serverChecks)).toMatchObject({
      xpMin: 1,
      xpMax: 100,
      cooldownSeconds: 600,
      voiceXpPerMinute: 50,
      levelFormula: "100 + 40 * level",
    });
    // Older pages send none of these.
    expect(checkLeveling(base, serverChecks)).toMatchObject({ xpMin: 15, levelFormula: null });
  });

  it("works levels out on the server's curve", () => {
    const config = normalizeLeveling({ levelFormula: "100" });
    expect(totalXpForLevel(5, config)).toBe(500);
    expect(levelForXp(499, config)).toBe(4);
    expect(levelProgress(650, config)).toEqual({ level: 6, current: 50, needed: 100 });
    expect(levelForXp(499)).toBe(levelForXp(499, normalizeLeveling({})));
    expect(curveFor("100")).toBe(curveFor("100")); // built once
    expect(curveFor("broken (")).toBe(standardCurve);
  });
});
