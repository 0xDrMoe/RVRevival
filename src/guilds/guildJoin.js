// What happens when the bot is added to a server.
//
// 1. A brand-new server (no saved settings) gets the country role commands
//    switched off, since most servers don't use them. Admins switch them back
//    on from the dashboard's Permissions page. Servers that already had
//    settings, such as one that removed and re-added the bot, keep theirs.
// 2. The bot posts a short "how to set me up" message in the server's system
//    channel, or the first channel it can talk in: a setup checklist with
//    clickable commands, any invite permissions its role is missing, and
//    buttons to the dashboard and the guide.
//
// Discord also sends a "guild create" event when a server comes back after an
// outage, so the message only goes out if the bot joined in the last few
// minutes.

import { ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { linkCommands } from "../commands/commandMentions.js";
import { dashboardButtonRow } from "../commands/dashboard.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import { INVITE_PERMISSIONS } from "./invite.js";

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

// The setup checklist, in the order most servers need it.
const SETUP_STEPS = ["joinStepModLog", "joinStepModRole", "joinStepAutomod", "joinStepWelcome", "joinStepTickets"];

// "ManageRoles" -> "Manage Roles".
const permissionName = (name) => name.replace(/([a-z])([A-Z])/g, "$1 $2");

// The invite permissions the bot's role doesn't have here (someone unticked
// them on the invite page), as readable names.
export function missingInvitePermissions(me) {
  if (!me?.permissions || me.permissions.has(PermissionFlagsBits.Administrator)) {
    return [];
  }
  return new PermissionsBitField(BigInt(INVITE_PERMISSIONS)).toArray().filter((name) => !me.permissions.has(PermissionFlagsBits[name])).map(permissionName);
}

export function introEmbed({ language, dashboardUrl, countriesOff, missing = [] }) {
  const lines = [translate(language, "joinIntro")];
  if (dashboardUrl) {
    lines.push(translate(language, "joinDashboard", { url: dashboardUrl }));
  }
  lines.push(
    [`**${translate(language, "joinChecklist")}**`, ...SETUP_STEPS.map((key, index) => `${index + 1}. ${linkCommands(translate(language, key))}`)].join("\n"),
  );
  lines.push(linkCommands(translate(language, "joinGuide")));
  if (missing.length > 0) {
    lines.push(translate(language, "joinMissingPermissions", { permissions: missing.join(", ") }));
  }
  if (countriesOff) {
    lines.push(linkCommands(translate(language, "joinCountriesOff")));
  }
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(translate(language, "joinTitle"))
    .setDescription(lines.join("\n\n"));
}

// Open dashboard and Read the guide, when the dashboard is set up.
function joinButtons(language, dashboardUrl, guildId) {
  if (!dashboardUrl) {
    return [];
  }
  const row = dashboardButtonRow(`${dashboardUrl}/g/${guildId}`, translate(language, "dashboardOpen"));
  row.addComponents(new ButtonBuilder().setURL(`${dashboardUrl}/guide`).setLabel(translate(language, "joinGuideButton")).setEmoji("📖").setStyle(ButtonStyle.Link));
  return [row];
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
    const base = dashboardUrl ? `${dashboardUrl}/g/${guild.id}` : undefined;
    const missing = missingInvitePermissions(guild.members.me);
    await channel.send({
      embeds: [introEmbed({ language, dashboardUrl: base, countriesOff, missing })],
      components: joinButtons(language, dashboardUrl, guild.id),
      allowedMentions: { parse: [] },
    });
  }

  return { guildJoined };
}
