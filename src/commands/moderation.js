// The moderation commands, like Dyno's:
//
//   /ban user:@someone [reason] [duration:7d] [delete-messages]   ban (temporarily with a duration)
//   /unban user:<id> [reason]
//   /kick member:@someone [reason]
//   /timeout member:@someone duration:1h [reason]                 Discord's timeout, up to 28 days
//   /untimeout member:@someone [reason]
//   /warn member:@someone reason
//
// Who can use them: members with the matching Discord permission, or with the
// staff role from /settings. Discord hides each command from members without
// the permission; to show it to the staff role as well, add the role in
// Server Settings > Integrations, or give it the permission.
//
// Every action gets a numbered case, is posted in the mod-log channel, and the
// member is DMed when possible. Replies are private; the mod log is the record.

import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  time,
  TimestampStyles,
} from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { hierarchyProblem, isModerator, outsiderProblem } from "../moderation/checks.js";
import { DAY_MS, parseDuration } from "../utils/duration.js";
import { getDiscordErrorCode, isPermissionError } from "../utils/discordErrors.js";

const MAX_REASON_LENGTH = 512;
// Discord's limit for a timeout.
export const MAX_TIMEOUT_MS = 28 * DAY_MS;
// Long enough for any temporary ban; longer means "ban for good".
export const MAX_TEMP_BAN_MS = 365 * DAY_MS;

// How much of a banned member's recent messages to delete, in seconds.
const DELETE_MESSAGE_CHOICES = [
  { key: "modDeleteNone", value: 0 },
  { key: "modDeleteHour", value: 60 * 60 },
  { key: "modDeleteDay", value: 24 * 60 * 60 },
  { key: "modDeleteThreeDays", value: 3 * 24 * 60 * 60 },
  { key: "modDeleteWeek", value: 7 * 24 * 60 * 60 },
];

// The translation key naming each permission, for "You need the … permission".
const PERMISSION_NAMES = new Map([
  [PermissionFlagsBits.BanMembers, "permBanMembers"],
  [PermissionFlagsBits.KickMembers, "permKickMembers"],
  [PermissionFlagsBits.ModerateMembers, "permModerateMembers"],
  [PermissionFlagsBits.ManageMessages, "permManageMessages"],
]);

// Shorthand for an English description plus its translations.
export function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const reasonOption = (required) => (option) =>
  withDescription(option.setName("reason"), "modReasonOptionDescription")
    .setRequired(required)
    .setMaxLength(MAX_REASON_LENGTH);

const memberOption = (option) =>
  withDescription(option.setName("member"), "modMemberOptionDescription").setRequired(true);

const userOption = (key) => (option) => withDescription(option.setName("user"), key).setRequired(true);

const durationOption = (required, key) => (option) =>
  withDescription(option.setName("duration"), key).setRequired(required).setMaxLength(20);

const discordTime = (ms, style = TimestampStyles.ShortDateTime) => time(Math.floor(ms / 1000), style);

// Each command: its Discord permission, its options, and what it does once the
// moderator and target have been checked. `prepare` can refuse (return a key)
// or add values for `run`; `run` returns { case, key, values }.
const COMMANDS = [
  {
    name: "ban",
    permission: PermissionFlagsBits.BanMembers,
    descriptionKey: "banCommandDescription",
    targetsOutsiders: true,
    build: (command) =>
      command
        .addUserOption(userOption("banUserOptionDescription"))
        .addStringOption(reasonOption(false))
        .addStringOption(durationOption(false, "banDurationOptionDescription"))
        .addIntegerOption((option) =>
          withDescription(option.setName("delete-messages"), "banDeleteOptionDescription").addChoices(
            ...DELETE_MESSAGE_CHOICES.map(({ key, value }) => ({
              name: translate("en", key),
              name_localizations: discordLocalizations(key),
              value,
            })),
          ),
        ),
    async prepare({ interaction, user }) {
      const text = interaction.options.getString("duration");
      const durationMs = text ? parseDuration(text) : undefined;
      if (text && (!durationMs || durationMs > MAX_TEMP_BAN_MS)) {
        return { refuse: "modInvalidDuration", values: { max: "365d" } };
      }
      if (await isBanned(interaction.guild, user.id)) {
        return { refuse: "modAlreadyBanned" };
      }
      return { durationMs, deleteMessageSeconds: interaction.options.getInteger("delete-messages") ?? 0 };
    },
    async run(moderation, { guild, user, member, moderator, reason, durationMs, deleteMessageSeconds }) {
      const moderationCase = await moderation.ban({ guild, user, member, moderator, reason, durationMs, deleteMessageSeconds });
      return moderationCase.expiresAt
        ? { moderationCase, key: "modTempBanned", values: { until: discordTime(moderationCase.expiresAt) } }
        : { moderationCase, key: "modBanned" };
    },
  },
  {
    name: "unban",
    permission: PermissionFlagsBits.BanMembers,
    descriptionKey: "unbanCommandDescription",
    targetsOutsiders: true,
    build: (command) => command.addUserOption(userOption("unbanUserOptionDescription")).addStringOption(reasonOption(false)),
    async run(moderation, { guild, user, moderator, reason }) {
      try {
        return { moderationCase: await moderation.unban({ guild, user, moderator, reason }), key: "modUnbanned" };
      } catch (error) {
        if (getDiscordErrorCode(error) === RESTJSONErrorCodes.UnknownBan) {
          return { refuse: "modNotBanned" };
        }
        throw error;
      }
    },
  },
  {
    name: "kick",
    permission: PermissionFlagsBits.KickMembers,
    descriptionKey: "kickCommandDescription",
    build: (command) => command.addUserOption(memberOption).addStringOption(reasonOption(false)),
    async run(moderation, { guild, member, moderator, reason }) {
      return { moderationCase: await moderation.kick({ guild, member, moderator, reason }), key: "modKicked" };
    },
  },
  {
    name: "timeout",
    permission: PermissionFlagsBits.ModerateMembers,
    descriptionKey: "timeoutCommandDescription",
    forTimeout: true,
    build: (command) =>
      command
        .addUserOption(memberOption)
        .addStringOption(durationOption(true, "timeoutDurationOptionDescription"))
        .addStringOption(reasonOption(false)),
    prepare({ interaction }) {
      const durationMs = parseDuration(interaction.options.getString("duration", true));
      if (!durationMs || durationMs > MAX_TIMEOUT_MS) {
        return { refuse: "modInvalidDuration", values: { max: "28d" } };
      }
      return { durationMs };
    },
    async run(moderation, { guild, member, moderator, reason, durationMs }) {
      const moderationCase = await moderation.timeout({ guild, member, moderator, reason, durationMs });
      return { moderationCase, key: "modTimedOut", values: { until: discordTime(moderationCase.expiresAt) } };
    },
  },
  {
    name: "untimeout",
    permission: PermissionFlagsBits.ModerateMembers,
    descriptionKey: "untimeoutCommandDescription",
    forTimeout: true,
    build: (command) => command.addUserOption(memberOption).addStringOption(reasonOption(false)),
    prepare({ member }) {
      return member.isCommunicationDisabled() ? {} : { refuse: "modNotTimedOut" };
    },
    async run(moderation, { guild, member, moderator, reason }) {
      return { moderationCase: await moderation.untimeout({ guild, member, moderator, reason }), key: "modUntimedOut" };
    },
  },
  {
    name: "warn",
    permission: PermissionFlagsBits.ModerateMembers,
    descriptionKey: "warnCommandDescription",
    // A warning is only a record, so the bot's own role doesn't matter.
    skipBotHierarchy: true,
    build: (command) => command.addUserOption(memberOption).addStringOption(reasonOption(true)),
    async run(moderation, { guild, member, moderator, reason }) {
      return { moderationCase: await moderation.warn({ guild, member, moderator, reason }), key: "modWarned" };
    },
  },
];

