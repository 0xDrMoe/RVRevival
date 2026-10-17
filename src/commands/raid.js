// Raid protection.
//
//   /raid lockdown [reason]          stop members posting in every public channel
//   /raid end [reason]               put every channel back exactly as it was
//   /raid status                     the lockdown, the join gate and join alerts
//   /raid gate min-age action        kick (or flag) accounts younger than min-age days
//   /raid gate-off
//   /raid alert joins                warn the mod log when this many join in a minute (0 = off)
//
// lockdown, end and status need Manage Channels or the mod role; gate,
// gate-off and alert need Manage Server. See raid/raid.js.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { Status } from "../logs/actionLog.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { auditReason } from "../moderation/moderationService.js";
import {
  applyLockdown,
  GATE_ACTIONS,
  GateAction,
  liftLockdown,
  MAX_ALERT_JOINS,
  MAX_GATE_DAYS,
  MIN_ALERT_JOINS,
  normalizeJoinGate,
  planLockdown,
} from "../raid/raid.js";
import { Setting } from "../settings/guildSettings.js";
import { beginModerationCommand } from "./commandHelpers.js";
import { withDescription } from "./moderation.js";
import { LogRoute } from "../logs/logRoutes.js";

const COMMAND_NAME = "raid";
const PERMISSION = PermissionFlagsBits.ManageChannels;
const PERMISSION_KEY = "permManageChannels";
const SETTINGS_SUBCOMMANDS = new Set(["gate", "gate-off", "alert"]);

function withChoiceNames(option, values, prefix) {
  return option.addChoices(
    ...values.map((value) => ({ name: translate("en", `${prefix}${value}`), name_localizations: discordLocalizations(`${prefix}${value}`), value })),
  );
}

const reasonOption = (option) => withDescription(option.setName("reason"), "modReasonOptionDescription").setMaxLength(512);

