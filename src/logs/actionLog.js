// Posts a compact embed in the server's logs channel (set with /settings
// logs-channel) for everything members do with the bot: every command, whether
// it worked, was refused or crashed, and every message deleted from the
// /country channel, with its text, attachments and stickers.
//
// Log entries are in English, since only staff read them. Posting a log entry
// never throws: if the logs channel is missing or the bot can't post there, the
// command still works and a warning goes to the console (once, until posting
// works again).

import { ApplicationCommandOptionType, AttachmentBuilder, EmbedBuilder, GatewayIntentBits } from "discord.js";
import { translate } from "../i18n/i18n.js";
import { Outcome } from "../roles/countryRoles.js";
import { Setting } from "../settings/guildSettings.js";
import { createLogChannelPoster } from "./logChannel.js";
import { LogRoute } from "./logRoutes.js";

// How a command ended. Commands return { status, key?, values?, note? } from
// execute(): `key` and `values` name the reply the user got (logged in English),
// `note` is a plain English explanation instead, and `action` ({ label, fields })
// names a button or form, which has no command name.
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
// Room left for a deleted message's text in one embed (Discord allows 4096).
const MAX_CONTENT_LENGTH = 3500;
// Attachments are re-uploaded to the log, since their links die with the
// message. Discord lets bots upload 10 MB per message and 10 files.
const MAX_SAVED_BYTES = 8 * 1024 * 1024;
const MAX_SAVED_FILES = 10;
const DOWNLOAD_TIMEOUT_MS = 15_000;

// Shows typed text as inline code, so it can't add formatting or mentions.
export function quote(value) {
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

// "/country-staff set" plus "member: @someone" for each option used.
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

const styleOf = (outcome) => STATUS_STYLE[outcome.status] ?? STATUS_STYLE[Status.ERROR];

// Prefixes every line with "> " so it shows as a quote.
const asQuote = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");

// The member's name and avatar at the top of every entry.
export function authorOf(user) {
  const name = user.tag ?? user.username ?? user.id;
  const iconURL = user.displayAvatarURL?.();
  return iconURL ? { name, iconURL } : { name };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

// Text in a code block, so it shows exactly as typed and can't ping or format.
export function codeBlock(text) {
  let shown = text;
  let cut = "";
  if (shown.length > MAX_CONTENT_LENGTH) {
    cut = `\n*…${shown.length - MAX_CONTENT_LENGTH} more characters not shown*`;
    shown = shown.slice(0, MAX_CONTENT_LENGTH);
  }
  // A zero-width space keeps ``` inside the message from closing the block.
  return `\`\`\`\n${shown.replace(/```/g, "`\u200b``")}\n\`\`\`${cut}`;
}

// What was used: a slash command and its options, or for buttons and forms the
// `action` the handler returned ({ label, fields }).
function describeAction(interaction, outcome) {
  if (!outcome.action) {
    return describeCommand(interaction);
  }
  const fields = Object.entries(outcome.action.fields ?? {});
  return { command: outcome.action.label, options: fields.map(([name, value]) => `${name}: ${quote(value)}`) };
}

// One compact entry:
//   [avatar] name
//   **Refused** · `/country-staff set` in #channel
//   member: @someone · country: `Canada`
//   > Only members with the @Staff role can use this command.
//   User ID 123 · today at 21:43
export function buildCommandLogEmbed(interaction, outcome) {
  const { command, options } = describeAction(interaction, outcome);
  const style = styleOf(outcome);
  const where = interaction.channelId ? ` in <#${interaction.channelId}>` : "";
  const lines = [`**${style.label}** · \`${command}\`${where}`];
  if (options.length > 0) {
    lines.push(options.join(" · "));
  }
  const detail = describeResult(outcome);
  if (detail) {
    lines.push(asQuote(detail));
  }
  return new EmbedBuilder()
    .setColor(style.color)
    .setAuthor(authorOf(interaction.user))
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: `User ID ${interaction.user.id}` })
    .setTimestamp();
}

// Whether the bot was allowed to read message text (the Message Content intent).
export function canReadContent(message) {
  return Boolean(message.client?.options?.intents?.has?.(GatewayIntentBits.MessageContent));
}

