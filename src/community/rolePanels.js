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
} from "discord.js";
import { isModeratorRole, MODERATOR_PERMISSION_BITS } from "../permissions/moderatorPermissions.js";
import { Setting } from "../settings/guildSettings.js";

export const PanelMode = Object.freeze({ TOGGLE: "toggle", UNIQUE: "unique" });
export const MAX_PANELS = 10;
// Discord allows 5 rows of 5 buttons.
export const MAX_PANEL_ROLES = 25;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LABEL_LENGTH = 80;
export const BUTTON_PREFIX = "rp:";
// Confirm, under the "Add X?" question: "rpc:<panel>:<role>:<add|remove>".
export const CONFIRM_PREFIX = "rpc:";
export const PickAction = Object.freeze({ ADD: "add", REMOVE: "remove" });

// Roles members must never be able to give themselves.

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

export const confirmId = (panelId, roleId, action) => `${CONFIRM_PREFIX}${panelId}:${roleId}:${action}`;

export function parseConfirmId(customId) {
  const match = /^rpc:(\d+):(\d{17,20}):(add|remove)$/.exec(customId);
  return match ? { panelId: Number(match[1]), roleId: match[2], action: match[3] } : undefined;
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
  if (isModeratorRole(role)) {
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
// `color` is the server's embed colour (see branding/branding.js).
export function buildPanelMessage(panel, guild, emptyText, color = EMBED_COLOR) {
  return panelMessage(panel, (roleId) => guild.roles.cache.get(roleId)?.name, emptyText, color);
}

// The same message for the dashboard, which knows roles from Discord's API
// rather than a discord.js cache: `roleName(id)` gives a role's name.
export function panelMessage(panel, roleName, emptyText, color = EMBED_COLOR) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(panel.title)
    .setDescription(panel.description || (panel.roles.length === 0 ? emptyText : null) || null);
  const rows = [];
  panel.roles.forEach((entry, index) => {
    if (index % 5 === 0) {
      rows.push(new ActionRowBuilder());
    }
    const button = new ButtonBuilder()
      .setCustomId(buttonId(panel.id, entry.roleId))
      .setStyle(ButtonStyle.Secondary)
      .setLabel((entry.label || roleName(entry.roleId) || "Role").slice(0, MAX_LABEL_LENGTH));
    if (entry.emoji) {
      button.setEmoji(entry.emoji);
    }
    rows.at(-1).addComponents(button);
  });
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

// Shows the panel's current buttons: edits its message, or posts it again if
// the message was deleted. Returns the panel with its (maybe new) message ID.
export async function publishPanel(panel, guild, emptyText, color = undefined) {
  const channel = guild.channels.cache.get(panel.channelId);
  if (!channel?.isTextBased?.()) {
    throw Object.assign(new Error("The panel's channel no longer exists"), { code: "NO_CHANNEL" });
  }
  const payload = buildPanelMessage(panel, guild, emptyText, color);
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

// --- Panels made on the dashboard ----------------------------------------------

export class InvalidPanel extends Error {}

// Why a role (as Discord's API gives it) can't go on a panel, in English for
// the dashboard, or undefined if it can. The same rules as roleProblem:
// `botTop` and `adminTop` are the positions of the bot's and the admin's
// highest roles; the owner may add roles above their own.
export function apiRoleProblem(role, { guildId, botTop, adminTop, isOwner }) {
  const name = `@${role.name}`;
  if (role.id === guildId) {
    return "@everyone can't go on a role panel.";
  }
  if (role.managed) {
    return `${name} belongs to a bot or integration, so nobody can be given it.`;
  }
  if ((BigInt(role.permissions ?? 0) & MODERATOR_PERMISSION_BITS) !== 0n) {
    return `${name} has moderator permissions, so members can't give it to themselves.`;
  }
  if (role.position >= botTop) {
    return `${name} is above the bot's highest role. Move the bot's role above it first.`;
  }
  if (!isOwner && role.position >= adminTop) {
    return `${name} is above your highest role.`;
  }
  return undefined;
}

const PANEL_FIELDS = ["channelId", "title", "description", "mode", "roles"];

// Checks a panel sent by the dashboard: { channelId, title, description, mode,
// roles: [{ roleId, emoji, label }] }. Returns the cleaned panel content
// (without id or messageId), or throws InvalidPanel with a message for the
// person. `channelIds` are the channels the panel may be posted in; `roles`
// are the server's roles from Discord's API.
export function checkPanelInput(body, { channelIds, roles, ...ranks }) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !PANEL_FIELDS.includes(key))) {
    throw new InvalidPanel("That isn't a role panel.");
  }
  const { channelId, title, description = "", mode = PanelMode.TOGGLE, roles: entries = [] } = body;
  if (typeof channelId !== "string" || !channelIds.has(channelId)) {
    throw new InvalidPanel("Pick a text or announcement channel for the panel.");
  }
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle || cleanTitle.length > MAX_TITLE_LENGTH) {
    throw new InvalidPanel(`The title is 1 to ${MAX_TITLE_LENGTH} characters.`);
  }
  if (typeof description !== "string" || description.trim().length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidPanel(`The text is at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (!Object.values(PanelMode).includes(mode)) {
    throw new InvalidPanel("Pick whether members can take any number of the roles or only one.");
  }
  if (!Array.isArray(entries) || entries.length > MAX_PANEL_ROLES) {
    throw new InvalidPanel(`A panel has at most ${MAX_PANEL_ROLES} roles.`);
  }
  const seen = new Set();
  const cleanRoles = entries.map((entry) => {
    const role = roles.find((candidate) => candidate.id === entry?.roleId);
    if (!role) {
      throw new InvalidPanel("One of the roles no longer exists. Reload the page.");
    }
    if (seen.has(role.id)) {
      throw new InvalidPanel(`@${role.name} is on the panel twice.`);
    }
    seen.add(role.id);
    const problem = apiRoleProblem(role, ranks);
    if (problem) {
      throw new InvalidPanel(problem);
    }
    const emojiText = typeof entry.emoji === "string" ? entry.emoji.trim() : "";
    const emoji = emojiText ? cleanEmoji(emojiText) : null;
    if (emojiText && !emoji) {
      throw new InvalidPanel(`The emoji for @${role.name} isn't one Discord accepts. Use one emoji, or a server emoji like <:name:123>.`);
    }
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (label.length > MAX_LABEL_LENGTH) {
      throw new InvalidPanel(`Button text is at most ${MAX_LABEL_LENGTH} characters.`);
    }
    return { roleId: role.id, emoji, label: label || null };
  });
  return { channelId, title: cleanTitle, description: description.replace(/\r\n?/g, "\n").trim(), mode, roles: cleanRoles };
}
