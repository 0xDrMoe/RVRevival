// A server's leveling settings, saved as one JSON object (Setting.LEVELING),
// and the level math.
//
// normalizeLeveling() reads a saved value, filling in defaults for anything
// missing or invalid. checkLeveling() is strict: the dashboard uses it to
// refuse bad input. Leveling is off until an admin turns it on.
//
// The level curve (how much XP each level takes) lives in
// dashboard/public/levelCurve.js, shared with the dashboard's graph.

import { buildCurve, InvalidFormula, MAX_FORMULA_LENGTH, progressOnCurve, STANDARD_FORMULA, standardCurve, tryBuildCurve } from "../dashboard/public/levelCurve.js";

import { variableError } from "../dashboard/public/variables.js";

export const Announce = Object.freeze({
  HERE: "here", // in the channel where they leveled up
  CHANNEL: "channel", // in one chosen channel
  DM: "dm", // privately
  OFF: "off",
});
export const ANNOUNCE_MODES = Object.values(Announce);

export const MAX_LEVEL = 500;
export const MAX_REWARDS = 25;
export const MAX_NO_XP_CHANNELS = 50;
export const MAX_NO_XP_ROLES = 25;
export const MAX_LEVEL_MESSAGE_LENGTH = 500;

// By default each message is worth 15 to 25 XP, at most once a minute per
// member, like most leveling bots, so spamming doesn't pay. Servers can change
// these within the XP_LIMITS ranges.
export const MIN_XP_PER_MESSAGE = 15;
export const MAX_XP_PER_MESSAGE = 25;
export const XP_COOLDOWN_MS = 60 * 1000;
// Voice XP: per minute in a voice channel with at least one other person,
// not deafened and not in the AFK channel.
export const VOICE_XP_PER_MINUTE = 10;
// The ranges servers may pick from: XP per message (lowest and highest), the
// seconds between messages that earn XP, and voice XP per minute.
export const XP_LIMITS = Object.freeze({
  xpPerMessage: Object.freeze({ min: 1, max: 100 }),
  cooldownSeconds: Object.freeze({ min: 10, max: 600 }),
  voiceXpPerMinute: Object.freeze({ min: 1, max: 50 }),
});
export const MAX_XP_COOLDOWN_MS = XP_LIMITS.cooldownSeconds.max * 1000;
export { MAX_FORMULA_LENGTH, STANDARD_FORMULA };
// XP boosts for Server Boosters and chosen roles. A member gets the highest
// boost they qualify for; boosts don't multiply each other.
export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 5;
export const MAX_ROLE_MULTIPLIERS = 10;

export const DEFAULT_LEVELING = Object.freeze({
  enabled: false,
  announce: Announce.HERE,
  announceChannelId: null,
  message: null,
  rewards: [],
  // true: members keep every reward role they reached; false: only the highest.
  stackRewards: true,
  noXpChannelIds: [],
  noXpRoleIds: [],
  voiceXp: false,
  boosterMultiplier: 1,
  roleMultipliers: [],
  xpMin: MIN_XP_PER_MESSAGE,
  xpMax: MAX_XP_PER_MESSAGE,
  cooldownSeconds: XP_COOLDOWN_MS / 1000,
  voiceXpPerMinute: VOICE_XP_PER_MINUTE,
  // null: the standard curve. Otherwise a formula (see levelCurve.js).
  levelFormula: null,
});

const inRange = (value, { min, max }) => Number.isInteger(value) && value >= min && value <= max;
const orDefault = (value, limits, fallback) => (inRange(value, limits) ? value : fallback);

const isId = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
const idList = (value, max) => (Array.isArray(value) ? [...new Set(value.filter(isId))].slice(0, max) : []);
const isLevel = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_LEVEL;
// Boosts go in steps of 0.1, from 1 (none) to 5.
export const isMultiplier = (value) =>
  typeof value === "number" && value >= MIN_MULTIPLIER && value <= MAX_MULTIPLIER && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
const roundMultiplier = (value) => Math.round(value * 10) / 10;

// Role boosts above 1, one per role, highest first.
export function cleanRoleMultipliers(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const byRole = new Map();
  for (const entry of list) {
    if (entry && isId(entry.roleId) && isMultiplier(entry.multiplier) && entry.multiplier > 1 && !byRole.has(entry.roleId)) {
      byRole.set(entry.roleId, { roleId: entry.roleId, multiplier: roundMultiplier(entry.multiplier) });
    }
  }
  return [...byRole.values()].sort((a, b) => b.multiplier - a.multiplier).slice(0, MAX_ROLE_MULTIPLIERS);
}

// Rewards sorted by level, one role per level and each role once.
export function cleanRewards(rewards) {
  if (!Array.isArray(rewards)) {
    return [];
  }
  const byLevel = new Map();
  const roles = new Set();
  for (const reward of rewards) {
    if (reward && isLevel(reward.level) && isId(reward.roleId) && !byLevel.has(reward.level) && !roles.has(reward.roleId)) {
      byLevel.set(reward.level, { level: reward.level, roleId: reward.roleId });
      roles.add(reward.roleId);
    }
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level).slice(0, MAX_REWARDS);
}

