// Support tickets: a panel with an "Open a ticket" button. Each ticket is a
// private thread in the panel's channel, or (a panel's choice) a private
// channel of its own in a category, where only the member and staff can talk.
// Discord has no ticket feature of its own; private threads are the closest
// thing, and channels are what the big ticket bots use.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits, StringSelectMenuBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { moderatorRoleId } from "../moderation/checks.js";
import { Setting } from "../settings/guildSettings.js";
import { findCategory } from "./categories.js";
import { findPanel, mainPanelCategories, mainPanelLook, panelCustomId, ticketPanels } from "./panels.js";
import { DEFAULT_NAME_FORMAT, fillTemplate, formatChannelName, formatThreadName, normalizeLook, PANEL_LIMITS } from "./panel.js";

export const OPEN_BUTTON = "tk:open";
export const CLOSE_BUTTON = "tk:close";
export const CLAIM_BUTTON = "tk:claim";
// "tk:rate:<ticket id>:<1-5>", sent by DM when a ticket closes (tickets/support.js).
export const RATE_PREFIX = "tk:rate:";
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

// What the bot needs where ticket channels are made (their category, or the
// server when there's none): making, hiding and deleting them, and letting
// people in and out (Manage Roles is "Manage Permissions" on a channel).
export const TICKET_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];
// What everyone in a ticket channel can do: the member, staff roles and people added.
export const TICKET_CHANNEL_ACCESS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];
// The same, as permissionOverwrites.edit takes it.
export const TICKET_CHANNEL_ACCESS_EDIT = Object.freeze({
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  AttachFiles: true,
  EmbedLinks: true,
});
// Discord's limit on channels in one category.
export const MAX_CATEGORY_CHANNELS = 50;
// How long a closed ticket stays before it's deleted, so people see it close.
export const CLOSE_DELETE_DELAY_MS = 5_000;

export const TICKET_COLOR = 0x5865f2;

// The DM asking a member to rate the help they got, 1 to 5 stars.
export function buildRatingRequest(language, { ticket, serverName }) {
  const row = new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((stars) =>
      new ButtonBuilder()
        .setCustomId(`${RATE_PREFIX}${ticket.id}:${stars}`)
        .setStyle(stars >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setLabel("⭐".repeat(stars)),
    ),
  );
  return {
    content: translate(language, "ticketRatingAsk", { number: ticket.number, server: serverName }),
    components: [row],
    allowedMentions: { parse: [] },
  };
}
const BUTTONS_PER_ROW = 5;
const MAX_MENU_DESCRIPTION = 100;

export const serverLanguage = (guild, forcedLanguage) => pickLanguage(guild?.preferredLocale, forcedLanguage);

// The main panel's saved message { channelId, messageId, … }, or undefined
// when it isn't posted. Other panels: tickets/panels.js.
export function ticketSettings(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TICKETS);
  return saved?.channelId ? saved : undefined;
}

// The main panel's categories and look (tickets/panels.js has every panel's).
export const ticketCategories = mainPanelCategories;
export const panelLook = mainPanelLook;

// The roles brought into a new ticket: the category's staff roles, else the
// panel's, else the mod role.
export function ticketStaffRoleIds(guildSettings, guildId, panel, category = null) {
  if (category?.staffRoleIds?.length > 0) {
    return category.staffRoleIds;
  }
  if (panel?.staffRoleIds?.length > 0) {
    return panel.staffRoleIds;
  }
  const modRoleId = moderatorRoleId(guildSettings, guildId);
  return modRoleId ? [modRoleId] : [];
}

// Who may open a ticket from this category (or panel): members with one of
// its roles, when it has any (the category's, else the panel's). Server
// managers always may, so they can test it.
export function mayOpen(interaction, panel, category = null) {
  const allowed = category?.openRoleIds?.length > 0 ? category.openRoleIds : (panel?.openRoleIds ?? []);
  if (allowed.length === 0 || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return { allowed: true, roleIds: allowed };
  }
  const roles = interaction.member?.roles?.cache;
  return { allowed: allowed.some((roleId) => roles?.has(roleId)), roleIds: allowed };
}

