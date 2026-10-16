// Join-to-create voice channels: joining the hub channel ("➕ Create a
// channel") makes a voice channel for that member and moves them into it.
// It's deleted as soon as it's empty. Discord has no feature like this.
//
// The owner gets Manage Channels and Move Members on their channel, so they
// rename it, set a user limit or disconnect people with Discord's own menus;
// /voice adds lock, unlock and claim (see commands/voice.js).

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { Setting } from "../settings/guildSettings.js";
import { KeyedLock } from "../utils/keyedLock.js";

export const MAX_TEMP_CHANNELS = 50;
export const MAX_NAME_TEMPLATE_LENGTH = 80;
export const MAX_USER_LIMIT = 99;
export const DEFAULT_NAME_TEMPLATE = "🔊 {name}";

// What the owner may do in their own channel.
export const OWNER_PERMISSIONS = { ViewChannel: true, Connect: true, Speak: true, ManageChannels: true, MoveMembers: true };
// What the bot needs to run join-to-create.
export const TEMP_VOICE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.Connect,
];

// The saved settings, or undefined when join-to-create is off.
export function tempVoiceSettings(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TEMP_VOICE);
  return saved?.hubChannelId ? saved : undefined;
}

// "🔊 {name}" → "🔊 Rumbler", within Discord's 100 characters.
export function channelName(template, member) {
  const name = member.displayName ?? member.user?.globalName ?? member.user?.username ?? "voice";
  return (template || DEFAULT_NAME_TEMPLATE).replaceAll("{name}", name).replaceAll("{username}", member.user?.username ?? name).slice(0, 100);
}

// Options: guildSettings, store (TempVoiceStore), logger, now
export function createTempVoice({ guildSettings, store, logger, now = Date.now }) {
  // One create at a time per member, so a quick re-join can't make two channels.
  const lock = new KeyedLock();

  async function deleteIfEmpty(channel) {
    if (channel.members.size > 0) {
      return false;
    }
    store.remove(channel.id);
    await channel.delete("Join-to-create channel is empty").catch((error) => {
      if (error?.code !== 10003) {
        logger.warn("Couldn't delete an empty join-to-create channel", { guildId: channel.guild?.id, channelId: channel.id, error });
      }
    });
    return true;
  }

  async function createFor(member, settings) {
    const guild = member.guild;
    // Someone who already has a channel is just moved back into it.
    for (const owned of store.byOwner(guild.id, member.id)) {
      const existing = guild.channels.cache.get(owned.channelId);
      if (existing) {
        await member.voice.setChannel(existing).catch(() => {});
        return;
      }
      store.remove(owned.channelId);
    }
    if (store.count(guild.id) >= MAX_TEMP_CHANNELS) {
      logger.warn("Too many join-to-create channels; not making another", { guildId: guild.id });
      return;
    }
    const hub = guild.channels.cache.get(settings.hubChannelId);
    const parent = guild.channels.cache.get(settings.categoryId ?? hub?.parentId ?? "") ?? null;
    const me = guild.members.me;
    if (!me || !(parent ?? hub)?.permissionsFor(me)?.has(TEMP_VOICE_PERMISSIONS)) {
      logger.warn("Can't make join-to-create channels; give the bot Manage Channels, Manage Roles, Move Members and Connect there", {
        guildId: guild.id,
      });
      return;
    }
    // The category's permissions, plus the owner's.
    const inherited = parent
      ? [...parent.permissionOverwrites.cache.values()].map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield,
        }))
      : [];
    const channel = await guild.channels.create({
      name: channelName(settings.nameTemplate, member),
      type: ChannelType.GuildVoice,
      parent: parent?.id,
      userLimit: settings.userLimit ?? 0,
      permissionOverwrites: inherited.filter((overwrite) => overwrite.id !== member.id),
      reason: `Join-to-create channel for ${member.id}`,
    });
    await channel.permissionOverwrites.edit(member.id, OWNER_PERMISSIONS, { reason: "Join-to-create channel owner" });
    store.add({ channelId: channel.id, guildId: guild.id, ownerId: member.id, createdAt: now() });
    try {
      await member.voice.setChannel(channel, "Join-to-create");
    } catch {
      // They left before they could be moved.
      await deleteIfEmpty(channel);
    }
  }

  return {
    async voiceStateUpdate(oldState, newState) {
      const guild = newState.guild ?? oldState.guild;
      const settings = tempVoiceSettings(guildSettings, guild.id);
      const member = newState.member ?? oldState.member;

      if (settings && newState.channelId === settings.hubChannelId && oldState.channelId !== newState.channelId && member && !member.user?.bot) {
        await lock.run(`${guild.id}:${member.id}`, () => createFor(member, settings));
      }
      if (oldState.channelId && oldState.channelId !== newState.channelId && store.get(oldState.channelId)) {
        const channel = oldState.channel ?? guild.channels.cache.get(oldState.channelId);
        if (!channel) {
          store.remove(oldState.channelId);
        } else {
          await deleteIfEmpty(channel);
        }
      }
    },

    // After a restart: forget channels that are gone and delete empty ones.
    async sweep(client) {
      for (const saved of store.all()) {
        const channel = client.guilds.cache.get(saved.guildId)?.channels.cache.get(saved.channelId);
        if (!channel) {
          store.remove(saved.channelId);
        } else {
          await deleteIfEmpty(channel);
        }
      }
    },

    channelDeleted(channel) {
      store.remove(channel.id);
    },
  };
}
