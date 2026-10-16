// Changing a member's roles and nickname:
//
//   /role add member:@someone role:@Role [reason]
//   /role remove member:@someone role:@Role [reason]
//   /nick member:@someone [nickname]      leave nickname empty to reset it
//
// /role needs Manage Roles and /nick needs Manage Nicknames (or the mod role
// for either). Nobody can hand out a role at or above their own highest role,
// or above the bot's. Each change is posted in the mod-log channel.

import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { Status } from "../logs/actionLog.js";
import { hierarchyProblem } from "../moderation/checks.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { auditReason } from "../moderation/moderationService.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { withDescription } from "./moderation.js";

// Discord's longest nickname.
const MAX_NICKNAME_LENGTH = 32;

const memberOption = (option) =>
  withDescription(option.setName("member"), "modMemberOptionDescription").setRequired(true);
const reasonOption = (option) =>
  withDescription(option.setName("reason"), "modReasonOptionDescription").setMaxLength(512);

export function buildRoleCommandData() {
  const command = new SlashCommandBuilder()
    .setName("role")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  const roleOption = (option) => withDescription(option.setName("role"), "roleOptionDescription").setRequired(true);
  return withDescription(command, "roleCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "roleAddDescription")
        .addUserOption(memberOption)
        .addRoleOption(roleOption)
        .addStringOption(reasonOption),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "roleRemoveDescription")
        .addUserOption(memberOption)
        .addRoleOption(roleOption)
        .addStringOption(reasonOption),
    )
    .toJSON();
}

export function buildNickCommandData() {
  const command = new SlashCommandBuilder()
    .setName("nick")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames);
  return withDescription(command, "nickCommandDescription")
    .addUserOption(memberOption)
    .addStringOption((option) =>
      withDescription(option.setName("nickname"), "nickOptionDescription").setMaxLength(MAX_NICKNAME_LENGTH),
    )
    .toJSON();
}

// Why `moderator` can't give or take `role`, or undefined if they can.
export function roleProblem({ role, moderator, bot, guild }) {
  if (role.id === guild.id) {
    return "roleEveryone";
  }
  if (role.managed) {
    return "roleManaged";
  }
  if (moderator.id !== guild.ownerId && role.position >= (moderator.roles?.highest?.position ?? 0)) {
    return "roleAboveYou";
  }
  if (role.position >= (bot?.roles?.highest?.position ?? 0)) {
    return "roleAboveBot";
  }
  return undefined;
}

// Options:
//   guildSettings    for the mod role (GuildSettings)
//   modLog           posts each change in the mod-log channel (see moderation/modLog.js)
//   forcedLanguage   reply in this language for everyone (BOT_LANGUAGE)
export function createMemberToolCommands({ guildSettings, modLog = noModLog, forcedLanguage }) {
  async function role(interaction) {
    const { answer, refusal } = beginModerationCommand(interaction, {
      permission: PermissionFlagsBits.ManageRoles,
      permissionKey: "permManageRoles",
      guildSettings,
      forcedLanguage,
    });
    if (refusal) {
      return refusal();
    }
    const guild = interaction.guild;
    const member = interaction.options.getMember("member");
    const chosenRole = interaction.options.getRole("role", true);
    const adding = interaction.options.getSubcommand() === "add";
    const values = { user: `<@${interaction.options.getUser("member", true).id}>`, role: `<@&${chosenRole.id}>` };

    if (!member) {
      return answer(Status.REFUSED, "modMemberNotFound", values);
    }
    // Moderators may change their own roles (below their top role), but not
    // those of anyone at or above them.
    const memberProblem = hierarchyProblem({
      moderator: interaction.member,
      target: member,
      botId: guild.members.me?.id,
      ownerId: guild.ownerId,
    });
    if (memberProblem && memberProblem !== "modSelf") {
      return answer(Status.REFUSED, memberProblem, values);
    }
    const problem = roleProblem({ role: chosenRole, moderator: interaction.member, bot: guild.members.me, guild });
    if (problem) {
      return answer(Status.REFUSED, problem, values);
    }
    if (member.roles.cache.has(chosenRole.id) === adding) {
      return answer(Status.REFUSED, adding ? "roleAlreadyHas" : "roleNotHas", values);
    }

    const reason = interaction.options.getString("reason")?.trim() || undefined;
    try {
      const audit = auditReason(interaction.user, reason);
      await (adding ? member.roles.add(chosenRole.id, audit) : member.roles.remove(chosenRole.id, audit));
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      return answer(Status.FAILED, "roleBotMissingPermission", values);
    }

    await modLog.post(guild, () => ({
      embed: buildActionLogEmbed({
        moderator: interaction.user,
        summary: `**Role ${adding ? "added" : "removed"}** · <@&${chosenRole.id}> ${adding ? "to" : "from"} <@${member.id}>`,
        lines: reason ? [`Reason: ${reason}`] : [],
        color: 0x9b59b6,
      }),
    }));
    return answer(Status.SUCCESS, adding ? "roleAdded" : "roleRemoved", values);
  }

  async function nick(interaction) {
    const { answer, refusal } = beginModerationCommand(interaction, {
      permission: PermissionFlagsBits.ManageNicknames,
      permissionKey: "permManageNicknames",
      guildSettings,
      forcedLanguage,
    });
    if (refusal) {
      return refusal();
    }
    const guild = interaction.guild;
    const member = interaction.options.getMember("member");
    const values = { user: `<@${interaction.options.getUser("member", true).id}>` };
    if (!member) {
      return answer(Status.REFUSED, "modMemberNotFound", values);
    }
    let problem = hierarchyProblem({
      moderator: interaction.member,
      target: member,
      bot: guild.members.me,
      ownerId: guild.ownerId,
    });
    if (problem === "modSelf") {
      // Renaming yourself is fine; Discord still needs the bot above you, and
      // nobody can rename the owner.
      const botPosition = guild.members.me?.roles?.highest?.position ?? 0;
      problem =
        member.id === guild.ownerId
          ? "modOwner"
          : botPosition <= (member.roles?.highest?.position ?? 0)
            ? "modBotLower"
            : undefined;
    }
    if (problem) {
      return answer(Status.REFUSED, problem, values);
    }

    const nickname = interaction.options.getString("nickname")?.trim() || null;
    const before = member.nickname;
    try {
      await member.setNickname(nickname, auditReason(interaction.user, "Nickname change"));
    } catch (error) {
      if (!isPermissionError(error)) {
        throw error;
      }
      return answer(Status.FAILED, "nickBotMissingPermission", values);
    }

    const shown = (name) => (name ? `\`${name.replace(/`/g, "'")}\`` : "*none*");
    await modLog.post(guild, () => ({
      embed: buildActionLogEmbed({
        moderator: interaction.user,
        summary: `**Nickname changed** · <@${member.id}>`,
        lines: [`${shown(before)} → ${shown(nickname)}`],
        color: 0x9b59b6,
      }),
    }));
    return nickname
      ? answer(Status.SUCCESS, "nickSet", { ...values, nickname })
      : answer(Status.SUCCESS, "nickReset", values);
  }

  return [
    { name: "role", data: buildRoleCommandData(), execute: role },
    { name: "nick", data: buildNickCommandData(), execute: nick },
  ];
}