// Every staff role that may handle a ticket: its panel's and its category's.
// Without a ticket (/tickets list), every panel's and category's.
function staffRolesFor(guildSettings, guildId, ticket) {
  const panels = ticket ? [findPanel(guildSettings, guildId, ticket.panelId)].filter(Boolean) : ticketPanels(guildSettings, guildId);
  return panels.flatMap((panel) => {
    const categories = ticket ? [findCategory(panel.categories, ticket.categoryId)].filter(Boolean) : panel.categories;
    return [...panel.staffRoleIds, ...categories.flatMap((category) => category.staffRoleIds)];
  });
}

// Who may close any ticket, add or remove people, and list tickets: people who
// can manage threads or the server, the mod role, and the staff roles of the
// ticket's panel and category (outside a ticket, of any panel or category).
export function isTicketStaff(interaction, guildSettings, ticket) {
  const permissions = interaction.memberPermissions;
  if (permissions?.has(PermissionFlagsBits.ManageThreads) || permissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }
  const roles = interaction.member?.roles?.cache;
  const guildId = interaction.guildId;
  return [moderatorRoleId(guildSettings, guildId), ...staffRolesFor(guildSettings, guildId, ticket)].some((roleId) => roleId && roles?.has(roleId));
}

const paddedNumber = (number) => String(number).padStart(4, "0");

// "🎫 0007 · Rumbler", within Discord's 100 characters.
export const threadName = (number, name) => formatThreadName(DEFAULT_NAME_FORMAT, { number: paddedNumber(number), user: name });

// A new ticket's thread name from the category's or panel's format.
export function ticketThreadName(format, { number, displayName, username, category, server }) {
  return formatThreadName(format, { number: paddedNumber(number), user: displayName, username, category: category ?? "ticket", server });
}

// A new ticket channel's name from the category's or panel's format.
export function ticketChannelName(format, { number, displayName, username, category, server }) {
  return formatChannelName(format, { number: paddedNumber(number), user: displayName, username, category: category ?? "ticket", server });
}

// Whether a ticket lives in a channel of its own (else a thread).
export const isTicketChannel = (place) => place?.type === ChannelType.GuildText;

const isCategory = (channel) => channel?.type === ChannelType.GuildCategory;
const channelsIn = (guild, categoryId) => [...guild.channels.cache.values()].filter((channel) => channel.parentId === categoryId && !channel.isThread?.()).length;

// Where a panel's next ticket channel goes: its own category, else the panel
// channel's (else none). { parent } when the bot can make it there, or
// { problem: "full" | "permissions" }.
export function ticketChannelParent(guild, panelChannel, look) {
  const chosen = look.categoryId ? guild.channels.cache.get(look.categoryId) : null;
  const parent = isCategory(chosen) ? chosen : isCategory(panelChannel?.parent) ? panelChannel.parent : null;
  const me = guild.members.me;
  const permissions = parent ? parent.permissionsFor(me) : me?.permissions;
  if (!me || !permissions?.has(TICKET_CHANNEL_PERMISSIONS)) {
    return { problem: "permissions", parent };
  }
  if (parent && channelsIn(guild, parent.id) >= MAX_CATEGORY_CHANNELS) {
    return { problem: "full", parent };
  }
  return { parent };
}

// Whether a category can take one more channel.
export const categoryHasRoom = (guild, categoryId) => isCategory(guild.channels.cache.get(categoryId)) && channelsIn(guild, categoryId) < MAX_CATEGORY_CHANNELS;

// A ticket channel's permissions: hidden from everyone but the member, the
// staff roles and the bot (server admins see every channel anyway).
export function ticketChannelOverwrites({ guild, userId, staffRoleIds = [] }) {
  const botId = guild.members.me?.id;
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: userId, type: OverwriteType.Member, allow: TICKET_CHANNEL_ACCESS },
    ...staffRoleIds.filter((id) => id !== guild.id && guild.roles.cache.has(id)).map((id) => ({ id, type: OverwriteType.Role, allow: TICKET_CHANNEL_ACCESS })),
    ...(botId ? [{ id: botId, type: OverwriteType.Member, allow: [...TICKET_CHANNEL_ACCESS, PermissionFlagsBits.ManageChannels] }] : []),
  ];
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
// `panelId` puts the panel in the buttons' IDs (none for the main panel).
export function buildPanelMessage(language, { look: saved, categories = [], color = TICKET_COLOR, panelId = null }) {
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
  return { embeds: [embed], components: buildPanelComponents(language, { look, categories, panelId }) };
}

