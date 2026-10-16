// A server's leveling settings, saved as one JSON object (Setting.LEVELING),
// and the level math.
//
// normalizeLeveling() reads a saved value, filling in defaults for anything
// missing or invalid. checkLeveling() is strict: the dashboard uses it to
// refuse bad input. Leveling is off until an admin turns it on.

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

// Each message is worth 15 to 25 XP, at most once a minute per member, like
// most leveling bots, so spamming doesn't pay.
export const MIN_XP_PER_MESSAGE = 15;
export const MAX_XP_PER_MESSAGE = 25;
export const XP_COOLDOWN_MS = 60 * 1000;

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
});

const isId = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
const idList = (value, max) => (Array.isArray(value) ? [...new Set(value.filter(isId))].slice(0, max) : []);
const isLevel = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_LEVEL;

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
  };
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
  if (!Array.isArray(value.rewards) || value.rewards.length > MAX_REWARDS) {
    throw new InvalidLeveling(`Add at most ${MAX_REWARDS} level rewards.`);
  }
  for (const reward of value.rewards) {
    if (!isLevel(reward?.level)) {
      throw new InvalidLeveling(`Reward levels go from 1 to ${MAX_LEVEL}.`);
    }
    if (!isRewardRole(reward.roleId)) {
      throw new InvalidLeveling("Pick reward roles the bot can give: below its own role, not bot or admin roles.");
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
  return normalizeLeveling({
    ...value,
    announceChannelId: value.announce === Announce.CHANNEL ? value.announceChannelId : null,
  });
}

// --- Level math --------------------------------------------------------------------

// XP needed to go from `level` to the next one: 100, 155, 220, 295… so each
// level takes a little longer than the last.
export const xpToNextLevel = (level) => 5 * level * level + 50 * level + 100;

// Total XP needed to reach `level` from zero.
export function totalXpForLevel(level) {
  let total = 0;
  for (let current = 0; current < level; current += 1) {
    total += xpToNextLevel(current);
  }
  return total;
}

// { level, current, needed }: the level for this much XP, the XP gained within
// it, and the XP that level takes.
export function levelProgress(xp) {
  let level = 0;
  let remaining = Math.max(0, xp);
  while (level < MAX_LEVEL && remaining >= xpToNextLevel(level)) {
    remaining -= xpToNextLevel(level);
    level += 1;
  }
  return { level, current: remaining, needed: xpToNextLevel(level) };
}

export const levelForXp = (xp) => levelProgress(xp).level;
