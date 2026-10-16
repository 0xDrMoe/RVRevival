// Gives members XP for chatting, announces level-ups and hands out reward
// roles. Settings come from leveling/config.js; XP is in leveling/levelStore.js.

import { randomInt } from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import {
  Announce,
  levelForXp,
  MAX_XP_PER_MESSAGE,
  MIN_XP_PER_MESSAGE,
  normalizeLeveling,
  XP_COOLDOWN_MS,
} from "./config.js";

const ANNOUNCE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

// "{user} reached level {level}!" with the placeholders filled in.
export function fillLevelMessage(template, { member, level, guild }) {
  return template
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.displayName ?? member.user?.username ?? "")
    .replaceAll("{level}", String(level))
    .replaceAll("{server}", guild.name);
}

// The reward roles a member should have at `level`: every one reached, or only
// the highest when rewards don't stack.
export function rewardRolesFor(config, level) {
  const reached = config.rewards.filter((reward) => reward.level <= level).map((reward) => reward.roleId);
  return config.stackRewards ? reached : reached.slice(-1);
}

// Options: guildSettings, store (LevelStore), logger, forcedLanguage, random(max), now
export function createLeveling({ guildSettings, store, logger, forcedLanguage, random = randomInt, now = Date.now }) {
  const configFor = (guildId) => normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING));

  // Gives and takes reward roles so the member has exactly what their level
  // earns. Roles the bot can't manage are skipped.
  async function syncRewards(member, level, config = configFor(member.guild.id)) {
    if (config.rewards.length === 0) {
      return { added: [], removed: [] };
    }
    const wanted = new Set(rewardRolesFor(config, level));
    const manageable = (roleId) => member.guild.roles.cache.get(roleId)?.editable;
    const has = (roleId) => member.roles.cache.has(roleId);
    const added = [...wanted].filter((roleId) => !has(roleId) && manageable(roleId));
    const removed = config.rewards
      .map((reward) => reward.roleId)
      .filter((roleId) => !wanted.has(roleId) && has(roleId) && manageable(roleId));
    try {
      if (added.length > 0) {
        await member.roles.add(added, `Level ${level} reward`);
      }
      if (removed.length > 0) {
        await member.roles.remove(removed, `Level ${level} reward replaced`);
      }
    } catch (error) {
      logger.warn("Couldn't update a member's level reward roles", { guildId: member.guild.id, userId: member.id, error });
    }
    return { added, removed };
  }

  async function announce(message, member, level, config) {
    const guild = message.guild;
    if (config.announce === Announce.OFF) {
      return;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    const text = fillLevelMessage(config.message ?? translate(language, "levelUpDefault"), { member, level, guild });
    if (config.announce === Announce.DM) {
      await member.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
      return;
    }
    const channel = config.announce === Announce.CHANNEL ? guild.channels.cache.get(config.announceChannelId) : message.channel;
    const me = guild.members.me;
    if (!channel?.isTextBased?.() || !me || !channel.permissionsFor(me)?.has(ANNOUNCE_PERMISSIONS)) {
      return;
    }
    await channel
      .send({ content: text, allowedMentions: { users: [member.id] } })
      .catch((error) => logger.debug("Couldn't announce a level-up", { guildId: guild.id, error }));
  }

  // A message in a server: maybe some XP, maybe a level-up.
  async function handleMessage(message) {
    if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system) {
      return undefined;
    }
    const guildId = message.guildId;
    const config = configFor(guildId);
    if (!config.enabled) {
      return undefined;
    }
    // The channel, its parent (for threads) and its category can each be excluded.
    const channel = message.channel;
    const places = [channel?.id, channel?.parentId, channel?.parent?.parentId].filter(Boolean);
    if (places.some((id) => config.noXpChannelIds.includes(id)) || places[0] === guildSettings.get(guildId, Setting.COUNTRY_CHANNEL)) {
      return undefined;
    }
    const member = message.member;
    if (!member || config.noXpRoleIds.some((roleId) => member.roles.cache.has(roleId))) {
      return undefined;
    }
    const award = store.award({
      guildId,
      userId: member.id,
      userTag: member.user?.username ?? null,
      amount: MIN_XP_PER_MESSAGE + random(MAX_XP_PER_MESSAGE - MIN_XP_PER_MESSAGE + 1),
      now: now(),
      cooldownMs: XP_COOLDOWN_MS,
    });
    if (!award) {
      return undefined;
    }
    const [before, after] = [levelForXp(award.before), levelForXp(award.after)];
    // Also catches up members who reached a level before its reward was added.
    // No request is made when their roles are already right.
    await syncRewards(member, after, config);
    if (after <= before) {
      return { xp: award.after, level: after, leveledUp: false };
    }
    await announce(message, member, after, config);
    return { xp: award.after, level: after, leveledUp: true };
  }

  return { handleMessage, syncRewards, configFor };
}
