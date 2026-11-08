// What happens when the bot is added to a server.
//
// 1. A brand-new server (no saved settings) gets the country role commands
//    switched off, since most servers don't use them. Admins switch them back
//    on from the dashboard's Permissions page. Servers that already had
//    settings, such as one that removed and re-added the bot, keep theirs.
// 2. The bot posts a short "how to set me up" message in the server's system
//    channel, or the first channel it can talk in.
//
// Discord also sends a "guild create" event when a server comes back after an
// outage, so the message only goes out if the bot joined in the last few
// minutes.

import { ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { dashboardButtonRow } from "../commands/dashboard.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";

export const COUNTRY_COMMANDS = ["country", "country-help", "country-staff"];
export const RECENT_JOIN_MS = 10 * 60 * 1000;
export const BRAND_COLOR = 0x7c5cff;

const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function canPost(channel, me) {
  return channel?.type === ChannelType.GuildText && Boolean(channel.permissionsFor?.(me)?.has(NEEDED));
}

// The system channel if the bot can post there, else the highest text channel it can.
export function pickIntroChannel(guild) {
  const me = guild.members?.me;
  if (!me) {
    return null;
  }
  if (canPost(guild.systemChannel, me)) {
    return guild.systemChannel;
  }
  const channels = [...(guild.channels?.cache?.values() ?? [])]
    .filter((channel) => canPost(channel, me))
    .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));
  return channels[0] ?? null;
}

export function introEmbed({ language, dashboardUrl, countriesOff }) {
  const lines = [translate(language, "joinIntro")];
  if (dashboardUrl) {
    lines.push(translate(language, "joinDashboard", { url: dashboardUrl }));
  }
  lines.push(translate(language, "joinGuide"));
  if (countriesOff) {
    lines.push(translate(language, "joinCountriesOff"));
  }
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(translate(language, "joinTitle"))
    .setDescription(lines.join("\n\n"));
}

export function createGuildJoinHandler({ guildSettings, logger, dashboardUrl, forcedLanguage, now = () => Date.now() }) {
  async function switchOffCountries(guild) {
    if (Object.keys(guildSettings.all(guild.id)).length > 0) {
      return false;
    }
    const rules = Object.fromEntries(
      COUNTRY_COMMANDS.map((name) => [name, { disabled: true, roleIds: [], blockedRoleIds: [], channelIds: [] }]),
    );
    await guildSettings.set(guild.id, Setting.COMMAND_RULES, rules);
    return true;
  }

  async function guildJoined(guild) {
    const joinedAt = guild.joinedTimestamp ?? 0;
    if (now() - joinedAt > RECENT_JOIN_MS) {
      return;
    }
    const countriesOff = await switchOffCountries(guild);
    logger.info("Added to a server", { guild: guild.id, members: guild.memberCount, countriesOff });

    const channel = pickIntroChannel(guild);
    if (!channel) {
      return;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    const base = dashboardUrl ? `${dashboardUrl}/#/g/${guild.id}` : undefined;
    await channel.send({
      embeds: [introEmbed({ language, dashboardUrl: base, countriesOff })],
      components: base ? [dashboardButtonRow(base, translate(language, "dashboardOpen"))] : [],
      allowedMentions: { parse: [] },
    });
  }

  return { guildJoined };
}
