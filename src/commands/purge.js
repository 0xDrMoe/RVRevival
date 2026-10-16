// The /purge command: delete recent messages in the current channel.
//
//   /purge amount:50                  the last 50 messages
//   /purge amount:20 member:@someone  that member's messages among the last 100
//
// Pinned messages are kept, and Discord can only bulk-delete messages from the
// last 14 days. The mod-log channel gets an entry with a transcript of what was
// deleted. Needs Manage Messages (or the staff role), and the bot needs Manage
// Messages and Read Message History in the channel.

import {
  AttachmentBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { authorOf, result, Status } from "../logs/actionLog.js";
import { buildTranscript } from "../logs/transcript.js";
import { isModerator } from "../moderation/checks.js";
import { noModLog } from "../moderation/modLog.js";
import { DAY_MS } from "../utils/duration.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "purge";
const MAX_AMOUNT = 100;
// Discord refuses to bulk-delete older messages. Keep a margin for clock drift.
const BULK_DELETE_MAX_AGE_MS = 14 * DAY_MS - 60_000;

export function buildPurgeCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);
  return withDescription(command, "purgeCommandDescription")
    .addIntegerOption((option) =>
      withDescription(option.setName("amount"), "purgeAmountOptionDescription")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_AMOUNT),
    )
    .addUserOption((option) => withDescription(option.setName("member"), "purgeMemberOptionDescription"))
    .toJSON();
}

// Which of the fetched messages (newest first) to delete.
export function pickMessagesToPurge(messages, { amount, userId, now = Date.now() }) {
  return messages
    .filter((message) => !message.pinned)
    .filter((message) => now - message.createdTimestamp < BULK_DELETE_MAX_AGE_MS)
    .filter((message) => !userId || message.author?.id === userId)
    .slice(0, amount);
}

function buildPurgeLogEmbed({ moderator, channelId, count, userId }) {
  const lines = [`**Purged ${count} message${count === 1 ? "" : "s"}** in <#${channelId}>`];
  if (userId) {
    lines.push(`From <@${userId}> only`);
  }
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor(authorOf(moderator))
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Moderator ID ${moderator.id}` })
    .setTimestamp();
}

// Options:
//   guildSettings    for the staff role (GuildSettings)
//   modLog           posts the purge in the mod-log channel (see moderation/modLog.js)
//   botDeletions     remembers what the bot deleted, so the server log skips it (RecentIds)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createPurgeCommand({ guildSettings, modLog = noModLog, botDeletions, forcedLanguage, now = Date.now }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values) => {
      const content = text(key, values);
      if (interaction.deferred) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };

    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!isModerator(interaction, PermissionFlagsBits.ManageMessages, guildSettings)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageMessages") });
    }
    const channel = interaction.channel;
    if (!channel?.isTextBased() || !channel.messages) {
      return answer(Status.REFUSED, "purgeWrongChannel");
    }

    const amount = interaction.options.getInteger("amount", true);
    const userId = interaction.options.getUser("member")?.id;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let deleted;
    try {
      const recent = [...(await channel.messages.fetch({ limit: MAX_AMOUNT })).values()];
      const chosen = pickMessagesToPurge(recent, { amount, userId, now: now() });
      if (chosen.length === 0) {
        return answer(Status.REFUSED, "purgeNothing");
      }
      botDeletions?.add(chosen.map((message) => message.id));
      deleted = await channel.bulkDelete(chosen, true);
      // Keep the transcript to the messages that were really deleted.
      deleted = chosen.filter((message) => deleted.has(message.id));
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      return answer(Status.FAILED, "purgeBotMissingPermission");
    }

    await modLog.post(interaction.guild, ({ canAttach }) => ({
      embed: buildPurgeLogEmbed({ moderator: interaction.user, channelId: channel.id, count: deleted.length, userId }),
      files: canAttach
        ? [new AttachmentBuilder(Buffer.from(buildTranscript(deleted), "utf8"), { name: `purge-${channel.id}.txt` })]
        : [],
    }));

    return answer(Status.SUCCESS, "purgeDone", { count: deleted.length });
  }

  return { name: COMMAND_NAME, data: buildPurgeCommandData(), execute };
}
