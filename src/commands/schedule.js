// Scheduled and repeating messages.
//
//   /schedule add channel:<channel> in:<duration> [every:<duration>]   opens a form for the message
//   /schedule list
//   /schedule remove message:<id>
//
// Needs Manage Server. Mentions in the message only ping when whoever
// scheduled it has Mention Everyone. Also on the dashboard's Scheduled page.
// Posted by scheduled/scheduler.js.

import {
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import {
  MAX_DELAY_MS,
  MAX_INTERVAL_MS,
  MAX_SCHEDULED,
  MAX_SCHEDULED_LENGTH,
  MIN_INTERVAL_MS,
} from "../scheduled/scheduler.js";
import { formatDuration, parseDuration } from "../utils/duration.js";

const COMMAND_NAME = "schedule";
const FORM_PREFIX = "schedform:";
const FORM_INPUT = "content";
const MIN_DELAY_MS = 60 * 1000;
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildScheduleCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "scheduleCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "scheduleAddDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "scheduleChannelOptionDescription")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addStringOption((option) => withDescription(option.setName("in"), "scheduleInOptionDescription").setRequired(true).setMaxLength(20))
        .addStringOption((option) => withDescription(option.setName("every"), "scheduleEveryOptionDescription").setMaxLength(20)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "scheduleListDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "scheduleRemoveDescription").addIntegerOption((option) =>
        withDescription(option.setName("message"), "scheduleMessageOptionDescription").setRequired(true).setAutocomplete(true).setMinValue(1),
      ),
    )
    .toJSON();
}

export function buildScheduleForm(language, { channelId, nextAt, intervalMs }) {
  return new ModalBuilder()
    .setCustomId(`${FORM_PREFIX}${channelId}:${nextAt}:${intervalMs ?? 0}`)
    .setTitle(translate(language, "scheduleFormTitle").slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(translate(language, "scheduleFormLabel"))
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(FORM_INPUT).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(MAX_SCHEDULED_LENGTH),
        ),
    );
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
const preview = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).replace(/\s+/g, " ");

// Options: store (ScheduledMessageStore; only needed to run the command), forcedLanguage, now
export function createScheduleCommand({ store, forcedLanguage, now = Date.now }) {
  const helpers = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(status, key, values);
    };
    return { language, text, answer };
  };
  const canManage = (interaction) => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  const botCanPost = (interaction, channel) => {
    const me = interaction.guild.members.me;
    return Boolean(me && channel?.permissionsFor?.(me)?.has(POST_PERMISSIONS));
  };

  async function execute(interaction) {
    const { language, text, answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!canManage(interaction)) {
      return answer(Status.REFUSED, "scheduleNeedsManageGuild");
    }
    const guildId = interaction.guildId;

    switch (interaction.options.getSubcommand()) {
      case "add": {
        const channel = interaction.options.getChannel("channel", true);
        const delay = parseDuration(interaction.options.getString("in", true));
        if (!delay || delay < MIN_DELAY_MS || delay > MAX_DELAY_MS) {
          return answer(Status.REFUSED, "scheduleBadDelay");
        }
        const every = interaction.options.getString("every");
        const intervalMs = every ? parseDuration(every) : null;
        if (every && (!intervalMs || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) {
          return answer(Status.REFUSED, "scheduleBadInterval");
        }
        if (store.count(guildId) >= MAX_SCHEDULED) {
          return answer(Status.REFUSED, "scheduleFull", { max: MAX_SCHEDULED });
        }
        if (!botCanPost(interaction, channel)) {
          return answer(Status.REFUSED, "scheduleBotCantPost", { channel: `<#${channel.id}>` });
        }
        await interaction.showModal(buildScheduleForm(language, { channelId: channel.id, nextAt: now() + delay, intervalMs }));
        return null;
      }
      case "list": {
        const messages = store.list(guildId);
        if (messages.length === 0) {
          return answer(Status.SUCCESS, "scheduleListEmpty");
        }
        const lines = messages.map((message) => {
          const repeat = message.intervalMs ? ` · ${text("scheduleEvery", { every: formatDuration(message.intervalMs) })}` : "";
          return `**#${message.id}** <#${message.channelId}> · ${timestamp(message.nextAt, "f")}${repeat}\n> ${preview(message.content)}`;
        });
        await interaction.reply({
          content: `${text("scheduleListTitle", { count: messages.length, max: MAX_SCHEDULED })}\n${lines.join("\n")}`.slice(0, 2000),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return result(Status.SUCCESS);
      }
      case "remove": {
        const id = interaction.options.getInteger("message", true);
        if (!store.deleteInGuild(guildId, id)) {
          return answer(Status.REFUSED, "scheduleNotFound");
        }
        return answer(Status.SUCCESS, "scheduleRemoved", { id });
      }
    }
    return answer(Status.FAILED, "unexpected");
  }

  // The message form, sent.
  async function readForm(interaction) {
    const { answer } = helpers(interaction);
    const parsed = /^schedform:(\d+):(\d+):(\d+)$/.exec(interaction.customId);
    if (!interaction.inCachedGuild() || !parsed) {
      return answer(Status.REFUSED, "unexpected");
    }
    if (!canManage(interaction)) {
      return answer(Status.REFUSED, "scheduleNeedsManageGuild");
    }
    const content = interaction.fields.getTextInputValue(FORM_INPUT).replace(/\r\n?/g, "\n").trim();
    if (!content) {
      return answer(Status.REFUSED, "scheduleEmpty");
    }
    const [, channelId, nextAtText, intervalText] = parsed;
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!botCanPost(interaction, channel)) {
      return answer(Status.REFUSED, "scheduleBotCantPost", { channel: `<#${channelId}>` });
    }
    // Checked again: someone may have added one while the form was open.
    if (store.count(interaction.guildId) >= MAX_SCHEDULED) {
      return answer(Status.REFUSED, "scheduleFull", { max: MAX_SCHEDULED });
    }
    const intervalMs = Number(intervalText) || null;
    // Taking a while to fill in the form doesn't schedule it in the past.
    const nextAt = Math.max(Number(nextAtText), now() + MIN_DELAY_MS);
    const saved = store.add({
      guildId: interaction.guildId,
      channelId,
      content,
      nextAt,
      intervalMs,
      allowMentions: interaction.memberPermissions?.has(PermissionFlagsBits.MentionEveryone) ?? false,
      createdBy: interaction.user.id,
      createdAt: now(),
    });
    const values = { id: saved.id, channel: `<#${channelId}>`, when: `${timestamp(nextAt, "f")} (${timestamp(nextAt, "R")})` };
    return intervalMs
      ? answer(Status.SUCCESS, "scheduleAddedRepeat", { ...values, every: formatDuration(intervalMs) })
      : answer(Status.SUCCESS, "scheduleAdded", values);
  }

  // Suggests the server's scheduled messages.
  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").trim().toLowerCase();
    const choices = store
      .list(interaction.guildId)
      .filter((message) => !typed || String(message.id).startsWith(typed) || message.content.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((message) => ({ name: `#${message.id} · ${preview(message.content, 80)}`.slice(0, 100), value: message.id }));
    await interaction.respond(choices);
  }

  return {
    name: COMMAND_NAME,
    data: buildScheduleCommandData(),
    execute,
    autocomplete,
    componentPrefixes: { [FORM_PREFIX]: { label: "Scheduled message form", handle: readForm } },
  };
}
