// The starboard: when a message gets enough ⭐ reactions, the bot reposts it in
// the starboard channel with a link back, and keeps the star count up to date.
//
// Saved in the server's settings (Setting.STARBOARD) as { channelId, threshold, emoji }.
//
// - Bots and the message's own author don't count toward the stars.
// - If the stars drop below the threshold, the starboard post is deleted; if the
//   original message is deleted, so is its starboard post.
// - If staff delete a starboard post, that message never goes back on the board.
// - Messages from channels @everyone can't see never go on a starboard that
//   @everyone can see, and messages from age-restricted channels only go on an
//   age-restricted starboard, so the starboard can't leak them.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import { KeyedLock } from "../utils/keyedLock.js";
import { cleanEmoji } from "./rolePanels.js";

export const DEFAULT_THRESHOLD = 3;
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 50;
export const DEFAULT_EMOJI = "⭐";
const COLOR = 0xf1c40f;
// Above this many reactions the count is used as is, without checking who reacted.
const MAX_USERS_CHECKED = 100;

const CUSTOM_EMOJI_ID = /^<a?:\w{2,32}:(\d{17,20})>$/;
const withoutVariation = (text) => String(text ?? "").replace(/️/g, "");

// The starboard's settings with defaults filled in, or undefined if it's off.
export function normalizeStarboard(saved) {
  if (!saved || typeof saved !== "object" || typeof saved.channelId !== "string") {
    return undefined;
  }
  const threshold = Number.isInteger(saved.threshold) ? saved.threshold : DEFAULT_THRESHOLD;
  return {
    channelId: saved.channelId,
    threshold: Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, threshold)),
    emoji: cleanEmoji(saved.emoji) ?? DEFAULT_EMOJI,
  };
}

export const starboardOf = (guildSettings, guildId) => normalizeStarboard(guildSettings.get(guildId, Setting.STARBOARD));

// Whether a reaction's emoji is the starboard's.
export function emojiMatches(configured, emoji) {
  const custom = CUSTOM_EMOJI_ID.exec(configured);
  if (custom) {
    return emoji?.id === custom[1];
  }
  return !emoji?.id && withoutVariation(emoji?.name) === withoutVariation(configured);
}

const isNsfw = (channel) => Boolean(channel?.nsfw ?? channel?.parent?.nsfw);
const everyoneCanSee = (channel, guild) =>
  Boolean(channel.permissionsFor?.(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));

// Whether a message from `source` may be shown on `board` (see the top of this file).
export function canFeature(source, board, guild) {
  if (!source || !board || source.id === board.id) {
    return false;
  }
  if (isNsfw(source) && !isNsfw(board)) {
    return false;
  }
  return everyoneCanSee(source, guild) || !everyoneCanSee(board, guild);
}

const isImage = (attachment) =>
  attachment.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(attachment.name ?? "");

// The starboard post for a message.
export function buildStarboardPost(message, { stars, emoji, language }) {
  const attachments = [...(message.attachments?.values?.() ?? [])];
  const image = attachments.find(isImage);
  const others = attachments.filter((attachment) => attachment !== image);
  const author = message.author;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({
      name: (message.member?.displayName ?? author?.globalName ?? author?.username ?? "?").slice(0, 256),
      iconURL: author?.displayAvatarURL?.() ?? undefined,
    })
    .setTimestamp(message.createdTimestamp ?? null);
  if (message.content) {
    embed.setDescription(message.content.slice(0, 4096));
  }
  if (image) {
    embed.setImage(image.url);
  }
  if (others.length > 0) {
    embed.addFields({
      name: translate(language, "starboardAttachments"),
      value: others.map((attachment) => `[${attachment.name}](${attachment.url})`).join("\n").slice(0, 1024),
    });
  }
  const jump = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(message.url).setLabel(translate(language, "starboardJump"));
  return {
    content: `${emoji} **${stars}** · <#${message.channelId}>`,
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(jump)],
    allowedMentions: { parse: [] },
  };
}