export function normalizeLeveling(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const message = typeof value.message === "string" ? value.message.trim().slice(0, MAX_LEVEL_MESSAGE_LENGTH) : "";
  return {
    enabled: value.enabled === true,
    announce: ANNOUNCE_MODES.includes(value.announce) ? value.announce : DEFAULT_LEVELING.announce,
    announceChannelId: isId(value.announceChannelId) ? value.announceChannelId : null,
    message: message || null,
    rewards: cleanRewards(value.rewards),
    stackRewards: value.stackRewards !== false,
    noXpChannelIds: idList(value.noXpChannelIds, MAX_NO_XP_CHANNELS),
    noXpRoleIds: idList(value.noXpRoleIds, MAX_NO_XP_ROLES),
    voiceXp: value.voiceXp === true,
    boosterMultiplier: isMultiplier(value.boosterMultiplier) ? roundMultiplier(value.boosterMultiplier) : 1,
    roleMultipliers: cleanRoleMultipliers(value.roleMultipliers),
    ...normalizeXpRates(value),
    levelFormula: normalizeFormula(value.levelFormula),
  };
}

// XP per message (lowest <= highest), cooldown and voice XP, each in its range.
function normalizeXpRates(value) {
  let xpMin = orDefault(value.xpMin, XP_LIMITS.xpPerMessage, DEFAULT_LEVELING.xpMin);
  let xpMax = orDefault(value.xpMax, XP_LIMITS.xpPerMessage, DEFAULT_LEVELING.xpMax);
  if (xpMin > xpMax) {
    [xpMin, xpMax] = [xpMax, xpMin];
  }
  return {
    xpMin,
    xpMax,
    cooldownSeconds: orDefault(value.cooldownSeconds, XP_LIMITS.cooldownSeconds, DEFAULT_LEVELING.cooldownSeconds),
    voiceXpPerMinute: orDefault(value.voiceXpPerMinute, XP_LIMITS.voiceXpPerMinute, DEFAULT_LEVELING.voiceXpPerMinute),
  };
}

// A saved formula that still works, or null for the standard curve.
function normalizeFormula(formula) {
  if (typeof formula !== "string") {
    return null;
  }
  const trimmed = formula.trim();
  if (trimmed === "" || trimmed === STANDARD_FORMULA) {
    return null;
  }
  return curveFor(trimmed) === standardCurve ? null : trimmed;
}

// The XP boost for a member: the highest of the booster boost (when they boost
// the server) and their roles' boosts. 1 means none.
export function multiplierFor(config, member) {
  let best = member?.premiumSince ? config.boosterMultiplier : 1;
  for (const { roleId, multiplier } of config.roleMultipliers) {
    if (multiplier > best && member?.roles?.cache?.has(roleId)) {
      best = multiplier;
    }
  }
  return best;
}

export class InvalidLeveling extends Error {
  name = "InvalidLeveling";
}