// The panel's rows: buttons, five to a row, or one dropdown.
export function buildPanelComponents(language, { look: saved, categories = [], panelId = null }) {
  const look = normalizeLook(saved);
  if (categories.length === 0) {
    const button = new ButtonBuilder()
      .setCustomId(panelCustomId(panelId, "open"))
      .setStyle(BUTTON_STYLE[look.buttonStyle])
      .setEmoji(look.buttonEmoji ?? "🎫")
      .setLabel(look.buttonLabel ?? translate(language, "ticketOpenButton"));
    return [new ActionRowBuilder().addComponents(button)];
  }
  if (look.layout === "menu") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(panelCustomId(panelId, "menu"))
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
          const button = new ButtonBuilder().setCustomId(panelCustomId(panelId, "open", category.id)).setStyle(BUTTON_STYLE[category.style] ?? ButtonStyle.Primary).setLabel(category.label);
          return category.emoji ? button.setEmoji(category.emoji) : button;
        }),
      ),
    );
  }
  return rows;
}

// The first message in a ticket: the intro (the category's, the panel's or
// the built-in one), what the member answered, and the Close button.
// `ping` says whether the staff roles are pinged; when they are and the intro
// doesn't mention them, the mentions go on a line of their own.
// `extraButtons` go after Close and Claim (the AI assistant's Staff assist).
export function buildTicketWelcome(language, { ticket, staffRoleIds = [], color = TICKET_COLOR, intro = null, ping = true, server = "", extraButtons = [] }) {
  const staffMention = staffRoleIds.length > 0 ? staffRoleIds.map((id) => `<@&${id}>`).join(" ") : null;
  const values = {
    user: `<@${ticket.userId}>`,
    username: ticket.userName ?? "",
    number: String(ticket.number),
    staff: staffMention ?? translate(language, "ticketStaffWord"),
    category: ticket.categoryLabel ?? "",
    server,
  };
  let content = intro ? fillTemplate(intro, values) : translate(language, staffMention ? "ticketWelcome" : "ticketWelcomeNoStaff", values);
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
  const claim = new ButtonBuilder()
    .setCustomId(CLAIM_BUTTON)
    .setStyle(ButtonStyle.Primary)
    .setEmoji("🙋")
    .setLabel(translate(language, "ticketClaimButton"));
  const pingsStaff = Boolean(ping && staffMention);
  return {
    content: content.slice(0, 2000),
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button, claim, ...extraButtons)],
    allowedMentions: { users: [ticket.userId], roles: pingsStaff ? staffRoleIds : [] },
  };
}

// Brings the staff roles into a private thread. Mentioning a role adds
// everyone who has it, but only when the role can be pinged; otherwise the
// people in the bot's member cache who have it are added one by one (at most
// MAX_STAFF_ADDED people across all the roles).
// With `pinged` false (the welcome didn't ping the roles) they're added one by
// one too, which brings them in without a ping.
// Returns whether every role was brought in by its mention.
export async function addStaff({ thread, guild, staffRoleIds = [], logger, pinged = true }) {
  const roles = staffRoleIds.map((id) => guild.roles.cache.get(id)).filter(Boolean);
  if (roles.length === 0) {
    return { pinged: false };
  }
  const canPingAll = guild.members.me?.permissions?.has(PermissionFlagsBits.MentionEveryone);
  const byHand = roles.filter((role) => !(pinged && (role.mentionable || canPingAll)));
  const added = new Set();
  for (const role of byHand) {
    for (const member of role.members.values()) {
      if (member.user?.bot || added.has(member.id) || added.size >= MAX_STAFF_ADDED) {
        continue;
      }
      added.add(member.id);
      await thread.members.add(member.id).catch((error) =>
        logger.debug("Couldn't add a staff member to a ticket", { guildId: guild.id, userId: member.id, error }),
      );
    }
  }
  return { pinged: byHand.length === 0 };
}
