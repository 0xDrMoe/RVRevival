// Looking up and correcting moderation cases:
//
//   /case view number:12                 show one case
//   /case reason number:12 reason:…      change its reason (the mod-log post is updated too)
//   /case delete number:12               delete it (Manage Server only)
//   /modlogs user:@someone               a member's case history, newest first
//
// Usable by members with Moderate Members or the staff role from /settings.

import {
  EmbedBuilder,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  TimestampStyles,
} from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { isModerator } from "../moderation/checks.js";
import { actionName, buildCaseEmbed } from "../moderation/modLog.js";
import { withDescription } from "./moderation.js";

const MAX_REASON_LENGTH = 512;
// Cases listed by /modlogs; an embed holds 4096 characters.
const MODLOGS_LIMIT = 20;

const numberOption = (option) =>
  withDescription(option.setName("number"), "caseNumberOptionDescription").setRequired(true).setMinValue(1);

export function buildCaseCommandData() {
  const command = new SlashCommandBuilder()
    .setName("case")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);
  return withDescription(command, "caseCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("view"), "caseViewDescription").addIntegerOption(numberOption))
    .addSubcommand((sub) =>
      withDescription(sub.setName("reason"), "caseReasonDescription")
        .addIntegerOption(numberOption)
        .addStringOption((option) =>
          withDescription(option.setName("reason"), "caseReasonOptionDescription")
            .setRequired(true)
            .setMaxLength(MAX_REASON_LENGTH),
        ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("delete"), "caseDeleteDescription").addIntegerOption(numberOption))
    .toJSON();
}

export function buildModlogsCommandData() {
  const command = new SlashCommandBuilder()
    .setName("modlogs")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);
  return withDescription(command, "modlogsCommandDescription")
    .addUserOption((option) => withDescription(option.setName("user"), "modlogsUserOptionDescription").setRequired(true))
    .toJSON();
}

// One line per case: "**#12** Ban · 3 days ago · reason".
export function buildModlogsEmbed(user, cases, total, language) {
  const text = (key, values) => translate(language, key, values);
  const lines = cases.map((moderationCase) => {
    const when = time(Math.floor(moderationCase.createdAt / 1000), TimestampStyles.RelativeTime);
    let reason = moderationCase.reason ?? text("caseNoReason");
    if (reason.length > 80) {
      reason = `${reason.slice(0, 79)}…`;
    }
    return `**#${moderationCase.number}** ${actionName(language, moderationCase)} · ${when} · ${escapeMarkdown(reason.replace(/\s+/g, " "))}`;
  });
  const footer = [text("caseFooter", { id: user.id })];
  if (total > cases.length) {
    footer.unshift(text("modlogsMore", { shown: cases.length, total }));
  }
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(text("modlogsTitle", { user: user.tag ?? user.username ?? user.id }))
    .setDescription(lines.join("\n"))
    .setFooter({ text: footer.join(" · ") });
}

// Shared checks and reply helpers for both commands.
function begin(interaction, { guildSettings, forcedLanguage }) {
  const language = pickLanguage(interaction.locale, forcedLanguage);
  const text = (key, values) => translate(language, key, values);
  const answer = async (status, key, values = {}) => {
    await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return result(status, key, values);
  };
  let refusal;
  if (!interaction.inCachedGuild()) {
    refusal = () => answer(Status.REFUSED, "guildOnly");
  } else if (!isModerator(interaction, PermissionFlagsBits.ModerateMembers, guildSettings)) {
    refusal = () => answer(Status.REFUSED, "modNoPermission", { permission: text("permModerateMembers") });
  }
  return { language, text, answer, refusal };
}

// Options:
//   guildSettings    for the staff role (GuildSettings)
//   moderation       the moderation service (see moderation/moderationService.js)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createCaseCommand({ guildSettings, moderation, forcedLanguage }) {
  async function execute(interaction) {
    const { language, answer, refusal } = begin(interaction, { guildSettings, forcedLanguage });
    if (refusal) {
      return refusal();
    }
    const guild = interaction.guild;
    const number = interaction.options.getInteger("number", true);
    const values = { number };

    switch (interaction.options.getSubcommand()) {
      case "view": {
        const moderationCase = moderation.store.getCase(guild.id, number);
        if (!moderationCase) {
          return answer(Status.REFUSED, "caseNotFound", values);
        }
        await interaction.reply({
          embeds: [buildCaseEmbed(moderationCase, language)],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return result(Status.SUCCESS);
      }
      case "reason": {
        const reason = interaction.options.getString("reason", true).trim();
        const updated = await moderation.updateReason(guild, number, reason);
        if (!updated) {
          return answer(Status.REFUSED, "caseNotFound", values);
        }
        return answer(Status.SUCCESS, "caseReasonUpdated", values);
      }
      case "delete": {
        // Deleting erases history, so only admins can do it.
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
          return answer(Status.REFUSED, "caseDeleteNoPermission");
        }
        if (!moderation.store.deleteCase(guild.id, number)) {
          return answer(Status.REFUSED, "caseNotFound", values);
        }
        return answer(Status.SUCCESS, "caseDeleted", values);
      }
    }
    return answer(Status.FAILED, "unexpected");
  }

  return { name: "case", data: buildCaseCommandData(), execute };
}

export function createModlogsCommand({ guildSettings, moderation, forcedLanguage }) {
  async function execute(interaction) {
    const { language, answer, refusal } = begin(interaction, { guildSettings, forcedLanguage });
    if (refusal) {
      return refusal();
    }
    const user = interaction.options.getUser("user", true);
    const counts = moderation.store.countCases(interaction.guildId, user.id);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      return answer(Status.SUCCESS, "modlogsNone", { user: `<@${user.id}>` });
    }
    const cases = moderation.store.listCases(interaction.guildId, user.id, MODLOGS_LIMIT);
    await interaction.reply({
      embeds: [buildModlogsEmbed(user, cases, total, language)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return result(Status.SUCCESS);
  }

  return { name: "modlogs", data: buildModlogsCommandData(), execute };
}
