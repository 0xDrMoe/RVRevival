// Raid protection: a server-wide lockdown, a gate for brand-new accounts, and
// an alert when many people join at once.
//
// Discord's own verification levels and raid alerts come first; this adds
// what they don't have: an account-age gate in days, one command that locks
// every public channel, and restoring exactly what was there afterwards.

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { moderatorRoleId } from "../moderation/checks.js";
import { Setting } from "../settings/guildSettings.js";

export const GateAction = Object.freeze({ KICK: "kick", ALERT: "alert" });
export const GATE_ACTIONS = Object.values(GateAction);
export const MAX_GATE_DAYS = 365;
export const MIN_ALERT_JOINS = 3;
export const MAX_ALERT_JOINS = 100;
export const ALERT_WINDOW_MS = 60 * 1000;
// One join alert per server at most this often, so a raid doesn't flood the log.
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
// Channels locked at most in one lockdown (each is one Discord request or more).
export const MAX_LOCKDOWN_CHANNELS = 250;

// What a lockdown takes away, the same as /lock.
export const LOCKED_PERMISSIONS = ["SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "CreatePrivateThreads"];
const LOCKABLE_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];
// Roles with any of these are staff: a lockdown never takes posting away from them.
const STAFF_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
];

export const DEFAULT_JOIN_GATE = Object.freeze({ minAgeDays: null, action: GateAction.KICK, alertJoins: null });

const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// The saved gate settings with defaults for anything missing or invalid.
export function normalizeJoinGate(saved) {
  const value = saved && typeof saved === "object" ? saved : {};
  return {
    minAgeDays: inRange(value.minAgeDays, 1, MAX_GATE_DAYS) ? value.minAgeDays : null,
    action: GATE_ACTIONS.includes(value.action) ? value.action : DEFAULT_JOIN_GATE.action,
    alertJoins: inRange(value.alertJoins, MIN_ALERT_JOINS, MAX_ALERT_JOINS) ? value.alertJoins : null,
  };
}

export class InvalidJoinGate extends Error {
  name = "InvalidJoinGate";
}

// Checks gate settings from the dashboard; returns what to save (null = off).
export function checkJoinGate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidJoinGate("Send the raid settings as an object.");
  }
  if (value.minAgeDays !== null && !inRange(value.minAgeDays, 1, MAX_GATE_DAYS)) {
    throw new InvalidJoinGate(`The minimum account age is 1 to ${MAX_GATE_DAYS} days, or off.`);
  }
  if (!GATE_ACTIONS.includes(value.action)) {
    throw new InvalidJoinGate("Pick kick or alert for new accounts.");
  }
  if (value.alertJoins !== null && !inRange(value.alertJoins, MIN_ALERT_JOINS, MAX_ALERT_JOINS)) {
    throw new InvalidJoinGate(`Join alerts need ${MIN_ALERT_JOINS} to ${MAX_ALERT_JOINS} joins a minute, or off.`);
  }
  const gate = normalizeJoinGate(value);
  return gate.minAgeDays === null && gate.alertJoins === null ? null : gate;
}

// --- Lockdown ---------------------------------------------------------------

// Roles that count as members: not bot roles, not staff, not the mod or staff role.
function memberRoles(guild, guildSettings) {
  const staffIds = new Set([moderatorRoleId(guildSettings, guild.id), guildSettings.get(guild.id, Setting.STAFF_ROLE)].filter(Boolean));
  return [...guild.roles.cache.values()].filter(
    (role) =>
      role.id === guild.id ||
      (!role.managed && !staffIds.has(role.id) && !STAFF_PERMISSIONS.some((bit) => role.permissions.has(bit))),
  );
}

// An overwrite's current value for each locked permission: true (allowed),
// false (denied) or null (inherited), so it can be put back exactly.
function overwriteState(overwrite) {
  return Object.fromEntries(
    LOCKED_PERMISSIONS.map((name) => {
      const bit = PermissionFlagsBits[name];
      return [name, overwrite?.allow.has(bit) ? true : overwrite?.deny.has(bit) ? false : null];
    }),
  );
}

