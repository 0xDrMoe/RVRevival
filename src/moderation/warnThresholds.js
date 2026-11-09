// Warning thresholds (Setting.WARN_THRESHOLDS): after a set number of /warn
// cases in a set number of days, the bot times out, kicks or bans the member
// on its own, like automod's escalation does for its own warnings. Set on the
// dashboard's Moderation page. Saved as up to MAX_THRESHOLDS
// [{ count, days, action, minutes }] (minutes only for timeouts).
//
// A threshold fires when a warning makes the count reach it exactly, so the
// same step never punishes twice for one run of warnings. When several are
// reached at once, the one with the most warnings wins.

import { CaseAction } from "./caseStore.js";

export const MAX_THRESHOLDS = 5;
export const THRESHOLD_ACTIONS = ["timeout", "kick", "ban"];
export const LIMITS = Object.freeze({ minCount: 2, maxCount: 20, maxDays: 365, maxMinutes: 28 * 24 * 60 });
const DAY_MS = 24 * 60 * 60 * 1000;

export class InvalidWarnThresholds extends Error {
  name = "InvalidWarnThresholds";
}

const isWhole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function checkOne(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new InvalidWarnThresholds("Each threshold must be an object.");
  }
  const { count, days, action, minutes } = entry;
  if (!isWhole(count, LIMITS.minCount, LIMITS.maxCount)) {
    throw new InvalidWarnThresholds(`Warnings must be a whole number from ${LIMITS.minCount} to ${LIMITS.maxCount}.`);
  }
  if (!isWhole(days, 1, LIMITS.maxDays)) {
    throw new InvalidWarnThresholds(`Days must be a whole number from 1 to ${LIMITS.maxDays}.`);
  }
  if (!THRESHOLD_ACTIONS.includes(action)) {
    throw new InvalidWarnThresholds("The action must be timeout, kick or ban.");
  }
  if (action === "timeout" && !isWhole(minutes, 1, LIMITS.maxMinutes)) {
    throw new InvalidWarnThresholds(`A timeout lasts from 1 minute to ${LIMITS.maxMinutes} minutes (28 days).`);
  }
  return action === "timeout" ? { count, days, action, minutes } : { count, days, action };
}

// For the dashboard. Returns what to save (null for none); throws InvalidWarnThresholds.
export function checkWarnThresholds(value) {
  if (!Array.isArray(value)) {
    throw new InvalidWarnThresholds("Send the thresholds as a list.");
  }
  if (value.length > MAX_THRESHOLDS) {
    throw new InvalidWarnThresholds(`At most ${MAX_THRESHOLDS} thresholds.`);
  }
  const checked = value.map(checkOne).sort((a, b) => a.count - b.count);
  if (new Set(checked.map((entry) => entry.count)).size !== checked.length) {
    throw new InvalidWarnThresholds("Two thresholds can't have the same number of warnings.");
  }
  return checked.length > 0 ? checked : null;
}

// Never throws: anything invalid is dropped.
export function normalizeWarnThresholds(saved) {
  try {
    return checkWarnThresholds(Array.isArray(saved) ? saved : []) ?? [];
  } catch {
    return [];
  }
}

export const describeThreshold = ({ count, days, action, minutes }) =>
  `${count} warnings in ${days} days → ${action}${action === "timeout" ? ` ${minutes} min` : ""}`;

export const describeWarnThresholds = (value) => {
  const list = normalizeWarnThresholds(value);
  return list.length > 0 ? list.map(describeThreshold).join("; ") : "*none*";
};

// The threshold this warning reaches, or undefined. `countSince(ms)` counts
// the member's warn cases since then (including the new one).
export function reachedThreshold(thresholds, countSince, now = Date.now()) {
  return [...thresholds]
    .sort((a, b) => b.count - a.count)
    .find((threshold) => countSince(now - threshold.days * DAY_MS) === threshold.count);
}

// Runs after a manual warning. Returns { threshold, moderationCase } when the
// bot punished the member, { threshold, failed: true } when it couldn't
// (their role is above the bot's), or undefined.
export async function applyWarnThreshold({ guild, member, moderation, thresholds, now = Date.now() }) {
  if (!member || thresholds.length === 0) {
    return undefined;
  }
  const threshold = reachedThreshold(thresholds, (since) => moderation.store.countCasesSince(guild.id, member.id, CaseAction.WARN, since), now);
  if (!threshold) {
    return undefined;
  }
  const moderator = guild.members.me?.user ?? guild.client?.user;
  const reason = `Warning threshold: ${threshold.count} warnings in ${threshold.days} days`;
  if (threshold.action === "timeout" && member.moderatable !== false) {
    return { threshold, moderationCase: await moderation.timeout({ guild, member, moderator, reason, durationMs: threshold.minutes * 60_000 }) };
  }
  if (threshold.action === "kick" && member.kickable !== false) {
    return { threshold, moderationCase: await moderation.kick({ guild, member, moderator, reason }) };
  }
  if (threshold.action === "ban" && member.bannable !== false) {
    return { threshold, moderationCase: await moderation.ban({ guild, user: member.user, member, moderator, reason }) };
  }
  return { threshold, failed: true };
}
