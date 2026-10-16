// Media-only channels: messages without a picture, video, file or (when
// allowed) link are deleted, with a short note that deletes itself. Staff
// (Manage Messages there) are exempt, and threads in the channel stay open
// for comments. Community servers can use Discord's own media channels
// instead; this is for normal text channels.

import { PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";

export const MAX_MEDIA_CHANNELS = 10;
const NOTE_LIFETIME_MS = 6_000;
// One note per member per channel in this time.
const NOTE_COOLDOWN_MS = 30_000;
const SNOWFLAKE = /^\d{17,20}$/;
const LINK = /https?:\/\/\S+/i;

export class InvalidMediaOnly extends Error {
  name = "InvalidMediaOnly";
}

// The saved setting, or the defaults: { channelIds, allowLinks }.
export function normalizeMediaOnly(value) {
  const channelIds = Array.isArray(value?.channelIds) ? [...new Set(value.channelIds.filter((id) => typeof id === "string" && SNOWFLAKE.test(id)))].slice(0, MAX_MEDIA_CHANNELS) : [];
  return { channelIds, allowLinks: value?.allowLinks !== false };
}

// Checks dashboard input. Returns what to save, or null for the defaults (no channels, links allowed).
export function checkMediaOnly(value, { isChannel }) {
  if (!value || typeof value !== "object" || !Array.isArray(value.channelIds) || typeof value.allowLinks !== "boolean") {
    throw new InvalidMediaOnly("Media-only channels are { channelIds, allowLinks }.");
  }
  if (value.channelIds.length > MAX_MEDIA_CHANNELS) {
    throw new InvalidMediaOnly(`Up to ${MAX_MEDIA_CHANNELS} media-only channels.`);
  }
  const bad = value.channelIds.find((id) => !isChannel(id));
  if (bad !== undefined) {
    throw new InvalidMediaOnly("Pick text channels from this server.");
  }
  const channelIds = [...new Set(value.channelIds)];
  return channelIds.length > 0 || !value.allowLinks ? { channelIds, allowLinks: value.allowLinks } : null;
}

export const describeMediaOnly = (value) => `${value.channelIds.map((id) => `<#${id}>`).join(", ")} · links ${value.allowLinks ? "allowed" : "not allowed"}`;

// Whether a message counts as media: an attachment, or a link when links are allowed.
export function isMedia(message, { allowLinks }) {
  if ((message.attachments?.size ?? 0) > 0) {
    return true;
  }
  return allowLinks && LINK.test(message.content ?? "");
}

// Options: guildSettings, logger, forcedLanguage, botDeletions (RecentIds), now, setTimer (tests)
export function createMediaOnly({ guildSettings, logger, forcedLanguage, botDeletions, now = Date.now, setTimer = setTimeout }) {
  const noted = new Map();

  function coolingDown(key) {
    const time = now();
    if (noted.size > 1000) {
      noted.forEach((at, old) => time - at >= NOTE_COOLDOWN_MS && noted.delete(old));
    }
    if (time - (noted.get(key) ?? -Infinity) < NOTE_COOLDOWN_MS) {
      return true;
    }
    noted.set(key, time);
    return false;
  }

  return {
    // Deletes a non-media message in a media-only channel. Returns whether it did.
    async messageCreated(message) {
      if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system) {
        return false;
      }
      const config = normalizeMediaOnly(guildSettings.get(message.guildId, Setting.MEDIA_ONLY));
      if (!config.channelIds.includes(message.channelId) || isMedia(message, config)) {
        return false;
      }
      if (message.member?.permissionsIn?.(message.channel)?.has(PermissionFlagsBits.ManageMessages)) {
        return false;
      }
      botDeletions?.add(message.id);
      try {
        await message.delete();
      } catch (error) {
        logger.debug("Couldn't delete a message in a media-only channel", { guildId: message.guildId, channelId: message.channelId, error });
        return false;
      }
      if (!coolingDown(`${message.channelId}:${message.author.id}`)) {
        const language = pickLanguage(message.guild?.preferredLocale, forcedLanguage);
        const key = config.allowLinks ? "mediaOnlyNote" : "mediaOnlyNoteNoLinks";
        await message.channel
          .send({ content: translate(language, key, { user: `<@${message.author.id}>` }), allowedMentions: { users: [message.author.id] } })
          .then((note) => {
            const timer = setTimer(() => note.delete().catch(() => {}), NOTE_LIFETIME_MS);
            timer?.unref?.();
          })
          .catch(() => {});
      }
      return true;
    },

    // A deleted channel stops being media-only.
    async channelDeleted(channel) {
      if (!channel.guildId) {
        return;
      }
      const config = normalizeMediaOnly(guildSettings.get(channel.guildId, Setting.MEDIA_ONLY));
      if (!config.channelIds.includes(channel.id)) {
        return;
      }
      const channelIds = config.channelIds.filter((id) => id !== channel.id);
      if (channelIds.length === 0) {
        await guildSettings.clear(channel.guildId, Setting.MEDIA_ONLY);
      } else {
        await guildSettings.set(channel.guildId, Setting.MEDIA_ONLY, { ...config, channelIds });
      }
    },
  };
}
