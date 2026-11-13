// Automod: checks every new and edited message against the server's automod
// rules (/settings automod or the dashboard) and acts on the first rule it
// breaks: deletes the message, tells the member in the channel, and either
// notes it in the mod log or warns or times them out (a case, posted in the mod
// log like any other). Members who collect enough warnings in 24 hours can be
// timed out, kicked or banned automatically. A rule set to "log only" leaves
// the message up and just notes it in the mod log.
//
// Left alone: bots, webhooks, moderators (Manage Messages in the channel, or
// the mod role), roles and channels the server exempts, and the /country
// channel, which deletes everything anyway. Each rule can also skip its own
// roles and channels, post no notice, and use its own timeout length.
//
// Reading what messages say needs the Message Content intent; without it only
// the spam rule and mention counts work.

import { PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { codeBlock } from "../logs/actionLog.js";
import { CaseAction } from "../moderation/caseStore.js";
import { moderatorRoleId } from "../moderation/checks.js";
import { buildActionLogEmbed, noModLog } from "../moderation/modLog.js";
import { derivedSetting, Setting } from "../settings/guildSettings.js";
import { getDiscordErrorCode } from "../utils/discordErrors.js";
import {
  activeRules,
  AutomodAction,
  AutomodRule,
  ESCALATION_WINDOW_MS,
  EscalationAction,
  normalizeAutomod,
  RULE_LABELS,
  ruleSkips,
} from "./config.js";
import { countMentions, findBannedWord, findBlockedLink, findInvites, isMostlyCaps, repeatKey, textRuleDetail } from "./rules.js";
import { LogRoute } from "../logs/logRoutes.js";
import { deleteMessage } from "../utils/rateLimits.js";

// How far back repeated messages are compared.
export const REPEAT_WINDOW_MS = 60_000;
// After automod warns or times out a member, more broken rules in this time
// only delete the message, so one burst of spam doesn't stack up cases.
export const PUNISH_COOLDOWN_MS = 10_000;
// How long the "please don't…" notice stays in the channel.
const NOTICE_MS = 6_000;
// Invite codes already looked up, and which server they're for.
const INVITE_CACHE_MS = 60 * 60 * 1000;
const MAX_REASON_EXCERPT = 120;

// Rules that look at more than one message. They aren't checked on edits.
const HISTORY_RULES = new Set([AutomodRule.SPAM, AutomodRule.DUPLICATES]);

// The server's automod config, or null when automod is off or has no rules on.
// Worked out once per settings change (GuildSettings.derived), not per message.
function automodPlan(saved) {
  const config = normalizeAutomod(saved);
  const rules = activeRules(config);
  if (!config.enabled || rules.length === 0) {
    return null;
  }
  const scoped = rules.some((rule) => config.rules[rule].exemptRoleIds.length > 0 || config.rules[rule].exemptChannelIds.length > 0);
  return { config, rules, scoped, needsHistory: rules.some((rule) => HISTORY_RULES.has(rule)) };
}

// Invite codes remembered at most; past this the oldest are forgotten.
const MAX_CACHED_INVITES = 5000;

const excerpt = (text) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_EXCERPT ? `${flat.slice(0, MAX_REASON_EXCERPT - 1)}…` : flat;
};

