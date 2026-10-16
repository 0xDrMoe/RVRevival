// Posts what happens in the server in the server-log channel (/settings
// server-log-channel): edited and deleted messages, bulk deletions, members
// joining and leaving, and nickname and role changes. Nothing is posted until a
// channel is set. Entries are in English, like the other logs.
//
// Messages from bots and messages the bot deleted itself (the /country channel
// and /purge, already logged elsewhere) are skipped. Admins can switch each kind
// of event off (/settings log-event) and stop logging messages from chosen
// channels (/settings log-ignore). Showing message text needs
// the Message Content intent; joins, leaves and member changes need the Server
// Members intent.

import { AttachmentBuilder, EmbedBuilder, time, TimestampStyles } from "discord.js";
import { Setting } from "../settings/guildSettings.js";
import { authorOf, canReadContent, codeBlock, formatBytes, quote } from "./actionLog.js";
import { buildTranscript } from "./transcript.js";

export const SERVER_LOG_SETTINGS = [Setting.SERVER_LOG_CHANNEL];

// The kinds of events the server log posts, each of which can be switched off.
// The values are stored in the settings, so never rename one.
export const LogEvent = Object.freeze({
  MESSAGE_EDIT: "messageEdit",
  MESSAGE_DELETE: "messageDelete",
  BULK_DELETE: "bulkDelete",
  MEMBER_JOIN: "memberJoin",
  MEMBER_LEAVE: "memberLeave",
  MEMBER_UPDATE: "memberUpdate",
});

const COLOR = {
  deleted: 0xed4245,
  edited: 0x3498db,
  joined: 0x57f287,
  left: 0xe67e22,
  changed: 0x9b59b6,
};

// Accounts younger than this get flagged when they join.
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
// Room for the before and after text of an edit in one embed.
const MAX_EDIT_TEXT = 1800;

const unix = (ms) => Math.floor(ms / 1000);

function messageText(message) {
  if (message.partial) {
    return "*Not available: the message was sent before the bot last started.*";
  }
  if (message.content) {
    return codeBlock(message.content.length > MAX_EDIT_TEXT ? `${message.content.slice(0, MAX_EDIT_TEXT)}…` : message.content);
  }
  return canReadContent(message) ? "*No text.*" : "*Text not available: the Message Content intent is off.*";
}

export function buildMessageDeletedEmbed(message) {
  const lines = [`**Message deleted** in <#${message.channelId}>`, messageText(message)];
  const attachments = [...(message.attachments?.values() ?? [])];
  if (attachments.length > 0) {
    lines.push(`**Attachments (${attachments.length})**`);
    for (const attachment of attachments) {
      lines.push(`- ${attachment.name} · ${formatBytes(attachment.size ?? 0)}`);
    }
  }
  const embed = new EmbedBuilder().setColor(COLOR.deleted).setDescription(lines.join("\n").slice(0, 4096)).setTimestamp();
  if (message.author) {
    embed.setAuthor(authorOf(message.author)).setFooter({ text: `User ID ${message.author.id} · Message ID ${message.id}` });
  } else {
    embed.setFooter({ text: `Message ID ${message.id}` });
  }
  return embed;
}

export function buildMessageEditedEmbed(oldMessage, newMessage) {
  const lines = [
    `**Message edited** in <#${newMessage.channelId}> · [Jump to message](${newMessage.url})`,
    "**Before**",
    messageText(oldMessage),
    "**After**",
    messageText(newMessage),
  ];
  return new EmbedBuilder()
    .setColor(COLOR.edited)
    .setAuthor(authorOf(newMessage.author))
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: `User ID ${newMessage.author.id} · Message ID ${newMessage.id}` })
    .setTimestamp();
}

export function buildBulkDeleteEmbed(channelId, count, logged) {
  const lines = [`**${count} messages bulk-deleted** in <#${channelId}>`];
  if (logged < count) {
    lines.push(`*${count - logged} were sent before the bot last started, so their text isn't in the transcript.*`);
  }
  return new EmbedBuilder().setColor(COLOR.deleted).setDescription(lines.join("\n")).setTimestamp();
}

export function buildMemberJoinedEmbed(member, now = Date.now()) {
  const created = member.user.createdTimestamp;
  const lines = [
    `**Member joined** · <@${member.id}>`,
    `Account created ${time(unix(created), TimestampStyles.RelativeTime)}`,
  ];
  if (now - created < NEW_ACCOUNT_MS) {
    lines.push("⚠️ New account");
  }
  if (member.guild?.memberCount) {
    lines.push(`Member #${member.guild.memberCount}`);
  }
  return new EmbedBuilder()
    .setColor(COLOR.joined)
    .setAuthor(authorOf(member.user))
    .setDescription(lines.join("\n"))
    .setFooter({ text: `User ID ${member.id}` })
    .setTimestamp();
}

export function buildMemberLeftEmbed(member) {
  const lines = [`**Member left** · <@${member.id}>`];
  if (member.joinedTimestamp) {
    lines.push(`Joined ${time(unix(member.joinedTimestamp), TimestampStyles.RelativeTime)}`);
  }
  const roles = member.partial
    ? []
    : [...(member.roles?.cache.values() ?? [])].filter((role) => role.id !== member.guild?.id).map((role) => `<@&${role.id}>`);
  if (roles.length > 0) {
    lines.push(`**Roles:** ${roles.join(" ")}`);
  }
  return new EmbedBuilder()
    .setColor(COLOR.left)
    .setAuthor(authorOf(member.user))
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: `User ID ${member.id}` })
    .setTimestamp();
}

