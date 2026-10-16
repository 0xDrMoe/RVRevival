// Highlights (/highlight): members pick words, and the bot DMs them when
// someone says one in a channel they can see. Like Discord's own keyword
// notifications, but per server and for everyone. Skipped when the member
// talked in that channel in the last few minutes (they're reading it anyway)
// and at most once per channel per few minutes.

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { MAX_WORD_LENGTH, MIN_WORD_LENGTH } from "./highlightStore.js";

const ACTIVE_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
// DMs sent for one message, so a message full of common words can't fan out.
const MAX_DMS_PER_MESSAGE = 10;
const COLOR = 0xfee75c;

// The word as saved (lowercase, single spaces), or null when it isn't usable.
export function normalizeWord(text) {
  const word = typeof text === "string" ? text.toLowerCase().replace(/\s+/g, " ").trim() : "";
  if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH || !/[\p{L}\p{N}]/u.test(word)) {
    return null;
  }
  return word;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches the word on its own, not inside a longer word ("cat" isn't in "category").
export const wordPattern = (word) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(word).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");

// Options: store (highlights/highlightStore.js), logger, forcedLanguage, now
export function createHighlights({ store, logger, forcedLanguage, now = Date.now }) {
  // server ID -> [{ word, pattern, userIds }]
  const matchers = new Map();
  // "channel:user" -> when they last talked there
  const lastSpoke = new Map();
  // "channel:user" -> when they were last DMed about it
  const lastDm = new Map();

  function matchersFor(guildId) {
    let list = matchers.get(guildId);
    if (!list) {
      const byWord = new Map();
      for (const { userId, word } of store.forGuild(guildId)) {
        if (!byWord.has(word)) {
          byWord.set(word, { word, pattern: wordPattern(word), userIds: new Set() });
        }
        byWord.get(word).userIds.add(userId);
      }
      list = [...byWord.values()];
      matchers.set(guildId, list);
    }
    return list;
  }

  function sweep(map, maxAge) {
    if (map.size < 5000) {
      return;
    }
    const time = now();
    for (const [key, at] of map) {
      if (time - at >= maxAge) {
        map.delete(key);
      }
    }
  }

  async function notify(message, userId, word, language) {
    const guild = message.guild;
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (!member || member.user?.bot) {
      return false;
    }
    const permissions = message.channel.permissionsFor?.(member);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      return false;
    }
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setAuthor({ name: message.member?.displayName ?? message.author.username, iconURL: message.author.displayAvatarURL?.() ?? undefined })
      .setDescription(`${message.content.slice(0, 1500)}\n\n[${translate(language, "highlightJump")}](${message.url})`)
      .setTimestamp(message.createdTimestamp ?? now());
    await member.send({
      content: translate(language, "highlightDm", { word, channel: `<#${message.channelId}>`, server: guild.name }),
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  return {
    async messageCreated(message) {
      if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system) {
        return;
      }
      const time = now();
      sweep(lastSpoke, ACTIVE_MS);
      lastSpoke.set(`${message.channelId}:${message.author.id}`, time);
      if (!message.content) {
        return;
      }
      const list = matchersFor(message.guildId);
      if (list.length === 0) {
        return;
      }
      // user ID -> the first word of theirs in the message
      const hits = new Map();
      for (const { word, pattern, userIds } of list) {
        if (!pattern.test(message.content)) {
          continue;
        }
        for (const userId of userIds) {
          if (!hits.has(userId)) {
            hits.set(userId, word);
          }
        }
      }
      hits.delete(message.author.id);
      for (const userId of message.mentions?.users?.keys?.() ?? []) {
        hits.delete(userId);
      }
      const language = pickLanguage(message.guild.preferredLocale, forcedLanguage);
      let sent = 0;
      sweep(lastDm, COOLDOWN_MS);
      for (const [userId, word] of hits) {
        if (sent >= MAX_DMS_PER_MESSAGE) {
          break;
        }
        const key = `${message.channelId}:${userId}`;
        if (time - (lastSpoke.get(key) ?? -Infinity) < ACTIVE_MS || time - (lastDm.get(key) ?? -Infinity) < COOLDOWN_MS) {
          continue;
        }
        try {
          if (await notify(message, userId, word, language)) {
            lastDm.set(key, time);
            sent += 1;
          }
        } catch (error) {
          // Closed DMs: don't try again for a while.
          lastDm.set(key, time);
          logger.debug("Couldn't DM a highlight", { guildId: message.guildId, userId, error });
        }
      }
    },

    // Words changed on this server.
    changed(guildId) {
      matchers.delete(guildId);
    },

    memberLeft(member) {
      if (store.clear(member.guild.id, member.id) > 0) {
        matchers.delete(member.guild.id);
      }
    },
  };
}
