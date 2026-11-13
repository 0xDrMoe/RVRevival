// Posts what happens in the server in the server-log channel (/settings
// server-log-channel), or each kind of event's own channel (logRoutes.js):
//
//   Messages   edits (with the changed words highlighted), deletions (and who
//              deleted them), bulk deletions with a transcript, pins
//   Members    joins (account age, the invite used), leaves (time in the
//              server, roles), nickname, role and timeout changes (and who made
//              them), name and avatar changes, boosts
//   Voice      joins, leaves (time spent), moves, server mutes and deafens
//   Server     channels, permissions, roles, server settings, emojis and
//              stickers, invites, webhooks, threads, events, bots and apps,
//              AutoMod rules: what changed and who changed it (serverChanges.js)
//
// Nothing is posted until a channel is set. Entries are in English, like the
// other logs. Admins can switch each kind of event off, skip channels and
// roles, and choose how entries look (logEvents.js, the Logging page).
//
// Messages from bots and messages the bot deleted itself (the /country channel
// and /purge, already logged elsewhere) are skipped, and so are changes the bot
// made to the server itself. Showing message text needs the Message Content
// intent; joins, leaves and member changes need the Server Members intent; "who
// did it" needs View Audit Log; the invite used needs Manage Server.

import { AttachmentBuilder, AuditLogEvent, time, TimestampStyles } from "discord.js";
import { Setting } from "../settings/guildSettings.js";
import { canReadContent, codeBlock, formatBytes, quote } from "./actionLog.js";
import { noAuditTrail } from "./auditTrail.js";
import { buildLogEntry, byLine, capList, formatDuration, LogColor } from "./logEntry.js";
import { DEFAULT_LOG_OPTIONS, LogEvent, logOptionsOf } from "./logEvents.js";
import { noInviteTracker } from "./inviteTracker.js";
import { loggedMemberChanges as defaultLoggedMemberChanges, memberChangeKey } from "./recentIds.js";
import { buildServerChangeEmbed, channelOfAuditEntry, eventOfAuditEntry } from "./serverChanges.js";
import { describeEdit } from "./textDiff.js";
import { deletedMessagesPage } from "../transcripts/deletedPage.js";

export { LogEvent } from "./logEvents.js";

export const SERVER_LOG_SETTINGS = [Setting.SERVER_LOG_CHANNEL];

// Accounts younger than this get flagged when they join.
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
// Room for the before and after text of an edit in one embed.
const MAX_EDIT_TEXT = 1500;

const unix = (ms) => Math.floor(ms / 1000);
const relative = (ms) => time(unix(ms), TimestampStyles.RelativeTime);
const fullDate = (ms) => time(unix(ms), TimestampStyles.LongDateTime);
const avatarOf = (user) => user?.displayAvatarURL?.() ?? undefined;
const roleList = (ids) => capList(ids.map((id) => `<@&${id}>`), { separator: " " });

function messageText(message) {
  if (message.partial) {
    return "*Not available: the message was sent before the bot last started.*";
  }
  if (message.content) {
    return codeBlock(message.content.length > MAX_EDIT_TEXT ? `${message.content.slice(0, MAX_EDIT_TEXT)}…` : message.content);
  }
  return canReadContent(message) ? "*No text.*" : "*Text not available: the Message Content intent is off.*";
}

const sameRoles = (oldMember, newMember) => {
  const before = oldMember.roles?.cache;
  const after = newMember.roles?.cache;
  return !before || !after || (before.size === after.size && [...after.keys()].every((id) => before.has(id)));
};

const jumpLink = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// --- Messages ---------------------------------------------------------------------

