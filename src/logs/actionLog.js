// Posts a short embed in the server's logs channel (set with /settings
// logs-channel) for everything members do with the bot: every command, whether
// it worked, was refused or crashed, and every message deleted from the
// /country channel.
//
// Log entries are in English, since only staff read them. Posting a log entry
// never throws: if the logs channel is missing or the bot can't post there, the
// command still works and a warning goes to the console (once, until posting
// works again).

import { ApplicationCommandOptionType, EmbedBuilder } from "discord.js";
import { translate } from "../i18n/i18n.js";
import { Outcome } from "../roles/countryRoles.js";
import { Setting } from "../settings/guildSettings.js";

// How a command ended. Commands return { status, key?, values?, note? } from
// execute(): `key` and `values` name the reply the user got (logged in English),
// `note` is a plain English explanation instead.
export const Status = Object.freeze({
  SUCCESS: "success", // did what was asked
  REFUSED: "refused", // not allowed, bad input, or nothing to do
  FAILED: "failed", // allowed, but the bot couldn't do it (usually permissions)
  ERROR: "error", // the command crashed
});

const STATUS_STYLE = {
  [Status.SUCCESS]: { label: "Success", color: 0x57f287 },
  [Status.REFUSED]: { label: "Refused", color: 0xfee75c },
  [Status.FAILED]: { label: "Failed", color: 0xe67e22 },
  [Status.ERROR]: { label: "Error", color: 0xed4245 },
};

// The status of each country role outcome (see roles/countryRoles.js).
const OUTCOME_STATUS = {
  [Outcome.ASSIGNED]: Status.SUCCESS,
  [Outcome.REMOVED]: Status.SUCCESS,
  [Outcome.ALREADY_ASSIGNED]: Status.REFUSED,
  [Outcome.LOCKED]: Status.REFUSED,
  [Outcome.NOTHING_TO_REMOVE]: Status.REFUSED,
};

export function statusForOutcome(outcome) {
  return OUTCOME_STATUS[outcome] ?? Status.FAILED;
}

// Shorthand used by commands: `return result(Status.REFUSED, "guildOnly")`.
export function result(status, key, values) {
  return { status, key, values };
}

// Longest text shown for one option, so a pasted wall of text can't fill the log.
const MAX_VALUE_LENGTH = 100;

// Shows typed text as inline code, so it can't add formatting or mentions.
function quote(value) {
  let text = String(value).replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (text.length > MAX_VALUE_LENGTH) {
    text = `${text.slice(0, MAX_VALUE_LENGTH - 1)}…`;
  }
  return text ? `\`${text}\`` : "(empty)";
}

function formatOptionValue(option) {
  switch (option.type) {
    case ApplicationCommandOptionType.User:
      return `<@${option.value}>`;
    case ApplicationCommandOptionType.Role:
      return `<@&${option.value}>`;
    case ApplicationCommandOptionType.Channel:
      return `<#${option.value}>`;
    default:
      return quote(option.value);
  }
}

// "/country-staff set" plus "member: @someone" lines for the options used.
export function describeCommand(interaction) {
  const words = [`/${interaction.commandName}`];
  let options = interaction.options?.data ?? [];
  // Subcommand groups and subcommands wrap the real options.
  while (
    options.length === 1 &&
    (options[0].type === ApplicationCommandOptionType.SubcommandGroup ||
      options[0].type === ApplicationCommandOptionType.Subcommand)
  ) {
    words.push(options[0].name);
    options = options[0].options ?? [];
  }
  return {
    command: words.join(" "),
    options: options.map((option) => `${option.name}: ${formatOptionValue(option)}`),
  };
}

function describeResult(outcome) {
  if (outcome.note) {
    return outcome.note;
  }
  if (outcome.key) {
    try {
      return translate("en", outcome.key, outcome.values);
    } catch {
      return outcome.key;
    }
  }
  return "";
}

function statusLine(outcome) {
  const style = STATUS_STYLE[outcome.status] ?? STATUS_STYLE[Status.ERROR];
  const detail = describeResult(outcome);
  return { style, text: detail ? `**${style.label}:** ${detail}` : `**${style.label}**` };
}

export function buildCommandLogEmbed(interaction, outcome) {
  const { command, options } = describeCommand(interaction);
  const { style, text } = statusLine(outcome);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(command)
    .setDescription(text.slice(0, 4000))
    .addFields({ name: "User", value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: true });
  if (interaction.channelId) {
    embed.addFields({ name: "Channel", value: `<#${interaction.channelId}>`, inline: true });
  }
  if (options.length > 0) {
    embed.addFields({ name: "Options", value: options.join("\n").slice(0, 1024) });
  }
  return embed.setTimestamp();
}

export function buildDeletedMessageLogEmbed(message, outcome) {
  const deleted = outcome.status === Status.SUCCESS;
  const { style, text } = statusLine(outcome);
  return new EmbedBuilder()
    .setColor(style.color)
    .setTitle(deleted ? "Message deleted in the /country channel" : "Couldn't delete a message in the /country channel")
    .setDescription(text)
    .addFields(
      { name: "User", value: `<@${message.author.id}> (${message.author.id})`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
    )
    .setTimestamp();
}

// Options:
//   guildSettings   where the logs channel is stored (GuildSettings)
//   logger
export function createActionLog({ guildSettings, logger }) {
  // Servers already warned about a broken logs channel, so every command
  // doesn't add a console warning. Cleared once posting works again.
  const warnedGuilds = new Set();

  async function post(guild, embed) {
    if (!guild) {
      return;
    }
    const channelId = guildSettings.get(guild.id, Setting.LOGS_CHANNEL);
    if (!channelId) {
      return;
    }
    try {
      const channel = guild.channels.cache.get(channelId);
      if (!channel?.isTextBased?.()) {
        throw new Error("The logs channel no longer exists or isn't a text channel");
      }
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      warnedGuilds.delete(guild.id);
    } catch (error) {
      if (!warnedGuilds.has(guild.id)) {
        warnedGuilds.add(guild.id);
        logger.warn(
          "Couldn't post in the logs channel. Give the bot View Channel, Send Messages and Embed Links there.",
          { guildId: guild.id, channelId, error },
        );
      }
    }
  }

  // Never throws, so a logging problem can't break the command being logged.
  async function safely(build, guild) {
    try {
      await post(guild, build());
    } catch (error) {
      logger.warn("Couldn't build a log entry", { error });
    }
  }

  return {
    logCommand: (interaction, outcome) => safely(() => buildCommandLogEmbed(interaction, outcome), interaction.guild),
    logDeletedMessage: (message, outcome) => safely(() => buildDeletedMessageLogEmbed(message, outcome), message.guild),
  };
}

// Used where no logs channel is wanted (tests, `npm run register`).
export const noActionLog = Object.freeze({
  logCommand: async () => {},
  logDeletedMessage: async () => {},
});
