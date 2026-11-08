// Support tickets: a panel with an "Open a ticket" button. Each ticket is a
// private thread in the panel's channel, where only the member and staff can
// talk. Discord has no ticket feature of its own; private threads are the
// closest thing, so that's what this builds on.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { moderatorRoleId } from "../moderation/checks.js";
import { Setting } from "../settings/guildSettings.js";
import { findCategory, normalizeCategories } from "./categories.js";
import { DEFAULT_NAME_FORMAT, fillTemplate, formatThreadName, normalizeLook, PANEL_LIMITS } from "./panel.js";

export const OPEN_BUTTON = "tk:open";
export const CLOSE_BUTTON = "tk:close";
export const FORM_ID = "tk:form";
export const FORM_INPUT = "subject";
// A category's button and form: "tk:open:<category id>", "tk:form:<category id>".
export const OPEN_PREFIX = "tk:open:";
export const FORM_PREFIX = "tk:form:";
// The panel's dropdown, when it shows categories as a menu.
export const MENU_ID = "tk:menu";
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

export const TICKET_COLOR = 0x5865f2;
const BUTTONS_PER_ROW = 5;
const MAX_MENU_DESCRIPTION = 100;

export const serverLanguage = (guild, forcedLanguage) => pickLanguage(guild?.preferredLocale, forcedLanguage);

// The saved panel { channelId, messageId, staffRoleId, title, message }, or undefined.
export function ticketSettings(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TICKETS);
  return saved?.channelId ? saved : undefined;
}

export const ticketCategories = (guildSettings, guildId) => normalizeCategories(guildSettings.get(guildId, Setting.TICKET_CATEGORIES));

// How the panel looks (tickets/panel.js). Servers that set their panel up
// before the look was its own setting have the title and text saved with the
// panel, so those are used until the look is saved.
export function panelLook(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TICKET_PANEL);
  if (saved) {
    return normalizeLook(saved);
  }
  const panel = guildSettings.get(guildId, Setting.TICKETS);
  return normalizeLook({ title: panel?.title ?? null, description: panel?.message ?? null });
}

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

const paddedNumber = (number) => String(number).padStart(4, "0");

// "🎫 0007 · Rumbler", within Discord's 100 characters.
export const threadName = (number, name) => formatThreadName(DEFAULT_NAME_FORMAT, { number: paddedNumber(number), user: name });

// A new ticket's thread name from the category's or panel's format.
export function ticketThreadName(format, { number, displayName, username, category, server }) {
  return formatThreadName(format, { number: paddedNumber(number), user: displayName, username, category: category ?? "ticket", server });
}

const BUTTON_STYLE = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

// The embed's fields that still fit in Discord's 6,000 characters.
function fieldsWithin(fields, used) {
  const kept = [];
  let total = used;
  for (const entry of fields) {
    total += entry.name.length + entry.value.length;
    if (total > PANEL_LIMITS.total || kept.length >= 25) {
      break;
    }
    kept.push(entry);
  }
  return kept;
}

const categoryName = (category) => `${category.emoji ? `${category.emoji} ` : ""}${category.label}`;

// The panel: the embed from the look, and a button per category (or the
// single "Open a ticket" button), or a dropdown. With buttons, categories
// that have a description are listed in the embed; a dropdown shows them itself.
// `color` is the server's embed colour (see branding/branding.js), used when
// the look has none.
export function buildPanelMessage(language, { look: saved, categories = [], color = TICKET_COLOR }) {
  const look = normalizeLook(saved);
  const embed = new EmbedBuilder()
    .setColor(look.color ?? color)
    .setTitle(look.title || translate(language, "ticketPanelDefaultTitle"))
    .setDescription(look.description || translate(language, "ticketPanelDefaultMessage"));
  if (look.authorName) {
    embed.setAuthor({ name: look.authorName, ...(look.authorIconUrl ? { iconURL: look.authorIconUrl } : {}) });
  }
  if (look.imageUrl) {
    embed.setImage(look.imageUrl);
  }
  if (look.thumbnailUrl) {
    embed.setThumbnail(look.thumbnailUrl);
  }
  if (look.footer) {
    embed.setFooter({ text: look.footer });
  }
  const described = look.layout === "menu" && categories.length > 0 ? [] : categories.filter((category) => category.description);
  if (described.length > 0) {
    const json = embed.toJSON();
    const used = [json.title, json.description, json.author?.name, json.footer?.text].join("").length;
    embed.addFields(fieldsWithin(described.map((category) => ({ name: categoryName(category), value: category.description })), used));
  }
  return { embeds: [embed], components: buildPanelComponents(language, { look, categories }) };
}