// `deletedBy` is the audit log entry saying who deleted it, if someone else did.
export function buildMessageDeletedEmbed(message, options = DEFAULT_LOG_OPTIONS, deletedBy = undefined) {
  const lines = [messageText(message)];
  const details = [];
  const attachments = [...(message.attachments?.values() ?? [])];
  if (attachments.length > 0) {
    lines.push(`**Attachments (${attachments.length})**`);
    for (const attachment of attachments) {
      lines.push(`- ${attachment.name} · ${formatBytes(attachment.size ?? 0)}`);
    }
  }
  const stickers = [...(message.stickers?.values() ?? [])];
  if (stickers.length > 0) {
    lines.push(`**Stickers:** ${stickers.map((sticker) => quote(sticker.name)).join(", ")}`);
  }
  if (deletedBy) {
    lines.push(byLine(deletedBy));
  }
  if (!message.partial && message.createdTimestamp) {
    details.push(`**Sent:** ${relative(message.createdTimestamp)}${message.editedTimestamp ? " · edited" : ""}`);
  }
  if (message.reference?.messageId && message.guildId) {
    details.push(`**Reply to:** [this message](${jumpLink(message.guildId, message.reference.channelId ?? message.channelId, message.reference.messageId)})`);
  }
  if ((message.embeds?.length ?? 0) > 0) {
    details.push(`**Embeds:** ${message.embeds.length}`);
  }
  return buildLogEntry(
    {
      color: LogColor.deleted,
      title: `**Message deleted** in <#${message.channelId}>${message.author ? ` · <@${message.author.id}>` : ""}`,
      lines,
      details,
      user: message.author ?? undefined,
      ids: [message.author && `User ID ${message.author.id}`, `Message ID ${message.id}`],
    },
    options,
  );
}

export function buildMessageEditedEmbed(oldMessage, newMessage, options = DEFAULT_LOG_OPTIONS) {
  const lines = ["**Before**", messageText(oldMessage), "**After**", messageText(newMessage)];
  const details = [];
  if (options.editDiff !== false && !oldMessage.partial) {
    const changes = describeEdit(oldMessage.content ?? "", newMessage.content ?? "");
    if (changes) {
      lines.push(`**Changes:** ${changes}`);
    }
  }
  if (!oldMessage.partial) {
    const kept = new Set(newMessage.attachments?.keys?.() ?? []);
    const removed = [...(oldMessage.attachments?.values() ?? [])].filter((attachment) => !kept.has(attachment.id));
    if (removed.length > 0) {
      lines.push(`**Attachments removed:** ${removed.map((attachment) => quote(attachment.name)).join(", ")}`);
    }
  }
  if (newMessage.createdTimestamp) {
    details.push(`**Sent:** ${relative(newMessage.createdTimestamp)}`);
  }
  return buildLogEntry(
    {
      color: LogColor.edited,
      title: `**Message edited** in <#${newMessage.channelId}> · <@${newMessage.author.id}> · [Jump to message](${newMessage.url})`,
      lines,
      details,
      user: newMessage.author,
      ids: [`User ID ${newMessage.author.id}`, `Message ID ${newMessage.id}`],
    },
    options,
  );
}

export function buildBulkDeleteEmbed(channelId, count, logged, options = DEFAULT_LOG_OPTIONS, deletedBy = undefined) {
  const lines = [];
  if (logged < count) {
    lines.push(`*${count - logged} were sent before the bot last started, so their text isn't in the transcript.*`);
  }
  if (deletedBy) {
    lines.push(byLine(deletedBy));
  }
  return buildLogEntry(
    { color: LogColor.deleted, title: `**${count} messages bulk-deleted** in <#${channelId}>`, lines, ids: [`Channel ID ${channelId}`] },
    options,
  );
}

// --- Members ----------------------------------------------------------------------

// `altMatches` ([{ userId, reason }], moderation/altHints.js) adds a warning
// for each banned account the new member looks like. `invite` is what
// inviteTracker.js worked out, if anything.
export function buildMemberJoinedEmbed(member, now = Date.now(), altMatches = [], { options = DEFAULT_LOG_OPTIONS, invite } = {}) {
  const created = member.user.createdTimestamp;
  const lines = [`Account created ${relative(created)}`];
  const details = [];
  if (now - created < NEW_ACCOUNT_MS) {
    lines.push("⚠️ New account");
  }
  for (const match of altMatches) {
    lines.push(`🚩 Looks like banned <@${match.userId}> (${match.reason === "avatar" ? "same avatar" : "similar name"})`);
  }
  if (member.user.bot) {
    lines.push("🤖 This is a bot.");
  }
  if (invite) {
    const by = invite.inviterId ? `, made by <@${invite.inviterId}>` : "";
    const uses = invite.maxUses > 0 ? `${invite.uses}/${invite.maxUses}` : `${invite.uses}`;
    lines.push(`**Invite:** discord.gg/${invite.code}${by} · used ${uses} time${invite.uses === 1 ? "" : "s"}`);
  }
  details.push(`**Account created:** ${fullDate(created)}`);
  if (member.guild?.memberCount) {
    details.push(`Member #${member.guild.memberCount}`);
  }
  return buildLogEntry(
    {
      color: altMatches.length > 0 ? LogColor.deleted : LogColor.joined,
      title: `**Member joined** · <@${member.id}>`,
      lines,
      details,
      user: member.user,
      thumbnail: avatarOf(member.user),
      ids: [`User ID ${member.id}`],
    },
    options,
  );
}

