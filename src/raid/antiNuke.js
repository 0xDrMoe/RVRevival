// Anti-nuke: stops someone with staff permissions (or a compromised bot) from
// wrecking the server. When one person deletes or creates too many channels,
// deletes too many roles, or bans, kicks or adds webhooks too fast, the bot
// takes their roles away (or kicks or bans them) and alerts the mod log and
// the server owner.
//
// Who did what comes from the audit log (GuildAuditLogEntryCreate, which needs
// View Audit Log). Bans and kicks done through the bot's own commands are
// counted too, against the moderator who ran them. The server owner and the
// trusted users the owner picks are never counted.

import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { Setting } from "../settings/guildSettings.js";

export const NukeAction = Object.freeze({
  CHANNEL_DELETE: "channelDelete",
  CHANNEL_CREATE: "channelCreate",
  ROLE_DELETE: "roleDelete",
  BAN: "ban",
  KICK: "kick",
  WEBHOOK_CREATE: "webhookCreate",
});
export const NUKE_ACTIONS = Object.values(NukeAction);

export const Punishment = Object.freeze({ STRIP: "strip", KICK: "kick", BAN: "ban" });
export const PUNISHMENTS = Object.values(Punishment);

// How many of each a person may do within WINDOW_MS before the bot steps in.
export const DEFAULT_LIMITS = Object.freeze({
  channelDelete: 3,
  channelCreate: 6,
  roleDelete: 3,
  ban: 8,
  kick: 8,
  webhookCreate: 3,
});
export const MIN_LIMIT = 2;
export const MAX_LIMIT = 50;
export const WINDOW_MS = 60 * 1000;
export const MAX_TRUSTED = 25;
// After stepping in, more actions by the same person are ignored this long,
// so one nuke attempt gives one alert.
const COOLDOWN_MS = 2 * 60 * 1000;

const AUDIT_ACTIONS = new Map([
  [AuditLogEvent.ChannelDelete, NukeAction.CHANNEL_DELETE],
  [AuditLogEvent.ChannelCreate, NukeAction.CHANNEL_CREATE],
  [AuditLogEvent.RoleDelete, NukeAction.ROLE_DELETE],
  [AuditLogEvent.MemberBanAdd, NukeAction.BAN],
  [AuditLogEvent.MemberKick, NukeAction.KICK],
  [AuditLogEvent.WebhookCreate, NukeAction.WEBHOOK_CREATE],
]);

const ACTION_LABELS = Object.freeze({
  channelDelete: "channels deleted",
  channelCreate: "channels created",
  roleDelete: "roles deleted",
  ban: "bans",
  kick: "kicks",
  webhookCreate: "webhooks created",
});

const SNOWFLAKE = /^\d{17,20}$/;
const isLimit = (value) => Number.isInteger(value) && value >= MIN_LIMIT && value <= MAX_LIMIT;

export const DEFAULT_ANTI_NUKE = Object.freeze({
  enabled: false,
  punishment: Punishment.STRIP,
  limits: DEFAULT_LIMITS,
  trustedUserIds: [],
});

// The saved settings with defaults for anything missing or invalid. Never throws.
export function normalizeAntiNuke(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const limits = value.limits && typeof value.limits === "object" ? value.limits : {};
  return {
    enabled: value.enabled === true,
    punishment: PUNISHMENTS.includes(value.punishment) ? value.punishment : Punishment.STRIP,
    limits: Object.fromEntries(NUKE_ACTIONS.map((action) => [action, isLimit(limits[action]) ? limits[action] : DEFAULT_LIMITS[action]])),
    trustedUserIds: Array.isArray(value.trustedUserIds)
      ? [...new Set(value.trustedUserIds.filter((id) => typeof id === "string" && SNOWFLAKE.test(id)))].slice(0, MAX_TRUSTED)
      : [],
  };
}

export class InvalidAntiNuke extends Error {
  name = "InvalidAntiNuke";
}

