// Server stats channels: locked voice channels whose names show live counts.
//
//   /stats add counter [name] [category]   add one (up to 5); `name` can use {members}, {humans}, ...
//   /stats remove channel                   remove one and delete its channel
//   /stats list                             what's counted
//
// Needs Manage Server. The bot needs Manage Channels. See stats/statsUpdater.js.
// Also on the dashboard's Server stats page.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import {
  checkTemplate,
  COUNTER_PRESETS,
  counterName,
  guildCounts,
  InvalidCounter,
  MAX_COUNTERS,
  MAX_TEMPLATE_LENGTH,
  newCounterId,
  normalizeCounters,
  PRESET_NAMES,
} from "../stats/statsCounters.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "stats";

export function buildStatsCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "statsCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "statsAddDescription")
        .addStringOption((option) =>
          withDescription(option.setName("counter"), "statsCounterOptionDescription")
            .setRequired(true)
            .addChoices(...PRESET_NAMES.map((name) => ({ name: translate("en", `statsCounter_${name}`), name_localizations: discordLocalizations(`statsCounter_${name}`), value: name }))),
        )
        .addStringOption((option) => withDescription(option.setName("name"), "statsNameOptionDescription").setMaxLength(MAX_TEMPLATE_LENGTH))
        .addChannelOption((option) => withDescription(option.setName("category"), "statsCategoryOptionDescription").addChannelTypes(ChannelType.GuildCategory)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "statsRemoveDescription").addChannelOption((option) =>
        withDescription(option.setName("channel"), "statsChannelOptionDescription").setRequired(true).addChannelTypes(ChannelType.GuildVoice),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "statsListDescription"))
    .toJSON();
}

// Options: guildSettings, updater (stats/statsUpdater.js), forcedLanguage
export function createStatsCommand({ guildSettings, updater, forcedLanguage, logger }) {
  async function add(interaction, answer) {
    const guild = interaction.guild;
    const counters = normalizeCounters(guildSettings.get(guild.id, Setting.STATS_COUNTERS));
    if (counters.length >= MAX_COUNTERS) {
      return answer(Status.REFUSED, "statsFull", { max: MAX_COUNTERS });
    }
    if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      return answer(Status.REFUSED, "statsNeedsManageChannels");
    }
    const preset = interaction.options.getString("counter", true);
    let template;
    try {
      template = checkTemplate(interaction.options.getString("name") ?? COUNTER_PRESETS[preset] ?? COUNTER_PRESETS.members);
    } catch (error) {
      if (error instanceof InvalidCounter) {
        return answer(Status.REFUSED, "statsBadName", { max: MAX_TEMPLATE_LENGTH });
      }
      throw error;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const counter = { id: newCounterId(), template, channelId: null, categoryId: interaction.options.getChannel("category")?.id ?? null, error: null };
    await guildSettings.set(guild.id, Setting.STATS_COUNTERS, [...counters, counter]);
    await updater?.refresh(guild);
    const saved = normalizeCounters(guildSettings.get(guild.id, Setting.STATS_COUNTERS)).find((each) => each.id === counter.id);
    if (!saved?.channelId) {
      // Couldn't create the channel; don't keep a counter that does nothing.
      await guildSettings.set(
        guild.id,
        Setting.STATS_COUNTERS,
        normalizeCounters(guildSettings.get(guild.id, Setting.STATS_COUNTERS)).filter((each) => each.id !== counter.id),
      );
      return answer(Status.FAILED, "statsCreateFailed");
    }
    logger?.info("Stats counter added", { guildId: guild.id, channelId: saved.channelId });
    return answer(Status.SUCCESS, "statsAdded", { channel: `<#${saved.channelId}>` });
  }

  async function remove(interaction, answer) {
    const guild = interaction.guild;
    const channel = interaction.options.getChannel("channel", true);
    const counters = normalizeCounters(guildSettings.get(guild.id, Setting.STATS_COUNTERS));
    const counter = counters.find((each) => each.channelId === channel.id);
    if (!counter) {
      return answer(Status.REFUSED, "statsNotACounter", { channel: `<#${channel.id}>` });
    }
    await guildSettings.set(
      guild.id,
      Setting.STATS_COUNTERS,
      counters.filter((each) => each.id !== counter.id),
    );
    const deleted = await guild.channels.cache
      .get(channel.id)
      ?.delete("Server stats counter removed")
      .then(() => true)
      .catch(() => false);
    return answer(Status.SUCCESS, deleted ? "statsRemoved" : "statsRemovedKeptChannel", { channel: `<#${channel.id}>` });
  }

  async function list(interaction, answer) {
    const guild = interaction.guild;
    const counters = normalizeCounters(guildSettings.get(guild.id, Setting.STATS_COUNTERS));
    if (counters.length === 0) {
      return answer(Status.SUCCESS, "statsListEmpty");
    }
    const counts = guildCounts(guild);
    const lines = counters.map(
      (counter) =>
        `${counter.channelId ? `<#${counter.channelId}>` : `**${counterName(counter.template, counts)}**`} · \`${counter.template}\`${counter.error ? ` · ⚠️ ${counter.error.slice(0, 80)}` : ""}`,
    );
    return answer(Status.SUCCESS, "statsList", { count: counters.length, max: MAX_COUNTERS, list: lines.join("\n") });
  }

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
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
    }
    switch (interaction.options.getSubcommand()) {
      case "add":
        return add(interaction, answer);
      case "remove":
        return remove(interaction, answer);
      case "list":
        return list(interaction, answer);
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildStatsCommandData(), execute };
}
