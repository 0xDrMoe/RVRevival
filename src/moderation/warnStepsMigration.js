// One-time move of automod's old "escalation" setting (N automod warnings in
// 24 hours, then time out, kick or ban) into the server's warning steps
// (warnThresholds.js), which now run after every warning, automod's included.
//
// Safe to run on every startup, from the bot and the dashboard alike: once a
// server's automod setting has no `escalation` left, there's nothing to do.

import { Setting } from "../settings/guildSettings.js";
import { mergeEscalation } from "./warnThresholds.js";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Returns how many servers were changed.
export async function moveAutomodEscalation(guildSettings, logger = undefined) {
  let moved = 0;
  for (const guildId of guildSettings.guildIds()) {
    const automod = guildSettings.get(guildId, Setting.AUTOMOD);
    if (!isObject(automod) || !("escalation" in automod)) {
      continue;
    }
    const before = guildSettings.get(guildId, Setting.WARN_THRESHOLDS);
    const steps = mergeEscalation(before, automod.escalation);
    if (steps.length > 0 && JSON.stringify(steps) !== JSON.stringify(before)) {
      await guildSettings.set(guildId, Setting.WARN_THRESHOLDS, steps);
    }
    const { escalation: _old, ...rest } = automod;
    await guildSettings.set(guildId, Setting.AUTOMOD, rest);
    moved += 1;
  }
  if (moved > 0) {
    logger?.info("Moved automod's warning escalation into the warning steps", { servers: moved });
  }
  return moved;
}

// The same move for a plain { setting: value } object, such as an older
// settings backup being restored. Returns a new object; never throws.
export function foldEscalationInto(settings) {
  const automod = settings?.[Setting.AUTOMOD];
  if (!isObject(automod) || !("escalation" in automod)) {
    return settings;
  }
  const { escalation, ...rest } = automod;
  const steps = mergeEscalation(settings[Setting.WARN_THRESHOLDS], escalation);
  const next = { ...settings, [Setting.AUTOMOD]: rest };
  if (steps.length > 0) {
    next[Setting.WARN_THRESHOLDS] = steps;
  }
  return next;
}
