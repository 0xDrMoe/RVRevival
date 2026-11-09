// Gives members XP for chatting (and, when switched on, for time in voice),
// announces level-ups and hands out reward roles. Server Boosters and chosen
// roles can earn more. Settings come from leveling/config.js; XP is in
// leveling/levelStore.js.

import { randomInt } from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { isModeratorRole } from "../permissions/moderatorPermissions.js";
import { derivedSetting, Setting } from "../settings/guildSettings.js";
import {
  Announce,
  levelForXp,
  MAX_XP_COOLDOWN_MS,
  multiplierFor,
  normalizeLeveling,
} from "./config.js";

const ANNOUNCE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const VOICE_TICK_MS = 60 * 1000;
// Past this many members on cooldown, the expired ones are forgotten.
const COOLDOWN_SWEEP_SIZE = 10_000;

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
  // The same, shared and kept until the settings change: for every message and voice minute.
  const liveConfigFor = (guildId) => derivedSetting(guildSettings, guildId, Setting.LEVELING, normalizeLeveling);

  // "<server>:<member>" -> when they last earned message XP. Most messages come
  // inside the cooldown, and this skips the database write for them. The
  // database still checks the cooldown itself, so this is only a shortcut.
  const lastAwarded = new Map();
  let lastSweep = -Infinity;

  // Cooldowns differ per server, so the sweep keeps entries for the longest one.
  function onCooldown(key, time, cooldownMs) {
    const last = lastAwarded.get(key);
    if (last !== undefined && time - last < cooldownMs) {
      return true;
    }
    if (lastAwarded.size >= COOLDOWN_SWEEP_SIZE && time - lastSweep >= MAX_XP_COOLDOWN_MS) {
      lastSweep = time;
      for (const [entry, at] of lastAwarded) {
        if (time - at >= MAX_XP_COOLDOWN_MS) {
          lastAwarded.delete(entry);
        }
      }
    }
    return false;
  }

  // Gives and takes reward roles so the member has exactly what their level
  // earns. Roles the bot can't manage are skipped.
  async function syncRewards(member, level, config = configFor(member.guild.id)) {
    if (config.rewards.length === 0) {
      return { added: [], removed: [] };
    }
    const wanted = new Set(rewardRolesFor(config, level));
    const manageable = (roleId) => member.guild.roles.cache.get(roleId)?.editable;
    const has = (roleId) => member.roles.cache.has(roleId);
    // A reward role that has since been given moderator permissions isn't handed out.
    const givable = (roleId) => manageable(roleId) && !isModeratorRole(member.guild.roles.cache.get(roleId));
    const added = [...wanted].filter((roleId) => !has(roleId) && givable(roleId));
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
    const [before, after] = [levelForXp(award.before, config), levelForXp(award.after, config)];
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
    const config = liveConfigFor(guildId);
    if (!config.enabled) {
      return undefined;
    }
    const member = message.member;
    if (!member || noXp(config, guildId, message.channel, member)) {
      return undefined;
    }
    const time = now();
    const cooldownKey = `${guildId}:${member.id}`;
    const cooldownMs = config.cooldownSeconds * 1000;
    if (onCooldown(cooldownKey, time, cooldownMs)) {
      return undefined;
    }
    const base = config.xpMin + random(config.xpMax - config.xpMin + 1);
    const award = store.award({
      guildId,
      userId: member.id,
      userTag: member.user?.username ?? null,
      amount: Math.round(base * multiplierFor(config, member)),
      now: time,
      cooldownMs,
    });
    if (!award) {
      return undefined;
    }
    lastAwarded.set(cooldownKey, time);
    return afterAward(award, member, message.channel, config);
  }

  // One minute of voice XP for a server: everyone in a voice channel with at
  // least one other person, not deafened, not in the AFK channel.
  async function awardVoice(guild) {
    const config = liveConfigFor(guild.id);
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
          amount: Math.round(config.voiceXpPerMinute * multiplierFor(config, member)),
          now: now(),
        });
        awarded.push(member.id);
        await afterAward(award, member, channel, config);
      }
    }
    return awarded;
  }

  let voiceTimer;
  let voiceRunning = false;

  let prunedDay;

  // Gives voice XP every minute in every server that has it switched on, and
  // once a day forgets daily XP the weekly and monthly boards no longer need.
  function startVoiceXp(client) {
    stopVoiceXp();
    voiceTimer = setInterval(async () => {
      if (voiceRunning) {
        return;
      }
      voiceRunning = true;
      try {
        const today = Math.floor(now() / 86_400_000);
        if (prunedDay !== today) {
          prunedDay = today;
          store.prune(now());
        }
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
