// The /settings automod commands: admins set up automod from Discord. The same
// settings are on the dashboard's Automod page.
//
//   /settings automod toggle enabled:true                    switch automod on or off
//   /settings automod rule rule:<…> enabled:true action:<…>  switch one rule on or off, and choose what it does
//   /settings automod limit setting:<…> value:8              change a number (mentions per message, spam speed…)
//   /settings automod word word:badword                      add a banned word, or remove it if it's listed
//   /settings automod allow-site site:youtube.com            allow links to a website, or stop allowing it
//   /settings automod exempt-role role:@Trusted              let a role skip automod, or stop letting it
//   /settings automod exempt-channel channel:#memes          switch automod off in a channel, or back on
//   /settings automod escalate warnings:3 action:<…>         punish members after too many warnings in 24 hours
//   /settings automod show

import { ChannelType } from "discord.js";
import {
  activeRules,
  AutomodAction,
  AUTOMOD_ACTIONS,
  AUTOMOD_LIMITS,
  AUTOMOD_RULES,
  cleanDomain,
  cleanWord,
  ESCALATION_ACTIONS,
  EscalationAction,
  MAX_ALLOWED_DOMAINS,
  MAX_BANNED_WORDS,
  MAX_EXEMPT_CHANNELS,
  MAX_EXEMPT_ROLES,
  MAX_WORD_LENGTH,
  normalizeAutomod,
  withPath,
} from "../automod/config.js";
import { discordLocalizations, translate } from "../i18n/i18n.js";
import { Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";

export const AUTOMOD_GROUP = "automod";

// Discord choices: the value plus its name in every language.
const choice = (value, nameKey) => ({
  name: translate("en", nameKey),
  name_localizations: discordLocalizations(nameKey),
  value,
});
const RULE_CHOICES = AUTOMOD_RULES.map((rule) => choice(rule, `automodRule_${rule}`));
const ACTION_CHOICES = AUTOMOD_ACTIONS.map((action) => choice(action, `automodAction_${action}`));
const ESCALATION_CHOICES = ESCALATION_ACTIONS.map((action) => choice(action, `automodEscalation_${action}`));
const LIMIT_CHOICES = Object.keys(AUTOMOD_LIMITS)
  .filter((name) => name !== "escalationWarnings")
  .map((name) => choice(name, `automodLimit_${name}`));

const EXEMPTABLE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

// Adds the automod subcommand group to the /settings builder.
export function addAutomodGroup(command) {
  return command.addSubcommandGroup((group) =>
    withDescription(group.setName(AUTOMOD_GROUP), "settingsAutomodDescription")
      .addSubcommand((sub) =>
        withDescription(sub.setName("toggle"), "automodToggleDescription").addBooleanOption((option) =>
          withDescription(option.setName("enabled"), "automodEnabledOptionDescription").setRequired(true),
        ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("rule"), "automodRuleDescription")
          .addStringOption((option) =>
            withDescription(option.setName("rule"), "automodRuleOptionDescription")
              .setRequired(true)
              .addChoices(...RULE_CHOICES),
          )
          .addBooleanOption((option) =>
            withDescription(option.setName("enabled"), "automodRuleEnabledOptionDescription").setRequired(true),
          )
          .addStringOption((option) =>
            withDescription(option.setName("action"), "automodActionOptionDescription").addChoices(...ACTION_CHOICES),
          ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("limit"), "automodLimitDescription")
          .addStringOption((option) =>
            withDescription(option.setName("setting"), "automodLimitOptionDescription")
              .setRequired(true)
              .addChoices(...LIMIT_CHOICES),
          )
          .addIntegerOption((option) =>
            withDescription(option.setName("value"), "automodValueOptionDescription").setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("word"), "automodWordDescription").addStringOption((option) =>
          withDescription(option.setName("word"), "automodWordOptionDescription")
            .setRequired(true)
            .setMaxLength(MAX_WORD_LENGTH),
        ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("allow-site"), "automodSiteDescription").addStringOption((option) =>
          withDescription(option.setName("site"), "automodSiteOptionDescription").setRequired(true).setMaxLength(253),
        ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("exempt-role"), "automodExemptRoleDescription").addRoleOption((option) =>
          withDescription(option.setName("role"), "automodExemptRoleOptionDescription").setRequired(true),
        ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("exempt-channel"), "automodExemptChannelDescription").addChannelOption((option) =>
          withDescription(option.setName("channel"), "automodExemptChannelOptionDescription")
            .setRequired(true)
            .addChannelTypes(...EXEMPTABLE_CHANNELS),
        ),
      )
      .addSubcommand((sub) =>
        withDescription(sub.setName("escalate"), "automodEscalateDescription")
          .addIntegerOption((option) =>
            withDescription(option.setName("warnings"), "automodWarningsOptionDescription")
              .setRequired(true)
              .setMinValue(AUTOMOD_LIMITS.escalationWarnings.min)
              .setMaxValue(AUTOMOD_LIMITS.escalationWarnings.max),
          )
          .addStringOption((option) =>
            withDescription(option.setName("action"), "automodEscalateActionOptionDescription").addChoices(
              ...ESCALATION_CHOICES,
            ),
          ),
      )
      .addSubcommand((sub) => withDescription(sub.setName("show"), "automodShowDescription")),
  );
}

// The automod settings as lines of text, in `language`.
export function describeAutomod(config, text) {
  const list = (ids, format) => ids.map(format).join(", ");
  const lines = [text("automodShowStatus", { status: text(config.enabled ? "automodStatusOn" : "automodStatusOff") })];
  for (const rule of AUTOMOD_RULES) {
    const entry = config.rules[rule];
    lines.push(
      entry.enabled
        ? text("automodShowRule", { rule: text(`automodRule_${rule}`), action: text(`automodAction_${entry.action}`) })
        : text("automodShowRuleOff", { rule: text(`automodRule_${rule}`) }),
    );
  }
  const { words } = config.rules.bannedWords;
  lines.push(words.length > 0 ? text("automodShowWords", { count: words.length, words: spoilerList(words) }) : text("automodShowNoWords"));
  const { allowedDomains } = config.rules.links;
  lines.push(
    allowedDomains.length > 0 ? text("automodShowSites", { sites: allowedDomains.join(", ") }) : text("automodShowNoSites"),
  );
  lines.push(
    config.exemptRoleIds.length > 0
      ? text("automodShowExemptRoles", { roles: list(config.exemptRoleIds, (id) => `<@&${id}>`) })
      : text("automodShowNoExemptRoles"),
  );
  lines.push(
    config.exemptChannelIds.length > 0
      ? text("automodShowExemptChannels", { channels: list(config.exemptChannelIds, (id) => `<#${id}>`) })
      : text("automodShowNoExemptChannels"),
  );
  const { rules } = config;
  lines.push(
    text("automodShowLimits", {
      mentions: rules.mentions.limit,
      messages: rules.spam.messages,
      seconds: rules.spam.seconds,
      repeats: rules.duplicates.count,
      percent: rules.caps.percent,
      letters: rules.caps.minLength,
      minutes: config.timeoutMinutes,
    }),
  );
  lines.push(
    config.escalation.warnings > 0
      ? text("automodShowEscalation", {
          count: config.escalation.warnings,
          action: escalationName(config.escalation, text),
        })
      : text("automodShowNoEscalation"),
  );
  lines.push(text("automodShowAlwaysExempt"));
  return lines;
}

// Banned words as spoilers, so a list of slurs isn't splashed across the
// admin's screen, cut short to keep the reply under Discord's 2000 characters.
const MAX_WORD_LIST = 800;
export const asSpoiler = (word) => `||${word.replace(/\|/g, "")}||`;
function spoilerList(words) {
  let shown = "";
  let count = 0;
  for (const word of words) {
    const next = shown ? `${shown}, ${asSpoiler(word)}` : asSpoiler(word);
    if (next.length > MAX_WORD_LIST) {
      break;
    }
    shown = next;
    count += 1;
  }
  return count < words.length ? `${shown} (+${words.length - count})` : shown;
}

function escalationName({ action, timeoutMinutes }, text) {
  const name = text(`automodEscalation_${action}`);
  return action === EscalationAction.TIMEOUT ? text("automodEscalationTimeoutFor", { action: name, minutes: timeoutMinutes }) : name;
}

const ruleNames = (config, text) => activeRules(config).map((rule) => text(`automodRule_${rule}`)).join(", ");

// Runs one /settings automod subcommand. `reply(status, key, values, extraKeys?)`
// answers privately and returns the log outcome; `show(lines)` answers with
// several lines.
export async function runAutomodSubcommand(interaction, { guildSettings, text, reply, show }) {
  const guildId = interaction.guildId;
  const config = normalizeAutomod(guildSettings.get(guildId, Setting.AUTOMOD));
  const save = (next) => guildSettings.set(guildId, Setting.AUTOMOD, next);
  // Rules only work while automod itself is on, so say so when it's off.
  const offNote = config.enabled ? [] : ["automodStillOff"];

  switch (interaction.options.getSubcommand()) {
    case "toggle": {
      const enabled = interaction.options.getBoolean("enabled", true);
      await save({ ...config, enabled });
      if (!enabled) {
        return reply(Status.SUCCESS, "automodOff");
      }
      const rules = ruleNames(config, text);
      return rules ? reply(Status.SUCCESS, "automodOn", { rules }) : reply(Status.SUCCESS, "automodOnNoRules");
    }
    case "rule": {
      const rule = interaction.options.getString("rule", true);
      if (!AUTOMOD_RULES.includes(rule)) {
        return reply(Status.FAILED, "unexpected");
      }
      const enabled = interaction.options.getBoolean("enabled", true);
      const requested = interaction.options.getString("action");
      const action = AUTOMOD_ACTIONS.includes(requested) ? requested : config.rules[rule].action;
      await save(withPath(withPath(config, ["rules", rule, "enabled"], enabled), ["rules", rule, "action"], action));
      const values = { rule: text(`automodRule_${rule}`), action: text(`automodAction_${action}`) };
      return enabled ? reply(Status.SUCCESS, "automodRuleOn", values, offNote) : reply(Status.SUCCESS, "automodRuleOff", values);
    }
    case "limit": {
      const name = interaction.options.getString("setting", true);
      const limit = AUTOMOD_LIMITS[name];
      if (!limit) {
        return reply(Status.FAILED, "unexpected");
      }
      const value = interaction.options.getInteger("value", true);
      const values = { limit: text(`automodLimit_${name}`), value, min: limit.min, max: limit.max };
      if (value < limit.min || value > limit.max) {
        return reply(Status.REFUSED, "automodLimitOutOfRange", values);
      }
      await save(withPath(config, limit.path, value));
      return reply(Status.SUCCESS, "automodLimitSet", values);
    }
    case "word": {
      const word = cleanWord(interaction.options.getString("word", true));
      if (!word || word.replace(/\*/g, "") === "" || word.length > MAX_WORD_LENGTH) {
        return reply(Status.REFUSED, "automodWordInvalid", { max: MAX_WORD_LENGTH });
      }
      const words = config.rules.bannedWords.words;
      const shown = asSpoiler(word);
      if (words.includes(word)) {
        const next = words.filter((entry) => entry !== word);
        await save(withPath(config, ["rules", "bannedWords", "words"], next));
        return reply(Status.SUCCESS, "automodWordRemoved", { word: shown, count: next.length });
      }
      if (words.length >= MAX_BANNED_WORDS) {
        return reply(Status.REFUSED, "automodListFull", { max: MAX_BANNED_WORDS });
      }
      await save(withPath(config, ["rules", "bannedWords", "words"], [...words, word]));
      const ruleOff = config.rules.bannedWords.enabled ? [] : ["automodWordRuleOff"];
      return reply(Status.SUCCESS, "automodWordAdded", { word: shown, count: words.length + 1 }, ruleOff);
    }
    case "allow-site": {
      const site = cleanDomain(interaction.options.getString("site", true));
      if (!site) {
        return reply(Status.REFUSED, "automodSiteInvalid");
      }
      const sites = config.rules.links.allowedDomains;
      if (sites.includes(site)) {
        await save(withPath(config, ["rules", "links", "allowedDomains"], sites.filter((entry) => entry !== site)));
        return reply(Status.SUCCESS, "automodSiteRemoved", { site });
      }
      if (sites.length >= MAX_ALLOWED_DOMAINS) {
        return reply(Status.REFUSED, "automodListFull", { max: MAX_ALLOWED_DOMAINS });
      }
      await save(withPath(config, ["rules", "links", "allowedDomains"], [...sites, site]));
      return reply(Status.SUCCESS, "automodSiteAdded", { site });
    }
    case "exempt-role": {
      const role = interaction.options.getRole("role", true);
      if (role.id === guildId) {
        return reply(Status.REFUSED, "automodExemptEveryone");
      }
      const ids = config.exemptRoleIds;
      const values = { role: `<@&${role.id}>` };
      if (ids.includes(role.id)) {
        await save({ ...config, exemptRoleIds: ids.filter((id) => id !== role.id) });
        return reply(Status.SUCCESS, "automodExemptRoleRemoved", values);
      }
      if (ids.length >= MAX_EXEMPT_ROLES) {
        return reply(Status.REFUSED, "automodListFull", { max: MAX_EXEMPT_ROLES });
      }
      await save({ ...config, exemptRoleIds: [...ids, role.id] });
      return reply(Status.SUCCESS, "automodExemptRoleAdded", values);
    }
    case "exempt-channel": {
      const channel = interaction.options.getChannel("channel", true);
      const ids = config.exemptChannelIds;
      const values = { channel: `<#${channel.id}>` };
      if (ids.includes(channel.id)) {
        await save({ ...config, exemptChannelIds: ids.filter((id) => id !== channel.id) });
        return reply(Status.SUCCESS, "automodExemptChannelRemoved", values);
      }
      if (ids.length >= MAX_EXEMPT_CHANNELS) {
        return reply(Status.REFUSED, "automodListFull", { max: MAX_EXEMPT_CHANNELS });
      }
      await save({ ...config, exemptChannelIds: [...ids, channel.id] });
      return reply(Status.SUCCESS, "automodExemptChannelAdded", values);
    }
    case "escalate": {
      const warnings = interaction.options.getInteger("warnings", true);
      const requested = interaction.options.getString("action");
      const action = ESCALATION_ACTIONS.includes(requested) ? requested : config.escalation.action;
      const limit = AUTOMOD_LIMITS.escalationWarnings;
      if (warnings < limit.min || warnings > limit.max) {
        return reply(Status.REFUSED, "unexpected");
      }
      const next = { ...config, escalation: { ...config.escalation, warnings, action } };
      await save(next);
      if (warnings === 0) {
        return reply(Status.SUCCESS, "automodEscalateOff");
      }
      // Only warnings count, so it does nothing unless a rule warns.
      const warns = AUTOMOD_RULES.some((rule) => config.rules[rule].enabled && config.rules[rule].action === AutomodAction.WARN);
      return reply(
        Status.SUCCESS,
        "automodEscalateSet",
        { count: warnings, action: escalationName(next.escalation, text) },
        warns ? [] : ["automodEscalateNoWarnRule"],
      );
    }
    case "show":
      return show(describeAutomod(config, text));
  }
  return reply(Status.FAILED, "unexpected");
}
