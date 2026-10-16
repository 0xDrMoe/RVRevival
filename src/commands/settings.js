// The /settings command: server admins choose how the bot behaves in their server.
//
//   /settings staff-role role:@Staff             members with this role can use /country-staff
//   /settings country-channel channel:#roles     only allow /country in #roles; other messages there are deleted
//   /settings logs-channel channel:#bot-logs     log everything members do with the bot in #bot-logs
//   /settings mod-log-channel channel:#mod-log   post moderation cases in #mod-log (otherwise the logs channel)
//   /settings server-log-channel channel:#server-log   log edits, deletions, joins, leaves and role changes
//   /settings mod-role role:@Mods                members with this role can use the moderation commands
//   /settings log-event event:<…> enabled:false  switch one kind of server-log event off (or back on)
//   /settings log-ignore channel:#spam           stop (or start again) logging messages from #spam
//   /settings automod …                          set up automod (see automodSettings.js)
//   /settings clear setting:<any of the above>
//   /settings show                               list the current settings
//
// Only members with the Manage Server permission can see or use it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { normalizeAutomod } from "../automod/config.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { LogEvent } from "../logs/serverLog.js";
import { Setting } from "../settings/guildSettings.js";
import { addAutomodGroup, AUTOMOD_GROUP, runAutomodSubcommand } from "./automodSettings.js";

const COMMAND_NAME = "settings";
const ROLE_OPTION = "role";
const CHANNEL_OPTION = "channel";
const SETTING_OPTION = "setting";
const EVENT_OPTION = "event";
const ENABLED_OPTION = "enabled";

// The server-log events admins can switch off, and how each is named.
const LOG_EVENT_NAMES = [
  { value: LogEvent.MESSAGE_EDIT, nameKey: "logEventMessageEdit" },
  { value: LogEvent.MESSAGE_DELETE, nameKey: "logEventMessageDelete" },
  { value: LogEvent.BULK_DELETE, nameKey: "logEventBulkDelete" },
  { value: LogEvent.MEMBER_JOIN, nameKey: "logEventMemberJoin" },
  { value: LogEvent.MEMBER_LEAVE, nameKey: "logEventMemberLeave" },
  { value: LogEvent.MEMBER_UPDATE, nameKey: "logEventMemberUpdate" },
];

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
  { value: Setting.MOD_ROLE, nameKey: "settingsModRoleName", clearedKey: "settingsModRoleCleared" },
  { value: Setting.DISABLED_LOG_EVENTS, nameKey: "settingsLogEventsName", clearedKey: "settingsLogEventsCleared" },
  { value: Setting.LOG_IGNORED_CHANNELS, nameKey: "settingsLogIgnoreName", clearedKey: "settingsLogIgnoreCleared" },
  { value: Setting.AUTOMOD, nameKey: "settingsAutomodName", clearedKey: "settingsAutomodCleared" },
];

