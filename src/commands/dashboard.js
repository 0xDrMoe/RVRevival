// /dashboard: a private reply with a link button to this server's page on
// the web dashboard. The dashboard itself decides what the person may see
// (Manage Server or a dashboard role), so anyone can ask for the link.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "dashboard";

// The server's page on the dashboard, or null when there's no dashboard.
export function dashboardLink(dashboardUrl, guildId) {
  return dashboardUrl && guildId ? `${dashboardUrl}/#/g/${guildId}` : null;
}

// A row with one link button, for any message that should point at the dashboard.
export function dashboardButtonRow(url, label) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setURL(url).setLabel(label).setEmoji("🦋").setStyle(ButtonStyle.Link));
}

export function buildDashboardCommandData() {
  return withDescription(
    new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild),
    "dashboardCommandDescription",
  ).toJSON();
}

// Options: dashboardUrl (DASHBOARD_URL, may be unset), forcedLanguage
export function createDashboardCommand({ dashboardUrl, forcedLanguage } = {}) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const reply = async (status, key, values = {}, components = []) => {
      await interaction.reply({ content: text(key, values), components, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };

    if (!interaction.inGuild()) {
      return reply(Status.REFUSED, "guildOnly");
    }
    const url = dashboardLink(dashboardUrl, interaction.guildId);
    if (!url) {
      return reply(Status.FAILED, "dashboardNotSetUp");
    }
    const server = escapeMarkdown(interaction.guild?.name ?? text("dashboardThisServer"));
    return reply(Status.SUCCESS, "dashboardLink", { server }, [dashboardButtonRow(url, text("dashboardOpen"))]);
  }

  return { name: COMMAND_NAME, data: buildDashboardCommandData(), execute };
}
