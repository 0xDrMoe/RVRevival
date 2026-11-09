// Right-click apps (Apps menu on a message or a member):
//   Report message       anyone: sends the message to staff with a reason
//   User info            anyone: the same card as /userinfo, only for you
//   Moderation history   moderators: the same list as /modlogs, only for you
//
// Reports go to the mod-log channel, else the logs channel, with buttons for
// staff: Delete message, Time out 10 minutes, Dismiss.

import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { accentColor } from "../branding/branding.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { hierarchyProblem, isModerator } from "../moderation/checks.js";
import { HISTORY_DAYS, ReportStatus } from "../moderation/reports.js";
import { Setting } from "../settings/guildSettings.js";
import { buildModlogsEmbed } from "./cases.js";
import { buildUserInfoEmbed } from "./infoCommands.js";

export const REPORT_COMMAND = "Report message";
export const USER_INFO_COMMAND = "User info";
export const HISTORY_COMMAND = "Moderation history";
export const REPORT_FORM_PREFIX = "report:form:";
export const REPORT_ACTION_PREFIX = "report:act:";
const REPORT_REASON = "reason";
const MAX_REPORT_REASON = 300;
const REPORT_TIMEOUT_MS = 10 * 60 * 1000;
const MODLOGS_LIMIT = 10;
const REPORT_COLOR = 0xf0b232;
// Report channels, most specific first.
const REPORT_CHANNELS = [Setting.MOD_LOG_CHANNEL, Setting.LOGS_CHANNEL];

function menuData(name, nameKey, type, permission) {
  const builder = new ContextMenuCommandBuilder()
    .setName(name)
    .setNameLocalizations(discordLocalizations(nameKey))
    .setType(type)
    .setContexts(InteractionContextType.Guild);
  if (permission !== undefined) {
    builder.setDefaultMemberPermissions(permission);
  }
  return builder.toJSON();
}

