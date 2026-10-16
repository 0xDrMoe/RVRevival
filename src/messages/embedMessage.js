// Messages written in the dashboard's embed builder: some text and one embed,
// checked against Discord's limits before the bot posts or edits them.

export const LIMITS = Object.freeze({
  content: 2000,
  title: 256,
  description: 4096,
  authorName: 256,
  footerText: 2048,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  // All the embed's text together.
  total: 6000,
  url: 2000,
});

export class InvalidMessage extends Error {
  name = "InvalidMessage";
}

const text = (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "");

function url(value, what) {
  const trimmed = text(value);
  if (!trimmed) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidMessage(`The ${what} must be a full link starting with https://.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidMessage(`The ${what} must be a full link starting with https://.`);
  }
  if (trimmed.length > LIMITS.url) {
    throw new InvalidMessage(`The ${what} is too long.`);
  }
  return trimmed;
}

function limited(value, max, what) {
  const trimmed = text(value);
  if (trimmed.length > max) {
    throw new InvalidMessage(`The ${what} is at most ${max} characters.`);
  }
  return trimmed;
}

// Checks { content, embed } from the dashboard. Returns the Discord message
// body ({ content, embeds }) with empty parts left out.
export function checkMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMessage("Send the message as an object.");
  }
  const content = limited(value.content, LIMITS.content, "message text");
  const embed = value.embed ? checkEmbed(value.embed) : null;
  if (!content && !embed) {
    throw new InvalidMessage("Write some text or fill in the embed.");
  }
  return { content, embeds: embed ? [embed] : [] };
}

function checkEmbed(value) {
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMessage("The embed must be an object.");
  }
  const embed = {};
  const title = limited(value.title, LIMITS.title, "title");
  if (title) {
    embed.title = title;
  }
  const link = url(value.url, "title link");
  if (link) {
    if (!title) {
      throw new InvalidMessage("A title link needs a title.");
    }
    embed.url = link;
  }
  const description = limited(value.description, LIMITS.description, "description");
  if (description) {
    embed.description = description;
  }
  if (value.color !== null && value.color !== undefined) {
    if (!Number.isInteger(value.color) || value.color < 0 || value.color > 0xffffff) {
      throw new InvalidMessage("Pick a color.");
    }
    embed.color = value.color;
  }
  const authorName = limited(value.author?.name, LIMITS.authorName, "author");
  if (authorName) {
    embed.author = { name: authorName };
    const authorIcon = url(value.author?.icon_url, "author icon");
    if (authorIcon) {
      embed.author.icon_url = authorIcon;
    }
  }
  const footerText = limited(value.footer?.text, LIMITS.footerText, "footer");
  if (footerText) {
    embed.footer = { text: footerText };
  }
  const image = url(value.image?.url, "image");
  if (image) {
    embed.image = { url: image };
  }
  const thumbnail = url(value.thumbnail?.url, "thumbnail");
  if (thumbnail) {
    embed.thumbnail = { url: thumbnail };
  }
  const fields = Array.isArray(value.fields) ? value.fields : [];
  if (fields.length > LIMITS.fields) {
    throw new InvalidMessage(`An embed has at most ${LIMITS.fields} fields.`);
  }
  const checkedFields = fields
    .map((field) => ({
      name: limited(field?.name, LIMITS.fieldName, "field name"),
      value: limited(field?.value, LIMITS.fieldValue, "field value"),
      inline: field?.inline === true,
    }))
    .filter((field) => field.name || field.value);
  if (checkedFields.some((field) => !field.name || !field.value)) {
    throw new InvalidMessage("Each field needs a name and a value.");
  }
  if (checkedFields.length > 0) {
    embed.fields = checkedFields;
  }
  const total = [embed.title, embed.description, embed.author?.name, embed.footer?.text, ...checkedFields.flatMap((field) => [field.name, field.value])]
    .filter(Boolean)
    .reduce((sum, part) => sum + part.length, 0);
  if (total > LIMITS.total) {
    throw new InvalidMessage(`All the embed's text together is at most ${LIMITS.total} characters (now ${total}).`);
  }
  // Only a color, or nothing, isn't an embed Discord will show.
  const visible = ["title", "description", "author", "footer", "image", "thumbnail", "fields"].some((key) => key in embed);
  return visible ? embed : null;
}

// What the editor shows for a message the bot posted: its text and first embed.
export function editableMessage(message) {
  const embed = message.embeds?.[0];
  return {
    content: message.content ?? "",
    embed: embed
      ? {
          title: embed.title ?? "",
          url: embed.url ?? "",
          description: embed.description ?? "",
          color: Number.isInteger(embed.color) ? embed.color : null,
          author: { name: embed.author?.name ?? "", icon_url: embed.author?.icon_url ?? "" },
          footer: { text: embed.footer?.text ?? "" },
          image: { url: embed.image?.url ?? "" },
          thumbnail: { url: embed.thumbnail?.url ?? "" },
          fields: (embed.fields ?? []).map((field) => ({ name: field.name, value: field.value, inline: Boolean(field.inline) })),
        }
      : null,
    // Only the first embed can be edited here; editing keeps the others out.
    extraEmbeds: Math.max(0, (message.embeds?.length ?? 0) - 1),
  };
}

// A short label for the list of sent messages.
export function messageSummary(body) {
  const embed = body.embeds[0];
  const label = embed?.title || embed?.author?.name || body.content || embed?.description || "Embed";
  return label.replace(/\s+/g, " ").slice(0, 100);
}

// "https://discord.com/channels/<guild>/<channel>/<message>" → its IDs.
export function parseMessageLink(link) {
  const match = typeof link === "string" && link.trim().match(/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/);
  return match ? { guildId: match[1], channelId: match[2], messageId: match[3] } : null;
}