// Checks settings from the dashboard; returns what to save.
export function checkAntiNuke(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidAntiNuke("Send the anti-nuke settings as an object.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new InvalidAntiNuke("Say whether anti-nuke is on.");
  }
  if (!PUNISHMENTS.includes(value.punishment)) {
    throw new InvalidAntiNuke("Pick what happens: take their roles, kick or ban.");
  }
  if (!value.limits || typeof value.limits !== "object") {
    throw new InvalidAntiNuke("Send a limit for each action.");
  }
  for (const action of NUKE_ACTIONS) {
    if (!isLimit(value.limits[action])) {
      throw new InvalidAntiNuke(`Each limit is ${MIN_LIMIT} to ${MAX_LIMIT} a minute.`);
    }
  }
  if (!Array.isArray(value.trustedUserIds) || value.trustedUserIds.length > MAX_TRUSTED) {
    throw new InvalidAntiNuke(`Trust at most ${MAX_TRUSTED} people.`);
  }
  if (!value.trustedUserIds.every((id) => typeof id === "string" && SNOWFLAKE.test(id))) {
    throw new InvalidAntiNuke("Trusted people are Discord user IDs (17 to 20 digits).");
  }
  return normalizeAntiNuke(value);
}

// "on · take roles · 3 channels deleted, …", for log entries.
export function describeAntiNuke(value) {
  const config = normalizeAntiNuke(value);
  const limits = NUKE_ACTIONS.map((action) => `${config.limits[action]} ${ACTION_LABELS[action]}`).join(", ");
  const trusted = config.trustedUserIds.length > 0 ? ` · trusted ${config.trustedUserIds.map((id) => `<@${id}>`).join(", ")}` : "";
  return `${config.enabled ? "on" : "off"} · ${config.punishment} · ${limits}${trusted}`;
}

const sentence = (action, count) => `${count} ${ACTION_LABELS[action]}`;

