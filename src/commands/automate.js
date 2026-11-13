// Channel automation from Discord. The same settings are on the dashboard's
// Channel automation page. See channels/automation.js.
//
//   /automate publish channel enabled            publish every post in an announcement channel
//   /automate threads channel enabled            start a thread on every new post
//   /automate keep-alive channel enabled         stop threads there (or that thread) auto-archiving
//   /automate auto-delete channel minutes        delete messages after N minutes (0 = off)
//   /automate slowmode channel messages [seconds] slowmode when N messages arrive in 10 seconds (0 = off)
//   /automate reactions channel [emojis]         react to every post (no emojis = off)
//   /automate counting [channel]                 the counting game channel (no channel = off)
//   /automate bump enabled [channel] [role] [message]  DISBOARD bump reminders
//   /automate show                               everything that's on
//
// Needs Manage Channels.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import {
  AUTOMATION_LIMITS,
  automationInUse,
  channelTypesFor,
  checkAutomation,
  InvalidAutomation,
  normalizeAutomation,
} from "../channels/automation.js";
import { cleanEmoji } from "../community/rolePanels.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "automate";
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const KEEP_ALIVE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];

export function buildAutomateCommandData() {
  const channel = (types, required = true) => (option) => withDescription(option.setName("channel"), "automateChannelOptionDescription").setRequired(required).addChannelTypes(...types);
  const enabled = (option) => withDescription(option.setName("enabled"), "automateEnabledOptionDescription").setRequired(true);
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);
  return withDescription(command, "automateCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("publish"), "automatePublishDescription").addChannelOption(channel([ChannelType.GuildAnnouncement])).addBooleanOption(enabled))
    .addSubcommand((sub) => withDescription(sub.setName("threads"), "automateThreadsDescription").addChannelOption(channel(TEXT)).addBooleanOption(enabled))
    .addSubcommand((sub) => withDescription(sub.setName("keep-alive"), "automateKeepAliveDescription").addChannelOption(channel(KEEP_ALIVE)).addBooleanOption(enabled))
    .addSubcommand((sub) =>
      withDescription(sub.setName("auto-delete"), "automateAutoDeleteDescription")
        .addChannelOption(channel(TEXT))
        .addIntegerOption((option) => withDescription(option.setName("minutes"), "automateMinutesOptionDescription").setRequired(true).setMinValue(0).setMaxValue(AUTOMATION_LIMITS.maxMinutes)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("slowmode"), "automateSlowmodeDescription")
        .addChannelOption(channel(TEXT))
        .addIntegerOption((option) => withDescription(option.setName("messages"), "automateMessagesOptionDescription").setRequired(true).setMinValue(0).setMaxValue(AUTOMATION_LIMITS.maxBurst))
        .addIntegerOption((option) => withDescription(option.setName("seconds"), "automateSecondsOptionDescription").setMinValue(AUTOMATION_LIMITS.minSlowmode).setMaxValue(AUTOMATION_LIMITS.maxSlowmode)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("reactions"), "automateReactionsDescription")
        .addChannelOption(channel(TEXT))
        .addStringOption((option) => withDescription(option.setName("emojis"), "automateEmojisOptionDescription").setMaxLength(300)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("counting"), "automateCountingDescription").addChannelOption(channel(TEXT, false)))
    .addSubcommand((sub) =>
      withDescription(sub.setName("bump"), "automateBumpDescription")
        .addBooleanOption(enabled)
        .addChannelOption(channel(TEXT, false))
        .addRoleOption((option) => withDescription(option.setName("role"), "automateRoleOptionDescription"))
        .addStringOption((option) => withDescription(option.setName("message"), "automateMessageOptionDescription").setMaxLength(AUTOMATION_LIMITS.bumpMessage)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("show"), "automateShowDescription"))
    .toJSON();
}

// Emoji typed into one option: "👍 👎", "👍,👎" or custom emoji like <:yes:123…>.
export function splitEmojis(text) {
  const custom = String(text ?? "").match(/<a?:\w{2,32}:\d{17,20}>/g) ?? [];
  const rest = String(text ?? "").replace(/<a?:\w{2,32}:\d{17,20}>/g, " ");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const unicode = [...segmenter.segment(rest)].map((part) => part.segment).filter((part) => !/^[\s,;]+$/.test(part));
  return [...custom, ...unicode];
}

const without = (list, id) => list.filter((item) => item !== id);
const withoutChannel = (list, id) => list.filter((entry) => entry.channelId !== id);

