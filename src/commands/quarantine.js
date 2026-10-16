// Quarantine a member while staff look into something.
//
//   /quarantine add member [reason]       take their roles (saved) and give the quarantine role
//   /quarantine release member [reason]   give every saved role back
//   /quarantine list                      who's quarantined
//   /quarantine role [role]               the role quarantined members get (empty = none)
//
// add, release and list need Manage Roles or the mod role; role needs Manage
// Server. See moderation/quarantine.js.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { Status } from "../logs/actionLog.js";
import { hierarchyProblem } from "../moderation/checks.js";
import { AlreadyQuarantined, canManageRole } from "../moderation/quarantine.js";
import { auditReason } from "../moderation/moderationService.js";
import { Setting } from "../settings/guildSettings.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "quarantine";
const LIST_LIMIT = 25;

const memberOption = (option) => withDescription(option.setName("member"), "modMemberOptionDescription").setRequired(true);
const reasonOption = (option) => withDescription(option.setName("reason"), "modReasonOptionDescription").setMaxLength(512);

export function buildQuarantineCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  return withDescription(command, "quarantineCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("add"), "quarantineAddDescription").addUserOption(memberOption).addStringOption(reasonOption))
    .addSubcommand((sub) =>
      withDescription(sub.setName("release"), "quarantineReleaseDescription").addUserOption(memberOption).addStringOption(reasonOption),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "quarantineListDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("role"), "quarantineRoleDescription").addRoleOption((option) =>
        withDescription(option.setName("role"), "quarantineRoleOptionDescription"),
      ),
    )
    .toJSON();
}

// Options: guildSettings, quarantine (moderation/quarantine.js), forcedLanguage
export function createQuarantineCommand({ guildSettings, quarantine, forcedLanguage }) {
  async function add(interaction, answer) {
    const guild = interaction.guild;
    const member = interaction.options.getMember("member");
    const values = { user: `<@${interaction.options.getUser("member", true).id}>` };
    if (!member) {
      return answer(Status.REFUSED, "modMemberNotFound", values);
    }
    const problem = hierarchyProblem({ moderator: interaction.member, target: member, bot: guild.members.me, ownerId: guild.ownerId });
    if (problem) {
      return answer(Status.REFUSED, problem, values);
    }
    const reason = interaction.options.getString("reason")?.trim() || null;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await quarantine.quarantine({
        guild,
        member,
        moderator: interaction.user,
        reason,
        audit: auditReason(interaction.user, `Quarantine${reason ? `: ${reason}` : ""}`),
      });
      return answer(Status.SUCCESS, result.roleGiven ? "quarantineDone" : "quarantineDoneNoRole", { ...values, count: result.removed.length });
    } catch (error) {
      if (error instanceof AlreadyQuarantined) {
        return answer(Status.REFUSED, "quarantineAlready", values);
      }
      if (isPermissionError(error)) {
        return answer(Status.FAILED, "quarantineBotMissingPermission", values);
      }
      throw error;
    }
  }

  async function release(interaction, answer) {
    const guild = interaction.guild;
    const user = interaction.options.getUser("member", true);
    const member = interaction.options.getMember("member");
    const values = { user: `<@${user.id}>` };
    if (!quarantine.isQuarantined(guild.id, user.id)) {
      return answer(Status.REFUSED, "quarantineNotQuarantined", values);
    }
    if (!member) {
      // They left: nothing to give back, so just forget it.
      quarantine.forget(guild.id, user.id);
      return answer(Status.SUCCESS, "quarantineForgotten", values);
    }
    const reason = interaction.options.getString("reason")?.trim() || null;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await quarantine.release({ guild, member, moderator: interaction.user, reason: auditReason(interaction.user, reason ?? "Quarantine ended") });
      return answer(Status.SUCCESS, result.missing.length > 0 ? "quarantineReleasedMissing" : "quarantineReleased", {
        ...values,
        count: result.restored.length,
        missing: result.missing.length,
      });
    } catch (error) {
      if (isPermissionError(error)) {
        return answer(Status.FAILED, "quarantineBotMissingPermission", values);
      }
      throw error;
    }
  }

  function list(interaction, answer, text) {
    const entries = quarantine.list(interaction.guildId);
    if (entries.length === 0) {
      return answer(Status.SUCCESS, "quarantineListEmpty");
    }
    const lines = entries
      .slice(0, LIST_LIMIT)
      .map((entry) => `• <@${entry.userId}> · <t:${Math.floor(entry.savedAt / 1000)}:R>${entry.reason ? ` · ${entry.reason.slice(0, 80)}` : ""}`);
    if (entries.length > LIST_LIMIT) {
      lines.push(text("quarantineListMore", { count: entries.length - LIST_LIMIT }));
    }
    return answer(Status.SUCCESS, "quarantineList", { count: entries.length, list: lines.join("\n") });
  }

  async function role(interaction, answer, text) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
    }
    const chosen = interaction.options.getRole("role");
    if (!chosen) {
      await guildSettings.clear(interaction.guildId, Setting.QUARANTINE_ROLE);
      return answer(Status.SUCCESS, "quarantineRoleCleared");
    }
    if (!canManageRole(interaction.guild, chosen)) {
      return answer(Status.REFUSED, "quarantineRoleUnusable", { role: `<@&${chosen.id}>` });
    }
    await guildSettings.set(interaction.guildId, Setting.QUARANTINE_ROLE, chosen.id);
    return answer(Status.SUCCESS, "quarantineRoleSet", { role: `<@&${chosen.id}>` });
  }

  async function execute(interaction) {
    const { answer, refusal, text } = beginModerationCommand(interaction, {
      permission: PermissionFlagsBits.ManageRoles,
      permissionKey: "permManageRoles",
      guildSettings,
      forcedLanguage,
    });
    const subcommand = interaction.options.getSubcommand();
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (subcommand === "role") {
      return role(interaction, answer, text);
    }
    if (refusal) {
      return refusal();
    }
    switch (subcommand) {
      case "add":
        return add(interaction, answer);
      case "release":
        return release(interaction, answer);
      case "list":
        return list(interaction, answer, text);
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildQuarantineCommandData(), execute };
}
