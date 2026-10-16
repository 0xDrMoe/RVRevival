// AFK (/afk): members say they're away. When someone mentions them (or
// replies to them), the bot says so; their next message marks them back.
// The bot also puts "[AFK] " in front of their nickname when it may.

import { PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { NicknameChange } from "./afkStore.js";

export const MAX_AFK_MESSAGE_LENGTH = 200;
export const AFK_PREFIX = "[AFK] ";
// One notice per away member per channel in this time, so a busy chat isn't spammed.
const NOTICE_COOLDOWN_MS = 60_000;
// Away members named in one notice.
const MAX_NOTICES = 3;
// Notices delete themselves after this.
const NOTICE_LIFETIME_MS = 15_000;

const unix = (time) => Math.floor(time / 1000);

// Whether the bot may change this member's nickname: not the owner, and below the bot's top role.
function canRename(member) {
  const me = member.guild?.members?.me;
  if (!me?.permissions?.has(PermissionFlagsBits.ManageNicknames) || member.id === member.guild.ownerId) {
    return false;
  }
  return (member.roles?.highest?.position ?? 0) < (me.roles?.highest?.position ?? 0);
}

// Options: store (afk/afkStore.js), logger, forcedLanguage, now, setTimer (tests)
export function createAfk({ store, logger, forcedLanguage, now = Date.now, setTimer = setTimeout }) {
  // "channel:user" -> when the last notice about them was posted there
  const noticed = new Map();

  function coolingDown(key) {
    const time = now();
    if (noticed.size > 1000) {
      for (const [old, at] of noticed) {
        if (time - at >= NOTICE_COOLDOWN_MS) {
          noticed.delete(old);
        }
      }
    }
    if (time - (noticed.get(key) ?? -Infinity) < NOTICE_COOLDOWN_MS) {
      return true;
    }
    noticed.set(key, time);
    return false;
  }

  const removeLater = (sent) => {
    const timer = setTimer(() => sent.delete().catch(() => {}), NOTICE_LIFETIME_MS);
    timer?.unref?.();
  };

  // Undoes what setAway did to the nickname, unless they changed it since.
  async function dropPrefix(member, change) {
    const nickname = member.nickname;
    if (!nickname?.startsWith(AFK_PREFIX) || !canRename(member)) {
      return;
    }
    const restored = change === NicknameChange.ADDED ? null : nickname.slice(AFK_PREFIX.length) || null;
    await member.setNickname(restored, "Back from AFK").catch((error) => logger.debug("Couldn't restore a nickname after AFK", { error }));
  }

  return {
    // Marks a member away, with "[AFK] " in front of their name when the bot may.
    async setAway(member, message) {
      const existing = store.get(member.guild.id, member.id);
      let nickname = existing?.nickname ?? NicknameChange.NONE;
      const hadNickname = Boolean(member.nickname);
      const shown = member.nickname ?? member.user?.globalName ?? member.user?.username ?? "";
      if (!shown.startsWith(AFK_PREFIX) && canRename(member)) {
        const renamed = await member
          .setNickname(`${AFK_PREFIX}${shown}`.slice(0, 32), "AFK")
          .then(() => true)
          .catch(() => false);
        if (renamed) {
          nickname = hadNickname ? NicknameChange.PREFIXED : NicknameChange.ADDED;
        }
      }
      store.set({ guildId: member.guild.id, userId: member.id, message, since: now(), nickname });
    },

    // Every message: welcomes back the author if they were away, and answers
    // mentions of away members.
    async messageCreated(message) {
      if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system) {
        return;
      }
      const language = pickLanguage(message.guild.preferredLocale, forcedLanguage);
      const back = store.delete(message.guildId, message.author.id);
      if (back) {
        if (back.nickname !== NicknameChange.NONE && message.member) {
          await dropPrefix(message.member, back.nickname);
        }
        await message
          .reply({
            content: translate(language, "afkBack", { user: `<@${message.author.id}>`, since: `<t:${unix(back.since)}:R>` }),
            allowedMentions: { parse: [], repliedUser: false },
            failIfNotExists: false,
          })
          .then(removeLater)
          .catch((error) => logger.debug("Couldn't welcome someone back from AFK", { error }));
      }

      const mentioned = new Set(message.mentions?.users?.keys?.() ?? []);
      const repliedTo = message.mentions?.repliedUser?.id;
      if (repliedTo) {
        mentioned.add(repliedTo);
      }
      mentioned.delete(message.author.id);
      const lines = [];
      for (const userId of mentioned) {
        if (lines.length >= MAX_NOTICES) {
          break;
        }
        const away = store.get(message.guildId, userId);
        if (!away || coolingDown(`${message.channelId}:${userId}`)) {
          continue;
        }
        const values = { user: `<@${userId}>`, since: `<t:${unix(away.since)}:R>`, message: away.message ?? "" };
        lines.push(translate(language, away.message ? "afkNotice" : "afkNoticeNoMessage", values));
      }
      if (lines.length === 0) {
        return;
      }
      await message
        .reply({ content: lines.join("\n"), allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false })
        .then(removeLater)
        .catch((error) => logger.debug("Couldn't post an AFK notice", { error }));
    },

    // A member who leaves isn't away any more.
    memberLeft(member) {
      store.delete(member.guild.id, member.id);
    },
  };
}