// The /automate show lines, in `text`'s language.
export function describeAutomationLines(config, text, countingState) {
  const channels = (ids) => ids.map((id) => `<#${id}>`).join(", ");
  const lines = [];
  if (config.publish.length > 0) lines.push(text("automateShowPublish", { channels: channels(config.publish) }));
  if (config.threads.length > 0) lines.push(text("automateShowThreads", { channels: channels(config.threads) }));
  if (config.keepAlive.length > 0) lines.push(text("automateShowKeepAlive", { channels: channels(config.keepAlive) }));
  for (const entry of config.autoDelete) lines.push(text("automateShowAutoDelete", { channel: `<#${entry.channelId}>`, minutes: entry.minutes }));
  for (const entry of config.slowmode) lines.push(text("automateShowSlowmode", { channel: `<#${entry.channelId}>`, messages: entry.messages, seconds: entry.seconds }));
  for (const entry of config.reactions) lines.push(text("automateShowReactions", { channel: `<#${entry.channelId}>`, emojis: entry.emojis.join(" ") }));
  if (config.countingChannelId) {
    const state = countingState?.(config.countingChannelId) ?? { count: 0, best: 0 };
    lines.push(text("automateShowCounting", { channel: `<#${config.countingChannelId}>`, count: state.count, best: state.best }));
  }
  if (config.bump) {
    lines.push(
      text("automateShowBump", {
        channel: config.bump.channelId ? `<#${config.bump.channelId}>` : text("automateBumpSameChannel"),
        role: config.bump.roleId ? `<@&${config.bump.roleId}>` : text("automateBumpNoRole"),
      }),
    );
  }
  return lines;
}

