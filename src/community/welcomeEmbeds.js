// Embeds for the welcome message, the leave message and the welcome DM
// (/welcome embed or the dashboard's Welcome page).
//
// Each one is saved as an embed in Discord's shape (see messages/embedMessage.js)
// whose text can use the "welcome" variables, like "Welcome to {server}!".
// Two extras:
//   color          unset = the server's Branding colour (else Rabble's violet)
//   memberAvatar   true = the member's avatar as the thumbnail (this beats a thumbnail link)
//
// With an embed on, the message text is optional: only text the server wrote
// is sent with it, never the default "Welcome {user}!" line.

import { escapeMarkdown } from "discord.js";
import { accentColor } from "../branding/branding.js";
import { fillVariables, variableError } from "../dashboard/public/variables.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { checkEmbed, InvalidMessage, LIMITS } from "../messages/embedMessage.js";
import { Setting } from "../settings/guildSettings.js";

export const WELCOME_EMBED_KINDS = Object.freeze(["welcome", "leave", "dm"]);

// Which setting holds each kind's embed and its text.
export const EMBED_SETTING = Object.freeze({
  welcome: Setting.WELCOME_EMBED,
  leave: Setting.LEAVE_EMBED,
  dm: Setting.WELCOME_DM_EMBED,
});
export const TEXT_SETTING = Object.freeze({
  welcome: Setting.WELCOME_MESSAGE,
  leave: Setting.LEAVE_MESSAGE,
  dm: Setting.WELCOME_DM,
});

// The text parts of an embed that can use variables, with a name for errors.
function textParts(embed) {
  return [
    ["title", embed.title],
    ["description", embed.description],
    ["author", embed.author?.name],
    ["footer", embed.footer?.text],
    ...(embed.fields ?? []).flatMap((field, index) => [
      [`field ${index + 1} name`, field.name],
      [`field ${index + 1} value`, field.value],
    ]),
  ].filter(([, text]) => text);
}

// Checks an embed from the dashboard or /welcome. Returns what to save, or
// null when nothing in it would show. Throws InvalidMessage.
export function checkWelcomeEmbed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMessage("The embed must be an object.");
  }
  const { memberAvatar, ...rest } = value;
  const embed = checkEmbed(rest) ?? {};
  for (const [where, text] of textParts(embed)) {
    const problem = variableError(text, "welcome");
    if (problem) {
      throw new InvalidMessage(`In the embed's ${where}: ${problem}`);
    }
  }
  if (memberAvatar === true) {
    delete embed.thumbnail;
    embed.memberAvatar = true;
  }
  const visible = Object.keys(embed).some((key) => key !== "color");
  return visible ? embed : null;
}

// The saved embed for a kind, or null.
export function savedEmbed(guildSettings, guildId, kind) {
  const saved = guildSettings.get(guildId, EMBED_SETTING[kind]);
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const avatarOf = (member) => {
  try {
    return member.displayAvatarURL?.({ size: 256 }) ?? member.user?.displayAvatarURL?.({ size: 256 }) ?? null;
  } catch {
    return null;
  }
};

// The embed with the member's details filled in, ready to send.
//   color   the colour to use when the embed has none of its own
export function renderWelcomeEmbed(saved, { member, guild, color = BRAND_COLOR }) {
  const name = member.displayName ?? member.user?.globalName ?? member.user?.username ?? "";
  const members = guild.memberCount ? new Intl.NumberFormat("en-US").format(guild.memberCount) : "?";
  // Titles, descriptions and fields show markdown; author names and footers don't.
  const formatted = { user: `<@${member.id}>`, username: escapeMarkdown(name), server: escapeMarkdown(guild.name ?? ""), members };
  const plain = { user: `@${name}`, username: name, server: guild.name ?? "", members };
  const fill = (text, max, values = formatted) => cut(fillVariables(text, "welcome", values), max);

  const embed = { color: Number.isInteger(saved.color) ? saved.color : color };
  if (saved.title) {
    embed.title = fill(saved.title, LIMITS.title);
    if (saved.url) {
      embed.url = saved.url;
    }
  }
  if (saved.author?.name) {
    embed.author = { name: fill(saved.author.name, LIMITS.authorName, plain), ...(saved.author.icon_url ? { icon_url: saved.author.icon_url } : {}) };
  }
  if (saved.footer?.text) {
    embed.footer = { text: fill(saved.footer.text, LIMITS.footerText, plain) };
  }
  if (Array.isArray(saved.fields) && saved.fields.length > 0) {
    embed.fields = saved.fields.map((field) => ({
      name: fill(field.name, LIMITS.fieldName),
      value: fill(field.value, LIMITS.fieldValue),
      inline: field.inline === true,
    }));
  }
  if (saved.image?.url) {
    embed.image = { url: saved.image.url };
  }
  const thumbnail = saved.memberAvatar ? avatarOf(member) : saved.thumbnail?.url;
  if (thumbnail) {
    embed.thumbnail = { url: thumbnail };
  }
  if (saved.description) {
    // Names can make the text a little longer than what was saved; the
    // description gives way so the whole embed stays under Discord's limit.
    const others = [embed.title, embed.author?.name, embed.footer?.text, ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])]
      .filter(Boolean)
      .reduce((sum, part) => sum + part.length, 0);
    const room = Math.min(LIMITS.description, LIMITS.total - others);
    if (room > 0) {
      embed.description = fill(saved.description, room);
    }
  }
  return embed;
}

// The colour an embed without its own colour gets in this server.
export const defaultEmbedColor = (guildSettings, guildId) => accentColor(guildSettings, guildId, BRAND_COLOR);

// "title, description, avatar thumbnail" for /welcome show and the dashboard log.
export function describeWelcomeEmbed(saved) {
  if (!saved) {
    return "off";
  }
  const parts = [
    saved.title ? `"${cut(saved.title, 60)}"` : null,
    saved.description ? "description" : null,
    saved.fields?.length ? `${saved.fields.length} field(s)` : null,
    saved.image ? "image" : null,
    saved.memberAvatar ? "member's avatar" : saved.thumbnail ? "thumbnail" : null,
    saved.footer ? "footer" : null,
    Number.isInteger(saved.color) ? `#${saved.color.toString(16).padStart(6, "0")}` : "branding colour",
  ];
  return parts.filter(Boolean).join(" · ").replace(/\n/g, " ");
}
