// Leveling commands.
//
//   /rank [member]                 a member's level, XP and place (everyone)
//   /leaderboard [period] [page]   the most active members, all time or the last 7 or 30 days (everyone)
//   /levels show|on|off            the settings, and switching leveling on or off
//   /levels announce where:<…> [channel]   where level-ups are announced
//   /levels message [text]         the level-up message ({user}, {username}, {level}, {server})
//   /levels reward-add level role  a role given at a level
//   /levels reward-remove level
//   /levels reward-mode mode:<keep|highest>
//   /levels no-xp [channel] [role] switch XP off (or back on) for a channel or role
//   /levels voice enabled:<bool>   XP for time in voice channels
//   /levels boost multiplier [role]  more XP for Server Boosters, or for a role (1 removes it)
//   /levels set member level       move someone to a level
//   /levels reset member           take all their XP away
//
// /levels needs Manage Server. Members earn XP by chatting (leveling/leveling.js).

import { ChannelType, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import {
  Announce,
  ANNOUNCE_MODES,
  levelProgress,
  MAX_LEVEL,
  MAX_LEVEL_MESSAGE_LENGTH,
  MAX_NO_XP_CHANNELS,
  MAX_NO_XP_ROLES,
  MAX_MULTIPLIER,
  MAX_REWARDS,
  MAX_ROLE_MULTIPLIERS,
  MIN_MULTIPLIER,
  isMultiplier,
  normalizeLeveling,
  totalXpForLevel,
} from "../leveling/config.js";
import { result, Status } from "../logs/actionLog.js";
import { Period, PERIODS, periodStart } from "../leveling/levelStore.js";
import { Setting } from "../settings/guildSettings.js";

const LEADERBOARD_PAGE = 10;
const PROGRESS_BAR_LENGTH = 12;
const LEVEL_COLOR = 0xfaa61a;
// Roles never handed out as rewards: Administrator and Manage Server.
const FORBIDDEN_REWARD_PERMISSIONS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

function withChoiceNames(option, values, prefix) {
  return option.addChoices(
    ...values.map((value) => ({
      name: translate("en", `${prefix}${value}`),
      name_localizations: discordLocalizations(`${prefix}${value}`),
      value,
    })),
  );
}

const levelOption = (option, key) => withDescription(option.setName("level"), key).setRequired(true).setMinValue(1).setMaxValue(MAX_LEVEL);
const memberOption = (option) => withDescription(option.setName("member"), "levelsMemberOptionDescription").setRequired(true);

export function buildRankCommandData() {
  return withDescription(new SlashCommandBuilder().setName("rank").setContexts(InteractionContextType.Guild), "rankCommandDescription")
    .addUserOption((option) => withDescription(option.setName("member"), "rankMemberOptionDescription"))
    .toJSON();
}

export function buildLeaderboardCommandData() {
  return withDescription(
    new SlashCommandBuilder().setName("leaderboard").setContexts(InteractionContextType.Guild),
    "leaderboardCommandDescription",
  )
    .addStringOption((option) =>
      withDescription(option.setName("period"), "leaderboardPeriodOptionDescription").addChoices(
        ...PERIODS.map((period) => ({ name: translate("en", `leaderboardPeriod_${period}`), name_localizations: discordLocalizations(`leaderboardPeriod_${period}`), value: period })),
      ),
    )
    .addIntegerOption((option) => withDescription(option.setName("page"), "leaderboardPageOptionDescription").setMinValue(1))
    .toJSON();
}

export function buildLevelsCommandData() {
  const command = new SlashCommandBuilder()
    .setName("levels")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "levelsCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("show"), "levelsShowDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("on"), "levelsOnDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("off"), "levelsOffDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("announce"), "levelsAnnounceDescription")
        .addStringOption((option) =>
          withChoiceNames(withDescription(option.setName("where"), "levelsWhereOptionDescription").setRequired(true), ANNOUNCE_MODES, "levelsWhere_"),
        )
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "levelsChannelOptionDescription").addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("message"), "levelsMessageDescription").addStringOption((option) =>
        withDescription(option.setName("text"), "levelsTextOptionDescription").setMaxLength(MAX_LEVEL_MESSAGE_LENGTH),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("reward-add"), "levelsRewardAddDescription")
        .addIntegerOption((option) => levelOption(option, "levelsLevelOptionDescription"))
        .addRoleOption((option) => withDescription(option.setName("role"), "levelsRoleOptionDescription").setRequired(true)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("reward-remove"), "levelsRewardRemoveDescription").addIntegerOption((option) =>
        levelOption(option, "levelsLevelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("reward-mode"), "levelsRewardModeDescription").addStringOption((option) =>
        withChoiceNames(withDescription(option.setName("mode"), "levelsModeOptionDescription").setRequired(true), ["keep", "highest"], "levelsMode_"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("no-xp"), "levelsNoXpDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "levelsNoXpChannelOptionDescription").addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildForum,
            ChannelType.GuildVoice,
            ChannelType.GuildCategory,
          ),
        )
        .addRoleOption((option) => withDescription(option.setName("role"), "levelsNoXpRoleOptionDescription")),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("voice"), "levelsVoiceDescription").addBooleanOption((option) =>
        withDescription(option.setName("enabled"), "levelsVoiceEnabledOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("boost"), "levelsBoostDescription")
        .addNumberOption((option) =>
          withDescription(option.setName("multiplier"), "levelsMultiplierOptionDescription")
            .setRequired(true)
            .setMinValue(MIN_MULTIPLIER)
            .setMaxValue(MAX_MULTIPLIER),
        )
        .addRoleOption((option) => withDescription(option.setName("role"), "levelsBoostRoleOptionDescription")),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "levelsSetDescription")
        .addUserOption(memberOption)
        .addIntegerOption((option) => withDescription(option.setName("level"), "levelsSetLevelOptionDescription").setRequired(true).setMinValue(0).setMaxValue(MAX_LEVEL)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("reset"), "levelsResetDescription").addUserOption(memberOption))
    .toJSON();
}