// Options: guildSettings, forcedLanguage, automation (channels/automation.js, for the counting score)
export function createAutomateCommand({ guildSettings, forcedLanguage, automation }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}, extra = []) => {
      const content = [text(key, values), ...extra].join("\n").slice(0, 2000);
      await interaction.reply({ content, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageChannels") });
    }
    const guild = interaction.guild;
    const config = normalizeAutomation(guildSettings.get(guild.id, Setting.CHANNEL_AUTOMATION));
    const subcommand = interaction.options.getSubcommand();
    const picked = interaction.options.getChannel("channel");
    const channel = picked ? `<#${picked.id}>` : "";

    if (subcommand === "show") {
      const lines = describeAutomationLines(config, text, automation?.countingState);
      return lines.length > 0 ? answer(Status.SUCCESS, "automateShowTitle", {}, lines) : answer(Status.SUCCESS, "automateShowNone");
    }

    const next = structuredClone(config);
    const full = (list, max = AUTOMATION_LIMITS.channels) => list.length >= max;
    let key;
    let values = { channel };
    switch (subcommand) {
      case "publish":
      case "threads":
      case "keep-alive": {
        const list = subcommand === "keep-alive" ? "keepAlive" : subcommand;
        const enabled = interaction.options.getBoolean("enabled", true);
        if (enabled && !next[list].includes(picked.id)) {
          const max = list === "keepAlive" ? AUTOMATION_LIMITS.keepAlive : AUTOMATION_LIMITS.channels;
          if (full(next[list], max)) {
            return answer(Status.REFUSED, "automateFull", { max });
          }
          next[list].push(picked.id);
        } else if (!enabled) {
          next[list] = without(next[list], picked.id);
        }
        key = `automate${enabled ? "On" : "Off"}_${list}`;
        break;
      }
      case "auto-delete": {
        const minutes = interaction.options.getInteger("minutes", true);
        const exists = next.autoDelete.some((entry) => entry.channelId === picked.id);
        next.autoDelete = withoutChannel(next.autoDelete, picked.id);
        if (minutes > 0) {
          if (!exists && full(next.autoDelete)) {
            return answer(Status.REFUSED, "automateFull", { max: AUTOMATION_LIMITS.channels });
          }
          next.autoDelete.push({ channelId: picked.id, minutes });
        }
        key = minutes > 0 ? "automateOn_autoDelete" : "automateOff_autoDelete";
        values = { channel, minutes };
        break;
      }
      case "slowmode": {
        const messages = interaction.options.getInteger("messages", true);
        const seconds = interaction.options.getInteger("seconds") ?? 10;
        const exists = next.slowmode.some((entry) => entry.channelId === picked.id);
        next.slowmode = withoutChannel(next.slowmode, picked.id);
        if (messages > 0) {
          if (messages < AUTOMATION_LIMITS.minBurst) {
            return answer(Status.REFUSED, "automateBurstTooLow", { min: AUTOMATION_LIMITS.minBurst });
          }
          if (!exists && full(next.slowmode)) {
            return answer(Status.REFUSED, "automateFull", { max: AUTOMATION_LIMITS.channels });
          }
          next.slowmode.push({ channelId: picked.id, messages, seconds });
        }
        key = messages > 0 ? "automateOn_slowmode" : "automateOff_slowmode";
        values = { channel, messages, seconds };
        break;
      }
      case "reactions": {
        const typed = interaction.options.getString("emojis");
        const emojis = splitEmojis(typed);
        const bad = emojis.find((emoji) => !cleanEmoji(emoji));
        if (bad) {
          return answer(Status.REFUSED, "automateBadEmoji", { emoji: bad.slice(0, 40) });
        }
        const exists = next.reactions.some((entry) => entry.channelId === picked.id);
        next.reactions = withoutChannel(next.reactions, picked.id);
        if (emojis.length > 0) {
          if (emojis.length > AUTOMATION_LIMITS.emojis) {
            return answer(Status.REFUSED, "automateTooManyEmojis", { max: AUTOMATION_LIMITS.emojis });
          }
          if (!exists && full(next.reactions)) {
            return answer(Status.REFUSED, "automateFull", { max: AUTOMATION_LIMITS.channels });
          }
          next.reactions.push({ channelId: picked.id, emojis });
        }
        key = emojis.length > 0 ? "automateOn_reactions" : "automateOff_reactions";
        values = { channel, emojis: emojis.join(" ") };
        break;
      }
      case "counting":
        next.countingChannelId = picked?.id ?? null;
        key = picked ? "automateOn_counting" : "automateOff_counting";
        break;
      case "bump": {
        const enabled = interaction.options.getBoolean("enabled", true);
        const role = interaction.options.getRole("role");
        next.bump = enabled
          ? {
              channelId: picked?.id ?? next.bump?.channelId ?? null,
              roleId: role?.id ?? next.bump?.roleId ?? null,
              message: interaction.options.getString("message") ?? next.bump?.message ?? null,
            }
          : null;
        if (role && (role.id === guild.id || role.managed)) {
          return answer(Status.REFUSED, "automateBadRole");
        }
        key = enabled ? "automateOn_bump" : "automateOff_bump";
        break;
      }
      default:
        return answer(Status.FAILED, "unexpected");
    }

    if (next.countingChannelId && [...next.threads, ...next.reactions.map((entry) => entry.channelId), ...next.autoDelete.map((entry) => entry.channelId)].includes(next.countingChannelId)) {
      return answer(Status.REFUSED, "automateCountingConflict");
    }
    let cleaned;
    try {
      cleaned = checkAutomation(next, {
        isChannel: (id, kind) => {
          const found = guild.channels.cache.get(id);
          return Boolean(found && channelTypesFor(kind).includes(found.type)) || (kind === "keepAlive" && /^\d{17,20}$/.test(id));
        },
        isRole: (id) => guild.roles.cache.has(id) && id !== guild.id,
      });
    } catch (error) {
      if (error instanceof InvalidAutomation) {
        return answer(Status.REFUSED, "automateInvalid", { reason: error.message });
      }
      throw error;
    }
    if (cleaned && automationInUse(cleaned)) {
      await guildSettings.set(guild.id, Setting.CHANNEL_AUTOMATION, cleaned);
    } else {
      await guildSettings.clear(guild.id, Setting.CHANNEL_AUTOMATION);
    }
    // Say what the bot still needs in that channel.
    const missing = picked ? missingPermissions(subcommand, guild.channels.cache.get(picked.id), guild, text) : null;
    return answer(Status.SUCCESS, key, values, missing ? [text("automateNeeds", { permissions: missing })] : []);
  }

  return { name: COMMAND_NAME, data: buildAutomateCommandData(), execute };
}

// Permissions each job needs in its channel, as Discord names them.
const NEEDS = {
  publish: [["SendMessages", "permSendMessages"], ["ManageMessages", "permManageMessages"]],
  threads: [["CreatePublicThreads", "permCreatePublicThreads"], ["SendMessagesInThreads", "permSendMessagesInThreads"]],
  "keep-alive": [["ManageThreads", "permManageThreads"]],
  "auto-delete": [["ManageMessages", "permManageMessages"], ["ReadMessageHistory", "permReadMessageHistory"]],
  slowmode: [["ManageChannels", "permManageChannels"]],
  reactions: [["AddReactions", "permAddReactions"], ["ReadMessageHistory", "permReadMessageHistory"]],
  counting: [["AddReactions", "permAddReactions"], ["SendMessages", "permSendMessages"]],
  bump: [["SendMessages", "permSendMessages"]],
};

function missingPermissions(subcommand, channel, guild, text) {
  const me = guild.members.me;
  if (!channel || !me || !channel.permissionsFor) {
    return null;
  }
  const permissions = channel.permissionsFor(me);
  const missing = (NEEDS[subcommand] ?? []).filter(([flag]) => !permissions?.has(PermissionFlagsBits[flag])).map(([, key]) => text(key));
  return missing.length > 0 ? missing.join(", ") : null;
}
