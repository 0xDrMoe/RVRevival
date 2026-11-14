// Warning steps (Setting.WARN_THRESHOLDS), shown as "Automatic punishments for
// warnings": after a set number of warnings in a set number of days, the bot
// times out, kicks or bans the member on its own. They run after EVERY warning,
// whoever gives it: /warn, the Warn app and automod rules set to "Delete and
// warn". Set on the dashboard's Moderation page or with /settings warn-step.
// Saved as up to MAX_THRESHOLDS [{ count, days, action, minutes }] (minutes
// only for timeouts).
//
// A step fires when a warning makes the count reach it exactly, so the same
// step never punishes twice for one run of warnings. When several are reached
// at once, the one with the most warnings wins.
//
// Automod used to have its own "escalation" (N warnings in 24 hours, checked
// only after automod's own warnings). It's now a step "within 1 day"; see
// stepFromEscalation and warnStepsMigration.js.

import { formatDuration } from "../utils/duration.js";
import { CaseAction } from "./caseStore.js";

export const MAX_THRESHOLDS = 5;
export const THRESHOLD_ACTIONS = ["timeout", "kick", "ban"];
export const LIMITS = Object.freeze({ minCount: 1, maxCount: 20, maxDays: 365, maxMinutes: 28 * 24 * 60 });
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
  `${count} ${count === 1 ? "warning" : "warnings"} within ${days} ${days === 1 ? "day" : "days"} → ${action === "timeout" ? `time out for ${formatMinutes(minutes)}` : action}`;

// 90 -> "90 minutes", 120 -> "2 hours", 2880 -> "2 days".
export function formatMinutes(minutes) {
  const [size, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  return `${size} ${unit}${size === 1 ? "" : "s"}`;
}

// Adds (or replaces) the step for `entry.count`, keeping the list sorted.
// Returns the new list, or throws InvalidWarnThresholds (for example when
// there are already MAX_THRESHOLDS other steps).
export function withStep(steps, entry) {
  return checkWarnThresholds([...normalizeWarnThresholds(steps).filter((step) => step.count !== entry.count), entry]) ?? [];
}

// The list without the step for `count`.
export function withoutStep(steps, count) {
  return normalizeWarnThresholds(steps).filter((step) => step.count !== count);
}

// One warning step as text, in the reader's language: "3 warnings within 30 days → time out for 1h".
// A step for 1 warning acts on every warning, so its number of days doesn't matter.
export function describeWarnStep({ count, days, action, minutes }, text) {
  const what = action === "timeout" ? text("warnStepAction_timeout", { duration: formatDuration(minutes * 60_000) }) : text(`warnStepAction_${action}`);
  if (count === 1) {
    return text("warnStepEveryLine", { action: what });
  }
  return text("warnStepLine", {
    count: text("warnStepCount", { count }),
    window: days === 1 ? text("warnStepWithinDay") : text("warnStepWithinDays", { days }),
    action: what,
  });
}

// Every step, one per line.
export const describeWarnSteps = (steps, text) => steps.map((step) => `• ${describeWarnStep(step, text)}`).join("\n");

// Automod's old escalation setting ({ warnings, action, timeoutMinutes },
// warnings 0 = off) as a step within 1 day, or undefined when it was off or broken.
export function stepFromEscalation(escalation) {
  const { warnings, action, timeoutMinutes } = escalation ?? {};
  if (!Number.isInteger(warnings) || warnings < 1) {
    return undefined;
  }
  try {
    const step = { count: Math.min(warnings, LIMITS.maxCount), days: 1, action };
    return checkOne(action === "timeout" ? { ...step, minutes: Number.isInteger(timeoutMinutes) ? timeoutMinutes : 60 } : step);
  } catch {
    return undefined;
  }
}

// The steps with automod's old escalation folded in. A step the server
// already has for the same number of warnings wins, and nothing is added
// when the list is full.
export function mergeEscalation(steps, escalation) {
  const list = normalizeWarnThresholds(steps);
  const step = stepFromEscalation(escalation);
  if (!step || list.length >= MAX_THRESHOLDS || list.some((entry) => entry.count === step.count)) {
    return list;
  }
  return [...list, step].sort((a, b) => a.count - b.count);
}

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

// Runs after every warning (manual or automod). Returns { threshold, moderationCase } when the
// bot punished the member, { threshold, failed: true } when it couldn't
// (their role is above the bot's), or undefined.
// `moderator` is who the new case names; the bot itself by default.
export async function applyWarnThreshold({ guild, member, moderation, thresholds, moderator = undefined, now = Date.now() }) {
  if (!member || thresholds.length === 0) {
    return undefined;
  }
  const threshold = reachedThreshold(thresholds, (since) => moderation.store.countCasesSince(guild.id, member.id, CaseAction.WARN, since), now);
  if (!threshold) {
    return undefined;
  }
  moderator ??= guild.members?.me?.user ?? guild.client?.user;
  const reason = `Automatic punishment: ${threshold.count} ${threshold.count === 1 ? "warning" : "warnings"} within ${threshold.days} ${threshold.days === 1 ? "day" : "days"}`;
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
