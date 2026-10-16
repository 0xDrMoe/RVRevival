// Posts each moderation case in the mod-log channel (/settings mod-log-channel,
// or the logs channel if no mod-log channel is set), and updates the post when a
// case's reason is edited.

import { EmbedBuilder, escapeMarkdown, time, TimestampStyles } from "discord.js";
import { translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import { formatDuration } from "../utils/duration.js";
import { CaseAction } from "./caseStore.js";

export const MOD_LOG_SETTINGS = [Setting.MOD_LOG_CHANNEL, Setting.LOGS_CHANNEL];

const ACTION_STYLE = {
  [CaseAction.BAN]: { key: "caseActionBan", color: 0xed4245 },
  [CaseAction.UNBAN]: { key: "caseActionUnban", color: 0x57f287 },
  [CaseAction.KICK]: { key: "caseActionKick", color: 0xe67e22 },
  [CaseAction.TIMEOUT]: { key: "caseActionTimeout", color: 0xfee75c },
  [CaseAction.UNTIMEOUT]: { key: "caseActionUntimeout", color: 0x57f287 },
  [CaseAction.WARN]: { key: "caseActionWarn", color: 0xf1c40f },
};

// The translated name of a case's action ("Ban", "Temporary ban", …).
export function actionName(language, moderationCase) {
  if (moderationCase.action === CaseAction.BAN && moderationCase.durationMs) {
    return translate(language, "caseActionTempBan");
  }
  return translate(language, ACTION_STYLE[moderationCase.action]?.key ?? "caseActionWarn");
}

// "@mention (tag)". ID "0" means an unknown moderator (see externalActions.js).
function personLine(id, tag) {
  if (id === "0") {
    return escapeMarkdown(tag ?? "Unknown");
  }
  return tag ? `<@${id}> (${escapeMarkdown(tag)})` : `<@${id}>`;
}

// One case as an embed, in `language` (English in the mod-log channel).
export function buildCaseEmbed(moderationCase, language = "en") {
  const text = (key, values) => translate(language, key, values);
  const style = ACTION_STYLE[moderationCase.action] ?? ACTION_STYLE[CaseAction.WARN];

  const fields = [
    { name: text("caseUser"), value: personLine(moderationCase.userId, moderationCase.userTag), inline: true },
    {
      name: text("caseModerator"),
      value: personLine(moderationCase.moderatorId, moderationCase.moderatorTag),
      inline: true,
    },
  ];
  if (moderationCase.durationMs) {
    const duration = formatDuration(moderationCase.durationMs);
    const value = moderationCase.expiresAt
      ? text("caseUntil", { duration, time: time(Math.floor(moderationCase.expiresAt / 1000), TimestampStyles.ShortDateTime) })
      : duration;
    fields.push({ name: text("caseDuration"), value, inline: true });
  }
  fields.push({
    name: text("caseReason"),
    value: moderationCase.reason ? moderationCase.reason.slice(0, 1024) : `*${text("caseNoReason")}*`,
  });
  if (moderationCase.dmSent !== undefined) {
    fields.push({ name: text("caseDm"), value: text(moderationCase.dmSent ? "caseDmSent" : "caseDmNotSent"), inline: true });
  }

  const footer = [text("caseFooter", { id: moderationCase.userId })];
  if (moderationCase.updatedAt) {
    footer.push(text("caseEdited"));
  }

  return new EmbedBuilder()
    .setColor(style.color)
    .setTitle(text("caseTitle", { number: moderationCase.number, action: actionName(language, moderationCase) }))
    .addFields(fields)
    .setFooter({ text: footer.join(" · ") })
    .setTimestamp(moderationCase.createdAt);
}

// Options:
//   poster   posts in log channels (see logs/logChannel.js)
//   store    the CaseStore, to remember where each case was posted
export function createModLog({ poster, store }) {
  return {
    async postCase(guild, moderationCase) {
      const message = await poster.post(guild, MOD_LOG_SETTINGS, () => ({ embed: buildCaseEmbed(moderationCase) }));
      if (message?.id && message.channelId) {
        store.setLogMessage(moderationCase.guildId, moderationCase.number, message.channelId, message.id);
      }
      return message;
    },

    // Updates the case's post after an edit. Returns whether it was updated.
    async refreshCase(guild, moderationCase) {
      if (!moderationCase.logChannelId || !moderationCase.logMessageId) {
        return false;
      }
      return poster.edit(guild, moderationCase.logChannelId, moderationCase.logMessageId, buildCaseEmbed(moderationCase));
    },

    // Posts something that isn't a case (a purge) in the same channel.
    post: (guild, build) => poster.post(guild, MOD_LOG_SETTINGS, build),
  };
}

export const noModLog = Object.freeze({
  postCase: async () => undefined,
  refreshCase: async () => false,
  post: async () => undefined,
});
