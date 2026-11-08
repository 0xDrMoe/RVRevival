// /serverinfo [private]: an embed about this server (owner, age, members,
// channels, roles, boosts, verification level and notable features).
//
// Everyone can use it. The colour is the server's embed colour from the
// dashboard's Branding page. Nothing is fetched from Discord: everything comes
// from the cache, so it answers instantly even on big servers.

import { ChannelType, EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { accentColor } from "../branding/branding.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "serverinfo";

// Discord's server features worth showing, in this order. Each has a
// serverInfoFeature_<NAME> translation; the rest are internal or rare.
export const SHOWN_FEATURES = [
  "VERIFIED",
  "PARTNERED",
  "COMMUNITY",
  "DISCOVERABLE",
  "GUILD_ONBOARDING",
  "WELCOME_SCREEN_ENABLED",
  "MEMBER_VERIFICATION_GATE_ENABLED",
  "AUTO_MODERATION",
  "NEWS",
  "ROLE_ICONS",
  "VANITY_URL",
  "ANIMATED_ICON",
  "BANNER",
  "INVITE_SPLASH",
];

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

export function buildServerInfoCommandData() {
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "serverInfoCommandDescription")
    .addBooleanOption((option) => withDescription(option.setName("private"), "serverInfoPrivateOptionDescription"))
    .toJSON();
}

// The numbers in the embed. Bots are counted from the member cache, so the
// people/bots split is only given when every member is cached.
export function serverInfoCounts(guild) {
  const members = guild.memberCount ?? 0;
  const cached = [...(guild.members?.cache?.values?.() ?? [])];
  const bots = cached.length > 0 && cached.length >= members ? cached.filter((member) => member.user?.bot).length : null;
  const channels = { text: 0, voice: 0, categories: 0 };
  for (const channel of guild.channels?.cache?.values?.() ?? []) {
    if (TEXT_TYPES.has(channel.type)) {
      channels.text += 1;
    } else if (VOICE_TYPES.has(channel.type)) {
      channels.voice += 1;
    } else if (channel.type === ChannelType.GuildCategory) {
      channels.categories += 1;
    }
  }
  return {
    members,
    bots,
    humans: bots === null ? null : Math.max(0, members - bots),
    channels,
    // Without @everyone.
    roles: Math.max(0, (guild.roles?.cache?.size ?? 1) - 1),
    emojis: guild.emojis?.cache?.size ?? 0,
    stickers: guild.stickers?.cache?.size ?? 0,
    boosts: guild.premiumSubscriptionCount ?? 0,
    tier: guild.premiumTier ?? 0,
  };
}

export function buildServerInfoEmbed(guild, { language, color }) {
  const text = (key, values) => translate(language, key, values);
  const number = (value) => new Intl.NumberFormat(language).format(value);
  const counts = serverInfoCounts(guild);
  const created = Math.floor(guild.createdTimestamp / 1000);
  const features = SHOWN_FEATURES.filter((feature) => guild.features?.includes(feature)).map((feature) => text(`serverInfoFeature_${feature}`));
  const verification = Number.isInteger(guild.verificationLevel) && guild.verificationLevel >= 0 && guild.verificationLevel <= 4 ? guild.verificationLevel : 0;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(guild.name)
    .setFooter({ text: text("serverInfoFooter", { id: guild.id }) });
  const description = [guild.description, guild.vanityURLCode ? `https://discord.gg/${guild.vanityURLCode}` : null].filter(Boolean).join("\n");
  if (description) {
    embed.setDescription(description.slice(0, 4096));
  }
  const icon = guild.iconURL?.({ size: 256 });
  if (icon) {
    embed.setThumbnail(icon);
  }
  const banner = guild.bannerURL?.({ size: 1024 });
  if (banner) {
    embed.setImage(banner);
  }
  embed.addFields(
    { name: text("serverInfoOwner"), value: guild.ownerId ? `<@${guild.ownerId}>` : "?", inline: true },
    { name: text("serverInfoCreated"), value: `<t:${created}:D>\n<t:${created}:R>`, inline: true },
    {
      name: text("serverInfoMembers"),
      value:
        counts.bots === null
          ? number(counts.members)
          : text("serverInfoMembersValue", { total: number(counts.members), humans: number(counts.humans), bots: number(counts.bots) }),
      inline: true,
    },
    {
      name: text("serverInfoChannels"),
      value: text("serverInfoChannelsValue", {
        text: number(counts.channels.text),
        voice: number(counts.channels.voice),
        categories: number(counts.channels.categories),
      }),
      inline: true,
    },
    { name: text("serverInfoRoles"), value: number(counts.roles), inline: true },
    { name: text("serverInfoEmojis"), value: text("serverInfoEmojisValue", { emojis: number(counts.emojis), stickers: number(counts.stickers) }), inline: true },
    { name: text("serverInfoBoosts"), value: text("serverInfoBoostsValue", { count: number(counts.boosts), tier: number(counts.tier) }), inline: true },
    { name: text("serverInfoVerification"), value: text(`serverInfoVerification_${verification}`), inline: true },
    { name: text("serverInfoFeatures"), value: features.length > 0 ? features.join(", ") : text("serverInfoNoFeatures") },
  );
  return embed;
}

// Options: guildSettings, forcedLanguage
export function createServerInfoCommand({ guildSettings, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: translate(language, "guildOnly"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const embed = buildServerInfoEmbed(guild, { language, color: accentColor(guildSettings, guild.id, BRAND_COLOR) });
    await interaction.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
      ...(interaction.options.getBoolean("private") ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return result(Status.SUCCESS);
  }

  return { name: COMMAND_NAME, data: buildServerInfoCommandData(), execute };
}
