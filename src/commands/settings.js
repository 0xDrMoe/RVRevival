// The /settings command: server admins choose how the bot behaves in their server.
//
//   /settings staff-role role:@Staff             members with this role can use /country-staff
//   /settings country-channel channel:#roles     only allow /country in #roles; other messages there are deleted
//   /settings logs-channel channel:#bot-logs     log everything members do with the bot in #bot-logs
//   /settings mod-log-channel channel:#mod-log   post moderation cases in #mod-log (otherwise the logs channel)
//   /settings server-log-channel channel:#server-log   log edits, deletions, joins, leaves and role changes
//   /settings clear setting:<staff role | /country channel | logs channel | mod-log channel | server-log channel>
//   /settings show                               list the current settings
//
// Only members with the Manage Server permission can see or use it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";

const COMMAND_NAME = "settings";
const ROLE_OPTION = "role";
const CHANNEL_OPTION = "channel";
const SETTING_OPTION = "setting";

// The choices for /settings clear, and the message for each.
const CLEARABLE = [
  { value: Setting.STAFF_ROLE, nameKey: "settingsStaffRoleName", clearedKey: "settingsStaffRoleCleared" },
  { value: Setting.COUNTRY_CHANNEL, nameKey: "settingsCountryChannelName", clearedKey: "settingsCountryChannelCleared" },
  { value: Setting.LOGS_CHANNEL, nameKey: "settingsLogsChannelName", clearedKey: "settingsLogsChannelCleared" },
  { value: Setting.MOD_LOG_CHANNEL, nameKey: "settingsModLogChannelName", clearedKey: "settingsModLogChannelCleared" },
  {
    value: Setting.SERVER_LOG_CHANNEL,
    nameKey: "settingsServerLogChannelName",
    clearedKey: "settingsServerLogChannelCleared",
  },
];

// Whether the bot has every permission in `wanted` in `channel`.
function botHasPermissionsIn(channel, guild, wanted) {
  const permissions = guild.members.me ? channel.permissionsFor?.(guild.members.me) : null;
  return Boolean(permissions?.has(wanted));
}

const DELETE_MESSAGES = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages];
const POST_LOGS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];

// A required text or announcement channel option.
function channelOption(option, descriptionKey) {
  return withDescription(option.setName(CHANNEL_OPTION), descriptionKey)
    .setRequired(true)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
}

