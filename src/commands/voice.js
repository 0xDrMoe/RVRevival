// Join-to-create voice channels.
//
//   /voice setup hub:<voice channel> [category] [name] [limit]   turn it on (Manage Server)
//   /voice off                                                   turn it off (Manage Server)
//   /voice lock                 only people already inside (and staff) can join your channel
//   /voice unlock               anyone can join again
//   /voice claim                take over a channel whose owner left
//
// Owners rename their channel, set a user limit and disconnect people with
// Discord's own channel menus (they have Manage Channels on it). See voice/tempVoice.js.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import {
  DEFAULT_NAME_TEMPLATE,
  MAX_NAME_TEMPLATE_LENGTH,
  MAX_USER_LIMIT,
  OWNER_PERMISSIONS,
  TEMP_VOICE_PERMISSIONS,
  tempVoiceSettings,
} from "../voice/tempVoice.js";

const COMMAND_NAME = "voice";

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildVoiceCommandData() {
  const command = new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild);
  return withDescription(command, "voiceCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("setup"), "voiceSetupDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("hub"), "voiceHubOptionDescription").setRequired(true).addChannelTypes(ChannelType.GuildVoice),
        )
        .addChannelOption((option) =>
          withDescription(option.setName("category"), "voiceCategoryOptionDescription").addChannelTypes(ChannelType.GuildCategory),
        )
        .addStringOption((option) => withDescription(option.setName("name"), "voiceNameOptionDescription").setMaxLength(MAX_NAME_TEMPLATE_LENGTH))
        .addIntegerOption((option) =>
          withDescription(option.setName("limit"), "voiceLimitOptionDescription").setMinValue(0).setMaxValue(MAX_USER_LIMIT),
        ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("off"), "voiceOffDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("lock"), "voiceLockDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("unlock"), "voiceUnlockDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("claim"), "voiceClaimDescription"))
    .toJSON();
}

// Options: guildSettings, store (TempVoiceStore; only needed to run the command), forcedLanguage
export function createVoiceCommand({ guildSettings, store, forcedLanguage }) {
  async function setup(interaction, answer) {
    const guild = interaction.guild;
    const hub = interaction.options.getChannel("hub", true);
    const category = interaction.options.getChannel("category");
    const nameTemplate = interaction.options.getString("name")?.trim() || DEFAULT_NAME_TEMPLATE;
    const userLimit = interaction.options.getInteger("limit") ?? 0;
    const parent = category ?? guild.channels.cache.get(hub.parentId ?? "") ?? hub;
    const me = guild.members.me;
    if (!me || !parent.permissionsFor?.(me)?.has(TEMP_VOICE_PERMISSIONS)) {
      return answer(Status.REFUSED, "voiceBotMissingPermission");
    }
    await guildSettings.set(guild.id, Setting.TEMP_VOICE, {
      hubChannelId: hub.id,
      categoryId: category?.id ?? null,
      nameTemplate,
      userLimit,
    });
    return answer(Status.SUCCESS, "voiceSetupDone", { hub: `<#${hub.id}>`, name: nameTemplate });
  }

  // The temp channel the member is in, and whether they own it.
  function ownChannel(interaction) {
    const channel = interaction.member.voice?.channel;
    const saved = channel && store.get(channel.id);
    return { channel, saved };
  }

  async function setLocked(interaction, answer, locking) {
    const { channel, saved } = ownChannel(interaction);
    if (!saved) {
      return answer(Status.REFUSED, "voiceNotInTempChannel");
    }
    if (saved.ownerId !== interaction.user.id) {
      return answer(Status.REFUSED, "voiceNotOwner", { owner: `<@${saved.ownerId}>` });
    }
    const guildId = interaction.guildId;
    await channel.permissionOverwrites.edit(guildId, { Connect: locking ? false : null }, { reason: `Join-to-create channel ${locking ? "locked" : "unlocked"} by its owner` });
    if (locking) {
      // People already inside may come back if they drop.
      for (const member of channel.members.values()) {
        if (member.id !== interaction.user.id && !member.user?.bot) {
          await channel.permissionOverwrites.edit(member.id, { Connect: true }, { reason: "In the channel when it was locked" }).catch(() => {});
        }
      }
    }
    return answer(Status.SUCCESS, locking ? "voiceLocked" : "voiceUnlocked");
  }

  async function claim(interaction, answer) {
    const { channel, saved } = ownChannel(interaction);
    if (!saved) {
      return answer(Status.REFUSED, "voiceNotInTempChannel");
    }
    if (saved.ownerId === interaction.user.id) {
      return answer(Status.REFUSED, "voiceAlreadyOwner");
    }
    if (channel.members.has(saved.ownerId)) {
      return answer(Status.REFUSED, "voiceOwnerStillHere", { owner: `<@${saved.ownerId}>` });
    }
    await channel.permissionOverwrites.delete(saved.ownerId, "Join-to-create channel claimed").catch(() => {});
    await channel.permissionOverwrites.edit(interaction.user.id, OWNER_PERMISSIONS, { reason: "Join-to-create channel claimed" });
    store.setOwner(channel.id, interaction.user.id);
    return answer(Status.SUCCESS, "voiceClaimed");
  }

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: translate(language, key, values), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "setup" || subcommand === "off") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return answer(Status.REFUSED, "voiceNeedsManageGuild");
      }
      if (subcommand === "setup") {
        return setup(interaction, answer);
      }
      if (!tempVoiceSettings(guildSettings, interaction.guildId)) {
        return answer(Status.REFUSED, "voiceAlreadyOff");
      }
      await guildSettings.clear(interaction.guildId, Setting.TEMP_VOICE);
      return answer(Status.SUCCESS, "voiceOffDone");
    }
    if (subcommand === "claim") {
      return claim(interaction, answer);
    }
    return setLocked(interaction, answer, subcommand === "lock");
  }

  return { name: COMMAND_NAME, data: buildVoiceCommandData(), execute };
}
