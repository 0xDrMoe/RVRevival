// Gives members XP for chatting (and, when switched on, for time in voice),
// announces level-ups and hands out reward roles. Server Boosters and chosen
// roles can earn more. Settings come from leveling/config.js; XP is in
// leveling/levelStore.js.

import { randomInt } from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import {
  Announce,
  levelForXp,
  MAX_XP_PER_MESSAGE,
  MIN_XP_PER_MESSAGE,
  multiplierFor,
  normalizeLeveling,
  VOICE_XP_PER_MINUTE,
  XP_COOLDOWN_MS,
} from "./config.js";

const ANNOUNCE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const VOICE_TICK_MS = 60 * 1000;

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

  // `here` is where they earned it: the message's channel, or the voice channel's chat.
  async function announce(here, member, level, config) {
    const guild = member.guild;
    if (config.announce === Announce.OFF) {
      return;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    const text = fillLevelMessage(config.message ?? translate(language, "levelUpDefault"), { member, level, guild });
    if (config.announce === Announce.DM) {
      await member.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
      return;
    }
    const channel = config.announce === Announce.CHANNEL ? guild.channels.cache.get(config.announceChannelId) : here;
    const me = guild.members.me;
    if (!channel?.isTextBased?.() || !me || !channel.permissionsFor(me)?.has(ANNOUNCE_PERMISSIONS)) {
      return;
    }
    await channel
      .send({ content: text, allowedMentions: { users: [member.id] } })
      .catch((error) => logger.debug("Couldn't announce a level-up", { guildId: guild.id, error }));
  }

  // Whether XP is switched off where they are (a channel, its parent or its category) or for one of their roles.
  function noXp(config, guildId, channel, member) {
    const places = [channel?.id, channel?.parentId, channel?.parent?.parentId].filter(Boolean);
    return (
      places.some((id) => config.noXpChannelIds.includes(id)) ||
      places[0] === guildSettings.get(guildId, Setting.COUNTRY_CHANNEL) ||
      config.noXpRoleIds.some((roleId) => member.roles.cache.has(roleId))
    );
  }

  // After XP was added: rewards, and the announcement on a level-up.
  async function afterAward(award, member, here, config) {
    const [before, after] = [levelForXp(award.before), levelForXp(award.after)];
    // Also catches up members who reached a level before its reward was added.
    // No request is made when their roles are already right.
    await syncRewards(member, after, config);
    if (after <= before) {
      return { xp: award.after, level: after, leveledUp: false };
    }
    await announce(here, member, after, config);
    return { xp: award.after, level: after, leveledUp: true };
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
    const member = message.member;
    if (!member || noXp(config, guildId, message.channel, member)) {
      return undefined;
    }
    const base = MIN_XP_PER_MESSAGE + random(MAX_XP_PER_MESSAGE - MIN_XP_PER_MESSAGE + 1);
    const award = store.award({
      guildId,
      userId: member.id,
      userTag: member.user?.username ?? null,
      amount: Math.round(base * multiplierFor(config, member)),
      now: now(),
      cooldownMs: XP_COOLDOWN_MS,
    });
    if (!award) {
      return undefined;
    }
    return afterAward(award, member, message.channel, config);
  }

  // One minute of voice XP for a server: everyone in a voice channel with at
  // least one other person, not deafened, not in the AFK channel.
  async function awardVoice(guild) {
    const config = configFor(guild.id);
    if (!config.enabled || !config.voiceXp) {
      return [];
    }
    const awarded = [];
    const byChannel = new Map();
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId && state.member && !state.member.user?.bot) {
        byChannel.set(state.channelId, [...(byChannel.get(state.channelId) ?? []), state]);
      }
    }
    for (const [channelId, states] of byChannel) {
      const channel = guild.channels.cache.get(channelId);
      if (states.length < 2 || channelId === guild.afkChannelId) {
        continue;
      }
      for (const state of states) {
        const member = state.member;
        if (state.deaf || noXp(config, guild.id, channel, member)) {
          continue;
        }
        const award = store.addXp({
          guildId: guild.id,
          userId: member.id,
          userTag: member.user?.username ?? null,
          amount: Math.round(VOICE_XP_PER_MINUTE * multiplierFor(config, member)),
        });
        awarded.push(member.id);
        await afterAward(award, member, channel, config);
      }
    }
    return awarded;
  }

  let voiceTimer;
  let voiceRunning = false;

  // Gives voice XP every minute in every server that has it switched on.
  function startVoiceXp(client) {
    stopVoiceXp();
    voiceTimer = setInterval(async () => {
      if (voiceRunning) {
        return;
      }
      voiceRunning = true;
      try {
        for (const guild of client.guilds.cache.values()) {
          await awardVoice(guild).catch((error) => logger.error("Giving voice XP crashed", { guildId: guild.id, error }));
        }
      } finally {
        voiceRunning = false;
      }
    }, VOICE_TICK_MS);
    voiceTimer.unref?.();
  }

  function stopVoiceXp() {
    clearInterval(voiceTimer);
    voiceTimer = undefined;
  }

  return { handleMessage, awardVoice, startVoiceXp, stopVoiceXp, syncRewards, configFor };
}