export function buildMemberLeftEmbed(member, options = DEFAULT_LOG_OPTIONS, now = Date.now()) {
  const lines = [];
  const details = [];
  if (member.joinedTimestamp) {
    lines.push(`Joined ${relative(member.joinedTimestamp)} · member for ${formatDuration(now - member.joinedTimestamp)}`);
  }
  const roles = member.partial
    ? []
    : [...(member.roles?.cache.values() ?? [])].filter((role) => role.id !== member.guild?.id).map((role) => role.id);
  if (roles.length > 0) {
    details.push(`**Roles:** ${roleList(roles)}`);
  }
  if (member.nickname) {
    details.push(`**Nickname:** ${quote(member.nickname)}`);
  }
  if (member.premiumSinceTimestamp) {
    details.push(`💎 Was boosting since ${relative(member.premiumSinceTimestamp)}`);
  }
  return buildLogEntry(
    {
      color: LogColor.left,
      title: `**Member left** · <@${member.id}>${member.user?.tag ? ` (${quote(member.user.tag)})` : ""}`,
      lines,
      details,
      user: member.user,
      thumbnail: avatarOf(member.user),
      ids: [`User ID ${member.id}`],
    },
    options,
  );
}

const timeoutOf = (member) => {
  const until = member.communicationDisabledUntilTimestamp;
  return until && until > Date.now() ? until : null;
};

// Nickname, role and timeout changes, or undefined if none of them changed.
// `changedBy` is the audit log entry saying who made them, if found.
export function buildMemberChangedEmbed(oldMember, newMember, options = DEFAULT_LOG_OPTIONS, changedBy = undefined) {
  if (oldMember.partial) {
    return undefined;
  }
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
    lines.push(`**Roles added:** ${roleList(added)}`);
  }
  if (removed.length > 0) {
    lines.push(`**Roles removed:** ${roleList(removed)}`);
  }
  const oldTimeout = timeoutOf(oldMember);
  const newTimeout = timeoutOf(newMember);
  if (oldTimeout !== newTimeout) {
    lines.push(newTimeout ? `**Timed out** until ${fullDate(newTimeout)} (${relative(newTimeout)})` : "**Timeout removed**");
  }
  if (lines.length === 0) {
    return undefined;
  }
  if (changedBy) {
    lines.push(byLine(changedBy));
  }
  return buildLogEntry(
    {
      color: LogColor.changed,
      title: `**Member updated** · <@${newMember.id}>`,
      lines,
      user: newMember.user,
      ids: [`User ID ${newMember.id}`, changedBy?.executorId && `By ID ${changedBy.executorId}`],
    },
    options,
  );
}