// Checks leveling settings from the dashboard. `isRole(id)`, `isRewardRole(id)`
// (a role the bot may give) and `isChannel(id)` check against the server.
export function checkLeveling(value, { isRole, isRewardRole, isChannel }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidLeveling("Send the leveling settings as an object.");
  }
  if (typeof value.enabled !== "boolean" || typeof value.stackRewards !== "boolean") {
    throw new InvalidLeveling("Leveling needs on or off for itself and for keeping rewards.");
  }
  if (!ANNOUNCE_MODES.includes(value.announce)) {
    throw new InvalidLeveling("Pick where level-ups are announced.");
  }
  if (value.announce === Announce.CHANNEL && !isChannel(value.announceChannelId)) {
    throw new InvalidLeveling("Pick a text channel for level-up messages.");
  }
  if (value.message !== null && (typeof value.message !== "string" || value.message.trim().length > MAX_LEVEL_MESSAGE_LENGTH)) {
    throw new InvalidLeveling(`Keep the level-up message under ${MAX_LEVEL_MESSAGE_LENGTH} characters.`);
  }
  const variableProblem = value.message !== null && variableError(value.message, "levelUp");
  if (variableProblem) {
    throw new InvalidLeveling(variableProblem);
  }
  if (!Array.isArray(value.rewards) || value.rewards.length > MAX_REWARDS) {
    throw new InvalidLeveling(`Add at most ${MAX_REWARDS} level rewards.`);
  }
  for (const reward of value.rewards) {
    if (!isLevel(reward?.level)) {
      throw new InvalidLeveling(`Reward levels go from 1 to ${MAX_LEVEL}.`);
    }
    if (!isRewardRole(reward.roleId)) {
      throw new InvalidLeveling("Pick reward roles the bot can give: below its own role, not bot roles or roles with moderator permissions.");
    }
  }
  const levels = value.rewards.map((reward) => reward.level);
  const roles = value.rewards.map((reward) => reward.roleId);
  if (new Set(levels).size !== levels.length || new Set(roles).size !== roles.length) {
    throw new InvalidLeveling("Use each level and each reward role once.");
  }
  const lists = [
    [value.noXpChannelIds, MAX_NO_XP_CHANNELS, isChannel, "channels"],
    [value.noXpRoleIds, MAX_NO_XP_ROLES, isRole, "roles"],
  ];
  for (const [list, max, check, what] of lists) {
    if (!Array.isArray(list) || list.length > max || !list.every(check)) {
      throw new InvalidLeveling(`Pick at most ${max} ${what} from this server that earn no XP.`);
    }
  }
  if (value.voiceXp !== undefined && typeof value.voiceXp !== "boolean") {
    throw new InvalidLeveling("Voice XP needs on or off.");
  }
  if (value.boosterMultiplier !== undefined && !isMultiplier(value.boosterMultiplier)) {
    throw new InvalidLeveling(`XP boosts go from ${MIN_MULTIPLIER} to ${MAX_MULTIPLIER}, in steps of 0.1.`);
  }
  const boosts = value.roleMultipliers ?? [];
  if (!Array.isArray(boosts) || boosts.length > MAX_ROLE_MULTIPLIERS) {
    throw new InvalidLeveling(`Add at most ${MAX_ROLE_MULTIPLIERS} role XP boosts.`);
  }
  for (const boost of boosts) {
    if (!isRole(boost?.roleId) || !isMultiplier(boost.multiplier) || boost.multiplier <= 1) {
      throw new InvalidLeveling(`Each role XP boost needs a role from this server and a boost above 1, up to ${MAX_MULTIPLIER}.`);
    }
  }
  if (new Set(boosts.map((boost) => boost.roleId)).size !== boosts.length) {
    throw new InvalidLeveling("Use each role once in XP boosts.");
  }
  checkXpRates(value);
  if (value.levelFormula !== undefined && value.levelFormula !== null) {
    if (typeof value.levelFormula !== "string" || value.levelFormula.length > MAX_FORMULA_LENGTH) {
      throw new InvalidLeveling(`Keep the level formula under ${MAX_FORMULA_LENGTH} characters.`);
    }
    if (value.levelFormula.trim() !== "") {
      try {
        buildCurve(value.levelFormula);
      } catch (error) {
        if (error instanceof InvalidFormula) {
          throw new InvalidLeveling(`Level formula: ${error.message}`);
        }
        throw error;
      }
    }
  }
  return normalizeLeveling({
    ...value,
    announceChannelId: value.announce === Announce.CHANNEL ? value.announceChannelId : null,
  });
}

// The XP rates are optional (older pages don't send them), but when sent they
// must be whole numbers in range.
function checkXpRates(value) {
  const { xpPerMessage, cooldownSeconds, voiceXpPerMinute } = XP_LIMITS;
  for (const key of ["xpMin", "xpMax"]) {
    if (value[key] !== undefined && !inRange(value[key], xpPerMessage)) {
      throw new InvalidLeveling(`XP per message goes from ${xpPerMessage.min} to ${xpPerMessage.max}, in whole numbers.`);
    }
  }
  if (value.xpMin !== undefined && value.xpMax !== undefined && value.xpMin > value.xpMax) {
    throw new InvalidLeveling("The lowest XP per message can't be more than the highest.");
  }
  if (value.cooldownSeconds !== undefined && !inRange(value.cooldownSeconds, cooldownSeconds)) {
    throw new InvalidLeveling(`The XP cooldown goes from ${cooldownSeconds.min} to ${cooldownSeconds.max} seconds.`);
  }
  if (value.voiceXpPerMinute !== undefined && !inRange(value.voiceXpPerMinute, voiceXpPerMinute)) {
    throw new InvalidLeveling(`Voice XP goes from ${voiceXpPerMinute.min} to ${voiceXpPerMinute.max} a minute.`);
  }
}

// --- Level math --------------------------------------------------------------------

// Built curves by formula, so each one is worked out once. A bad formula maps
// to the standard curve. The cache is small: one entry per distinct formula.
const curves = new Map();
const MAX_CACHED_CURVES = 200;

export function curveFor(formula) {
  if (!formula) {
    return standardCurve;
  }
  let curve = curves.get(formula);
  if (!curve) {
    curve = tryBuildCurve(formula) ?? standardCurve;
    if (curves.size >= MAX_CACHED_CURVES) {
      curves.delete(curves.keys().next().value);
    }
    curves.set(formula, curve);
  }
  return curve;
}

// The curve a server uses, from its (normalized) leveling settings.
export const curveOf = (config) => curveFor(config?.levelFormula ?? null);

// The standard curve's XP from `level` to the next one: 100, 155, 220, 295…
// so each level takes a little longer than the last.
export const xpToNextLevel = (level) => 5 * level * level + 50 * level + 100;

// Total XP needed to reach `level` from zero, on the server's curve (`config`
// is its leveling settings; leave it out for the standard curve).
export function totalXpForLevel(level, config) {
  const curve = curveOf(config);
  return curve.totals[Math.min(Math.max(0, level), MAX_LEVEL)];
}

// { level, current, needed }: the level for this much XP, the XP gained within
// it, and the XP the next level takes.
export const levelProgress = (xp, config) => progressOnCurve(curveOf(config), xp);

export const levelForXp = (xp, config) => levelProgress(xp, config).level;
