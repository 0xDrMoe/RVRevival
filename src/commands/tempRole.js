// Roles that are taken away again by themselves.
//
//   /temprole add member role duration [reason]   give a role for 1h, 3d, 2w… (giving it again moves the end)
//   /temprole remove member role                   take it away now
//   /temprole list [member]                        temporary roles, soonest first
//
// Needs Manage Roles or the mod role. Nobody can hand out a role at or above
// their own highest role, or above the bot's. See tempRoles/tempRoleScheduler.js.

import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { Status } from "../logs/actionLog.js";
import { hierarchyProblem } from "../moderation/checks.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { auditReason } from "../moderation/moderationService.js";
import { formatDuration, parseDuration } from "../utils/duration.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { roleProblem } from "./memberTools.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "temprole";
export const MAX_TEMP_ROLE_MS = 365 * 24 * 60 * 60 * 1000;
export const MIN_TEMP_ROLE_MS = 60 * 1000;
export const MAX_TEMP_ROLES = 500;
const LIST_LIMIT = 20;

const memberOption = (option, required = true) =>
  withDescription(option.setName("member"), "modMemberOptionDescription").setRequired(required);
const roleOption = (option) => withDescription(option.setName("role"), "roleOptionDescription").setRequired(true);

export function buildTempRoleCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  return withDescription(command, "temproleCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "temproleAddDescription")
        .addUserOption(memberOption)
        .addRoleOption(roleOption)
        .addStringOption((option) =>
          withDescription(option.setName("duration"), "temproleDurationOptionDescription").setRequired(true).setMaxLength(20),
        )
        .addStringOption((option) => withDescription(option.setName("reason"), "modReasonOptionDescription").setMaxLength(512)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "temproleRemoveDescription").addUserOption(memberOption).addRoleOption(roleOption),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("list"), "temproleListDescription").addUserOption((option) => memberOption(option, false)),
    )
    .toJSON();
}

const timestamp = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

// Options: guildSettings, store (TempRoleStore), modLog, forcedLanguage, now
export function createTempRoleCommand({ guildSettings, store, modLog = noModLog, forcedLanguage, now = Date.now }) {
  const log = (guild, moderator, summary, lines) =>
    modLog.post(guild, () => ({ embed: buildActionLogEmbed({ moderator, summary, lines, color: 0x9b59b6 }) }));

  // The member and role, or a refusal.
  function check(interaction, answer) {
    const guild = interaction.guild;
    const member = interaction.options.getMember("member");
    const role = interaction.options.getRole("role", true);
    const values = { user: `<@${interaction.options.getUser("member", true).id}>`, role: `<@&${role.id}>` };
    if (!member) {
      return { refused: answer(Status.REFUSED, "modMemberNotFound", values) };
    }
    const memberProblem = hierarchyProblem({ moderator: interaction.member, target: member, botId: guild.members.me?.id, ownerId: guild.ownerId });
    if (memberProblem && memberProblem !== "modSelf") {
      return { refused: answer(Status.REFUSED, memberProblem, values) };
    }
    const problem = roleProblem({ role, moderator: interaction.member, bot: guild.members.me, guild });
    if (problem) {
      return { refused: answer(Status.REFUSED, problem, values) };
    }
    return { member, role, values };
  }

  async function add(interaction, answer) {
    const { refused, member, role, values } = check(interaction, answer);
    if (refused) {
      return refused;
    }
    const guild = interaction.guild;
    const durationMs = parseDuration(interaction.options.getString("duration", true));
    if (!durationMs || durationMs < MIN_TEMP_ROLE_MS || durationMs > MAX_TEMP_ROLE_MS) {
      return answer(Status.REFUSED, "temproleBadDuration", values);
    }
    const existing = store.get(guild.id, member.id, role.id);
    if (!existing && member.roles.cache.has(role.id)) {
      return answer(Status.REFUSED, "temproleAlreadyHas", values);
    }
    if (!existing && store.count(guild.id) >= MAX_TEMP_ROLES) {
      return answer(Status.REFUSED, "temproleFull", { max: MAX_TEMP_ROLES });
    }
    const reason = interaction.options.getString("reason")?.trim() || null;
    if (!member.roles.cache.has(role.id)) {
      try {
        await member.roles.add(role.id, auditReason(interaction.user, `Temporary role for ${formatDuration(durationMs)}${reason ? `: ${reason}` : ""}`));
      } catch (error) {
        if (!isPermissionError(error)) {
          throw error;
        }
        return answer(Status.FAILED, "roleBotMissingPermission", values);
      }
    }
    const expiresAt = now() + durationMs;
    store.set({ guildId: guild.id, userId: member.id, roleId: role.id, expiresAt, moderatorId: interaction.user.id, reason, createdAt: now() });
    await log(guild, interaction.user, `**Temporary role ${existing ? "extended" : "given"}** · <@&${role.id}> to <@${member.id}> for ${formatDuration(durationMs)}`, [
      `Ends ${timestamp(expiresAt)}`,
      ...(reason ? [`Reason: ${reason}`] : []),
    ]);
    return answer(Status.SUCCESS, existing ? "temproleExtended" : "temproleAdded", { ...values, when: timestamp(expiresAt) });
  }

  async function remove(interaction, answer) {
    const { refused, member, role, values } = check(interaction, answer);
    if (refused) {
      return refused;
    }
    const guild = interaction.guild;
    if (!store.get(guild.id, member.id, role.id)) {
      return answer(Status.REFUSED, "temproleNotTemporary", values);
    }
    if (member.roles.cache.has(role.id)) {
      try {
        await member.roles.remove(role.id, auditReason(interaction.user, "Temporary role removed early"));
      } catch (error) {
        if (!isPermissionError(error)) {
          throw error;
        }
        return answer(Status.FAILED, "roleBotMissingPermission", values);
      }
    }
    store.deleteFor(guild.id, member.id, role.id);
    await log(guild, interaction.user, `**Temporary role removed early** · <@&${role.id}> from <@${member.id}>`, []);
    return answer(Status.SUCCESS, "temproleRemoved", values);
  }

  function list(interaction, answer, text) {
    const user = interaction.options.getUser("member");
    const entries = user ? store.listForUser(interaction.guildId, user.id) : store.list(interaction.guildId, LIST_LIMIT + 1);
    if (entries.length === 0) {
      return answer(Status.SUCCESS, "temproleListEmpty");
    }
    const lines = entries.slice(0, LIST_LIMIT).map((entry) => `• <@${entry.userId}> · <@&${entry.roleId}> · ${timestamp(entry.expiresAt)}`);
    if (!user && entries.length > LIST_LIMIT) {
      lines.push(text("temproleListMore", { count: store.count(interaction.guildId) - LIST_LIMIT }));
    }
    return answer(Status.SUCCESS, "temproleList", { list: lines.join("\n") });
  }

  async function execute(interaction) {
    const { answer, refusal, text } = beginModerationCommand(interaction, {
      permission: PermissionFlagsBits.ManageRoles,
      permissionKey: "permManageRoles",
      guildSettings,
      forcedLanguage,
    });
    if (refusal) {
      return refusal();
    }
    switch (interaction.options.getSubcommand()) {
      case "add":
        return add(interaction, answer);
      case "remove":
        return remove(interaction, answer);
      case "list":
        return list(interaction, answer, text);
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildTempRoleCommandData(), execute };
}