// Shorthand for an English description plus its translations.
function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildSettingsCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  return withDescription(command, "settingsCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("staff-role"), "settingsStaffRoleDescription").addRoleOption((option) =>
        withDescription(option.setName(ROLE_OPTION), "settingsRoleOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("country-channel"), "settingsCountryChannelDescription").addChannelOption((option) =>
        channelOption(option, "settingsChannelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("logs-channel"), "settingsLogsChannelDescription").addChannelOption((option) =>
        channelOption(option, "settingsLogsChannelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("mod-log-channel"), "settingsModLogChannelDescription").addChannelOption((option) =>
        channelOption(option, "settingsModLogChannelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("server-log-channel"), "settingsServerLogChannelDescription").addChannelOption(
        (option) => channelOption(option, "settingsServerLogChannelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("clear"), "settingsClearDescription").addStringOption((option) =>
        withDescription(option.setName(SETTING_OPTION), "settingsSettingOptionDescription")
          .setRequired(true)
          .addChoices(
            ...CLEARABLE.map(({ value, nameKey }) => ({
              name: translate("en", nameKey),
              name_localizations: discordLocalizations(nameKey),
              value,
            })),
          ),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("show"), "settingsShowDescription"))
    .toJSON();
}

// Options:
//   guildSettings    where the settings are stored (GuildSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createSettingsCommand({ guildSettings, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const guildId = interaction.guildId;
    // Answers privately and reports how the command ended.
    const reply = async (status, key, values) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    // Saves a channel setting, warning the admin (in the same reply) when the
    // bot is missing permissions there. It's saved anyway, so it starts working
    // as soon as the permissions are fixed.
    const setChannel = async (setting, setKey, wanted, warningKey) => {
      const channel = interaction.options.getChannel(CHANNEL_OPTION, true);
      await guildSettings.set(guildId, setting, channel.id);
      const values = { channel: `<#${channel.id}>` };
      const lines = [text(setKey, values)];
      if (!botHasPermissionsIn(channel, interaction.guild, wanted)) {
        lines.push(text(warningKey, values));
      }
      await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
      if (lines.length === 1) {
        return result(Status.SUCCESS, setKey, values);
      }
      // The log is always English, so build the same two lines in English.
      return { status: Status.SUCCESS, note: [setKey, warningKey].map((key) => translate("en", key, values)).join("\n") };
    };

    if (!interaction.inCachedGuild()) {
      return reply(Status.REFUSED, "guildOnly");
    }
    // Discord already hides the command from everyone else, but check anyway.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return reply(Status.REFUSED, "settingsNoPermission");
    }

    switch (interaction.options.getSubcommand()) {
      case "staff-role": {
        const role = interaction.options.getRole(ROLE_OPTION, true);
        // @everyone has the server's ID. Making it the staff role would let anyone change countries.
        if (role.id === guildId) {
          return reply(Status.REFUSED, "settingsStaffRoleEveryone");
        }
        await guildSettings.set(guildId, Setting.STAFF_ROLE, role.id);
        return reply(Status.SUCCESS, "settingsStaffRoleSet", { role: `<@&${role.id}>` });
      }
      case "country-channel":
        return setChannel(
          Setting.COUNTRY_CHANNEL,
          "settingsCountryChannelSet",
          DELETE_MESSAGES,
          "settingsCountryChannelNeedsManageMessages",
        );
      case "logs-channel":
        return setChannel(Setting.LOGS_CHANNEL, "settingsLogsChannelSet", POST_LOGS, "settingsLogsChannelNeedsPermissions");
      case "mod-log-channel":
        return setChannel(Setting.MOD_LOG_CHANNEL, "settingsModLogChannelSet", POST_LOGS, "settingsLogsChannelNeedsPermissions");
      case "server-log-channel":
        return setChannel(
          Setting.SERVER_LOG_CHANNEL,
          "settingsServerLogChannelSet",
          POST_LOGS,
          "settingsLogsChannelNeedsPermissions",
        );
      case "clear": {
        const choice = CLEARABLE.find(({ value }) => value === interaction.options.getString(SETTING_OPTION, true));
        if (!choice) {
          return reply(Status.FAILED, "unexpected");
        }
        await guildSettings.clear(guildId, choice.value);
        return reply(Status.SUCCESS, choice.clearedKey);
      }
      case "show": {
        const staffRoleId = guildSettings.get(guildId, Setting.STAFF_ROLE);
        const channelId = guildSettings.get(guildId, Setting.COUNTRY_CHANNEL);
        const logsChannelId = guildSettings.get(guildId, Setting.LOGS_CHANNEL);
        const modLogChannelId = guildSettings.get(guildId, Setting.MOD_LOG_CHANNEL);
        const serverLogChannelId = guildSettings.get(guildId, Setting.SERVER_LOG_CHANNEL);
        const lines = [
          staffRoleId ? text("settingsShowStaffRole", { role: `<@&${staffRoleId}>` }) : text("settingsShowNoStaffRole"),
          channelId ? text("settingsShowCountryChannel", { channel: `<#${channelId}>` }) : text("settingsShowNoCountryChannel"),
          logsChannelId ? text("settingsShowLogsChannel", { channel: `<#${logsChannelId}>` }) : text("settingsShowNoLogsChannel"),
          modLogChannelId
            ? text("settingsShowModLogChannel", { channel: `<#${modLogChannelId}>` })
            : text("settingsShowNoModLogChannel"),
          serverLogChannelId
            ? text("settingsShowServerLogChannel", { channel: `<#${serverLogChannelId}>` })
            : text("settingsShowNoServerLogChannel"),
        ];
        // Mentions in an ephemeral reply never ping, but say so explicitly anyway.
        await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return result(Status.SUCCESS);
      }
    }
    return reply(Status.FAILED, "unexpected");
  }

  return { name: COMMAND_NAME, data: buildSettingsCommandData(), execute };
}
