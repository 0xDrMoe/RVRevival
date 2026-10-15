// The /settings command: server admins choose how the bot behaves in their server.
//
//   /settings staff-role role:@Staff             members with this role can use /country-staff
//   /settings country-channel channel:#roles     only allow /country in #roles; other messages there are deleted
//   /settings clear setting:<staff role | /country channel>
//   /settings show                               list the current settings
//
// Only members with the Manage Server permission can see or use it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";

const COMMAND_NAME = "settings";
const ROLE_OPTION = "role";
const CHANNEL_OPTION = "channel";
const SETTING_OPTION = "setting";

// The choices for /settings clear, and the message for each.
const CLEARABLE = [
  { value: Setting.STAFF_ROLE, nameKey: "settingsStaffRoleName", clearedKey: "settingsStaffRoleCleared" },
  { value: Setting.COUNTRY_CHANNEL, nameKey: "settingsCountryChannelName", clearedKey: "settingsCountryChannelCleared" },
];

// Whether the bot can delete other people's messages in `channel`.
function botCanDeleteMessagesIn(channel, guild) {
  const permissions = guild.members.me ? channel.permissionsFor?.(guild.members.me) : null;
  return Boolean(permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages]));
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
        withDescription(option.setName(CHANNEL_OPTION), "settingsChannelOptionDescription")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
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
    const reply = (key, values) => interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral });

    if (!interaction.inCachedGuild()) {
      await reply("guildOnly");
      return;
    }
    // Discord already hides the command from everyone else, but check anyway.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await reply("settingsNoPermission");
      return;
    }

    const guildId = interaction.guildId;
    switch (interaction.options.getSubcommand()) {
      case "staff-role": {
        const role = interaction.options.getRole(ROLE_OPTION, true);
        // @everyone has the server's ID. Making it the staff role would let anyone change countries.
        if (role.id === guildId) {
          await reply("settingsStaffRoleEveryone");
          return;
        }
        await guildSettings.set(guildId, Setting.STAFF_ROLE, role.id);
        await reply("settingsStaffRoleSet", { role: `<@&${role.id}>` });
        break;
      }
      case "country-channel": {
        const channel = interaction.options.getChannel(CHANNEL_OPTION, true);
        await guildSettings.set(guildId, Setting.COUNTRY_CHANNEL, channel.id);
        const mention = `<#${channel.id}>`;
        const lines = [text("settingsCountryChannelSet", { channel: mention })];
        // Save it anyway, but tell the admin the channel won't be kept clean yet.
        if (!botCanDeleteMessagesIn(channel, interaction.guild)) {
          lines.push(text("settingsCountryChannelNeedsManageMessages", { channel: mention }));
        }
        await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
        break;
      }
      case "clear": {
        const choice = CLEARABLE.find(({ value }) => value === interaction.options.getString(SETTING_OPTION, true));
        if (!choice) {
          await reply("unexpected");
          return;
        }
        await guildSettings.clear(guildId, choice.value);
        await reply(choice.clearedKey);
        break;
      }
      case "show": {
        const staffRoleId = guildSettings.get(guildId, Setting.STAFF_ROLE);
        const channelId = guildSettings.get(guildId, Setting.COUNTRY_CHANNEL);
        const lines = [
          staffRoleId ? text("settingsShowStaffRole", { role: `<@&${staffRoleId}>` }) : text("settingsShowNoStaffRole"),
          channelId ? text("settingsShowCountryChannel", { channel: `<#${channelId}>` }) : text("settingsShowNoCountryChannel"),
        ];
        // Mentions in an ephemeral reply never ping, but say so explicitly anyway.
        await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        break;
      }
    }
  }

  return { name: COMMAND_NAME, data: buildSettingsCommandData(), execute };
}