// Which channels a lockdown would lock, and who to deny in each: @everyone,
// plus member roles with their own overwrite there (an allow on a role wins
// over a deny on @everyone). Channels members can't post in are left alone,
// and so are channels the bot can't edit.
export function planLockdown(guild, guildSettings) {
  const me = guild.members.me;
  const roles = memberRoles(guild, guildSettings);
  const plan = [];
  let skipped = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!LOCKABLE_TYPES.includes(channel.type)) {
      continue;
    }
    const posting = roles.filter((role) =>
      channel.permissionsFor(role)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    );
    if (posting.length === 0) {
      continue;
    }
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
      skipped += 1;
      continue;
    }
    const targets = [guild.id, ...posting.filter((role) => role.id !== guild.id && channel.permissionOverwrites.cache.has(role.id)).map((role) => role.id)];
    plan.push({
      id: channel.id,
      targets: targets.map((id) => ({ id, previous: overwriteState(channel.permissionOverwrites.cache.get(id)) })),
    });
  }
  return { channels: plan.slice(0, MAX_LOCKDOWN_CHANNELS), skipped: skipped + Math.max(0, plan.length - MAX_LOCKDOWN_CHANNELS) };
}

const denied = Object.fromEntries(LOCKED_PERMISSIONS.map((name) => [name, false]));

// Locks the planned channels. Returns the ones that worked, to save.
export async function applyLockdown(guild, plan, auditReason) {
  const locked = [];
  for (const entry of plan) {
    const channel = guild.channels.cache.get(entry.id);
    try {
      for (const target of entry.targets) {
        await channel.permissionOverwrites.edit(target.id, denied, { reason: auditReason });
      }
      locked.push(entry);
    } catch {
      // Put back what this channel already got, then move on.
      await restoreChannel(channel, entry, auditReason).catch(() => {});
    }
  }
  return locked;
}

async function restoreChannel(channel, entry, auditReason) {
  for (const target of entry.targets) {
    await channel.permissionOverwrites.edit(target.id, target.previous, { reason: auditReason });
  }
}

// Puts every locked channel back as it was. Returns how many were restored
// and how many couldn't be (deleted channels are skipped quietly).
export async function liftLockdown(guild, lockdown, auditReason) {
  let restored = 0;
  let failed = 0;
  for (const entry of lockdown.channels ?? []) {
    const channel = guild.channels.cache.get(entry.id);
    if (!channel) {
      continue;
    }
    try {
      await restoreChannel(channel, entry, auditReason);
      restored += 1;
    } catch {
      failed += 1;
    }
  }
  return { restored, failed };
}

// --- New members --------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

// Options: guildSettings, moderation (kicks with a case), modLog, logger, now
export function createRaidGuard({ guildSettings, moderation, modLog = noModLog, logger, now = Date.now }) {
  // Recent join times per server, for join alerts.
  const joins = new Map();
  const lastAlert = new Map();

  async function alert(guild, summary, lines = []) {
    await modLog.post(guild, () => ({
      embed: buildActionLogEmbed({ moderator: guild.client?.user ?? { id: "0", tag: "Raid protection" }, summary, lines, color: 0xed4245 }),
    }));
  }

  async function checkJoinRate(member, gate) {
    if (!gate.alertJoins) {
      return;
    }
    const guildId = member.guild.id;
    const cutoff = now() - ALERT_WINDOW_MS;
    const recent = (joins.get(guildId) ?? []).filter((at) => at > cutoff);
    recent.push(now());
    joins.set(guildId, recent);
    if (recent.length < gate.alertJoins || now() - (lastAlert.get(guildId) ?? 0) < ALERT_COOLDOWN_MS) {
      return;
    }
    lastAlert.set(guildId, now());
    logger.warn("Possible raid: many members joined at once", { guildId, joins: recent.length });
    await alert(member.guild, `🚨 **Possible raid:** ${recent.length} members joined in the last minute.`, [
      "Use `/raid lockdown` to stop everyone posting, and `/raid end` when it's over.",
    ]);
  }

  async function checkAccountAge(member, gate) {
    if (!gate.minAgeDays || member.user.bot) {
      return;
    }
    const ageDays = Math.floor((now() - member.user.createdTimestamp) / DAY_MS);
    if (ageDays >= gate.minAgeDays) {
      return;
    }
    const reason = `Join gate: account is ${ageDays} day${ageDays === 1 ? "" : "s"} old (minimum ${gate.minAgeDays})`;
    if (gate.action === GateAction.KICK && member.kickable !== false) {
      await moderation.kick({ guild: member.guild, member, moderator: member.client.user, reason });
      return;
    }
    await alert(member.guild, `⚠️ **New account joined:** <@${member.id}> (${member.user.tag ?? member.user.username})`, [
      `Account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>, under the ${gate.minAgeDays}-day minimum.`,
      gate.action === GateAction.KICK ? "They couldn't be kicked: their role is above the bot's." : "Alert only: they were not kicked.",
    ]);
  }

  return {
    async memberJoined(member) {
      const gate = normalizeJoinGate(guildSettings.get(member.guild.id, Setting.JOIN_GATE));
      await checkJoinRate(member, gate);
      await checkAccountAge(member, gate);
    },
  };
}