// Options:
//   guildSettings, store (StarboardStore), logger, forcedLanguage
//   botDeletions   starboard posts the bot deletes itself, so the server log skips them (RecentIds)
export function createStarboard({ guildSettings, store, logger, forcedLanguage, botDeletions }) {
  // One update at a time per message, so quick reactions can't post it twice.
  const locks = new KeyedLock();

  // Stars from members other than the author.
  async function countStars(reaction, message) {
    if (!reaction || reaction.count === 0) {
      return 0;
    }
    if (reaction.count > MAX_USERS_CHECKED) {
      return reaction.count;
    }
    const users = await reaction.users.fetch({ limit: MAX_USERS_CHECKED });
    return [...users.values()].filter((user) => !user.bot && user.id !== message.author?.id).length;
  }

  async function deletePost(board, post) {
    store.delete(post.messageId);
    if (post.starMessageId && board?.isTextBased?.()) {
      botDeletions?.add(post.starMessageId);
      await board.messages.delete(post.starMessageId).catch(() => {});
    }
  }

  // Brings a message's starboard post up to date. `reaction` is the starboard
  // emoji's reaction on it, or undefined if those reactions were all removed.
  async function update(message, findReaction) {
    const guild = message.guild;
    const config = guild && starboardOf(guildSettings, guild.id);
    if (!config) {
      return;
    }
    const board = guild.channels.cache.get(config.channelId);
    if (!board?.isTextBased?.() || !canFeature(message.channel, board, guild)) {
      return;
    }
    await locks.run(message.id, async () => {
      const post = store.get(message.id);
      if (post?.removed) {
        return;
      }
      const reaction = findReaction(config);
      // Cheap check first: no need to look at who reacted if it can't be enough.
      if (!post && (reaction?.count ?? 0) < config.threshold) {
        return;
      }
      if (message.partial) {
        message = await message.fetch();
      }
      const stars = await countStars(reaction, message);
      if (stars < config.threshold) {
        if (post) {
          await deletePost(board, post);
        }
        return;
      }
      const language = pickLanguage(guild.preferredLocale, forcedLanguage);
      const payload = buildStarboardPost(message, { stars, emoji: config.emoji, language });
      const existing = post?.starMessageId && (await board.messages.fetch(post.starMessageId).catch(() => undefined));
      let starMessageId = post?.starMessageId;
      if (existing) {
        await existing.edit(payload);
      } else {
        starMessageId = (await board.send(payload)).id;
      }
      store.save({ messageId: message.id, guildId: guild.id, channelId: message.channelId, starMessageId, stars });
    });
  }

  const reactionFinder = (message) => (config) =>
    message.reactions?.cache?.find((reaction) => emojiMatches(config.emoji, reaction.emoji));

  return {
    // A reaction added or removed (Events.MessageReactionAdd / Remove).
    async reactionChanged(reaction) {
      const config = reaction.message.guild && starboardOf(guildSettings, reaction.message.guildId);
      if (!config || !emojiMatches(config.emoji, reaction.emoji)) {
        return;
      }
      if (reaction.partial) {
        reaction = await reaction.fetch().catch(() => reaction);
      }
      await update(reaction.message, () => reaction);
    },

    // All reactions removed, or all of one emoji (Events.MessageReactionRemoveAll / RemoveEmoji).
    async reactionsCleared(message) {
      if (message.guild && store.get(message.id)) {
        await update(message, reactionFinder(message));
      }
    },

    // A message deleted: either an original (its post goes too) or a starboard
    // post deleted by staff (the original stays off the board).
    async messageDeleted(message) {
      if (!message.guildId) {
        return;
      }
      const post = store.get(message.id);
      if (post) {
        const config = starboardOf(guildSettings, message.guildId);
        const board = config && message.guild?.channels.cache.get(config.channelId);
        await deletePost(board, post);
        return;
      }
      const shown = store.byStarMessage(message.id);
      if (shown) {
        store.markRemoved(shown.messageId);
        logger.debug("A starboard post was deleted; that message stays off the starboard", { guildId: message.guildId });
      }
    },
  };
}