// Options:
//   guildSettings    where the automod settings are stored
//   moderation       warns, times out, kicks and bans (moderation/moderationService.js)
//   modLog           where deletions are noted (moderation/modLog.js)
//   logger
//   forcedLanguage   the channel notices' language (BOT_LANGUAGE); otherwise the server's
//   botDeletions     messages the bot deleted itself, so the server log skips them (RecentIds)
//   now              the clock (replaceable in tests)
export function createAutomod({
  guildSettings,
  moderation,
  modLog = noModLog,
  logger,
  forcedLanguage,
  botDeletions,
  now = Date.now,
}) {
  // "<server>:<member>" -> recent messages [{ id, channelId, at, key }], for spam and repeats.
  const history = new Map();
  // "<server>:<member>" -> when automod last warned or timed them out.
  const lastPunished = new Map();
  // "<server>:<member>:<rule>" -> when a log-only rule last noted them.
  const lastLogged = new Map();
  // invite code -> { guildId, at }
  const invites = new Map();

  // Forget what's too old to matter, so memory doesn't grow.
  const sweep = setInterval(() => {
    const cutoff = now() - REPEAT_WINDOW_MS * 2;
    for (const [key, entries] of history) {
      const kept = entries.filter((entry) => entry.at >= cutoff);
      if (kept.length > 0) {
        history.set(key, kept);
      } else {
        history.delete(key);
      }
    }
    for (const [key, at] of lastPunished) {
      if (at < now() - PUNISH_COOLDOWN_MS) {
        lastPunished.delete(key);
      }
    }
    for (const [key, at] of lastLogged) {
      if (at < now() - PUNISH_COOLDOWN_MS) {
        lastLogged.delete(key);
      }
    }
    for (const [code, entry] of invites) {
      if (entry.at < now() - INVITE_CACHE_MS) {
        invites.delete(code);
      }
    }
  }, 60_000);
  sweep.unref?.();

  const planFor = (guildId) => derivedSetting(guildSettings, guildId, Setting.AUTOMOD, automodPlan) ?? undefined;

  const channelIdsOf = (message) => [message.channelId, message.channel?.parentId, message.channel?.parent?.parentId].filter(Boolean);

  function isExempt(message, member, config) {
    const channel = message.channel;
    const channelIds = channelIdsOf(message);
    if (channelIds.some((id) => config.exemptChannelIds.includes(id))) {
      return true;
    }
    if (guildSettings.get(message.guildId, Setting.COUNTRY_CHANNEL) === message.channelId) {
      return true;
    }
    const permissions = channel?.permissionsFor?.(member) ?? member.permissions;
    if (permissions?.has(PermissionFlagsBits.ManageMessages) || permissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }
    const roles = member.roles?.cache;
    const modRole = moderatorRoleId(guildSettings, message.guildId);
    return Boolean(roles && [modRole, ...config.exemptRoleIds].some((id) => id && roles.has(id)));
  }

  // The rules that check this message: the active ones, minus any that skip
  // the member's roles or this channel.
  function rulesFor(message, member, plan) {
    if (!plan.scoped) {
      return plan.rules;
    }
    const scope = { channelIds: channelIdsOf(message), roleIds: member.roles?.cache };
    return plan.rules.filter((rule) => !ruleSkips(plan.config.rules[rule], scope));
  }

  // invite code -> the lookup in progress, so a burst of the same invite asks Discord once.
  const lookups = new Map();

  // Which server an invite is for, or undefined if it doesn't work.
  async function inviteGuildId(client, code) {
    const cached = invites.get(code);
    if (cached && cached.at >= now() - INVITE_CACHE_MS) {
      return cached.guildId;
    }
    if (lookups.has(code)) {
      return lookups.get(code);
    }
    const lookup = client
      .fetchInvite(code)
      .then((invite) => invite?.guild?.id, () => undefined)
      .then((guildId) => {
        if (invites.size >= MAX_CACHED_INVITES) {
          // Maps keep insertion order, so the first key is the oldest.
          invites.delete(invites.keys().next().value);
        }
        invites.set(code, { guildId, at: now() });
        return guildId;
      })
      .finally(() => lookups.delete(code));
    lookups.set(code, lookup);
    return lookup;
  }

  // Remembers the message and returns the member's recent messages, oldest first.
  function remember(message) {
    const key = `${message.guildId}:${message.author.id}`;
    const at = message.createdTimestamp ?? now();
    const cutoff = now() - REPEAT_WINDOW_MS;
    const entries = (history.get(key) ?? []).filter((entry) => entry.at >= cutoff);
    entries.push({ id: message.id, channelId: message.channelId, at, key: repeatKey(message.content) });
    history.set(key, entries);
    return entries;
  }

  // The first rule `message` breaks, as { rule, detail, messages }, or
  // undefined. `messages` lists every message to delete ({ id, channelId }).
  async function findViolation(message, config, { recent, rules = activeRules(config) }) {
    const content = message.content ?? "";
    const only = [{ id: message.id, channelId: message.channelId }];
    for (const rule of rules) {
      const settings = config.rules[rule];
      switch (rule) {
        case AutomodRule.BANNED_WORDS: {
          const word = findBannedWord(content, settings.words);
          if (word) {
            return { rule, detail: word, messages: only };
          }
          break;
        }
        case AutomodRule.INVITES: {
          for (const invite of findInvites(content)) {
            // Invites to this same server are fine.
            if (!invite.lookup || (await inviteGuildId(message.client, invite.code)) !== message.guildId) {
              return { rule, detail: invite.code, messages: only };
            }
          }
          break;
        }
        case AutomodRule.LINKS: {
          const host = findBlockedLink(content, settings.allowedDomains);
          if (host) {
            return { rule, detail: host, messages: only };
          }
          break;
        }
        case AutomodRule.MENTIONS: {
          // Without the Message Content intent, the text is empty but Discord still lists mentions.
          const listed = content
            ? 0
            : (message.mentions?.users?.filter?.((user) => user.id !== message.mentions.repliedUser?.id).size ?? 0) +
              (message.mentions?.roles?.size ?? 0);
          const count = Math.max(countMentions(content), listed);
          if (count >= settings.limit) {
            return { rule, detail: `${count} mentions`, messages: only };
          }
          break;
        }
        case AutomodRule.SPAM: {
          if (!recent) {
            break;
          }
          const since = now() - settings.seconds * 1000;
          const burst = recent.filter((entry) => entry.at >= since);
          if (burst.length >= settings.messages) {
            return { rule, detail: `${burst.length} messages in ${settings.seconds}s`, messages: burst };
          }
          break;
        }
        case AutomodRule.DUPLICATES: {
          const key = repeatKey(content);
          if (!recent || !key) {
            break;
          }
          const repeats = recent.filter((entry) => entry.key === key);
          if (repeats.length >= settings.count) {
            return { rule, detail: `sent ${repeats.length} times`, messages: repeats };
          }
          break;
        }
        case AutomodRule.CAPS:
          if (isMostlyCaps(content, settings)) {
            return { rule, detail: `${settings.percent}%+ capitals`, messages: only };
          }
          break;
        default: {
          const detail = textRuleDetail(rule, content, settings);
          if (detail) {
            return { rule, detail, messages: only };
          }
        }
      }
    }
    return undefined;
  }

  // Deletes the messages, a whole channel's worth at a time where possible.
  async function deleteMessages(message, messages) {
    const byChannel = new Map();
    for (const entry of messages) {
      byChannel.set(entry.channelId, [...(byChannel.get(entry.channelId) ?? []), entry.id]);
    }
    for (const [channelId, ids] of byChannel) {
      ids.forEach((id) => botDeletions?.add(id));
      const channel = channelId === message.channelId ? message.channel : message.guild.channels.cache.get(channelId);
      try {
        if (ids.length === 1 && ids[0] === message.id) {
          await deleteMessage(message);
        } else if (ids.length === 1) {
          await channel?.messages.delete(ids[0]);
        } else {
          await channel?.bulkDelete(ids, true);
        }
      } catch (error) {
        if (getDiscordErrorCode(error) !== RESTJSONErrorCodes.UnknownMessage) {
          logger.warn("Automod couldn't delete a message. Give the bot Manage Messages there.", {
            guildId: message.guildId,
            channelId,
            error,
          });
        }
      }
    }
  }

  // "@member, please don't…" in the channel, deleted after a few seconds.
  async function sendNotice(message, rule) {
    const language = pickLanguage(message.guild.preferredLocale, forcedLanguage);
    try {
      const notice = await message.channel.send({
        content: translate(language, `automodNotice_${rule}`, { user: `<@${message.author.id}>` }),
        allowedMentions: { users: [message.author.id] },
      });
      const timer = setTimeout(() => notice.delete().catch(() => {}), NOTICE_MS);
      timer.unref?.();
    } catch (error) {
      logger.debug("Automod couldn't post its notice", { guildId: message.guildId, error });
    }
  }

  // Times out, kicks or bans a member who reached the warning limit.
  async function escalate(guild, member, moderator, config) {
    const { warnings, action, timeoutMinutes } = config.escalation;
    if (warnings <= 0) {
      return;
    }
    const count = moderation.store.countCasesSince(guild.id, member.id, CaseAction.WARN, now() - ESCALATION_WINDOW_MS);
    if (count < warnings) {
      return;
    }
    const reason = `Automod: ${count} warnings in 24 hours`;
    if (action === EscalationAction.TIMEOUT && member.moderatable !== false) {
      await moderation.timeout({ guild, member, moderator, reason, durationMs: timeoutMinutes * 60_000 });
    } else if (action === EscalationAction.KICK && member.kickable !== false) {
      await moderation.kick({ guild, member, moderator, reason });
    } else if (action === EscalationAction.BAN && member.bannable !== false) {
      await moderation.ban({ guild, user: member.user, member, moderator, reason });
    } else {
      logger.warn("Automod couldn't punish a member who reached the warning limit; their role is above the bot's", {
        guildId: guild.id,
        userId: member.id,
        action,
      });
    }
  }

  // A log-only rule: the message stays, and the mod log notes what it would
  // have caught (once per member and rule in PUNISH_COOLDOWN_MS).
  async function logOnly(message, member, violation) {
    const { rule } = violation;
    if (HISTORY_RULES.has(rule)) {
      history.delete(`${message.guildId}:${message.author.id}`);
    }
    const key = `${message.guildId}:${message.author.id}:${rule}`;
    if ((lastLogged.get(key) ?? -Infinity) > now() - PUNISH_COOLDOWN_MS) {
      return;
    }
    lastLogged.set(key, now());
    const content = message.content ?? "";
    const link = message.url ? ` · [message](${message.url})` : "";
    logger.info("Automod noted a message (log only)", { guildId: message.guildId, userId: member.id, rule });
    try {
      await modLog.post(message.guild, () => ({
        embed: buildActionLogEmbed({
          moderator: message.client.user,
          summary: `**Automod (log only): ${RULE_LABELS[rule]}** · message by <@${member.id}> in <#${message.channelId}> was left up${link}`,
          lines: [`**Matched:** ${violation.detail}`, ...(content ? [codeBlock(content.slice(0, 1500))] : [])],
          color: 0x95a5a6,
        }),
      }), { route: LogRoute.AUTOMOD });
    } catch (error) {
      logger.warn("Automod couldn't note a log-only match", { guildId: message.guildId, userId: member.id, rule, error });
    }
  }

  async function enforce(message, member, config, violation) {
    const { rule } = violation;
    const ruleSettings = config.rules[rule];
    if (ruleSettings.action === AutomodAction.LOG) {
      await logOnly(message, member, violation);
      return false;
    }
    const guild = message.guild;
    const moderator = message.client.user;
    await deleteMessages(message, violation.messages);
    if (HISTORY_RULES.has(rule)) {
      // Start counting again, so the next message doesn't trigger it again.
      history.delete(`${message.guildId}:${message.author.id}`);
    }

    const memberKey = `${message.guildId}:${message.author.id}`;
    if ((lastPunished.get(memberKey) ?? -Infinity) > now() - PUNISH_COOLDOWN_MS) {
      return true;
    }
    lastPunished.set(memberKey, now());
    if (ruleSettings.notify) {
      await sendNotice(message, rule);
    }

    let action = ruleSettings.action;
    // Discord can't time out admins or anyone above the bot; warn instead.
    if (action === AutomodAction.TIMEOUT && member.moderatable === false) {
      action = AutomodAction.WARN;
    }
    const content = message.content ?? "";
    const reason = `Automod · ${RULE_LABELS[rule]}${content ? `: "${excerpt(content)}"` : ""}`;
    logger.info("Automod acted on a message", { guildId: guild.id, userId: member.id, rule, action });

    try {
      if (action === AutomodAction.WARN) {
        await moderation.warn({ guild, member, moderator, reason });
        await escalate(guild, member, moderator, config);
      } else if (action === AutomodAction.TIMEOUT) {
        await moderation.timeout({ guild, member, moderator, reason, durationMs: (ruleSettings.timeoutMinutes ?? config.timeoutMinutes) * 60_000 });
      } else {
        await modLog.post(guild, () => ({
          embed: buildActionLogEmbed({
            moderator,
            summary: `**Automod: ${RULE_LABELS[rule]}** · message by <@${member.id}> deleted in <#${message.channelId}>`,
            lines: [`**Matched:** ${violation.detail}`, ...(content ? [codeBlock(content.slice(0, 1500))] : [])],
            color: 0xe67e22,
          }),
        }), { route: LogRoute.AUTOMOD });
      }
    } catch (error) {
      logger.warn("Automod couldn't finish acting on a message", { guildId: guild.id, userId: member.id, rule, action, error });
    }
    return true;
  }

  // Finds the member behind a message, fetching them if they aren't cached.
  async function memberOf(message) {
    if (message.member) {
      return message.member;
    }
    return message.guild.members.fetch(message.author.id).catch(() => undefined);
  }

  const ignored = (message) => !message.inGuild?.() || message.author?.bot || message.webhookId || message.system;

  return {
    async handleMessage(message) {
      if (ignored(message)) {
        return;
      }
      const plan = planFor(message.guildId);
      if (!plan) {
        return;
      }
      const { config } = plan;
      const member = await memberOf(message);
      if (!member || isExempt(message, member, config)) {
        return;
      }
      const recent = plan.needsHistory ? remember(message) : undefined;
      const violation = await findViolation(message, config, { recent, rules: rulesFor(message, member, plan) });
      // True when the message was removed (a log-only rule leaves it up).
      return violation ? enforce(message, member, config, violation) : false;
    },

    // Someone editing a message into something automod would have caught.
    async handleEdit(oldMessage, newMessage) {
      if (newMessage.partial || ignored(newMessage) || (!oldMessage.partial && oldMessage.content === newMessage.content)) {
        return;
      }
      const plan = planFor(newMessage.guildId);
      if (!plan) {
        return;
      }
      const { config } = plan;
      const member = await memberOf(newMessage);
      if (!member || isExempt(newMessage, member, config)) {
        return;
      }
      const violation = await findViolation(newMessage, config, { recent: undefined, rules: rulesFor(newMessage, member, plan) });
      if (violation) {
        await enforce(newMessage, member, config, violation);
      }
    },

    stop() {
      clearInterval(sweep);
    },
  };
}