// Nickname and role changes, or undefined if neither changed.
export function buildMemberChangedEmbed(oldMember, newMember) {
  const lines = [];
  if (oldMember.nickname !== newMember.nickname) {
    const shown = (nickname) => (nickname ? quote(nickname) : "*none*");
    lines.push(`**Nickname:** ${shown(oldMember.nickname)} → ${shown(newMember.nickname)}`);
  }
  const before = oldMember.roles.cache;
  const after = newMember.roles.cache;
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  if (added.length > 0) {
    lines.push(`**Roles added:** ${added.map((id) => `<@&${id}>`).join(" ")}`);
  }
  if (removed.length > 0) {
    lines.push(`**Roles removed:** ${removed.map((id) => `<@&${id}>`).join(" ")}`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  return new EmbedBuilder()
    .setColor(COLOR.changed)
    .setAuthor(authorOf(newMember.user))
    .setDescription([`**Member updated** · <@${newMember.id}>`, ...lines].join("\n").slice(0, 4096))
    .setFooter({ text: `User ID ${newMember.id}` })
    .setTimestamp();
}

// Options:
//   poster          posts in log channels (see logChannel.js)
//   botDeletions    messages the bot deleted itself (RecentIds)
//   guildSettings   which events are switched off and which channels are ignored
export function createServerLog({ poster, botDeletions, guildSettings }) {
  const post = (guild, build) => poster.post(guild, SERVER_LOG_SETTINGS, build);

  // Whether to log `event` in this server, and (for message events) in this
  // channel. Threads follow their parent channel, and channels their category.
  function wants(guild, event, channel) {
    if (!guild || !poster.isEnabled(guild, SERVER_LOG_SETTINGS)) {
      return false;
    }
    if (guildSettings?.getList(guild.id, Setting.DISABLED_LOG_EVENTS).includes(event)) {
      return false;
    }
    const ignored = guildSettings?.getList(guild.id, Setting.LOG_IGNORED_CHANNELS) ?? [];
    if (!channel || ignored.length === 0) {
      return true;
    }
    return ![channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && ignored.includes(id));
  }
  const channelOf = (message) => message.channel ?? { id: message.channelId };
  const isFromBot = (message) => Boolean(message.author?.bot || message.webhookId);

  return {
    async messageDeleted(message) {
      if (!wants(message.guild, LogEvent.MESSAGE_DELETE, channelOf(message)) || botDeletions?.has(message.id) || isFromBot(message)) {
        return;
      }
      await post(message.guild, () => ({ embed: buildMessageDeletedEmbed(message) }));
    },

    async messagesBulkDeleted(messages, channel) {
      const guild = channel.guild;
      const all = [...messages.values()];
      const others = all.filter((message) => !botDeletions?.has(message.id));
      if (!wants(guild, LogEvent.BULK_DELETE, channel) || others.length === 0) {
        return;
      }
      const known = others.filter((message) => !message.partial);
      await post(guild, ({ canAttach }) => ({
        embed: buildBulkDeleteEmbed(channel.id, others.length, known.length),
        files:
          canAttach && known.length > 0
            ? [new AttachmentBuilder(Buffer.from(buildTranscript(known), "utf8"), { name: `deleted-${channel.id}.txt` })]
            : [],
      }));
    },

    async messageEdited(oldMessage, newMessage) {
      if (!wants(newMessage.guild, LogEvent.MESSAGE_EDIT, channelOf(newMessage)) || newMessage.partial || isFromBot(newMessage)) {
        return;
      }
      // Discord also sends an "edit" when a link preview loads: the text is the
      // same and the message isn't marked as edited.
      if (!newMessage.editedTimestamp || (!oldMessage.partial && oldMessage.content === newMessage.content)) {
        return;
      }
      await post(newMessage.guild, () => ({ embed: buildMessageEditedEmbed(oldMessage, newMessage) }));
    },

    async memberJoined(member) {
      if (wants(member.guild, LogEvent.MEMBER_JOIN)) {
        await post(member.guild, () => ({ embed: buildMemberJoinedEmbed(member) }));
      }
    },

    async memberLeft(member) {
      if (member.user && wants(member.guild, LogEvent.MEMBER_LEAVE)) {
        await post(member.guild, () => ({ embed: buildMemberLeftEmbed(member) }));
      }
    },

    async memberUpdated(oldMember, newMember) {
      // Without the old version there's nothing to compare.
      if (oldMember.partial || !wants(newMember.guild, LogEvent.MEMBER_UPDATE)) {
        return;
      }
      const embed = buildMemberChangedEmbed(oldMember, newMember);
      if (embed) {
        await post(newMember.guild, () => ({ embed }));
      }
    },
  };
}

export const noServerLog = Object.freeze({
  messageDeleted: async () => {},
  messagesBulkDeleted: async () => {},
  messageEdited: async () => {},
  memberJoined: async () => {},
  memberLeft: async () => {},
  memberUpdated: async () => {},
});
