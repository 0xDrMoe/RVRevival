// Giving or taking one role from many members at once:
//
//   /massrole add role who [has-role]      who: humans, bots or everyone
//   /massrole remove role who [has-role]   has-role: only members who have that role too
//   /massrole cancel                       stops the one running in this server
//
// Needs Manage Roles or the mod role, with the same role checks as /role (not
// @everyone, not a bot's role, below your highest role and the bot's). Only
// the server owner can hand out a role with admin or moderator powers this
// way. One job runs per server; Discord lets a bot change roughly one member
// a second, so big servers take a while. The reply shows the progress for as
// long as Discord allows (15 minutes); the final count is also posted in the
// mod-log channel. A restart stops a running job.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { createMemberLoader } from "../guilds/memberCache.js";
import { discordLocalizations, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { auditReason } from "../moderation/moderationService.js";
import { getDiscordErrorCode, isPermissionError } from "../utils/discordErrors.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { roleProblem } from "./memberTools.js";
import { withDescription } from "./moderation.js";

export const WHO = Object.freeze({ HUMANS: "humans", BOTS: "bots", EVERYONE: "everyone" });

// Roles only the owner may give to many members at once.
export const POWERFUL_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
];

// How often the progress in the reply is updated, and when to stop updating
// it (Discord lets a reply be edited for 15 minutes).
const PROGRESS_EVERY_MS = 10_000;
const REPLY_EDITABLE_MS = 14 * 60_000;
// Discord error codes for a member who left or a role that was deleted.
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;

export function buildMassRoleCommandData() {
  const command = new SlashCommandBuilder()
    .setName("massrole")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  const options = (sub) =>
    sub
      .addRoleOption((option) => withDescription(option.setName("role"), "massRoleRoleOptionDescription").setRequired(true))
      .addStringOption((option) =>
        withDescription(option.setName("who"), "massRoleWhoOptionDescription")
          .setRequired(true)
          .addChoices(
            ...Object.values(WHO).map((value) => {
              const key = `massRoleWho_${value}`;
              return { name: translate("en", key), name_localizations: discordLocalizations(key), value };
            }),
          ),
      )
      .addRoleOption((option) => withDescription(option.setName("has-role"), "massRoleHasRoleOptionDescription"));
  return withDescription(command, "massRoleCommandDescription")
    .addSubcommand((sub) => options(withDescription(sub.setName("add"), "massRoleAddDescription")))
    .addSubcommand((sub) => options(withDescription(sub.setName("remove"), "massRoleRemoveDescription")))
    .addSubcommand((sub) => withDescription(sub.setName("cancel"), "massRoleCancelDescription"))
    .toJSON();
}

// The members a job changes, from the member cache.
export function pickTargets(members, { roleId, adding, who, hasRoleId }) {
  return [...members].filter((member) => {
    if (who === WHO.HUMANS && member.user?.bot) {
      return false;
    }
    if (who === WHO.BOTS && !member.user?.bot) {
      return false;
    }
    if (hasRoleId && !member.roles.cache.has(hasRoleId)) {
      return false;
    }
    return member.roles.cache.has(roleId) !== adding;
  });
}

// Runs a job: changes each member in turn, skipping members who left, and
// stops on cancel or when the bot loses the permission. Returns the counts.
export async function runMassRole({ members, roleId, adding, reason, job, onProgress = () => {} }) {
  const counts = { done: 0, skipped: 0, failed: 0, total: members.length, stopped: null };
  for (const member of members) {
    if (job.cancelled) {
      counts.stopped = "cancelled";
      break;
    }
    try {
      await (adding ? member.roles.add(roleId, reason) : member.roles.remove(roleId, reason));
      counts.done += 1;
    } catch (error) {
      const code = getDiscordErrorCode(error);
      if (code === UNKNOWN_MEMBER) {
        counts.skipped += 1;
      } else if (code === UNKNOWN_ROLE) {
        counts.stopped = "roleDeleted";
        break;
      } else if (isPermissionError(error)) {
        counts.stopped = "noPermission";
        break;
      } else {
        counts.failed += 1;
      }
    }
    await onProgress(counts);
  }
  return counts;
}

