// Button role panels: a message with a button per role, where members give
// themselves roles (platforms, regions, ping roles for events or playtests).
// Each panel is saved in the server's settings (Setting.ROLE_PANELS) as
//
//   { id, channelId, messageId, title, description, mode, roles: [{ roleId, emoji, label }] }
//
// In "toggle" mode a button adds the role, or removes it if the member has it.
// In "unique" mode a member can only have one of the panel's roles at a time.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { Setting } from "../settings/guildSettings.js";

export const PanelMode = Object.freeze({ TOGGLE: "toggle", UNIQUE: "unique" });
export const MAX_PANELS = 10;
// Discord allows 5 rows of 5 buttons.
export const MAX_PANEL_ROLES = 25;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LABEL_LENGTH = 80;
export const BUTTON_PREFIX = "rp:";

// Roles members must never be able to give themselves.
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ViewAuditLog,
];

const EMBED_COLOR = 0x5865f2;
// A custom emoji (<:name:id> or <a:name:id>), or a few characters that are an emoji.
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;

// The emoji as Discord accepts it, or undefined if it isn't one.
export function cleanEmoji(text) {
  const emoji = String(text ?? "").trim();
  if (CUSTOM_EMOJI.test(emoji)) {
    return emoji;
  }
  return emoji.length <= 16 && UNICODE_EMOJI.test(emoji) && !/[\p{L}\s]/u.test(emoji) ? emoji : undefined;
}

export const buttonId = (panelId, roleId) => `${BUTTON_PREFIX}${panelId}:${roleId}`;

export function parseButtonId(customId) {
  const match = /^rp:(\d+):(\d{17,20})$/.exec(customId);
  return match ? { panelId: Number(match[1]), roleId: match[2] } : undefined;
}

// Why a role can't go on a panel (a translation key), or undefined if it can.
// `admin` is the member adding it, `bot` the bot's member.
export function roleProblem(role, { guild, admin, bot }) {
  if (role.id === guild.id) {
    return "rolePanelEveryone";
  }
  if (role.managed) {
    return "rolePanelManaged";
  }
  if (DANGEROUS_PERMISSIONS.some((permission) => role.permissions?.has(permission))) {
    return "rolePanelDangerous";
  }
  if (!bot || role.position >= bot.roles.highest.position) {
    return "rolePanelAboveBot";
  }
  if (admin && admin.id !== guild.ownerId && role.position >= admin.roles.highest.position) {
    return "rolePanelAboveYou";
  }
  return undefined;
}

// The panel's message: an embed with the title and description, and its buttons.
export function buildPanelMessage(panel, guild, emptyText) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(panel.title)
    .setDescription(panel.description || (panel.roles.length === 0 ? emptyText : null) || null);
  const rows = [];
  panel.roles.forEach((entry, index) => {
    if (index % 5 === 0) {
      rows.push(new ActionRowBuilder());
    }
    const roleName = guild.roles.cache.get(entry.roleId)?.name ?? "Role";
    const button = new ButtonBuilder()
      .setCustomId(buttonId(panel.id, entry.roleId))
      .setStyle(ButtonStyle.Secondary)
      .setLabel((entry.label || roleName).slice(0, MAX_LABEL_LENGTH));
    if (entry.emoji) {
      button.setEmoji(entry.emoji);
    }
    rows.at(-1).addComponents(button);
  });
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

// Shows the panel's current buttons: edits its message, or posts it again if
// the message was deleted. Returns the panel with its (maybe new) message ID.
export async function publishPanel(panel, guild, emptyText) {
  const channel = guild.channels.cache.get(panel.channelId);
  if (!channel?.isTextBased?.()) {
    throw Object.assign(new Error("The panel's channel no longer exists"), { code: "NO_CHANNEL" });
  }
  const payload = buildPanelMessage(panel, guild, emptyText);
  if (panel.messageId) {
    const existing = await channel.messages.fetch(panel.messageId).catch(() => undefined);
    if (existing) {
      await existing.edit(payload);
      return panel;
    }
  }
  const message = await channel.send(payload);
  return { ...panel, messageId: message.id };
}

// The server's panels, with anything malformed dropped.
export function panelsOf(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.ROLE_PANELS);
  return Array.isArray(saved) ? saved.filter((panel) => panel && Number.isInteger(panel.id) && Array.isArray(panel.roles)) : [];
}
