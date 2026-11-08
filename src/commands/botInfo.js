// About the bot itself:
//
//   /botinfo [private]   servers, members, commands, uptime, ping, memory and
//                        versions, with Dashboard, Add to server and Privacy buttons
//   /ping                how quickly Discord and the bot answer (only you see it)
//
// Everyone can use them. Nothing is saved.

import { readFileSync } from "node:fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  version as discordJsVersion,
} from "discord.js";
import { accentColor } from "../branding/branding.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { inviteLink } from "../guilds/invite.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { withDescription } from "./moderation.js";

const BOT_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function buildBotInfoCommandData() {
  return withDescription(new SlashCommandBuilder().setName("botinfo"), "botInfoCommandDescription")
    .setContexts(InteractionContextType.Guild)
    .addBooleanOption((option) => withDescription(option.setName("private"), "infoPrivateOptionDescription"))
    .toJSON();
}

export function buildPingCommandData() {
  return withDescription(new SlashCommandBuilder().setName("ping"), "pingCommandDescription")
    .setContexts(InteractionContextType.Guild)
    .toJSON();
}

// The numbers on the card, from the bot's cache. `memoryBytes` is the
// process's resident memory.
export function botStats(client, { memoryBytes = process.memoryUsage().rss } = {}) {
  let members = 0;
  for (const guild of client.guilds.cache.values()) {
    members += guild.memberCount ?? 0;
  }
  return {
    servers: client.guilds.cache.size,
    members,
    // Discord reports -1 until the first heartbeat comes back.
    pingMs: client.ws?.ping >= 0 ? Math.round(client.ws.ping) : null,
    readyAt: client.readyTimestamp ?? null,
    memoryMb: Math.round(memoryBytes / (1024 * 1024)),
  };
}

export function buildBotInfoEmbed({ client, language, color, commandCount, stats = botStats(client) }) {
  const text = (key, values) => translate(language, key, values);
  const number = (value) => new Intl.NumberFormat(language).format(value);
  const name = client.user?.username ?? "Rabble";
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name, iconURL: client.user?.displayAvatarURL?.({ size: 64 }) })
    .setDescription(text("botInfoAbout", { name }))
    .setFooter({ text: text("botInfoFooter", { version: BOT_VERSION, node: process.versions.node, discordjs: discordJsVersion }) });
  const avatar = client.user?.displayAvatarURL?.({ size: 256 });
  if (avatar) {
    embed.setThumbnail(avatar);
  }
  embed.addFields(
    { name: text("botInfoServers"), value: number(stats.servers), inline: true },
    { name: text("botInfoMembers"), value: number(stats.members), inline: true },
    { name: text("botInfoCommands"), value: number(commandCount), inline: true },
    { name: text("botInfoOnlineSince"), value: stats.readyAt ? `<t:${Math.floor(stats.readyAt / 1000)}:R>` : "?", inline: true },
    { name: text("botInfoPing"), value: stats.pingMs === null ? "?" : text("pingMs", { ms: number(stats.pingMs) }), inline: true },
    { name: text("botInfoMemory"), value: text("botInfoMemoryValue", { mb: number(stats.memoryMb) }), inline: true },
  );
  return embed;
}

// Link buttons: the dashboard and Privacy Policy (when DASHBOARD_URL is set)
// and the invite link.
export function botInfoButtons({ clientId, dashboardUrl, language }) {
  const text = (key) => translate(language, key);
  const buttons = [];
  if (dashboardUrl) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(dashboardUrl).setLabel(text("botInfoDashboard")).setEmoji("🦋"));
  }
  if (clientId) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(inviteLink(clientId)).setLabel(text("botInfoInvite")));
  }
  if (dashboardUrl) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`${dashboardUrl}/privacy`).setLabel(text("botInfoPrivacy")));
  }
  return buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

// Options: guildSettings (for the Branding colour), forcedLanguage,
// dashboardUrl, commandCount() (how many slash commands the bot has), now
export function createBotInfoCommands({ guildSettings, forcedLanguage, dashboardUrl, commandCount = () => 0, now = Date.now }) {
  async function botinfo(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const color = interaction.guildId ? accentColor(guildSettings, interaction.guildId, BRAND_COLOR) : BRAND_COLOR;
    const embed = buildBotInfoEmbed({ client: interaction.client, language, color, commandCount: commandCount() });
    await interaction.reply({
      embeds: [embed],
      components: botInfoButtons({ clientId: interaction.client.user?.id ?? interaction.applicationId, dashboardUrl, language }),
      allowedMentions: { parse: [] },
      ...(interaction.options.getBoolean("private") ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return result(Status.SUCCESS);
  }

  async function ping(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const started = now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roundTrip = Math.max(0, now() - started);
    const gateway = interaction.client.ws?.ping >= 0 ? Math.round(interaction.client.ws.ping) : null;
    const number = (value) => new Intl.NumberFormat(language).format(value);
    await interaction.editReply({
      content: translate(language, "pingResult", {
        roundTrip: number(roundTrip),
        gateway: gateway === null ? "?" : number(gateway),
      }),
    });
    return result(Status.SUCCESS);
  }

  return [
    { name: "botinfo", data: buildBotInfoCommandData(), execute: botinfo },
    { name: "ping", data: buildPingCommandData(), execute: ping },
  ];
}