// What a deleted message held: its text, attachments and stickers. `saved` is
// the list from saveAttachments(), shown as "saved below" or why not.
export function buildDeletedMessageLogEmbed(message, outcome, saved = []) {
  const style = styleOf(outcome);
  const deleted = outcome.status === Status.SUCCESS;
  const lines = [`**${deleted ? "Message deleted" : "Couldn't delete a message"}** in <#${message.channelId}>`];

  if (message.content) {
    lines.push(codeBlock(message.content));
  } else if (!canReadContent(message)) {
    lines.push("*Text not available: the Message Content intent is off.*");
  } else if (message.attachments?.size === 0 && !message.stickers?.size) {
    lines.push("*No text.*");
  }

  const savedById = new Map(saved.map((entry) => [entry.id, entry]));
  const attachments = [...(message.attachments?.values() ?? [])];
  if (attachments.length > 0) {
    lines.push(`**Attachments (${attachments.length})**`);
    for (const attachment of attachments) {
      const entry = savedById.get(attachment.id);
      const status = deleted ? ` · ${entry?.file ? "saved below" : (entry?.reason ?? "not saved")}` : "";
      lines.push(`- [${attachment.name}](${attachment.url}) · ${formatBytes(attachment.size ?? 0)}${status}`);
    }
  }
  const stickers = [...(message.stickers?.values() ?? [])];
  if (stickers.length > 0) {
    lines.push(`**Stickers:** ${stickers.map((sticker) => quote(sticker.name)).join(", ")}`);
  }
  if (outcome.note) {
    lines.push(asQuote(outcome.note));
  }

  return new EmbedBuilder()
    .setColor(style.color)
    .setAuthor(authorOf(message.author))
    .setDescription(lines.join("\n").slice(0, 4096))
    .setFooter({ text: `User ID ${message.author.id} · Message ID ${message.id}` })
    .setTimestamp(message.createdTimestamp ?? Date.now());
}

// Downloads a message's attachments (within Discord's upload limit), so they
// can be re-uploaded to the log after the message is gone. Never throws.
// Returns [{ id, file?, reason? }] in the message's order.
export async function saveAttachments(message, { fetchFile = fetch } = {}) {
  const results = [];
  let total = 0;
  for (const attachment of message.attachments?.values() ?? []) {
    const size = attachment.size ?? 0;
    if (results.filter((entry) => entry.attachment).length >= MAX_SAVED_FILES) {
      results.push({ id: attachment.id, reason: "too many files to keep" });
      continue;
    }
    if (total + size > MAX_SAVED_BYTES) {
      results.push({ id: attachment.id, reason: "too large to keep" });
      continue;
    }
    total += size;
    results.push({ id: attachment.id, attachment });
  }

  return Promise.all(
    results.map(async (entry) => {
      if (!entry.attachment) {
        return entry;
      }
      const { id, attachment } = entry;
      try {
        const response = await fetchFile(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = Buffer.from(await response.arrayBuffer());
        return { id, file: new AttachmentBuilder(data, { name: attachment.name, description: attachment.description }) };
      } catch {
        return { id, reason: "couldn't be downloaded" };
      }
    }),
  );
}

// Options:
//   guildSettings   where the logs channel is stored (GuildSettings)
//   logger
//   fetchFile       downloads attachments (replaceable in tests)
//   poster          posts in log channels (see logChannel.js); shared with the other logs
export function createActionLog({
  guildSettings,
  logger,
  fetchFile = fetch,
  poster = createLogChannelPoster({ guildSettings, logger }),
}) {
  const post = (guild, route, build) => poster.post(guild, [Setting.LOGS_CHANNEL], build, { route });

  return {
    logCommand: (interaction, outcome) =>
      post(interaction.guild, LogRoute.COMMANDS, () => ({ embed: buildCommandLogEmbed(interaction, outcome) })),

    // Call before deleting a message: starts downloading its attachments while
    // their links still work. Skipped when the server has no logs channel.
    saveAttachments: async (message) =>
      poster.isEnabled(message.guild, [Setting.LOGS_CHANNEL], LogRoute.BOT_DELETIONS) ? saveAttachments(message, { fetchFile }) : [],

    // `saved` is what saveAttachments() returned, re-uploaded with the entry.
    logDeletedMessage: (message, outcome, saved = []) =>
      post(message.guild, LogRoute.BOT_DELETIONS, ({ canAttach }) => {
        const shown = canAttach
          ? saved
          : saved.map(({ id, file, reason }) => ({ id, reason: file ? "not saved: the bot needs Attach Files here" : reason }));
        return {
          embed: buildDeletedMessageLogEmbed(message, outcome, shown),
          files: shown.flatMap((entry) => (entry.file ? [entry.file] : [])),
        };
      }),
  };
}

// Used where no logs channel is wanted (tests, `npm run register`).
export const noActionLog = Object.freeze({
  logCommand: async () => {},
  saveAttachments: async () => [],
  logDeletedMessage: async () => {},
});
