// Channel moderation:
//
//   /lock [channel] [reason]       stop @everyone from posting there
//   /unlock [channel] [reason]     let them post again
//   /slowmode duration [channel]   members can post once per duration (off, 10s, 5m… up to 6h)
//
// Usable by members with Manage Channels or the mod role. The bot needs Manage
// Channels and Manage Roles in the channel. Each change is posted in the
// mod-log channel.

import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Status } from "../logs/actionLog.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { auditReason } from "../moderation/moderationService.js";
import { formatDuration, parseDuration } from "../utils/duration.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { withDescription } from "./moderation.js";

// What a lock takes away from @everyone. Unlocking resets these to the
// channel's default (inherit from the category or server).
const LOCKED_PERMISSIONS = ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"];
// Discord's longest slowmode.
export const MAX_SLOWMODE_SECONDS = 6 * 60 * 60;
const OFF_WORDS = new Set(["off", "0", "0s", "none"]);

const PERMISSION = PermissionFlagsBits.ManageChannels;
const PERMISSION_KEY = "permManageChannels";

function lockCommandData(name, descriptionKey) {
  const command = new SlashCommandBuilder()
    .setName(name)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PERMISSION);
  return withDescription(command, descriptionKey)
    .addChannelOption((option) =>
      withDescription(option.setName("channel"), "lockChannelOptionDescription").addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
      ),
    )
    .addStringOption((option) => withDescription(option.setName("reason"), "modReasonOptionDescription").setMaxLength(512))
    .toJSON();
}

export function buildSlowmodeCommandData() {
  const command = new SlashCommandBuilder()
    .setName("slowmode")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PERMISSION);
  return withDescription(command, "slowmodeCommandDescription")
    .addStringOption((option) =>
      withDescription(option.setName("duration"), "slowmodeDurationOptionDescription").setRequired(true).setMaxLength(20),
    )
    .addChannelOption((option) =>
      withDescription(option.setName("channel"), "slowmodeChannelOptionDescription").addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildForum,
        ChannelType.GuildVoice,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
      ),
    )
    .toJSON();
}

// Whether @everyone is currently denied posting in `channel`.
export function isLocked(channel, guildId) {
  const overwrite = channel.permissionOverwrites?.cache.get(guildId);
  return Boolean(overwrite?.deny.has(PermissionFlagsBits.SendMessages));
}

// Options:
//   guildSettings    for the mod role (GuildSettings)
//   modLog           posts each change in the mod-log channel (see moderation/modLog.js)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createChannelToolCommands({ guildSettings, modLog = noModLog, forcedLanguage }) {
  const begin = (interaction) =>
    beginModerationCommand(interaction, { permission: PERMISSION, permissionKey: PERMISSION_KEY, guildSettings, forcedLanguage });

  // Lock or unlock, depending on `locking`.
  const setLock = (locking) => async (interaction) => {
    const { answer, refusal } = begin(interaction);
    if (refusal) {
      return refusal();
    }
    const guild = interaction.guild;
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    const values = { channel: `<#${channel?.id}>` };
    if (!channel?.permissionOverwrites) {
      return answer(Status.REFUSED, "lockWrongChannel", values);
    }
    if (isLocked(channel, guild.id) === locking) {
      return answer(Status.REFUSED, locking ? "lockAlready" : "unlockNotLocked", values);
    }

    const reason = interaction.options.getString("reason")?.trim() || undefined;
    // A notice for members, in the server's language. Posted before locking
    // (and after unlocking), since a lock can stop the bot posting too.
    const serverLanguage = pickLanguage(guild.preferredLocale, forcedLanguage);
    const notice = translate(serverLanguage, locking ? "lockNotice" : "unlockNotice");
    const postNotice = () => channel.send?.({ content: notice, allowedMentions: { parse: [] } }).catch(() => {});

    try {
      if (locking) {
        await postNotice();
      }
      await channel.permissionOverwrites.edit(
        guild.id,
        Object.fromEntries(LOCKED_PERMISSIONS.map((name) => [name, locking ? false : null])),
        { reason: auditReason(interaction.user, reason) },
      );
      if (!locking) {
        await postNotice();
      }
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      return answer(Status.FAILED, "lockBotMissingPermission", values);
    }

    await modLog.post(guild, () => ({
      embed: buildActionLogEmbed({
        moderator: interaction.user,
        summary: `**Channel ${locking ? "locked" : "unlocked"}** · <#${channel.id}>`,
        lines: reason ? [`Reason: ${reason}`] : [],
        color: locking ? 0xe67e22 : 0x57f287,
      }),
    }));
    return answer(Status.SUCCESS, locking ? "lockDone" : "unlockDone", values);
  };

  async function slowmode(interaction) {
    const { answer, refusal } = begin(interaction);
    if (refusal) {
      return refusal();
    }
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    const values = { channel: `<#${channel?.id}>` };
    if (typeof channel?.setRateLimitPerUser !== "function") {
      return answer(Status.REFUSED, "slowmodeWrongChannel", values);
    }

    const input = interaction.options.getString("duration", true).trim().toLowerCase();
    const milliseconds = OFF_WORDS.has(input) ? 0 : parseDuration(input);
    const seconds = Number.isFinite(milliseconds) ? Math.round(milliseconds / 1000) : -1;
    if (seconds < 0 || seconds > MAX_SLOWMODE_SECONDS) {
      return answer(Status.REFUSED, "modInvalidDuration", { max: "6h" });
    }

    try {
      await channel.setRateLimitPerUser(seconds, auditReason(interaction.user, "Slowmode"));
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      return answer(Status.FAILED, "slowmodeBotMissingPermission", values);
    }

    const shown = formatDuration(seconds * 1000);
    await modLog.post(interaction.guild, () => ({
      embed: buildActionLogEmbed({
        moderator: interaction.user,
        summary: seconds
          ? `**Slowmode set to ${shown}** · <#${channel.id}>`
          : `**Slowmode turned off** · <#${channel.id}>`,
      }),
    }));
    return seconds
      ? answer(Status.SUCCESS, "slowmodeSet", { ...values, duration: shown })
      : answer(Status.SUCCESS, "slowmodeOff", values);
  }

  return [
    { name: "lock", data: lockCommandData("lock", "lockCommandDescription"), execute: setLock(true) },
    { name: "unlock", data: lockCommandData("unlock", "unlockCommandDescription"), execute: setLock(false) },
    { name: "slowmode", data: buildSlowmodeCommandData(), execute: slowmode },
  ];
}
