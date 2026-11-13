// /invites: who invited whom (see members/inviteStats.js).
//
//   /invites member [member]     how many people someone invited, and who invited them
//   /invites top                 the members who brought in the most people still here
//   /invites tracking enabled    switch tracking on or off (Manage Server)
//
// Anyone can look; only Manage Server can switch tracking.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { canReadInvites, inviteTrackingOn } from "../members/inviteStats.js";
import { GrowthStore } from "../members/growthStore.js";
import { Setting } from "../settings/guildSettings.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "invites";
export const INVITES_TOP_SIZE = 10;

export function buildInvitesCommandData() {
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "invitesCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("member"), "invitesMemberDescription").addUserOption((option) =>
        withDescription(option.setName("member"), "invitesMemberOption"),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("top"), "invitesTopDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("tracking"), "invitesTrackingDescription").addBooleanOption((option) =>
        withDescription(option.setName("enabled"), "invitesTrackingOption").setRequired(true),
      ),
    )
    .toJSON();
}

// Options: guildSettings, growth (GrowthStore), inviteTracker (to load a
// server's invites as soon as tracking is switched on), forcedLanguage
export function createInvitesCommand({ guildSettings, growth = new GrowthStore(), inviteTracker, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, lines, key) => {
      await interaction.reply({ content: lines.join("\n").slice(0, 2000), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, [text("guildOnly")], "guildOnly");
    }
    const guild = interaction.guild;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "tracking") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return answer(Status.REFUSED, [text("settingsNoPermission")], "settingsNoPermission");
      }
      const enabled = interaction.options.getBoolean("enabled", true);
      if (enabled) {
        await guildSettings.set(guild.id, Setting.INVITE_TRACKING, true);
        await inviteTracker?.prime(guild);
      } else {
        await guildSettings.clear(guild.id, Setting.INVITE_TRACKING);
      }
      const key = enabled ? "invitesTrackingOn" : "invitesTrackingOff";
      return answer(Status.SUCCESS, [text(key), ...(enabled && !canReadInvites(guild) ? [text("invitesNeedManageServer")] : [])], key);
    }

    if (!inviteTrackingOn(guildSettings, guild.id)) {
      return answer(Status.REFUSED, [text("invitesOff")], "invitesOff");
    }
    const notes = canReadInvites(guild) ? [] : [text("invitesNeedManageServer")];

    if (subcommand === "top") {
      const top = growth.top(guild.id, INVITES_TOP_SIZE);
      if (top.length === 0) {
        return answer(Status.SUCCESS, [text("invitesTopEmpty"), ...notes], "invitesTopEmpty");
      }
      const lines = top.map((row, index) => text("invitesTopLine", { rank: index + 1, user: `<@${row.inviterId}>`, here: row.here, total: row.total }));
      return answer(Status.SUCCESS, [`**${text("invitesTopTitle")}**`, ...lines, ...notes], "invitesTopTitle");
    }

    const user = interaction.options.getUser("member") ?? interaction.user;
    const stats = growth.statsFor(guild.id, user.id);
    const join = growth.joinOf(guild.id, user.id);
    const lines = [text("invitesMemberStats", { user: `<@${user.id}>`, total: stats.total, here: stats.here, left: stats.left })];
    if (join?.inviterId) {
      lines.push(text("invitesMemberJoinedVia", { inviter: `<@${join.inviterId}>`, code: join.code ?? "?" }));
    } else if (join) {
      lines.push(text("invitesMemberJoinedUnknown"));
    }
    return answer(Status.SUCCESS, [...lines, ...notes], "invitesMemberStats");
  }

  return { name: COMMAND_NAME, data: buildInvitesCommandData(), execute };
}
