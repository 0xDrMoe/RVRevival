// The /remind command: members ask the bot to remind them of something later.
//
//   /remind set in:2h about:Tournament check-in [private:true]   remind me here (or by DM) in 2 hours
//   /remind list                                                 my reminders in this server
//   /remind cancel reminder:<…>                                  cancel one
//
// Anyone can use it. Reminders are saved in data/bot.db, so they survive
// restarts, and are sent by reminders/reminderScheduler.js.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { parseDuration } from "../utils/duration.js";

export const MIN_REMINDER_MS = 60 * 1000;
export const MAX_REMINDER_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_REMINDERS_PER_MEMBER = 25;
export const MAX_REMINDER_LENGTH = 500;
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildRemindCommandData() {
  const command = new SlashCommandBuilder().setName("remind").setContexts(InteractionContextType.Guild);
  return withDescription(command, "remindCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "remindSetDescription")
        .addStringOption((option) =>
          withDescription(option.setName("in"), "remindInOptionDescription").setRequired(true).setMaxLength(20),
        )
        .addStringOption((option) =>
          withDescription(option.setName("about"), "remindAboutOptionDescription")
            .setRequired(true)
            .setMaxLength(MAX_REMINDER_LENGTH),
        )
        .addBooleanOption((option) => withDescription(option.setName("private"), "remindPrivateOptionDescription")),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "remindListDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("cancel"), "remindCancelDescription").addIntegerOption((option) =>
        withDescription(option.setName("reminder"), "remindReminderOptionDescription").setRequired(true).setAutocomplete(true),
      ),
    )
    .toJSON();
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
const preview = (text, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).replace(/\s+/g, " ");

// Options:
//   reminders   the ReminderStore (only needed to run the command, not to register it)
//   forcedLanguage, now
export function createRemindCommand({ reminders, forcedLanguage, now = Date.now }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    switch (interaction.options.getSubcommand()) {
      case "set": {
        const delay = parseDuration(interaction.options.getString("in", true));
        if (!delay) {
          return answer(Status.REFUSED, "remindBadDuration");
        }
        if (delay < MIN_REMINDER_MS || delay > MAX_REMINDER_MS) {
          return answer(Status.REFUSED, "remindOutOfRange");
        }
        const about = interaction.options.getString("about", true).replace(/\\n/g, "\n").trim();
        if (!about) {
          return answer(Status.REFUSED, "remindEmpty");
        }
        if (reminders.countForUser(guildId, userId) >= MAX_REMINDERS_PER_MEMBER) {
          return answer(Status.REFUSED, "remindFull", { max: MAX_REMINDERS_PER_MEMBER });
        }
        // If the bot can't post in this channel, the reminder comes by DM instead.
        const me = interaction.guild.members.me;
        const canPost = Boolean(me && interaction.channel?.permissionsFor?.(me)?.has(POST_PERMISSIONS));
        const wantsPrivate = interaction.options.getBoolean("private") ?? false;
        const createdAt = now();
        const reminder = reminders.add({
          guildId,
          channelId: interaction.channelId,
          userId,
          text: about,
          private: wantsPrivate || !canPost,
          createdAt,
          dueAt: createdAt + delay,
        });
        const values = { id: reminder.id, when: timestamp(reminder.dueAt, "R"), date: timestamp(reminder.dueAt, "f") };
        if (wantsPrivate) {
          return answer(Status.SUCCESS, "remindSetPrivate", values);
        }
        return answer(Status.SUCCESS, canPost ? "remindSetHere" : "remindSetDmFallback", values);
      }
      case "list": {
        const mine = reminders.listForUser(guildId, userId);
        if (mine.length === 0) {
          return answer(Status.SUCCESS, "remindListEmpty");
        }
        const lines = mine.map((reminder) =>
          text("remindListLine", {
            id: reminder.id,
            when: timestamp(reminder.dueAt, "R"),
            where: reminder.private ? text("remindWhereDm") : `<#${reminder.channelId}>`,
            text: preview(reminder.text),
          }),
        );
        await interaction.reply({
          content: [text("remindListTitle", { count: mine.length, max: MAX_REMINDERS_PER_MEMBER }), ...lines].join("\n").slice(0, 2000),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return result(Status.SUCCESS);
      }
      case "cancel": {
        const id = interaction.options.getInteger("reminder", true);
        return reminders.deleteForUser(id, guildId, userId)
          ? answer(Status.SUCCESS, "remindCancelled", { id })
          : answer(Status.REFUSED, "remindNotFound");
      }
    }
    return answer(Status.FAILED, "unexpected");
  }

  // Suggests the member's own reminders.
  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").toLowerCase();
    const choices = reminders
      .listForUser(interaction.guildId, interaction.user.id)
      .filter((reminder) => !typed || String(reminder.id) === typed || reminder.text.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((reminder) => ({ name: `#${reminder.id} ${preview(reminder.text, 90)}`.slice(0, 100), value: reminder.id }));
    await interaction.respond(choices);
  }

  return { name: "remind", data: buildRemindCommandData(), execute, autocomplete };
}
