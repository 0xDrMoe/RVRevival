// Anti-nuke settings. Only the server owner can change them, since trusted
// users can do anything without the bot stepping in.
//
//   /antinuke status                        what's watched, the limits and who's trusted
//   /antinuke on | off
//   /antinuke limit action count            how many a minute before the bot steps in
//   /antinuke punishment type               take their roles, kick or ban
//   /antinuke trust user | untrust user
//
// status needs Administrator; everything else needs the owner. See raid/antiNuke.js.

import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, translate } from "../i18n/i18n.js";
import { Status } from "../logs/actionLog.js";
import { MAX_LIMIT, MAX_TRUSTED, MIN_LIMIT, normalizeAntiNuke, NUKE_ACTIONS, PUNISHMENTS } from "../raid/antiNuke.js";
import { Setting } from "../settings/guildSettings.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "antinuke";

function withChoiceNames(option, values, prefix) {
  return option.addChoices(
    ...values.map((value) => ({ name: translate("en", `${prefix}${value}`), name_localizations: discordLocalizations(`${prefix}${value}`), value })),
  );
}

export function buildAntiNukeCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  return withDescription(command, "antinukeCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("status"), "antinukeStatusDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("on"), "antinukeOnDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("off"), "antinukeOffDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("limit"), "antinukeLimitDescription")
        .addStringOption((option) =>
          withChoiceNames(withDescription(option.setName("action"), "antinukeActionOptionDescription").setRequired(true), NUKE_ACTIONS, "antinukeAction_"),
        )
        .addIntegerOption((option) =>
          withDescription(option.setName("count"), "antinukeCountOptionDescription").setRequired(true).setMinValue(MIN_LIMIT).setMaxValue(MAX_LIMIT),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("punishment"), "antinukePunishmentDescription").addStringOption((option) =>
        withChoiceNames(withDescription(option.setName("type"), "antinukeTypeOptionDescription").setRequired(true), PUNISHMENTS, "antinukePunishment_"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("trust"), "antinukeTrustDescription").addUserOption((option) =>
        withDescription(option.setName("user"), "antinukeUserOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("untrust"), "antinukeUntrustDescription").addUserOption((option) =>
        withDescription(option.setName("user"), "antinukeUserOptionDescription").setRequired(true),
      ),
    )
    .toJSON();
}

// Options: guildSettings, forcedLanguage
export function createAntiNukeCommand({ guildSettings, forcedLanguage }) {
  async function save(guildId, config) {
    await guildSettings.set(guildId, Setting.ANTI_NUKE, config);
  }

  function status(interaction, answer, text, config) {
    const limits = NUKE_ACTIONS.map((action) => `• ${text(`antinukeAction_${action}`)}: ${config.limits[action]}`).join("\n");
    return answer(Status.SUCCESS, "antinukeStatus", {
      state: text(config.enabled ? "antinukeStatusOn" : "antinukeStatusOff"),
      punishment: text(`antinukePunishment_${config.punishment}`),
      limits,
      trusted: config.trustedUserIds.length > 0 ? config.trustedUserIds.map((id) => `<@${id}>`).join(", ") : text("antinukeNoTrusted"),
    });
  }

  async function execute(interaction) {
    const { answer, text } = beginModerationCommand(interaction, {
      permission: PermissionFlagsBits.Administrator,
      permissionKey: "permAdministrator",
      guildSettings,
      forcedLanguage,
    });
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const subcommand = interaction.options.getSubcommand();
    const config = normalizeAntiNuke(guildSettings.get(guild.id, Setting.ANTI_NUKE));
    const isOwner = interaction.user.id === guild.ownerId;

    if (subcommand === "status") {
      if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return answer(Status.REFUSED, "modNoPermission", { permission: text("permAdministrator") });
      }
      return status(interaction, answer, text, config);
    }
    if (!isOwner) {
      return answer(Status.REFUSED, "antinukeOwnerOnly");
    }

    switch (subcommand) {
      case "on": {
        await save(guild.id, { ...config, enabled: true });
        const readsAuditLog = guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog);
        return answer(Status.SUCCESS, readsAuditLog ? "antinukeOn" : "antinukeOnNoAuditLog");
      }
      case "off":
        await save(guild.id, { ...config, enabled: false });
        return answer(Status.SUCCESS, "antinukeOff");
      case "limit": {
        const action = interaction.options.getString("action", true);
        const count = interaction.options.getInteger("count", true);
        await save(guild.id, { ...config, limits: { ...config.limits, [action]: count } });
        return answer(Status.SUCCESS, "antinukeLimitSet", { action: text(`antinukeAction_${action}`), count });
      }
      case "punishment": {
        const punishment = interaction.options.getString("type", true);
        await save(guild.id, { ...config, punishment });
        return answer(Status.SUCCESS, "antinukePunishmentSet", { punishment: text(`antinukePunishment_${punishment}`) });
      }
      case "trust": {
        const user = interaction.options.getUser("user", true);
        if (config.trustedUserIds.includes(user.id)) {
          return answer(Status.SUCCESS, "antinukeTrusted", { user: `<@${user.id}>` });
        }
        if (config.trustedUserIds.length >= MAX_TRUSTED) {
          return answer(Status.REFUSED, "antinukeTrustFull", { max: MAX_TRUSTED });
        }
        await save(guild.id, { ...config, trustedUserIds: [...config.trustedUserIds, user.id] });
        return answer(Status.SUCCESS, "antinukeTrusted", { user: `<@${user.id}>` });
      }
      case "untrust": {
        const user = interaction.options.getUser("user", true);
        if (!config.trustedUserIds.includes(user.id)) {
          return answer(Status.REFUSED, "antinukeNotTrusted", { user: `<@${user.id}>` });
        }
        await save(guild.id, { ...config, trustedUserIds: config.trustedUserIds.filter((id) => id !== user.id) });
        return answer(Status.SUCCESS, "antinukeUntrusted", { user: `<@${user.id}>` });
      }
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildAntiNukeCommandData(), execute };
}