// Whether `userId` is banned. Unknown if the bot can't see bans (then false,
// and the ban itself reports the missing permission).
async function isBanned(guild, userId) {
  try {
    await guild.bans.fetch({ user: userId, force: true });
    return true;
  } catch {
    return false;
  }
}

function buildData(spec) {
  const command = new SlashCommandBuilder()
    .setName(spec.name)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(spec.permission);
  return spec.build(withDescription(command, spec.descriptionKey)).toJSON();
}

// Options:
//   guildSettings    for the staff role (GuildSettings)
//   moderation       carries out the actions (see moderation/moderationService.js)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
//   logger
function createModerationCommand(spec, { guildSettings, moderation, forcedLanguage, logger }) {
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
    if (!isModerator(interaction, spec.permission, guildSettings)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text(PERMISSION_NAMES.get(spec.permission)) });
    }

    const guild = interaction.guild;
    const user = interaction.options.getUser(spec.targetsOutsiders ? "user" : "member", true);
    const member = interaction.options.getMember(spec.targetsOutsiders ? "user" : "member");
    const values = { user: `<@${user.id}>` };

    if (!member && !spec.targetsOutsiders) {
      return answer(Status.REFUSED, "modMemberNotFound", values);
    }
    const problem = member
      ? hierarchyProblem({
          moderator: interaction.member,
          target: member,
          bot: spec.skipBotHierarchy ? undefined : guild.members.me,
          botId: guild.members.me?.id,
          ownerId: guild.ownerId,
          forTimeout: spec.forTimeout,
        })
      : outsiderProblem({ moderator: interaction.member, userId: user.id, botId: guild.members.me?.id });
    if (problem) {
      return answer(Status.REFUSED, problem, values);
    }

    // Talking to Discord several times can take longer than its 3-second limit.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const context = { interaction, guild, user, member, moderator: interaction.user };
    const prepared = (await spec.prepare?.(context)) ?? {};
    if (prepared.refuse) {
      return answer(Status.REFUSED, prepared.refuse, { ...values, ...prepared.values });
    }

    let outcome;
    try {
      outcome = await spec.run(moderation, {
        ...context,
        ...prepared,
        reason: interaction.options.getString("reason")?.trim() || undefined,
      });
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      logger?.warn("The bot lacks a permission for a moderation command", { command: spec.name, guildId: guild.id, error });
      return answer(Status.FAILED, "modBotMissingPermission", {
        ...values,
        permission: text(PERMISSION_NAMES.get(spec.permission)),
      });
    }
    if (outcome.refuse) {
      return answer(Status.REFUSED, outcome.refuse, values);
    }

    const { moderationCase } = outcome;
    const replyValues = { ...values, ...outcome.values, number: moderationCase.number };
    const lines = [text(outcome.key, replyValues)];
    if (moderationCase.dmSent === false) {
      lines.push(text("modDmFailed"));
    }
    await interaction.editReply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
    return result(Status.SUCCESS, outcome.key, replyValues);
  }

  return { name: spec.name, data: buildData(spec), execute };
}

export function createModerationCommands(options) {
  return COMMANDS.map((spec) => createModerationCommand(spec, options));
}