// Username, display name and avatar changes (`oldUser`/`newUser` are users),
// or the server avatar (members). Undefined if none of them changed.
export function buildProfileChangedEmbed(oldUser, newUser, options = DEFAULT_LOG_OPTIONS, { serverAvatar = false } = {}) {
  const lines = [];
  let thumbnail;
  if (!serverAvatar) {
    if (oldUser.username !== newUser.username) {
      lines.push(`**Username:** ${quote(oldUser.username)} → ${quote(newUser.username)}`);
    }
    if ((oldUser.globalName ?? null) !== (newUser.globalName ?? null)) {
      const shown = (name) => (name ? quote(name) : "*none*");
      lines.push(`**Display name:** ${shown(oldUser.globalName)} → ${shown(newUser.globalName)}`);
    }
  }
  if ((oldUser.avatar ?? null) !== (newUser.avatar ?? null)) {
    lines.push(serverAvatar ? (newUser.avatar ? "**Server avatar changed**" : "**Server avatar removed**") : newUser.avatar ? "**Avatar changed**" : "**Avatar removed**");
    thumbnail = avatarOf(newUser);
    const oldAvatar = oldUser.displayAvatarURL?.();
    if (oldAvatar && oldUser.avatar) {
      lines.push(`[Old avatar](${oldAvatar})`);
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  const user = newUser.user ?? newUser;
  return buildLogEntry(
    { color: LogColor.changed, title: `**Profile updated** · <@${user.id}>`, lines, user, thumbnail, ids: [`User ID ${user.id}`] },
    options,
  );
}

// Started or stopped boosting, or undefined.
export function buildBoostEmbed(oldMember, newMember, options = DEFAULT_LOG_OPTIONS) {
  const before = oldMember.premiumSinceTimestamp ?? null;
  const after = newMember.premiumSinceTimestamp ?? null;
  if (Boolean(before) === Boolean(after)) {
    return undefined;
  }
  const guild = newMember.guild;
  const details = guild?.premiumSubscriptionCount !== undefined ? [`Server now has ${guild.premiumSubscriptionCount} boosts (level ${guild.premiumTier ?? 0})`] : [];
  return buildLogEntry(
    {
      color: LogColor.boost,
      title: after ? `💎 **Started boosting** · <@${newMember.id}>` : `**Stopped boosting** · <@${newMember.id}>`,
      lines: before && !after ? [`Boosted for ${formatDuration(Date.now() - before)}`] : [],
      details,
      user: newMember.user,
      ids: [`User ID ${newMember.id}`],
    },
    options,
  );
}

// --- Voice ------------------------------------------------------------------------

// `kind` is "join", "leave", "move" or "moderation". `spentMs` is how long they
// were in the channel they left, if known.
export function buildVoiceEmbed(kind, oldState, newState, options = DEFAULT_LOG_OPTIONS, { spentMs, by } = {}) {
  const member = newState.member ?? oldState.member;
  const userId = newState.id ?? oldState.id;
  const lines = [];
  let title;
  if (kind === "join") {
    title = `**Joined voice** · <@${userId}> → <#${newState.channelId}>`;
  } else if (kind === "leave") {
    title = `**Left voice** · <@${userId}> ← <#${oldState.channelId}>`;
  } else if (kind === "move") {
    title = `**Moved voice** · <@${userId}> · <#${oldState.channelId}> → <#${newState.channelId}>`;
  } else {
    title = `**Voice moderation** · <@${userId}> in <#${newState.channelId ?? oldState.channelId}>`;
    if (Boolean(oldState.serverMute) !== Boolean(newState.serverMute)) {
      lines.push(newState.serverMute ? "🔇 Server muted" : "🔈 Server unmuted");
    }
    if (Boolean(oldState.serverDeaf) !== Boolean(newState.serverDeaf)) {
      lines.push(newState.serverDeaf ? "🙉 Server deafened" : "👂 Server undeafened");
    }
  }
  if (spentMs !== undefined) {
    lines.push(`Spent ${formatDuration(spentMs)} in <#${oldState.channelId}>`);
  }
  if (by) {
    lines.push(byLine(by));
  }
  return buildLogEntry(
    {
      color: kind === "moderation" ? LogColor.changed : kind === "leave" ? LogColor.left : LogColor.voice,
      title,
      lines,
      user: member?.user,
      ids: [`User ID ${userId}`],
    },
    options,
  );
}

// --- The log ----------------------------------------------------------------------

// Options:
//   poster          posts in log channels (see logChannel.js)
//   botDeletions    messages the bot deleted itself (RecentIds)
//   guildSettings   which events are switched off, what's ignored, the options
//   altHints        (moderation/altHints.js) flags joins that look like banned accounts
//   auditTrail      (auditTrail.js) says who did things
//   inviteTracker   (inviteTracker.js) says which invite a new member used
//   now             the clock (replaceable in tests)
export function createServerLog({
  poster,
  botDeletions,
  guildSettings,
  altHints,
  auditTrail = noAuditTrail,
  inviteTracker = noInviteTracker,
  loggedMemberChanges = defaultLoggedMemberChanges,
  now = Date.now,
}) {
  // Each event can have its own channel (log routes), named after the event.
  const post = (guild, event, build) => poster.post(guild, SERVER_LOG_SETTINGS, build, { route: event });
  const optionsOf = (guild) => logOptionsOf(guildSettings, guild.id);
  // "<guild>:<user>" -> when they joined their current voice channel
  const voiceSince = new Map();

  // Whether to log `event` in this server: it has a channel and is switched
  // on, and it isn't about an ignored channel (threads follow their parent
  // channel, and channels their category) or a member with an ignored role.
  function wants(guild, event, { channel, member, userId } = {}) {
    if (!guild || !poster.isEnabled(guild, SERVER_LOG_SETTINGS, event)) {
      return false;
    }
    if (guildSettings?.getList(guild.id, Setting.DISABLED_LOG_EVENTS).includes(event)) {
      return false;
    }
    const ignored = guildSettings?.getList(guild.id, Setting.LOG_IGNORED_CHANNELS) ?? [];
    if (channel && ignored.length > 0 && [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && ignored.includes(id))) {
      return false;
    }
    const ignoredRoles = guildSettings?.getList(guild.id, Setting.LOG_IGNORED_ROLES) ?? [];
    if (ignoredRoles.length > 0) {
      const who = member ?? (userId ? guild.members?.cache?.get(userId) : undefined);
      if (who?.roles?.cache && ignoredRoles.some((id) => who.roles.cache.has(id))) {
        return false;
      }
    }
    return true;
  }
  const channelOf = (message) => message.channel ?? { id: message.channelId };
  const isMe = (guild, userId) => Boolean(userId) && userId === (guild.members?.me?.id ?? guild.client?.user?.id);
  const isFromBot = (message) => Boolean(message.author?.bot || message.webhookId);
  const skipsBots = (guild) => !optionsOf(guild).logBots;
  // Who did something, from the audit log, when the server wants to know.
  const findWho = (guild, match) => (optionsOf(guild).whoDidIt ? auditTrail.find(guild, match) : Promise.resolve(undefined));

  return {
    // Whether join entries in `guild` show the invite used (for inviteTracker.js).
    tracksInvites: (guild) => wants(guild, LogEvent.MEMBER_JOIN) && optionsOf(guild).invites,

    async messageDeleted(message) {
      const guild = message.guild;
      if (!wants(guild, LogEvent.MESSAGE_DELETE, { channel: channelOf(message), member: message.member, userId: message.author?.id })) {
        return;
      }
      if (botDeletions?.has(message.id) || isMe(guild, message.author?.id) || (isFromBot(message) && skipsBots(guild))) {
        return;
      }
      const deletedBy = message.author
        ? await findWho(
            guild,
            (entry) =>
              entry.action === AuditLogEvent.MessageDelete && entry.targetId === message.author.id && entry.extra?.channel?.id === message.channelId,
          )
        : undefined;
      const options = optionsOf(guild);
      await post(guild, LogEvent.MESSAGE_DELETE, () => ({ embed: buildMessageDeletedEmbed(message, options, deletedBy) }));
    },

    async messagesBulkDeleted(messages, channel) {
      const guild = channel.guild;
      const all = [...messages.values()];
      const others = all.filter((message) => !botDeletions?.has(message.id));
      if (!wants(guild, LogEvent.BULK_DELETE, { channel }) || others.length === 0) {
        return;
      }
      const known = others.filter((message) => !message.partial);
      const deletedBy = await findWho(guild, (entry) => entry.action === AuditLogEvent.MessageBulkDelete && entry.targetId === channel.id);
      const options = optionsOf(guild);
      await post(guild, LogEvent.BULK_DELETE, ({ canAttach }) => ({
        embed: buildBulkDeleteEmbed(channel.id, others.length, known.length, options, deletedBy),
        files:
          canAttach && known.length > 0
            ? [
                new AttachmentBuilder(Buffer.from(deletedMessagesPage({ guild, channel, messages: known, title: "Messages deleted", at: now() }), "utf8"), {
                  name: `deleted-${channel.id}.html`,
                }),
              ]
            : [],
      }));
    },

    async messageEdited(oldMessage, newMessage) {
      const guild = newMessage.guild;
      if (newMessage.partial || !wants(guild, LogEvent.MESSAGE_EDIT, { channel: channelOf(newMessage), member: newMessage.member, userId: newMessage.author?.id })) {
        return;
      }
      if (isMe(guild, newMessage.author?.id) || (isFromBot(newMessage) && skipsBots(guild))) {
        return;
      }
      // Discord also sends an "edit" when a link preview loads: the text is the
      // same and the message isn't marked as edited.
      if (!newMessage.editedTimestamp || (!oldMessage.partial && oldMessage.content === newMessage.content && oldMessage.attachments?.size === newMessage.attachments?.size)) {
        return;
      }
      const options = optionsOf(guild);
      await post(guild, LogEvent.MESSAGE_EDIT, () => ({ embed: buildMessageEditedEmbed(oldMessage, newMessage, options) }));
    },

    async memberJoined(member) {
      if (!wants(member.guild, LogEvent.MEMBER_JOIN)) {
        return;
      }
      const options = optionsOf(member.guild);
      const matches = member.user ? (altHints?.matches(member.guild.id, member.user) ?? []) : [];
      const invite = options.invites && !member.user?.bot ? await inviteTracker.inviteUsed(member) : undefined;
      await post(member.guild, LogEvent.MEMBER_JOIN, () => ({ embed: buildMemberJoinedEmbed(member, now(), matches, { options, invite }) }));
    },

    async memberLeft(member) {
      voiceSince.delete(`${member.guild?.id}:${member.id}`);
      // Banned or kicked by the bot: the case already says so.
      const loggedElsewhere = loggedMemberChanges?.has(memberChangeKey(member.guild?.id, member.id));
      if (member.user && !loggedElsewhere && wants(member.guild, LogEvent.MEMBER_LEAVE)) {
        const options = optionsOf(member.guild);
        await post(member.guild, LogEvent.MEMBER_LEAVE, () => ({ embed: buildMemberLeftEmbed(member, options, now()) }));
      }
    },

    async memberUpdated(oldMember, newMember) {
      // Without the old version there's nothing to compare.
      if (oldMember.partial) {
        return;
      }
      const guild = newMember.guild;
      const tasks = [];
      // A timeout, /role or /nick change the bot made is in the mod log already.
      // So is a new nickname for the bot itself (the dashboard's Branding page logs that).
      const ownNickname = isMe(guild, newMember.id) && sameRoles(oldMember, newMember) && oldMember.nickname !== newMember.nickname;
      const loggedElsewhere = ownNickname || loggedMemberChanges?.has(memberChangeKey(guild?.id, newMember.id));
      if (!loggedElsewhere && wants(guild, LogEvent.MEMBER_UPDATE, { member: newMember }) && buildMemberChangedEmbed(oldMember, newMember)) {
        tasks.push(
          (async () => {
            const rolesChanged = oldMember.roles.cache.size !== newMember.roles.cache.size || [...newMember.roles.cache.keys()].some((id) => !oldMember.roles.cache.has(id));
            const action = rolesChanged ? AuditLogEvent.MemberRoleUpdate : AuditLogEvent.MemberUpdate;
            const changedBy = await findWho(guild, (entry) => entry.action === action && entry.targetId === newMember.id);
            const embed = buildMemberChangedEmbed(oldMember, newMember, optionsOf(guild), changedBy);
            await post(guild, LogEvent.MEMBER_UPDATE, () => ({ embed }));
          })(),
        );
      }
      if (
        (oldMember.avatar ?? null) !== (newMember.avatar ?? null) &&
        wants(guild, LogEvent.MEMBER_PROFILE, { member: newMember }) &&
        !(newMember.user?.bot && skipsBots(guild))
      ) {
        const embed = buildProfileChangedEmbed(oldMember, newMember, optionsOf(guild), { serverAvatar: true });
        tasks.push(post(guild, LogEvent.MEMBER_PROFILE, () => ({ embed })));
      }
      if (wants(guild, LogEvent.MEMBER_BOOST, { member: newMember })) {
        const embed = buildBoostEmbed(oldMember, newMember, optionsOf(guild));
        if (embed) {
          tasks.push(post(guild, LogEvent.MEMBER_BOOST, () => ({ embed })));
        }
      }
      await Promise.all(tasks);
    },

    // A user's own name or avatar changed: posted in every server (in
    // `guilds`) the bot shares with them that logs it.
    async userUpdated(oldUser, newUser, guilds) {
      if (oldUser.partial) {
        return;
      }
      await Promise.all(
        [...guilds].map(async (guild) => {
          const member = guild.members?.cache?.get(newUser.id);
          if (!member || !wants(guild, LogEvent.MEMBER_PROFILE, { member }) || (newUser.bot && skipsBots(guild))) {
            return;
          }
          const embed = buildProfileChangedEmbed(oldUser, newUser, optionsOf(guild));
          if (embed) {
            await post(guild, LogEvent.MEMBER_PROFILE, () => ({ embed }));
          }
        }),
      );
    },

    async voiceStateUpdated(oldState, newState) {
      const guild = newState.guild ?? oldState.guild;
      const member = newState.member ?? oldState.member;
      if (!guild) {
        return;
      }
      const key = `${guild.id}:${newState.id}`;
      const joinedAt = voiceSince.get(key);
      const changedChannel = oldState.channelId !== newState.channelId;
      if (changedChannel) {
        if (newState.channelId) {
          voiceSince.set(key, now());
        } else {
          voiceSince.delete(key);
        }
      }
      if (isMe(guild, newState.id) || (member?.user?.bot && skipsBots(guild))) {
        return;
      }
      const spentMs = joinedAt === undefined ? undefined : now() - joinedAt;
      const options = optionsOf(guild);
      if (changedChannel) {
        const kind = !oldState.channelId ? "join" : !newState.channelId ? "leave" : "move";
        const event = { join: LogEvent.VOICE_JOIN, leave: LogEvent.VOICE_LEAVE, move: LogEvent.VOICE_MOVE }[kind];
        const channel = (kind === "leave" ? oldState.channel : newState.channel) ?? { id: kind === "leave" ? oldState.channelId : newState.channelId };
        if (!wants(guild, event, { channel, member })) {
          return;
        }
        const by =
          kind === "move"
            ? await findWho(guild, (entry) => entry.action === AuditLogEvent.MemberMove && entry.extra?.channel?.id === newState.channelId)
            : undefined;
        const embed = buildVoiceEmbed(kind, oldState, newState, options, { spentMs: kind === "join" ? undefined : spentMs, by });
        await post(guild, event, () => ({ embed }));
        return;
      }
      const moderated = Boolean(oldState.serverMute) !== Boolean(newState.serverMute) || Boolean(oldState.serverDeaf) !== Boolean(newState.serverDeaf);
      if (moderated && newState.channelId && wants(guild, LogEvent.VOICE_MODERATION, { channel: newState.channel ?? { id: newState.channelId }, member })) {
        const by = await findWho(
          guild,
          (entry) => entry.action === AuditLogEvent.MemberUpdate && entry.targetId === newState.id && entry.changes?.some((change) => change.key === "mute" || change.key === "deaf"),
        );
        const embed = buildVoiceEmbed("moderation", oldState, newState, options, { by });
        await post(guild, LogEvent.VOICE_MODERATION, () => ({ embed }));
      }
    },

    // A new audit log entry: server changes (channels, roles, settings…).
    async auditLogEntry(entry, guild) {
      const event = eventOfAuditEntry(entry);
      // Changes the bot made itself are its own features at work (temporary
      // voice channels, stats counters, lockdowns), logged elsewhere if at all.
      if (!event || !guild || isMe(guild, entry.executorId)) {
        return;
      }
      const executor = entry.executorId ? guild.members?.cache?.get(entry.executorId) : undefined;
      if (!wants(guild, event, { channel: channelOfAuditEntry(entry, guild), member: executor })) {
        return;
      }
      const embed = buildServerChangeEmbed(entry, guild, optionsOf(guild));
      if (embed) {
        await post(guild, event, () => ({ embed }));
      }
    },
  };
}

export const noServerLog = Object.freeze({
  tracksInvites: () => false,
  messageDeleted: async () => {},
  messagesBulkDeleted: async () => {},
  messageEdited: async () => {},
  memberJoined: async () => {},
  memberLeft: async () => {},
  memberUpdated: async () => {},
  userUpdated: async () => {},
  voiceStateUpdated: async () => {},
  auditLogEntry: async () => {},
});