// Options:
//   guildSettings    for the mod role
//   modLog           posts the result in the mod-log channel
//   forcedLanguage
//   memberLoader     guilds/memberCache.js (one is made if left out)
//   now              for tests
export function createMassRoleCommand({ guildSettings, modLog = noModLog, forcedLanguage, memberLoader = createMemberLoader(), now = Date.now }) {
  // guildId -> { cancelled, startedBy }
  const jobs = new Map();

  async function execute(interaction) {
    const { text, answer, refusal } = beginModerationCommand(interaction, {
      permission: PermissionFlagsBits.ManageRoles,
      permissionKey: "permManageRoles",
      guildSettings,
      forcedLanguage,
    });
    if (refusal) {
      return refusal();
    }
    const guild = interaction.guild;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "cancel") {
      const job = jobs.get(guild.id);
      if (!job) {
        return answer(Status.REFUSED, "massRoleNothingRunning");
      }
      job.cancelled = true;
      return answer(Status.SUCCESS, "massRoleCancelling");
    }

    const role = interaction.options.getRole("role", true);
    const hasRole = interaction.options.getRole("has-role");
    const who = interaction.options.getString("who", true);
    const adding = subcommand === "add";
    const values = { role: `<@&${role.id}>` };

    if (jobs.has(guild.id)) {
      return answer(Status.REFUSED, "massRoleBusy");
    }
    const problem = roleProblem({ role, moderator: interaction.member, bot: guild.members.me, guild });
    if (problem) {
      return answer(Status.REFUSED, problem, values);
    }
    if (adding && interaction.user.id !== guild.ownerId && POWERFUL_PERMISSIONS.some((flag) => role.permissions?.has(flag))) {
      return answer(Status.REFUSED, "massRoleTooPowerful", values);
    }
    if (hasRole && hasRole.id === role.id) {
      return answer(Status.REFUSED, "massRoleSameRole", values);
    }

    const job = { cancelled: false, startedBy: interaction.user.id };
    jobs.set(guild.id, job);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ content: text("massRoleLoading"), allowedMentions: { parse: [] } });
      const loaded = await memberLoader.loadAll(guild, { timeMs: 120_000 });
      if (!loaded) {
        return await answer(Status.FAILED, "massRoleNoMemberList");
      }
      const targets = pickTargets(guild.members.cache.values(), { roleId: role.id, adding, who, hasRoleId: hasRole?.id });
      if (targets.length === 0) {
        return await answer(Status.SUCCESS, "massRoleNobody", values);
      }

      const started = now();
      let lastProgress = started;
      const progressValues = (counts) => ({
        ...values,
        done: counts.done + counts.skipped + counts.failed,
        total: counts.total,
        minutes: Math.max(1, Math.ceil((counts.total - counts.done - counts.skipped - counts.failed) / 60)),
      });
      await interaction.editReply({ content: text(adding ? "massRoleAdding" : "massRoleRemoving", progressValues({ done: 0, skipped: 0, failed: 0, total: targets.length })), allowedMentions: { parse: [] } });

      const counts = await runMassRole({
        members: targets,
        roleId: role.id,
        adding,
        reason: auditReason(interaction.user, adding ? "Mass role add" : "Mass role remove"),
        job,
        onProgress: async (current) => {
          const time = now();
          if (time - lastProgress < PROGRESS_EVERY_MS || time - started > REPLY_EDITABLE_MS) {
            return;
          }
          lastProgress = time;
          await interaction
            .editReply({ content: text(adding ? "massRoleAdding" : "massRoleRemoving", progressValues(current)), allowedMentions: { parse: [] } })
            .catch(() => {});
        },
      });

      const doneKey =
        counts.stopped === "cancelled"
          ? "massRoleCancelled"
          : counts.stopped === "noPermission"
            ? "massRoleLostPermission"
            : counts.stopped === "roleDeleted"
              ? "massRoleRoleDeleted"
              : adding
                ? "massRoleAddedDone"
                : "massRoleRemovedDone";
      const doneValues = { ...values, done: counts.done, total: counts.total, skipped: counts.skipped, failed: counts.failed };
      await modLog.post(guild, () => ({
        embed: buildActionLogEmbed({
          moderator: interaction.user,
          summary: `**Mass role ${adding ? "add" : "remove"}** · <@&${role.id}>`,
          lines: [
            `Who: ${who}${hasRole ? ` with <@&${hasRole.id}>` : ""}`,
            `Changed ${counts.done} of ${counts.total}${counts.skipped ? `, ${counts.skipped} left the server` : ""}${counts.failed ? `, ${counts.failed} failed` : ""}`,
            ...(counts.stopped ? [`Stopped: ${counts.stopped}`] : []),
          ],
          color: 0x9b59b6,
        }),
      }));
      const status = counts.stopped && counts.stopped !== "cancelled" ? Status.FAILED : Status.SUCCESS;
      if (now() - started > REPLY_EDITABLE_MS) {
        // The reply can't be edited any more; the mod log has the result.
        return result(status, doneKey, doneValues);
      }
      return await answer(status, doneKey, doneValues);
    } finally {
      jobs.delete(guild.id);
    }
  }

  return { name: "massrole", data: buildMassRoleCommandData(), execute };
}
