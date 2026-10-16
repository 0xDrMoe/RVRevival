// Server stats channels: locked voice channels whose names show live counts,
// like "👥 Members: 1,234". Saved as a list of counters in the server's
// settings (Setting.STATS_COUNTERS); statsUpdater.js creates and renames the
// channels.

import { randomBytes } from "node:crypto";

export const MAX_COUNTERS = 5;
export const MAX_TEMPLATE_LENGTH = 60;

export const COUNTER_KEYS = ["members", "humans", "bots", "boosts", "tier", "channels", "roles"];
const PLACEHOLDER = /\{(members|humans|bots|boosts|tier|channels|roles)\}/g;

// The ready-made counters /stats and the dashboard offer.
export const COUNTER_PRESETS = Object.freeze({
  members: "👥 Members: {members}",
  humans: "🧑 Humans: {humans}",
  bots: "🤖 Bots: {bots}",
  boosts: "🚀 Boosts: {boosts}",
  channels: "💬 Channels: {channels}",
  roles: "🏷️ Roles: {roles}",
});
export const PRESET_NAMES = Object.keys(COUNTER_PRESETS);

export class InvalidCounter extends Error {
  name = "InvalidCounter";
}

const SNOWFLAKE = /^\d{17,20}$/;

export const newCounterId = () => randomBytes(4).toString("hex");

// A template, trimmed. Throws InvalidCounter unless it has a placeholder and fits.
export function checkTemplate(template) {
  const text = typeof template === "string" ? template.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > MAX_TEMPLATE_LENGTH) {
    throw new InvalidCounter(`A counter's name is 1 to ${MAX_TEMPLATE_LENGTH} characters.`);
  }
  if (!text.match(PLACEHOLDER)) {
    throw new InvalidCounter("A counter's name needs a number, like {members}.");
  }
  return text;
}

// The saved list, with anything malformed dropped.
export function normalizeCounters(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const counters = [];
  for (const counter of value) {
    if (counters.length >= MAX_COUNTERS) {
      break;
    }
    if (!counter || typeof counter.id !== "string" || !/^[a-f0-9]{8}$/.test(counter.id)) {
      continue;
    }
    let template;
    try {
      template = checkTemplate(counter.template);
    } catch {
      continue;
    }
    counters.push({
      id: counter.id,
      template,
      channelId: SNOWFLAKE.test(counter.channelId ?? "") ? counter.channelId : null,
      categoryId: SNOWFLAKE.test(counter.categoryId ?? "") ? counter.categoryId : null,
      error: typeof counter.error === "string" ? counter.error.slice(0, 200) : null,
    });
  }
  return counters;
}

const format = (number) => Number(number ?? 0).toLocaleString("en-US");

// The channel name for a template and the counts, within Discord's 100 characters.
export function counterName(template, counts) {
  return template.replace(PLACEHOLDER, (whole, key) => format(counts[key])).slice(0, 100);
}

// The counts for a server. Bots come from the member cache, so `humans` is
// exact once the members were fetched (statsUpdater.js does that).
export function guildCounts(guild) {
  const members = guild.memberCount ?? guild.members?.cache?.size ?? 0;
  let bots = 0;
  for (const member of guild.members?.cache?.values?.() ?? []) {
    if (member.user?.bot) {
      bots += 1;
    }
  }
  let channels = 0;
  for (const channel of guild.channels?.cache?.values?.() ?? []) {
    if (!channel.isThread?.()) {
      channels += 1;
    }
  }
  return {
    members,
    humans: Math.max(0, members - bots),
    bots,
    boosts: guild.premiumSubscriptionCount ?? 0,
    tier: guild.premiumTier ?? 0,
    channels,
    // Without @everyone.
    roles: Math.max(0, (guild.roles?.cache?.size ?? 1) - 1),
  };
}