// The panel's rows: buttons, five to a row, or one dropdown.
export function buildPanelComponents(language, { look: saved, categories = [] }) {
  const look = normalizeLook(saved);
  if (categories.length === 0) {
    const button = new ButtonBuilder()
      .setCustomId(OPEN_BUTTON)
      .setStyle(BUTTON_STYLE[look.buttonStyle])
      .setEmoji(look.buttonEmoji ?? "🎫")
      .setLabel(look.buttonLabel ?? translate(language, "ticketOpenButton"));
    return [new ActionRowBuilder().addComponents(button)];
  }
  if (look.layout === "menu") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(MENU_ID)
      .setPlaceholder(look.menuPlaceholder ?? translate(language, "ticketMenuPlaceholder"))
      .addOptions(
        categories.map((category) => ({
          label: category.label.slice(0, 100),
          value: category.id,
          ...(category.description
            ? { description: category.description.length > MAX_MENU_DESCRIPTION ? `${category.description.slice(0, MAX_MENU_DESCRIPTION - 1)}…` : category.description }
            : {}),
          ...(category.emoji ? { emoji: category.emoji } : {}),
        })),
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }
  const rows = [];
  for (let index = 0; index < categories.length; index += BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder().addComponents(
        categories.slice(index, index + BUTTONS_PER_ROW).map((category) => {
          const button = new ButtonBuilder().setCustomId(`${OPEN_PREFIX}${category.id}`).setStyle(BUTTON_STYLE[category.style] ?? ButtonStyle.Primary).setLabel(category.label);
          return category.emoji ? button.setEmoji(category.emoji) : button;
        }),
      ),
    );
  }
  return rows;
}

// The first message in a ticket: the intro (the category's, the panel's or
// the built-in one), what the member answered, and the Close button.
// `ping` says whether the staff role is pinged; when it is and the intro
// doesn't mention it, the mention goes on a line of its own.
// Returns the message and whether the staff role is mentioned in it.
export function buildTicketWelcome(language, { ticket, staffRoleId, color = TICKET_COLOR, intro = null, ping = true, server = "" }) {
  const staffMention = staffRoleId ? `<@&${staffRoleId}>` : null;
  const values = {
    user: `<@${ticket.userId}>`,
    username: ticket.userName ?? "",
    number: String(ticket.number),
    staff: staffMention ?? translate(language, "ticketStaffWord"),
    category: ticket.categoryLabel ?? "",
    server,
  };
  let content = intro ? fillTemplate(intro, values) : translate(language, staffRoleId ? "ticketWelcome" : "ticketWelcomeNoStaff", values);
  if (ping && staffMention && !content.includes(staffMention)) {
    content = `${content}\n${staffMention}`;
  }
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(ticket.categoryLabel ?? translate(language, "ticketSubject"))
    .setDescription(ticket.subject.slice(0, 4096))
    .setTimestamp(ticket.createdAt);
  const button = new ButtonBuilder()
    .setCustomId(CLOSE_BUTTON)
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🔒")
    .setLabel(translate(language, "ticketCloseButton"));
  const pingsStaff = Boolean(ping && staffMention);
  return {
    content: content.slice(0, 2000),
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { users: [ticket.userId], roles: pingsStaff ? [staffRoleId] : [] },
  };
}

// Brings the staff role into a private thread. Mentioning a role adds everyone
// who has it, but only when the role can be pinged; otherwise the people in
// the bot's member cache who have it are added one by one.
// With `pinged` false (the welcome didn't ping the role) they're added one by
// one too, which brings them in without a ping.
export async function addStaff({ thread, guild, staffRoleId, logger, pinged = true }) {
  const role = staffRoleId && guild.roles.cache.get(staffRoleId);
  if (!role) {
    return { pinged: false };
  }
  const canPing = role.mentionable || guild.members.me?.permissions?.has(PermissionFlagsBits.MentionEveryone);
  if (pinged && canPing) {
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