// Discord choices for `entries` ({ value, nameKey }), named in every language.
const choicesOf = (entries) =>
  entries.map(({ value, nameKey }) => ({ name: translate("en", nameKey), name_localizations: discordLocalizations(nameKey), value }));

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

  const built = withDescription(command, "settingsCommandDescription")
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
      withDescription(sub.setName("mod-role"), "settingsModRoleDescription").addRoleOption((option) =>
        withDescription(option.setName(ROLE_OPTION), "settingsModRoleOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("log-event"), "settingsLogEventDescription")
        .addStringOption((option) =>
          withDescription(option.setName(EVENT_OPTION), "settingsLogEventOptionDescription")
            .setRequired(true)
            .addChoices(...choicesOf(LOG_EVENT_NAMES)),
        )
        .addBooleanOption((option) =>
          withDescription(option.setName(ENABLED_OPTION), "settingsLogEventEnabledDescription").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("log-ignore"), "settingsLogIgnoreDescription").addChannelOption((option) =>
        withDescription(option.setName(CHANNEL_OPTION), "settingsLogIgnoreOptionDescription")
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildForum,
            ChannelType.GuildVoice,
            ChannelType.GuildCategory,
          ),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("clear"), "settingsClearDescription").addStringOption((option) =>
        withDescription(option.setName(SETTING_OPTION), "settingsSettingOptionDescription")
          .setRequired(true)
          .addChoices(...choicesOf(CLEARABLE)),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("show"), "settingsShowDescription"));
  return addAutomodGroup(built).toJSON();
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

    if (interaction.options.getSubcommandGroup(false) === AUTOMOD_GROUP) {
      return runAutomodSubcommand(interaction, {
        guildSettings,
        text,
        // Some answers add a line or two (keys in `extraKeys`) with the same values.
        reply: async (status, key, values, extraKeys = []) => {
          const keys = [key, ...extraKeys];
          await interaction.reply({
            content: keys.map((entry) => text(entry, values)).join("\n"),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
          if (extraKeys.length === 0) {
            return result(status, key, values);
          }
          return { status, note: keys.map((entry) => translate("en", entry, values)).join("\n") };
        },
        show: async (lines) => {
          await interaction.reply({ content: lines.join("\n").slice(0, 2000), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          return result(Status.SUCCESS);
        },
      });
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
      case "mod-role": {
        const role = interaction.options.getRole(ROLE_OPTION, true);
        // Making @everyone the mod role would let anyone ban, kick and time out.
        if (role.id === guildId) {
          return reply(Status.REFUSED, "settingsModRoleEveryone");
        }
        await guildSettings.set(guildId, Setting.MOD_ROLE, role.id);
        return reply(Status.SUCCESS, "settingsModRoleSet", { role: `<@&${role.id}>` });
      }
      case "log-event": {
        const choice = LOG_EVENT_NAMES.find(({ value }) => value === interaction.options.getString(EVENT_OPTION, true));
        if (!choice) {
          return reply(Status.FAILED, "unexpected");
        }
        const enabled = interaction.options.getBoolean(ENABLED_OPTION, true);
        const disabled = guildSettings.getList(guildId, Setting.DISABLED_LOG_EVENTS);
        if (disabled.includes(choice.value) === enabled) {
          await guildSettings.toggleInList(guildId, Setting.DISABLED_LOG_EVENTS, choice.value);
        }
        return reply(Status.SUCCESS, enabled ? "settingsLogEventOn" : "settingsLogEventOff", {
          event: text(choice.nameKey),
        });
      }
      case "log-ignore": {
        const channel = interaction.options.getChannel(CHANNEL_OPTION, true);
        const added = await guildSettings.toggleInList(guildId, Setting.LOG_IGNORED_CHANNELS, channel.id);
        return reply(Status.SUCCESS, added ? "settingsLogIgnoreAdded" : "settingsLogIgnoreRemoved", {
          channel: `<#${channel.id}>`,
        });
      }
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
        const modRoleId = guildSettings.get(guildId, Setting.MOD_ROLE);
        const offEvents = LOG_EVENT_NAMES.filter(({ value }) =>
          guildSettings.getList(guildId, Setting.DISABLED_LOG_EVENTS).includes(value),
        );
        const ignored = guildSettings.getList(guildId, Setting.LOG_IGNORED_CHANNELS);
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
          modRoleId ? text("settingsShowModRole", { role: `<@&${modRoleId}>` }) : text("settingsShowNoModRole"),
          offEvents.length > 0
            ? text("settingsShowLogEvents", { events: offEvents.map(({ nameKey }) => text(nameKey)).join(", ") })
            : text("settingsShowAllLogEvents"),
          ignored.length > 0
            ? text("settingsShowLogIgnore", { channels: ignored.map((id) => `<#${id}>`).join(", ") })
            : text("settingsShowNoLogIgnore"),
          text("settingsShowAutomod", {
            status: text(normalizeAutomod(guildSettings.get(guildId, Setting.AUTOMOD)).enabled ? "automodStatusOn" : "automodStatusOff"),
          }),
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
