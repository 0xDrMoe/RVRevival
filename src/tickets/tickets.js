// Support tickets: a panel with an "Open a ticket" button. Each ticket is a
// private thread in the panel's channel, where only the member and staff can
// talk. Discord has no ticket feature of its own; private threads are the
// closest thing, so that's what this builds on.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { moderatorRoleId } from "../moderation/checks.js";
import { Setting } from "../settings/guildSettings.js";
import { findCategory, normalizeCategories } from "./categories.js";

export const OPEN_BUTTON = "tk:open";
export const CLOSE_BUTTON = "tk:close";
export const FORM_ID = "tk:form";
export const FORM_INPUT = "subject";
// A category's button and form: "tk:open:<category id>", "tk:form:<category id>".
export const OPEN_PREFIX = "tk:open:";
export const FORM_PREFIX = "tk:form:";
export const questionInput = (index) => `q${index}`;

export const MAX_SUBJECT_LENGTH = 1000;
export const MAX_TITLE_LENGTH = 100;
export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_REASON_LENGTH = 300;
// Open tickets per server, so a raid can't fill a channel with threads.
export const MAX_OPEN_TICKETS = 50;
// Staff added one by one when their role can't be pinged into the thread.
export const MAX_STAFF_ADDED = 25;

// What the bot needs in the panel's channel.
export const TICKET_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
];

const TICKET_COLOR = 0x5865f2;

export const serverLanguage = (guild, forcedLanguage) => pickLanguage(guild?.preferredLocale, forcedLanguage);

// The saved panel { channelId, messageId, staffRoleId }, or undefined.
export function ticketSettings(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TICKETS);
  return saved?.channelId ? saved : undefined;
}

export const ticketCategories = (guildSettings, guildId) => normalizeCategories(guildSettings.get(guildId, Setting.TICKET_CATEGORIES));

// The role added to every ticket: the panel's staff role, else the mod role (or staff role).
export function ticketStaffRoleId(guildSettings, guildId) {
  return ticketSettings(guildSettings, guildId)?.staffRoleId ?? moderatorRoleId(guildSettings, guildId) ?? null;
}

// The staff role of a ticket's category, if it has its own.
export function categoryStaffRoleId(guildSettings, guildId, categoryId) {
  return findCategory(ticketCategories(guildSettings, guildId), categoryId)?.staffRoleId ?? null;
}

// Who may close any ticket, add or remove people, and list tickets: people who
// can manage threads or the server, and the ticket staff role or mod role.
// Inside a ticket (`ticket`), its category's staff role too.
export function isTicketStaff(interaction, guildSettings, ticket) {
  const permissions = interaction.memberPermissions;
  if (permissions?.has(PermissionFlagsBits.ManageThreads) || permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }
  const roles = interaction.member?.roles?.cache;
  const guildId = interaction.guildId;
  return [
    ticketStaffRoleId(guildSettings, guildId),
    moderatorRoleId(guildSettings, guildId),
    ticket?.categoryId ? categoryStaffRoleId(guildSettings, guildId, ticket.categoryId) : null,
  ].some((roleId) => roleId && roles?.has(roleId));
}

// "🎫 0007 · Rumbler", within Discord's 100 characters.
export const threadName = (number, name) => `🎫 ${String(number).padStart(4, "0")} · ${name}`.slice(0, 100);

// The panel: the title and message, and one button per category (or the
// single "Open a ticket" button). Categories with a description are listed.
export function buildPanelMessage(language, { title, message, categories = [] }) {
  const embed = new EmbedBuilder()
    .setColor(TICKET_COLOR)
    .setTitle(title || translate(language, "ticketPanelDefaultTitle"))
    .setDescription(message || translate(language, "ticketPanelDefaultMessage"));
  const described = categories.filter((category) => category.description);
  if (described.length > 0) {
    embed.addFields(described.map((category) => ({ name: `${category.emoji ? `${category.emoji} ` : ""}${category.label}`, value: category.description })));
  }
  return { embeds: [embed], components: [buildPanelButtons(language, categories)] };
}

export function buildPanelButtons(language, categories = []) {
  const buttons =
    categories.length > 0
      ? categories.map((category) => {
          const button = new ButtonBuilder().setCustomId(`${OPEN_PREFIX}${category.id}`).setStyle(ButtonStyle.Primary).setLabel(category.label);
          return category.emoji ? button.setEmoji(category.emoji) : button;
        })
      : [new ButtonBuilder().setCustomId(OPEN_BUTTON).setStyle(ButtonStyle.Primary).setEmoji("🎫").setLabel(translate(language, "ticketOpenButton"))];
  return new ActionRowBuilder().addComponents(buttons);
}

// The first message in a ticket: who opened it, why, and the Close button.
export function buildTicketWelcome(language, { ticket, staffRoleId }) {
  const values = { user: `<@${ticket.userId}>`, number: ticket.number, staff: `<@&${staffRoleId}>` };
  const embed = new EmbedBuilder()
    .setColor(TICKET_COLOR)
    .setTitle(ticket.categoryLabel ?? translate(language, "ticketSubject"))
    .setDescription(ticket.subject.slice(0, 4096))
    .setTimestamp(ticket.createdAt);
  const button = new ButtonBuilder()
    .setCustomId(CLOSE_BUTTON)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔒")
    .setLabel(translate(language, "ticketCloseButton"));
  return {
    content: translate(language, staffRoleId ? "ticketWelcome" : "ticketWelcomeNoStaff", values),
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
  };
}

// Brings the staff role into a private thread. Mentioning a role adds everyone
// who has it, but only when the role can be pinged; otherwise the people in
// the bot's member cache who have it are added one by one.
export async function addStaff({ thread, guild, staffRoleId, logger }) {
  const role = staffRoleId && guild.roles.cache.get(staffRoleId);
  if (!role) {
    return { pinged: false };
  }
  const canPing = role.mentionable || guild.members.me?.permissions?.has(PermissionFlagsBits.MentionEveryone);
  if (canPing) {
    return { pinged: true };
  }
  const staff = [...role.members.values()].filter((member) => !member.user?.bot).slice(0, MAX_STAFF_ADDED);
  for (const member of staff) {
    await thread.members.add(member.id).catch((error) =>
      logger.debug("Couldn't add a staff member to a ticket", { guildId: guild.id, userId: member.id, error }),
    );
  }
  return { pinged: false };
}

// The mod-log entry for a closed ticket, in English like every log entry.
export function buildTicketLogEmbed({ ticket, closedBy, messageCount }) {
  const embed = new EmbedBuilder()
    .setColor(TICKET_COLOR)
    .setTitle(`🎫 Ticket #${ticket.number} closed`)
    .addFields(
      { name: "Opened by", value: `<@${ticket.userId}>`, inline: true },
      { name: "Closed by", value: closedBy ? `<@${closedBy}>` : "—", inline: true },
      { name: "Messages", value: String(messageCount ?? "—"), inline: true },
      ...(ticket.categoryLabel ? [{ name: "Category", value: ticket.categoryLabel.slice(0, 1024) }] : []),
      { name: "Subject", value: ticket.subject.slice(0, 1024) },
    )
    .setTimestamp(ticket.closedAt ?? Date.now());
  if (ticket.threadId) {
    embed.setDescription(`<#${ticket.threadId}>`);
  }
  if (ticket.closeReason) {
    embed.addFields({ name: "Reason", value: ticket.closeReason.slice(0, 1024) });
  }
  return embed;
}
