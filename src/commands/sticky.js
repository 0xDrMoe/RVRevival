// Sticky messages: a message that stays at the bottom of a channel.
//
//   /sticky set message [channel]   set or change it (type \n for a new line)
//   /sticky remove [channel]        remove it
//   /sticky list                    every sticky on the server
//
// Needs Manage Messages. Also on the dashboard's Sticky messages page.
// See sticky/stickies.js.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { MAX_STICKIES, MAX_STICKY_LENGTH } from "../sticky/stickyStore.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "sticky";
const POSTING = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export function buildStickyCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);
  const channelOption = (option) => withDescription(option.setName("channel"), "stickyChannelOptionDescription").addChannelTypes(...POSTING);
  return withDescription(command, "stickyCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "stickySetDescription")
        .addStringOption((option) => withDescription(option.setName("message"), "stickyMessageOptionDescription").setRequired(true).setMaxLength(MAX_STICKY_LENGTH))
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "stickyRemoveDescription").addChannelOption(channelOption))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "stickyListDescription"))
    .toJSON();
}

// "\n" typed in a slash command option becomes a line break.
export const stickyText = (text) => text.replace(/\\n/g, "\n").trim().slice(0, MAX_STICKY_LENGTH);

// Options: store (sticky/stickyStore.js), stickies (sticky/stickies.js), forcedLanguage
export function createStickyCommand({ store, stickies, forcedLanguage, now = Date.now }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageMessages") });
    }
    const guild = interaction.guild;
    const picked = interaction.options.getChannel("channel") ?? interaction.channel;
    const channel = picked && guild.channels.cache.get(picked.id);
    const values = { channel: `<#${picked?.id}>` };

    switch (interaction.options.getSubcommand()) {
      case "set": {
        if (!channel || !POSTING.includes(channel.type)) {
          return answer(Status.REFUSED, "stickyBadChannel");
        }
        if (!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
          return answer(Status.REFUSED, "stickyCannotPost", values);
        }
        const existing = store.get(channel.id);
        if (!existing && store.count(guild.id) >= MAX_STICKIES) {
          return answer(Status.REFUSED, "stickyFull", { max: MAX_STICKIES });
        }
        const content = stickyText(interaction.options.getString("message", true));
        if (!content) {
          return answer(Status.REFUSED, "stickyEmpty");
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        store.set({ channelId: channel.id, guildId: guild.id, content, messageId: existing?.messageId ?? null, createdBy: interaction.user.id, updatedAt: now() });
        stickies.cancel(channel.id);
        try {
          await stickies.repost(channel);
        } catch {
          store.delete(channel.id);
          return answer(Status.FAILED, "stickyCannotPost", values);
        }
        return answer(Status.SUCCESS, existing ? "stickyChanged" : "stickySet", values);
      }
      case "remove": {
        const removed = picked && store.delete(picked.id);
        if (!removed) {
          return answer(Status.REFUSED, "stickyNone", values);
        }
        stickies.cancel(picked.id);
        if (removed.messageId) {
          await channel?.messages?.delete(removed.messageId).catch(() => {});
        }
        return answer(Status.SUCCESS, "stickyRemoved", values);
      }
      case "list": {
        const all = store.list(guild.id);
        if (all.length === 0) {
          return answer(Status.SUCCESS, "stickyListEmpty");
        }
        const lines = all.map((sticky) => `<#${sticky.channelId}> · ${sticky.content.replace(/\s+/g, " ").slice(0, 80)}${sticky.content.length > 80 ? "…" : ""}`);
        return answer(Status.SUCCESS, "stickyList", { count: all.length, max: MAX_STICKIES, list: lines.join("\n") });
      }
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildStickyCommandData(), execute };
}