// Options: guildSettings, moderation (kicks and bans with a case), quarantine
// (takes roles so /quarantine release can give them back), modLog, logger,
// forcedLanguage, now
export function createAntiNuke({ guildSettings, moderation, quarantine, modLog = noModLog, logger, forcedLanguage, now = Date.now }) {
  // "<guild>:<user>:<action>" -> recent times
  const recent = new Map();
  // "<guild>:<user>" -> when the bot stepped in
  const handled = new Map();

  function forget(guildId, userId) {
    const prefix = `${guildId}:${userId}:`;
    for (const key of recent.keys()) {
      if (key.startsWith(prefix)) {
        recent.delete(key);
      }
    }
  }

  // Takes away every role the bot can remove. Bots keep their own integration
  // role, so they're kicked instead.
  async function punish(guild, member, punishment, reason) {
    const moderator = guild.client?.user ?? guild.members.me?.user;
    if (!member) {
      return { done: "left", kept: [] };
    }
    if (punishment === Punishment.BAN) {
      if (member.bannable === false) {
        return { done: "failed", kept: [] };
      }
      await moderation.ban({ guild, user: member.user, member, moderator, reason });
      return { done: "banned", kept: [] };
    }
    if (punishment === Punishment.KICK || member.user?.bot) {
      if (member.kickable === false) {
        return { done: "failed", kept: [] };
      }
      await moderation.kick({ guild, member, moderator, reason });
      return { done: "kicked", kept: [] };
    }
    if (quarantine && !quarantine.isQuarantined(guild.id, member.id)) {
      const result = await quarantine.quarantine({ guild, member, moderator, reason });
      return { done: result.removed.length > 0 || result.roleGiven ? "stripped" : "failed", removed: result.removed, kept: result.kept };
    }
    const roles = [...member.roles.cache.values()].filter((role) => role.id !== guild.id);
    const removable = roles.filter((role) => !role.managed && role.editable !== false);
    const kept = roles.filter((role) => !removable.includes(role));
    if (removable.length > 0) {
      await member.roles.remove(removable.map((role) => role.id), reason);
    }
    return { done: removable.length > 0 ? "stripped" : "failed", removed: removable.map((role) => role.id), kept: kept.map((role) => role.id) };
  }

  async function tellOwner(guild, values) {
    try {
      const owner = await guild.fetchOwner();
      const language = pickLanguage(guild.preferredLocale, forcedLanguage);
      await owner.send({ content: translate(language, "antinukeOwnerDm", values(language)), allowedMentions: { parse: [] } });
    } catch {
      // Closed DMs; the mod log still has it.
    }
  }

  async function stepIn(guild, userId, action, count, config) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const reason = `Anti-nuke: ${sentence(action, count)} in a minute`;
    let outcome;
    try {
      outcome = await punish(guild, member, config.punishment, reason);
    } catch (error) {
      logger.warn("Anti-nuke couldn't act", { guildId: guild.id, userId, error });
      outcome = { done: "failed", kept: [] };
    }
    logger.warn("Anti-nuke stepped in", { guildId: guild.id, userId, action, count, outcome: outcome.done });
    const results = {
      stripped: `Their roles were taken away${quarantine ? " (they're quarantined; `/quarantine release` gives them back)" : ""}: ${(outcome.removed ?? []).map((id) => `<@&${id}>`).join(", ")}.`,
      kicked: "They were kicked.",
      banned: "They were banned.",
      left: "They're no longer in the server.",
      failed: "The bot couldn't act: their highest role is above the bot's. Move the bot's role up.",
    };
    const lines = [results[outcome.done]];
    if (outcome.kept.length > 0) {
      lines.push(`Roles the bot couldn't take: ${outcome.kept.map((id) => `<@&${id}>`).join(", ")}.`);
    }
    lines.push("Trust someone with `/antinuke trust` if this was expected.");
    await modLog.post(guild, () => ({
      embed: buildActionLogEmbed({
        moderator: guild.client?.user ?? { id: "0", tag: "Anti-nuke" },
        summary: `🛡️ **Anti-nuke:** <@${userId}> made ${sentence(action, count)} in under a minute.`,
        lines,
        color: 0xed4245,
      }),
    }));
    await tellOwner(guild, (language) => ({
      server: guild.name,
      user: member?.user?.tag ?? member?.user?.username ?? userId,
      action: translate(language, `antinukeAction_${action}`),
      count,
      result: translate(language, `antinukeResult_${outcome.done}`),
    }));
  }

  // Counts one action by `userId`; steps in once they go over the limit.
  async function record(guild, userId, action) {
    if (!guild || !userId || !NUKE_ACTIONS.includes(action)) {
      return false;
    }
    const config = normalizeAntiNuke(guildSettings.get(guild.id, Setting.ANTI_NUKE));
    const botId = guild.client?.user?.id ?? guild.members.me?.id;
    if (!config.enabled || userId === botId || userId === guild.ownerId || config.trustedUserIds.includes(userId)) {
      return false;
    }
    const personKey = `${guild.id}:${userId}`;
    if (now() - (handled.get(personKey) ?? -Infinity) < COOLDOWN_MS) {
      return false;
    }
    const key = `${personKey}:${action}`;
    const times = (recent.get(key) ?? []).filter((at) => at > now() - WINDOW_MS);
    times.push(now());
    recent.set(key, times);
    if (times.length < config.limits[action]) {
      return false;
    }
    handled.set(personKey, now());
    forget(guild.id, userId);
    await stepIn(guild, userId, action, times.length, config);
    return true;
  }

  return {
    record,

    // Discord's GuildAuditLogEntryCreate event.
    async auditLogEntry(entry, guild) {
      const action = AUDIT_ACTIONS.get(entry?.action);
      if (!action || !entry.executorId) {
        return false;
      }
      return record(guild, entry.executorId, action);
    },

    // Whether the bot can see who did what.
    canReadAuditLog(guild) {
      return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog));
    },
  };
}
