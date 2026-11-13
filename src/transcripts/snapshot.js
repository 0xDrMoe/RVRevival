// A transcript's data: the messages of a ticket thread (or a bulk delete) in a
// small, plain form that can be saved as JSON and drawn as a web page later
// (render.js), after the messages themselves are gone.
//
//   { version, guild: { id, name, icon }, channel: { id, name },
//     messages: [{ id, authorId, createdAt, editedAt, content, embeds,
//                  attachments, stickers, replyTo, system }],
//     users: { id: { name, username, avatar, bot, color } },
//     channels: { id: name }, roles: { id: { name, color } }, truncated }

export const TRANSCRIPT_VERSION = 1;
// Most the saved data may take; older messages are dropped to fit.
export const MAX_TRANSCRIPT_DATA = 2_000_000;

const MAX_CONTENT = 4000;
const MAX_EMBED_TEXT = 2000;
const MAX_EMBEDS = 5;
const MAX_ATTACHMENTS = 10;

const clip = (text, max) => (typeof text === "string" ? (text.length > max ? text.slice(0, max) : text) : null);
const colorHex = (value) => (Number.isInteger(value) && value > 0 ? `#${value.toString(16).padStart(6, "0")}` : null);

function snapshotEmbed(embed) {
  const data = embed?.data ?? embed ?? {};
  return {
    title: clip(data.title, 256),
    url: clip(data.url, 512),
    description: clip(data.description, MAX_EMBED_TEXT),
    color: colorHex(data.color),
    author: data.author?.name ? { name: clip(data.author.name, 256), iconUrl: clip(data.author.icon_url ?? data.author.iconURL, 512) } : null,
    fields: (data.fields ?? []).slice(0, 25).map((field) => ({ name: clip(field.name, 256), value: clip(field.value, 1024), inline: Boolean(field.inline) })),
    image: clip(data.image?.url, 512),
    thumbnail: clip(data.thumbnail?.url, 512),
    footer: data.footer?.text ? clip(data.footer.text, 2048) : null,
    timestamp: data.timestamp ? Date.parse(data.timestamp) || null : null,
  };
}

// One message, from discord.js. Never throws on missing parts.
export function snapshotMessage(message) {
  return {
    id: message.id,
    authorId: message.author?.id ?? null,
    createdAt: message.createdTimestamp ?? null,
    editedAt: message.editedTimestamp ?? null,
    content: clip(message.content ?? "", MAX_CONTENT) ?? "",
    embeds: (message.embeds ?? []).slice(0, MAX_EMBEDS).map(snapshotEmbed),
    attachments: [...(message.attachments?.values?.() ?? [])].slice(0, MAX_ATTACHMENTS).map((attachment) => ({
      name: clip(attachment.name ?? "file", 200),
      url: clip(attachment.url, 1024),
      size: attachment.size ?? null,
      contentType: clip(attachment.contentType, 100),
      width: attachment.width ?? null,
      height: attachment.height ?? null,
    })),
    stickers: [...(message.stickers?.values?.() ?? [])].map((sticker) => clip(sticker.name, 60)),
    replyTo: message.reference?.messageId ?? null,
    // Joins, pins, thread renames…: shown as a small grey line.
    system: Boolean(message.system),
  };
}

function snapshotUser(message) {
  const user = message.author;
  const member = message.member;
  return {
    name: clip(member?.displayName ?? user?.globalName ?? user?.username ?? "Unknown", 100),
    username: clip(user?.tag ?? user?.username ?? null, 100),
    avatar: clip(member?.displayAvatarURL?.({ size: 64 }) ?? user?.displayAvatarURL?.({ size: 64 }) ?? null, 512),
    bot: Boolean(user?.bot || message.webhookId),
    color: colorHex(member?.displayColor),
  };
}

// The names the messages mention, so they read as #general and @Mods later.
function mentionNames(messages, guild) {
  const channels = {};
  const roles = {};
  const users = {};
  for (const message of messages) {
    for (const channel of message.mentions?.channels?.values?.() ?? []) {
      channels[channel.id] = clip(channel.name, 100);
    }
    for (const role of message.mentions?.roles?.values?.() ?? []) {
      roles[role.id] = { name: clip(role.name, 100), color: colorHex(role.color) };
    }
    for (const user of message.mentions?.users?.values?.() ?? []) {
      users[user.id] = { name: clip(user.globalName ?? user.username ?? "Unknown", 100), username: clip(user.username ?? null, 100), avatar: null, bot: Boolean(user.bot), color: null };
    }
    for (const id of (message.content ?? "").matchAll(/<#(\d{17,20})>/g)) {
      const channel = guild?.channels?.cache?.get(id[1]);
      if (channel && !channels[id[1]]) {
        channels[id[1]] = clip(channel.name, 100);
      }
    }
  }
  return { channels, roles, users };
}

// The data for `messages` (any order). `extra` is kept as is (ticket details).
export function buildTranscriptData({ guild, channel, messages, extra = {} }) {
  const sorted = [...messages].sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));
  const names = mentionNames(sorted, guild);
  const users = { ...names.users };
  for (const message of sorted) {
    if (message.author?.id) {
      users[message.author.id] = snapshotUser(message);
    }
  }
  let data = {
    version: TRANSCRIPT_VERSION,
    guild: guild ? { id: guild.id, name: clip(guild.name, 100), icon: clip(guild.iconURL?.({ size: 128 }) ?? null, 512) } : null,
    channel: channel ? { id: channel.id, name: clip(channel.name ?? null, 100) } : null,
    messages: sorted.map(snapshotMessage),
    users,
    channels: names.channels,
    roles: names.roles,
    truncated: false,
    ...extra,
  };
  // Drops the oldest messages until it fits.
  let json = JSON.stringify(data);
  while (json.length > MAX_TRANSCRIPT_DATA && data.messages.length > 1) {
    const drop = Math.max(1, Math.ceil(data.messages.length * ((json.length - MAX_TRANSCRIPT_DATA) / json.length)));
    data = { ...data, messages: data.messages.slice(drop), truncated: true };
    json = JSON.stringify(data);
  }
  return data;
}

// Reads saved data back. Returns undefined for anything that isn't a transcript.
export function parseTranscriptData(text) {
  try {
    const data = JSON.parse(text);
    return data && data.version === TRANSCRIPT_VERSION && Array.isArray(data.messages) ? data : undefined;
  } catch {
    return undefined;
  }
}