// "▰▰▰▰▱▱▱▱▱▱▱▱ 33%"
export function progressBar(current, needed) {
  const fraction = needed > 0 ? Math.min(1, current / needed) : 0;
  const filled = Math.round(fraction * PROGRESS_BAR_LENGTH);
  return `${"▰".repeat(filled)}${"▱".repeat(PROGRESS_BAR_LENGTH - filled)} ${Math.floor(fraction * 100)}%`;
}

// Options: levels (LevelStore, only to run them), leveling (leveling/leveling.js), guildSettings, forcedLanguage
export function createLevelCommands({ levels, leveling, guildSettings, forcedLanguage, now = Date.now }) {
  const configFor = (guildId) => normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING));

  function answerer(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const number = (value) => new Intl.NumberFormat(language).format(value);
    const answer = async (status, key, values = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };
    return { language, text, number, answer };
  }

  async function executeRank(interaction) {
    const { text, number, answer } = answerer(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!configFor(interaction.guildId).enabled) {
      return answer(Status.REFUSED, "levelsDisabled");
    }
    const user = interaction.options.getUser("member") ?? interaction.user;
    const entry = levels.get(interaction.guildId, user.id);
    if (!entry || entry.xp <= 0) {
      return answer(Status.SUCCESS, user.id === interaction.user.id ? "rankNoXpYou" : "rankNoXp", { member: `<@${user.id}>` });
    }
    const { level, current, needed } = levelProgress(entry.xp);
    const member = interaction.options.getMember?.("member") ?? (user.id === interaction.user.id ? interaction.member : null);
    const embed = new EmbedBuilder()
      .setColor(LEVEL_COLOR)
      .setAuthor({ name: member?.displayName ?? user.username, iconURL: user.displayAvatarURL?.() })
      .setDescription(progressBar(current, needed))
      .addFields(
        { name: text("rankLevel"), value: number(level), inline: true },
        { name: text("rankXp"), value: `${number(current)} / ${number(needed)}`, inline: true },
        {
          name: text("rankPlace"),
          value: text("rankPlaceValue", { rank: number(levels.rank(interaction.guildId, user.id)), total: number(levels.count(interaction.guildId)) }),
          inline: true,
        },
      )
      .setFooter({ text: text("rankFooter", { xp: number(entry.xp), messages: number(entry.messages) }) });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  async function executeLeaderboard(interaction) {
    const { text, number, answer } = answerer(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!configFor(interaction.guildId).enabled) {
      return answer(Status.REFUSED, "levelsDisabled");
    }
    const period = PERIODS.includes(interaction.options.getString("period")) ? interaction.options.getString("period") : Period.ALL;
    const since = periodStart(period, now());
    const total = since === undefined ? levels.count(interaction.guildId) : levels.countSince(interaction.guildId, since);
    if (total === 0) {
      return answer(Status.SUCCESS, since === undefined ? "leaderboardEmpty" : "leaderboardEmptyPeriod");
    }
    const pages = Math.ceil(total / LEADERBOARD_PAGE);
    const page = Math.min(interaction.options.getInteger("page") ?? 1, pages);
    const range = { limit: LEADERBOARD_PAGE, offset: (page - 1) * LEADERBOARD_PAGE };
    const entries = since === undefined ? levels.top(interaction.guildId, range) : levels.topSince(interaction.guildId, since, range);
    const medals = ["🥇", "🥈", "🥉"];
    const lines = entries.map((entry, index) => {
      const place = range.offset + index + 1;
      const values = {
        place: medals[place - 1] ?? `**${place}.**`,
        member: `<@${entry.userId}>`,
        level: number(levelProgress(entry.xp).level),
        xp: number(entry.xp),
      };
      return since === undefined ? text("leaderboardLine", values) : text("leaderboardLinePeriod", { ...values, gained: number(entry.gained) });
    });
    const myRank = since === undefined ? levels.rank(interaction.guildId, interaction.user.id) : levels.rankSince(interaction.guildId, interaction.user.id, since);
    const footer = text("leaderboardFooter", { page, pages }) + (myRank ? ` · ${text("leaderboardYou", { rank: number(myRank) })}` : "");
    const embed = new EmbedBuilder()
      .setColor(LEVEL_COLOR)
      .setTitle(text(since === undefined ? "leaderboardTitle" : `leaderboardTitle_${period}`, { server: interaction.guild.name }))
      .setDescription(lines.join("\n"))
      .setFooter({ text: footer });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  // A one-paragraph summary of the settings.
  function describe(config, text) {
    const where =
      config.announce === Announce.CHANNEL && config.announceChannelId
        ? `<#${config.announceChannelId}>`
        : text(`levelsWhere_${config.announce}`);
    const rewards = config.rewards.length > 0 ? config.rewards.map((reward) => text("levelsRewardLine", { level: reward.level, role: `<@&${reward.roleId}>` })).join("\n") : text("levelsNone");
    const noXp = [...config.noXpChannelIds.map((id) => `<#${id}>`), ...config.noXpRoleIds.map((id) => `<@&${id}>`)];
    const boosts = config.roleMultipliers.map((boost) => `<@&${boost.roleId}> ×${boost.multiplier}`);
    return `${text("levelsShow", {
      state: text(config.enabled ? "levelsStateOn" : "levelsStateOff"),
      where,
      message: config.message ?? text("levelsDefaultMessage"),
      mode: text(config.stackRewards ? "levelsMode_keep" : "levelsMode_highest"),
      rewards,
      noXp: noXp.length > 0 ? noXp.join(", ") : text("levelsNone"),
    })}\n${text("levelsShowExtras", {
      voice: text(config.voiceXp ? "levelsStateOn" : "levelsStateOff"),
      booster: config.boosterMultiplier > 1 ? `×${config.boosterMultiplier}` : text("levelsNone"),
      roles: boosts.length > 0 ? boosts.join(", ") : text("levelsNone"),
    })}`;
  }

  async function executeLevels(interaction) {
    const { text, answer } = answerer(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
    }
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    const config = configFor(guildId);
    const save = (changes) => guildSettings.set(guildId, Setting.LEVELING, { ...config, ...changes });
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "show":
        await interaction.reply({ content: describe(config, text).slice(0, 2000), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return result(Status.SUCCESS);
      case "on":
        await save({ enabled: true });
        return answer(Status.SUCCESS, "levelsTurnedOn");
      case "off":
        await save({ enabled: false });
        return answer(Status.SUCCESS, "levelsTurnedOff");
      case "announce": {
        const where = interaction.options.getString("where", true);
        const channel = interaction.options.getChannel("channel");
        if (where === Announce.CHANNEL) {
          const me = guild.members.me;
          if (!channel?.isTextBased?.() || !me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            return answer(Status.REFUSED, "levelsAnnounceNeedsChannel");
          }
        }
        await save({ announce: where, announceChannelId: where === Announce.CHANNEL ? channel.id : null });
        return answer(Status.SUCCESS, "levelsAnnounceSet", {
          where: where === Announce.CHANNEL ? `<#${channel.id}>` : text(`levelsWhere_${where}`),
        });
      }
      case "message": {
        const message = interaction.options.getString("text")?.trim() || null;
        await save({ message });
        return answer(Status.SUCCESS, message ? "levelsMessageSet" : "levelsMessageReset");
      }
      case "reward-add": {
        const level = interaction.options.getInteger("level", true);
        const role = interaction.options.getRole("role", true);
        if (role.id === guildId || role.managed || !role.editable || FORBIDDEN_REWARD_PERMISSIONS.some((bit) => role.permissions?.has(bit))) {
          return answer(Status.REFUSED, "levelsRewardBadRole", { role: `<@&${role.id}>` });
        }
        const others = config.rewards.filter((reward) => reward.level !== level && reward.roleId !== role.id);
        if (others.length >= MAX_REWARDS) {
          return answer(Status.REFUSED, "levelsRewardTooMany", { max: MAX_REWARDS });
        }
        await save({ rewards: [...others, { level, roleId: role.id }] });
        return answer(Status.SUCCESS, "levelsRewardAdded", { level, role: `<@&${role.id}>` });
      }
      case "reward-remove": {
        const level = interaction.options.getInteger("level", true);
        if (!config.rewards.some((reward) => reward.level === level)) {
          return answer(Status.REFUSED, "levelsRewardMissing", { level });
        }
        await save({ rewards: config.rewards.filter((reward) => reward.level !== level) });
        return answer(Status.SUCCESS, "levelsRewardRemoved", { level });
      }
      case "reward-mode": {
        const keep = interaction.options.getString("mode", true) === "keep";
        await save({ stackRewards: keep });
        return answer(Status.SUCCESS, keep ? "levelsModeKeepSet" : "levelsModeHighestSet");
      }
      case "no-xp": {
        const channel = interaction.options.getChannel("channel");
        const role = interaction.options.getRole("role");
        if (!channel && !role) {
          return answer(Status.REFUSED, "levelsNoXpPickOne");
        }
        const toggle = (list, id) => (list.includes(id) ? list.filter((other) => other !== id) : [...list, id]);
        const noXpChannelIds = channel ? toggle(config.noXpChannelIds, channel.id) : config.noXpChannelIds;
        const noXpRoleIds = role ? toggle(config.noXpRoleIds, role.id) : config.noXpRoleIds;
        if (noXpChannelIds.length > MAX_NO_XP_CHANNELS || noXpRoleIds.length > MAX_NO_XP_ROLES) {
          return answer(Status.REFUSED, "levelsNoXpTooMany");
        }
        await save({ noXpChannelIds, noXpRoleIds });
        const lines = [
          channel ? text(noXpChannelIds.includes(channel.id) ? "levelsNoXpOn" : "levelsNoXpOff", { target: `<#${channel.id}>` }) : null,
          role ? text(noXpRoleIds.includes(role.id) ? "levelsNoXpOn" : "levelsNoXpOff", { target: `<@&${role.id}>` }) : null,
        ].filter(Boolean);
        await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return result(Status.SUCCESS);
      }
      case "voice": {
        const enabled = interaction.options.getBoolean("enabled", true);
        await save({ voiceXp: enabled });
        return answer(Status.SUCCESS, enabled ? "levelsVoiceOn" : "levelsVoiceOff");
      }
      case "boost": {
        const multiplier = interaction.options.getNumber("multiplier", true);
        if (!isMultiplier(multiplier)) {
          return answer(Status.REFUSED, "levelsBoostBadStep", { min: MIN_MULTIPLIER, max: MAX_MULTIPLIER });
        }
        const role = interaction.options.getRole("role");
        if (!role) {
          await save({ boosterMultiplier: multiplier });
          return answer(Status.SUCCESS, multiplier > 1 ? "levelsBoostBoosterSet" : "levelsBoostBoosterOff", { multiplier });
        }
        const others = config.roleMultipliers.filter((boost) => boost.roleId !== role.id);
        if (multiplier > 1 && others.length >= MAX_ROLE_MULTIPLIERS) {
          return answer(Status.REFUSED, "levelsBoostTooMany", { max: MAX_ROLE_MULTIPLIERS });
        }
        await save({ roleMultipliers: multiplier > 1 ? [...others, { roleId: role.id, multiplier }] : others });
        return answer(Status.SUCCESS, multiplier > 1 ? "levelsBoostRoleSet" : "levelsBoostRoleOff", { role: `<@&${role.id}>`, multiplier });
      }
      case "set": {
        const user = interaction.options.getUser("member", true);
        if (user.bot) {
          return answer(Status.REFUSED, "levelsNoBots");
        }
        const level = interaction.options.getInteger("level", true);
        levels.setXp(guildId, user.id, totalXpForLevel(level), user.username);
        const member = interaction.options.getMember?.("member");
        if (member) {
          await leveling.syncRewards(member, level, config);
        }
        return answer(Status.SUCCESS, "levelsSetDone", { member: `<@${user.id}>`, level });
      }
      default: {
        // reset
        const user = interaction.options.getUser("member", true);
        if (!levels.reset(guildId, user.id)) {
          return answer(Status.REFUSED, "levelsResetNothing", { member: `<@${user.id}>` });
        }
        const member = interaction.options.getMember?.("member");
        if (member) {
          await leveling.syncRewards(member, 0, config);
        }
        return answer(Status.SUCCESS, "levelsResetDone", { member: `<@${user.id}>` });
      }
    }
  }

  return [
    { name: "rank", data: buildRankCommandData(), execute: executeRank },
    { name: "leaderboard", data: buildLeaderboardCommandData(), execute: executeLeaderboard },
    { name: "levels", data: buildLevelsCommandData(), execute: executeLevels },
  ];
}
