// The /country-channel command: lets server admins limit /country to one channel.
//
//   /country-channel set channel:#roles   only allow /country in #roles
//   /country-channel clear                allow /country in any channel again
//   /country-channel show                 say which channel is set
//
// Only members with the Manage Server permission can see or use it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";

const COMMAND_NAME = "country-channel";
const CHANNEL_OPTION = "channel";

// Shorthand for an English description plus its translations.
function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildCountryChannelCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

  return withDescription(command, "channelCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "channelSetDescription").addChannelOption((option) =>
        withDescription(option.setName(CHANNEL_OPTION), "channelOptionDescription")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("clear"), "channelClearDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("show"), "channelShowDescription"))
    .toJSON();
}

// Options:
//   channelSettings  where the chosen channel is stored (ChannelSettings)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createCountryChannelCommand({ channelSettings, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const reply = (key, values) =>
      interaction.reply({ content: translate(language, key, values), flags: MessageFlags.Ephemeral });

    if (!interaction.inCachedGuild()) {
      await reply("guildOnly");
      return;
    }
    // Discord already hides the command from everyone else, but check anyway.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await reply("channelNoPermission");
      return;
    }

    const guildId = interaction.guildId;
    switch (interaction.options.getSubcommand()) {
      case "set": {
        const channel = interaction.options.getChannel(CHANNEL_OPTION, true);
        await channelSettings.set(guildId, channel.id);
        await reply("channelSet", { channel: `<#${channel.id}>` });
        break;
      }
      case "clear":
        await channelSettings.clear(guildId);
        await reply("channelCleared");
        break;
      case "show": {
        const channelId = channelSettings.get(guildId);
        await (channelId ? reply("channelShow", { channel: `<#${channelId}>` }) : reply("channelShowNone"));
        break;
      }
    }
  }

  return { name: COMMAND_NAME, data: buildCountryChannelCommandData(), execute };
}