// The report as staff see it. `handled` = { status, by } once someone acted.
export function buildReportMessage({ report, message, reporter, timesReported, handled = null }) {
  const content = message?.content ? message.content.slice(0, 1024) : null;
  const embed = new EmbedBuilder()
    .setColor(handled ? 0x99aab5 : REPORT_COLOR)
    .setTitle(`🚩 Message reported (#${report.id})`)
    .setDescription(`[Jump to the message](https://discord.com/channels/${report.guildId}/${report.channelId}/${report.messageId}) in <#${report.channelId}>`)
    .addFields(
      { name: "Author", value: `<@${report.authorId}>`, inline: true },
      { name: "Reported by", value: `<@${report.reporterId}>`, inline: true },
      { name: `Reports in ${HISTORY_DAYS} days`, value: String(timesReported), inline: true },
    )
    .setFooter({ text: `Author ID ${report.authorId}` })
    .setTimestamp(report.createdAt);
  if (content) {
    embed.addFields({ name: "Message", value: content });
  }
  const attachments = message?.attachments?.size ?? 0;
  if (attachments > 0) {
    embed.addFields({ name: "Attachments", value: String(attachments), inline: true });
  }
  if (report.reason) {
    embed.addFields({ name: "Reason", value: report.reason.slice(0, 1024) });
  }
  if (reporter?.tag) {
    embed.setAuthor({ name: `Report from ${reporter.tag}` });
  }
  if (handled) {
    const what = { [ReportStatus.DELETED]: "message deleted", [ReportStatus.TIMED_OUT]: "author timed out for 10 minutes", [ReportStatus.DISMISSED]: "dismissed" }[handled.status];
    embed.addFields({ name: "Handled", value: `${what} by <@${handled.by}>` });
    return { embeds: [embed], components: [], allowedMentions: { parse: [] } };
  }
  const button = (action, style, label) => new ButtonBuilder().setCustomId(`${REPORT_ACTION_PREFIX}${report.id}:${action}`).setStyle(style).setLabel(label);
  const row = new ActionRowBuilder().addComponents(
    button("delete", ButtonStyle.Danger, "Delete message"),
    button("timeout", ButtonStyle.Primary, "Time out 10 min"),
    button("dismiss", ButtonStyle.Secondary, "Dismiss"),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

// Options: guildSettings, reports (moderation/reports.js ReportStore),
// moderation (moderation/moderationService.js), forcedLanguage, logger, now.
// Without `reports` and `moderation` (registering) only the data is used.
export function createContextMenus({ guildSettings, reports, moderation, forcedLanguage, logger, now = Date.now }) {
  const replyPrivately = async (interaction, key, values = {}, status = Status.REFUSED) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const payload = { content: translate(language, key, values), allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
    return result(status, key, values);
  };

  // Where reports go in this server, if the bot can post there.
  function reportChannel(guild) {
    for (const setting of REPORT_CHANNELS) {
      const channel = guild.channels.cache.get(guildSettings.get(guild.id, setting));
      const me = guild.members.me;
      if (channel?.isTextBased?.() && me && channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return channel;
      }
    }
    return undefined;
  }

  // Right-click > Apps > Report message: asks why.
  async function report(interaction) {
    if (!interaction.inCachedGuild()) {
      return replyPrivately(interaction, "guildOnly");
    }
    const message = interaction.targetMessage;
    if (message.author.id === interaction.user.id) {
      return replyPrivately(interaction, "reportOwnMessage");
    }
    if (message.author.bot || message.system) {
      return replyPrivately(interaction, "reportBotMessage");
    }
    if (!reportChannel(interaction.guild)) {
      return replyPrivately(interaction, "reportNoChannel");
    }
    if (reports.openForMessage(interaction.guildId, message.id)) {
      return replyPrivately(interaction, "reportAlreadyOpen", {}, Status.SUCCESS);
    }
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const input = new TextInputBuilder()
      .setCustomId(REPORT_REASON)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(MAX_REPORT_REASON)
      .setPlaceholder(translate(language, "reportReasonPlaceholder"));
    const form = new ModalBuilder()
      .setCustomId(`${REPORT_FORM_PREFIX}${message.channelId}:${message.id}`)
      .setTitle(translate(language, "reportFormTitle").slice(0, 45))
      .addLabelComponents(new LabelBuilder().setLabel(translate(language, "reportReasonLabel")).setTextInputComponent(input));
    await interaction.showModal(form);
    return undefined;
  }

  // The report form was sent: post it for staff.
  async function reportSubmitted(interaction) {
    if (!interaction.inCachedGuild()) {
      return replyPrivately(interaction, "guildOnly");
    }
    const [channelId, messageId] = interaction.customId.slice(REPORT_FORM_PREFIX.length).split(":");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!reports.canReport(guild.id, interaction.user.id, now())) {
      return replyPrivately(interaction, "reportTooMany");
    }
    if (reports.openForMessage(guild.id, messageId)) {
      return replyPrivately(interaction, "reportAlreadyOpen", {}, Status.SUCCESS);
    }
    const message = await guild.channels.cache
      .get(channelId)
      ?.messages?.fetch(messageId)
      .catch(() => undefined);
    if (!message) {
      return replyPrivately(interaction, "reportMessageGone");
    }
    const target = reportChannel(guild);
    if (!target) {
      return replyPrivately(interaction, "reportNoChannel");
    }
    let reason = null;
    try {
      reason = interaction.fields.getTextInputValue(REPORT_REASON).trim().slice(0, MAX_REPORT_REASON) || null;
    } catch {
      // The form had no reason box.
    }
    const saved = reports.add({ guildId: guild.id, channelId, messageId, authorId: message.author.id, reporterId: interaction.user.id, reason, createdAt: now() });
    const timesReported = reports.recentAgainst(guild.id, message.author.id, now());
    try {
      const posted = await target.send(buildReportMessage({ report: saved, message, reporter: interaction.user, timesReported }));
      reports.setPost(saved.id, target.id, posted.id);
    } catch (error) {
      reports.remove(saved.id);
      logger.warn("Couldn't post a message report", { guildId: guild.id, error });
      return replyPrivately(interaction, "reportNoChannel", {}, Status.FAILED);
    }
    return replyPrivately(interaction, "reportSent", {}, Status.SUCCESS);
  }

  // Delete / Time out / Dismiss on a posted report.
  async function reportAction(interaction) {
    if (!interaction.inCachedGuild()) {
      return replyPrivately(interaction, "guildOnly");
    }
    const [idText, action] = interaction.customId.slice(REPORT_ACTION_PREFIX.length).split(":");
    const saved = reports.get(Number(idText));
    if (!saved || saved.guildId !== interaction.guildId) {
      return replyPrivately(interaction, "reportGone");
    }
    const permission = action === "timeout" ? PermissionFlagsBits.ModerateMembers : PermissionFlagsBits.ManageMessages;
    if (!isModerator(interaction, permission, guildSettings)) {
      return replyPrivately(interaction, "reportStaffOnly");
    }
    if (saved.status !== ReportStatus.OPEN) {
      return replyPrivately(interaction, "reportAlreadyHandled", { user: `<@${saved.handledBy}>` });
    }
    const guild = interaction.guild;
    const channel = guild.channels.cache.get(saved.channelId);
    const message = await channel?.messages?.fetch(saved.messageId).catch(() => undefined);
    let status = ReportStatus.DISMISSED;
    if (action === "delete") {
      if (message) {
        try {
          await message.delete();
        } catch (error) {
          logger.debug("Couldn't delete a reported message", { guildId: guild.id, error });
          return replyPrivately(interaction, "reportCouldNotDelete", {}, Status.FAILED);
        }
      }
      status = ReportStatus.DELETED;
    } else if (action === "timeout") {
      const member = await guild.members.fetch(saved.authorId).catch(() => undefined);
      if (!member) {
        return replyPrivately(interaction, "modMemberNotFound", { user: `<@${saved.authorId}>` });
      }
      const problem = hierarchyProblem({ moderator: interaction.member, target: member, bot: guild.members.me, ownerId: guild.ownerId, forTimeout: true });
      if (problem) {
        return replyPrivately(interaction, problem, { user: `<@${saved.authorId}>` });
      }
      await moderation.timeout({ guild, member, moderator: interaction.user, reason: `Reported message (report #${saved.id})`, durationMs: REPORT_TIMEOUT_MS });
      status = ReportStatus.TIMED_OUT;
    }
    const resolved = reports.resolve(saved.id, status, interaction.user.id);
    if (!resolved) {
      return replyPrivately(interaction, "reportAlreadyHandled", { user: "someone" });
    }
    await interaction.update(
      buildReportMessage({
        report: resolved,
        message,
        reporter: null,
        timesReported: reports.recentAgainst(guild.id, saved.authorId, now()),
        handled: { status, by: interaction.user.id },
      }),
    );
    return result(Status.SUCCESS, "reportHandledLog", { number: saved.id });
  }

  async function userInfo(interaction) {
    if (!interaction.inCachedGuild()) {
      return replyPrivately(interaction, "guildOnly");
    }
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const embed = buildUserInfoEmbed({
      user: interaction.targetUser,
      member: interaction.targetMember ?? undefined,
      guild: interaction.guild,
      language,
      color: accentColor(guildSettings, interaction.guildId, BRAND_COLOR),
    });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  async function history(interaction) {
    if (!interaction.inCachedGuild()) {
      return replyPrivately(interaction, "guildOnly");
    }
    if (!isModerator(interaction, PermissionFlagsBits.ModerateMembers, guildSettings)) {
      return replyPrivately(interaction, "modNoPermission", { permission: translate(pickLanguage(interaction.locale, forcedLanguage), "permModerateMembers") });
    }
    const user = interaction.targetUser;
    const counts = moderation.store.countCases(interaction.guildId, user.id);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      return replyPrivately(interaction, "modlogsNone", { user: `<@${user.id}>` }, Status.SUCCESS);
    }
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const cases = moderation.store.listCases(interaction.guildId, user.id, MODLOGS_LIMIT);
    await interaction.reply({ embeds: [buildModlogsEmbed(user, cases, total, language)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  return [
    {
      name: REPORT_COMMAND,
      data: menuData(REPORT_COMMAND, "contextReportMessage", ApplicationCommandType.Message),
      execute: report,
      componentPrefixes: {
        [REPORT_FORM_PREFIX]: { label: "Report form", handle: reportSubmitted },
        [REPORT_ACTION_PREFIX]: { label: "Report button", handle: reportAction },
      },
    },
    { name: USER_INFO_COMMAND, data: menuData(USER_INFO_COMMAND, "contextUserInfo", ApplicationCommandType.User), execute: userInfo },
    {
      name: HISTORY_COMMAND,
      data: menuData(HISTORY_COMMAND, "contextModHistory", ApplicationCommandType.User, PermissionFlagsBits.ModerateMembers),
      execute: history,
    },
  ];
}
