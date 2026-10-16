// Media-only channels: only pictures, videos, files and links can be posted.
//
//   /mediaonly add channel        make a channel media-only (up to 10)
//   /mediaonly remove channel     back to normal
//   /mediaonly links allow        whether links count as media (on by default)
//   /mediaonly list               the media-only channels
//
// Needs Manage Channels. Also on the dashboard's Automod page. See community/mediaOnly.js.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { MAX_MEDIA_CHANNELS, normalizeMediaOnly } from "../community/mediaOnly.js";
import { Setting } from "../settings/guildSettings.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "mediaonly";
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export function buildMediaOnlyCommandData() {
  const channelOption = (option) => withDescription(option.setName("channel"), "mediaOnlyChannelOptionDescription").setRequired(true).addChannelTypes(...TEXT_CHANNELS);
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);
  return withDescription(command, "mediaOnlyCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("add"), "mediaOnlyAddDescription").addChannelOption(channelOption))
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "mediaOnlyRemoveDescription").addChannelOption(channelOption))
    .addSubcommand((sub) =>
      withDescription(sub.setName("links"), "mediaOnlyLinksDescription").addBooleanOption((option) =>
        withDescription(option.setName("allow"), "mediaOnlyAllowOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "mediaOnlyListDescription"))
    .toJSON();
}

// Options: guildSettings, forcedLanguage
export function createMediaOnlyCommand({ guildSettings, forcedLanguage }) {
  async function save(guildId, config) {
    if (config.channelIds.length === 0) {
      await guildSettings.clear(guildId, Setting.MEDIA_ONLY);
    } else {
      await guildSettings.set(guildId, Setting.MEDIA_ONLY, config);
    }
  }

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: text(key, values), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageChannels") });
    }
    const guild = interaction.guild;
    const config = normalizeMediaOnly(guildSettings.get(guild.id, Setting.MEDIA_ONLY));
    switch (interaction.options.getSubcommand()) {
      case "add": {
        const channel = interaction.options.getChannel("channel", true);
        const values = { channel: `<#${channel.id}>` };
        if (config.channelIds.includes(channel.id)) {
          return answer(Status.REFUSED, "mediaOnlyAlready", values);
        }
        if (config.channelIds.length >= MAX_MEDIA_CHANNELS) {
          return answer(Status.REFUSED, "mediaOnlyFull", { max: MAX_MEDIA_CHANNELS });
        }
        const cached = guild.channels.cache.get(channel.id);
        if (!cached?.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
          return answer(Status.REFUSED, "mediaOnlyNeedsManageMessages", values);
        }
        await save(guild.id, { ...config, channelIds: [...config.channelIds, channel.id] });
        return answer(Status.SUCCESS, config.allowLinks ? "mediaOnlyAdded" : "mediaOnlyAddedNoLinks", values);
      }
      case "remove": {
        const channel = interaction.options.getChannel("channel", true);
        const values = { channel: `<#${channel.id}>` };
        if (!config.channelIds.includes(channel.id)) {
          return answer(Status.REFUSED, "mediaOnlyNot", values);
        }
        await save(guild.id, { ...config, channelIds: config.channelIds.filter((id) => id !== channel.id) });
        return answer(Status.SUCCESS, "mediaOnlyRemoved", values);
      }
      case "links": {
        const allowLinks = interaction.options.getBoolean("allow", true);
        if (config.channelIds.length > 0) {
          await save(guild.id, { ...config, allowLinks });
        } else {
          await guildSettings.set(guild.id, Setting.MEDIA_ONLY, { channelIds: [], allowLinks });
        }
        return answer(Status.SUCCESS, allowLinks ? "mediaOnlyLinksOn" : "mediaOnlyLinksOff");
      }
      case "list": {
        if (config.channelIds.length === 0) {
          return answer(Status.SUCCESS, "mediaOnlyListEmpty");
        }
        return answer(Status.SUCCESS, config.allowLinks ? "mediaOnlyList" : "mediaOnlyListNoLinks", {
          list: config.channelIds.map((id) => `<#${id}>`).join(", "),
        });
      }
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildMediaOnlyCommandData(), execute };
}
