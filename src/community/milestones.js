// Member-count milestones (/welcome milestones or the dashboard's Welcome
// page): when the server reaches every Nth member (100, 200, 300…), the bot
// posts a celebration in a channel, thanking whoever got it there.
//
// Saved as Setting.MILESTONES { channelId, every, message }, message null for
// the default. The last milestone posted is kept in data/bot.db (table
// milestone_posts), so members leaving and rejoining around a milestone can't
// post it twice, and a restart doesn't forget it. The first join after the
// feature is switched on only posts if it lands exactly on a milestone;
// otherwise it just notes where the server is.
//
// Messages use the "welcome" variables; {members} is the milestone reached.

import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import { canPost } from "../utils/rateLimits.js";
import { MAX_MESSAGE_LENGTH, renderTemplate } from "./welcome.js";

export const MIN_MILESTONE_EVERY = 10;
export const MAX_MILESTONE_EVERY = 1_000_000;
export const DEFAULT_MILESTONE_EVERY = 100;

export class InvalidMilestones extends Error {
  name = "InvalidMilestones";
}

const isSnowflake = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);

// The saved setting, cleaned up, or null when milestones are off.
export function normalizeMilestones(value) {
  if (!value || typeof value !== "object" || !isSnowflake(value.channelId)) {
    return null;
  }
  const every = Number.isInteger(value.every) && value.every >= MIN_MILESTONE_EVERY && value.every <= MAX_MILESTONE_EVERY ? value.every : DEFAULT_MILESTONE_EVERY;
  const message = typeof value.message === "string" && value.message.trim() ? value.message.trim().slice(0, MAX_MESSAGE_LENGTH) : null;
  return { channelId: value.channelId, every, message };
}

// Checks a value from the dashboard or /welcome. Returns what to save (null
// switches milestones off). Throws InvalidMilestones.
export function checkMilestones(value, { channelOk = () => true } = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMilestones("Send the milestones as an object.");
  }
  if (!isSnowflake(value.channelId) || !channelOk(value.channelId)) {
    throw new InvalidMilestones("Pick a text channel from this server for the milestones.");
  }
  if (!Number.isInteger(value.every) || value.every < MIN_MILESTONE_EVERY || value.every > MAX_MILESTONE_EVERY) {
    throw new InvalidMilestones(`Celebrate every ${MIN_MILESTONE_EVERY} to ${MAX_MILESTONE_EVERY.toLocaleString("en-US")} members.`);
  }
  if (value.message !== null && value.message !== undefined && typeof value.message !== "string") {
    throw new InvalidMilestones("Send the milestone message as text.");
  }
  const message = typeof value.message === "string" ? value.message.replace(/\r\n?/g, "\n").trim() : "";
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new InvalidMilestones(`Keep the milestone message under ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return { channelId: value.channelId, every: value.every, message: message || null };
}

export const describeMilestones = (value) => {
  const config = normalizeMilestones(value);
  return config ? `every ${config.every.toLocaleString("en-US")} members in <#${config.channelId}>${config.message ? " · own message" : ""}` : "off";
};

// The milestone a member count has reached (0 before the first).
export const milestoneFor = (count, every) => Math.floor(count / every) * every;

// Whether reaching `count` should post, given the last milestone posted
// (undefined before the first).
export function reachedMilestone(count, every, last) {
  const milestone = milestoneFor(count, every);
  if (milestone <= 0) {
    return false;
  }
  return last === undefined ? count === milestone : milestone > last;
}

// The message for `milestone`, with `member` as the one who reached it.
export function milestonePayload(config, { member, guild, milestone, language }) {
  const template = config.message ?? translate(language, "milestoneDefault");
  return { content: renderTemplate(template, { member, guild: { name: guild.name, memberCount: milestone } }) };
}

// Options: guildSettings, store (GrowthStore), logger, forcedLanguage
export function createMilestones({ guildSettings, store, logger, forcedLanguage }) {
  const warned = new Set();

  return {
    async memberJoined(member) {
      const guild = member.guild;
      const config = normalizeMilestones(guildSettings.get(guild.id, Setting.MILESTONES));
      const count = guild.memberCount;
      if (!config || !Number.isInteger(count) || member.user?.bot) {
        return;
      }
      const last = store.milestone(guild.id);
      const milestone = milestoneFor(count, config.every);
      const post = reachedMilestone(count, config.every, last);
      // Saved before posting, so two joins at once can't both post it.
      if (milestone > 0 && (last === undefined || milestone > last)) {
        store.setMilestone(guild.id, milestone);
      }
      if (!post) {
        return;
      }
      const channel = guild.channels.cache.get(config.channelId);
      if (!channel?.isTextBased?.() || !canPost(channel)) {
        if (!warned.has(guild.id)) {
          warned.add(guild.id);
          logger.warn("Couldn't post a member milestone. Give the bot View Channel and Send Messages in the milestone channel.", { guildId: guild.id });
        }
        return;
      }
      const language = pickLanguage(guild.preferredLocale, forcedLanguage);
      try {
        await channel.send({ ...milestonePayload(config, { member, guild, milestone, language }), allowedMentions: { users: [member.id] } });
        warned.delete(guild.id);
      } catch (error) {
        logger.warn("Couldn't post a member milestone", { guildId: guild.id, error });
      }
    },
  };
}