export function buildRaidCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PERMISSION);
  return withDescription(command, "raidCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("lockdown"), "raidLockdownDescription").addStringOption(reasonOption))
    .addSubcommand((sub) => withDescription(sub.setName("end"), "raidEndDescription").addStringOption(reasonOption))
    .addSubcommand((sub) => withDescription(sub.setName("status"), "raidStatusDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("gate"), "raidGateDescription")
        .addIntegerOption((option) =>
          withDescription(option.setName("min-age"), "raidMinAgeOptionDescription").setRequired(true).setMinValue(1).setMaxValue(MAX_GATE_DAYS),
        )
        .addStringOption((option) => withChoiceNames(withDescription(option.setName("action"), "raidActionOptionDescription"), GATE_ACTIONS, "raidAction_")),
    )
    .addSubcommand((sub) => withDescription(sub.setName("gate-off"), "raidGateOffDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("alert"), "raidAlertDescription").addIntegerOption((option) =>
        withDescription(option.setName("joins"), "raidJoinsOptionDescription").setRequired(true).setMinValue(0).setMaxValue(MAX_ALERT_JOINS),
      ),
    )
    .toJSON();
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

// Options: guildSettings, modLog, forcedLanguage, now
export function createRaidCommand({ guildSettings, modLog = noModLog, forcedLanguage, now = Date.now }) {
  // A short notice for members in the server's system channel, if the bot can post there.
  async function notice(guild, key) {
    const channel = guild.systemChannel;
    const me = guild.members.me;
    if (!channel || !me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    await channel.send({ content: translate(language, key), allowedMentions: { parse: [] } }).catch(() => {});
  }

  const logEntry = (guild, moderator, summary, lines, color) =>
    modLog.post(guild, () => ({ embed: buildActionLogEmbed({ moderator, summary, lines, color }) }), { route: LogRoute.PROTECTION });

  async function lockdown(interaction, answer) {
    const guild = interaction.guild;
    if (guildSettings.get(guild.id, Setting.LOCKDOWN)) {
      return answer(Status.REFUSED, "raidLockdownAlready");
    }
    const reason = interaction.options.getString("reason")?.trim() || null;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const plan = planLockdown(guild, guildSettings);
    if (plan.channels.length === 0) {
      return answer(Status.REFUSED, plan.skipped > 0 ? "raidLockdownBotMissingPermission" : "raidNothingToLock");
    }
    const audit = auditReason(interaction.user, `Raid lockdown${reason ? `: ${reason}` : ""}`);
    const locked = await applyLockdown(guild, plan.channels, audit);
    if (locked.length === 0) {
      return answer(Status.FAILED, "raidLockdownBotMissingPermission");
    }
    await guildSettings.set(guild.id, Setting.LOCKDOWN, { startedAt: now(), by: interaction.user.id, reason, channels: locked });
    await notice(guild, "raidNoticeLocked");
    const skipped = plan.skipped + plan.channels.length - locked.length;
    await logEntry(
      guild,
      interaction.user,
      `🔒 **Raid lockdown** · ${locked.length} channel${locked.length === 1 ? "" : "s"} locked`,
      [reason ? `Reason: ${reason}` : null, skipped > 0 ? `${skipped} channel(s) skipped: the bot can't edit them.` : null].filter(Boolean),
      0xed4245,
    );
    return answer(Status.SUCCESS, skipped > 0 ? "raidLockdownDoneSkipped" : "raidLockdownDone", { count: locked.length, skipped });
  }

  async function end(interaction, answer) {
    const guild = interaction.guild;
    const saved = guildSettings.get(guild.id, Setting.LOCKDOWN);
    if (!saved) {
      return answer(Status.REFUSED, "raidNotLocked");
    }
    const reason = interaction.options.getString("reason")?.trim() || null;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { restored, failed } = await liftLockdown(guild, saved, auditReason(interaction.user, `Raid lockdown ended${reason ? `: ${reason}` : ""}`));
    await guildSettings.clear(guild.id, Setting.LOCKDOWN);
    await notice(guild, "raidNoticeUnlocked");
    await logEntry(
      guild,
      interaction.user,
      `🔓 **Raid lockdown ended** · ${restored} channel${restored === 1 ? "" : "s"} restored`,
      [reason ? `Reason: ${reason}` : null, failed > 0 ? `${failed} channel(s) couldn't be restored; check them by hand.` : null].filter(Boolean),
      0x57f287,
    );
    return answer(Status.SUCCESS, failed > 0 ? "raidEndDoneFailed" : "raidEndDone", { count: restored, failed });
  }

  function status(interaction, answer, text) {
    const guildId = interaction.guildId;
    const saved = guildSettings.get(guildId, Setting.LOCKDOWN);
    const gate = normalizeJoinGate(guildSettings.get(guildId, Setting.JOIN_GATE));
    return answer(Status.SUCCESS, "raidStatus", {
      lockdown: saved
        ? text("raidStatusLocked", { count: saved.channels.length, time: timestamp(saved.startedAt, "R"), user: `<@${saved.by}>` })
        : text("raidStatusNotLocked"),
      gate: gate.minAgeDays
        ? text(gate.action === GateAction.KICK ? "raidStatusGateKick" : "raidStatusGateAlert", { days: gate.minAgeDays })
        : text("raidStatusGateOff"),
      alert: gate.alertJoins ? text("raidStatusAlertOn", { count: gate.alertJoins }) : text("raidStatusAlertOff"),
    });
  }

  async function saveGate(interaction, changes) {
    const current = normalizeJoinGate(guildSettings.get(interaction.guildId, Setting.JOIN_GATE));
    const next = { ...current, ...changes };
    if (next.minAgeDays === null && next.alertJoins === null) {
      await guildSettings.clear(interaction.guildId, Setting.JOIN_GATE);
    } else {
      await guildSettings.set(interaction.guildId, Setting.JOIN_GATE, next);
    }
  }

  async function execute(interaction) {
    const { answer, refusal, text } = beginModerationCommand(interaction, {
      permission: PERMISSION,
      permissionKey: PERMISSION_KEY,
      guildSettings,
      forcedLanguage,
    });
    const subcommand = interaction.options.getSubcommand();
    if (!interaction.inCachedGuild()) {
      return refusal();
    }
    if (SETTINGS_SUBCOMMANDS.has(subcommand)) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return answer(Status.REFUSED, "raidNeedsManageGuild");
      }
    } else if (refusal) {
      return refusal();
    }

    switch (subcommand) {
      case "lockdown":
        return lockdown(interaction, answer);
      case "end":
        return end(interaction, answer);
      case "status":
        return status(interaction, answer, text);
      case "gate": {
        const days = interaction.options.getInteger("min-age", true);
        const action = interaction.options.getString("action") ?? GateAction.KICK;
        await saveGate(interaction, { minAgeDays: days, action });
        return answer(Status.SUCCESS, action === GateAction.KICK ? "raidGateSet" : "raidGateSetAlert", { days });
      }
      case "gate-off":
        await saveGate(interaction, { minAgeDays: null });
        return answer(Status.SUCCESS, "raidGateOff");
      case "alert": {
        const joins = interaction.options.getInteger("joins", true);
        if (joins !== 0 && joins < MIN_ALERT_JOINS) {
          return answer(Status.REFUSED, "raidAlertTooLow", { min: MIN_ALERT_JOINS });
        }
        await saveGate(interaction, { alertJoins: joins === 0 ? null : joins });
        return answer(Status.SUCCESS, joins === 0 ? "raidAlertOff" : "raidAlertSet", { count: joins });
      }
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildRaidCommandData(), execute };
}
