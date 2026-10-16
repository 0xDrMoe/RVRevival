// The /giveaway command and its "Enter" button.
//
//   /giveaway start prize:<…> duration:1d [winners:3] [channel:#events] [role:@Members]
//   /giveaway end giveaway:<…>       end it now and pick the winners
//   /giveaway reroll giveaway:<…>    pick new winners for an ended giveaway
//   /giveaway cancel giveaway:<…>    stop it without winners
//   /giveaway list                   the giveaways that are running
//
// Needs Manage Server or the mod role. Members enter by clicking the button on
// the giveaway (and click again to leave). Giveaways are saved in data/bot.db
// and ended on time by giveaways/giveawayScheduler.js.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import {
  BUTTON_PREFIX,
  buildGiveawayMessage,
  endGiveaway,
  giveawayLanguage,
  MAX_GIVEAWAY_MS,
  MAX_PRIZE_LENGTH,
  MAX_RUNNING_GIVEAWAYS,
  MAX_WINNERS,
  MIN_GIVEAWAY_MS,
  parseButtonId,
  refreshGiveawayMessage,
  rerollGiveaway,
  showCancelled,
} from "../giveaways/giveaways.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { isModerator } from "../moderation/checks.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { formatDuration, parseDuration } from "../utils/duration.js";

const COMMAND_NAME = "giveaway";
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
// The entry count on the message is redrawn at most this often per giveaway.
const REFRESH_DELAY_MS = 5000;

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const giveawayOption = (option) =>
  withDescription(option.setName("giveaway"), "giveawayGiveawayOptionDescription").setRequired(true).setAutocomplete(true);
const winnersOption = (option, key) => withDescription(option.setName("winners"), key).setMinValue(1).setMaxValue(MAX_WINNERS);

export function buildGiveawayCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "giveawayCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("start"), "giveawayStartDescription")
        .addStringOption((option) =>
          withDescription(option.setName("prize"), "giveawayPrizeOptionDescription").setRequired(true).setMaxLength(MAX_PRIZE_LENGTH),
        )
        .addStringOption((option) =>
          withDescription(option.setName("duration"), "giveawayDurationOptionDescription").setRequired(true).setMaxLength(20),
        )
        .addIntegerOption((option) => winnersOption(option, "giveawayWinnersOptionDescription"))
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "giveawayChannelOptionDescription").addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
        )
        .addRoleOption((option) => withDescription(option.setName("role"), "giveawayRoleOptionDescription")),
    )
    .addSubcommand((sub) => withDescription(sub.setName("end"), "giveawayEndDescription").addIntegerOption(giveawayOption))
    .addSubcommand((sub) =>
      withDescription(sub.setName("reroll"), "giveawayRerollDescription")
        .addIntegerOption(giveawayOption)
        .addIntegerOption((option) => winnersOption(option, "giveawayRerollWinnersOptionDescription")),
    )
    .addSubcommand((sub) => withDescription(sub.setName("cancel"), "giveawayCancelDescription").addIntegerOption(giveawayOption))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "giveawayListDescription"))
    .toJSON();
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

// Options:
//   giveaways   the GiveawayStore (only needed to run the command, not to register it)
//   guildSettings (for the mod role), logger, forcedLanguage, now, random
export function createGiveawayCommand({ giveaways, guildSettings, logger, forcedLanguage, now = Date.now, random }) {
  // giveaway ID -> pending redraw of its entry count
  const refreshTimers = new Map();

  function refreshSoon(giveaway, guild) {
    if (refreshTimers.has(giveaway.id)) {
      return;
    }
    const timer = setTimeout(() => {
      refreshTimers.delete(giveaway.id);
      const current = giveaways.get(giveaway.id);
      if (current && current.endedAt === null) {
        refreshGiveawayMessage({ giveaway: current, guild, store: giveaways, forcedLanguage }).catch((error) =>
          logger.debug("Couldn't update a giveaway's entry count", { guildId: guild.id, giveaway: giveaway.id, error }),
        );
      }
    }, REFRESH_DELAY_MS);
    timer.unref?.();
    refreshTimers.set(giveaway.id, timer);
  }

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };

    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!isModerator(interaction, PermissionFlagsBits.ManageGuild, guildSettings)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
    }
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
      const running = giveaways.running(guildId);
      if (running.length === 0) {
        return answer(Status.SUCCESS, "giveawayListEmpty");
      }
      const lines = running.map((giveaway) =>
        text("giveawayListLine", {
          id: giveaway.id,
          prize: giveaway.prize,
          channel: `<#${giveaway.channelId}>`,
          when: timestamp(giveaway.endsAt, "R"),
          entries: giveaways.countEntries(giveaway.id),
        }),
      );
      await interaction.reply({
        content: [text("giveawayListTitle", { count: running.length }), ...lines].join("\n").slice(0, 2000),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return result(Status.SUCCESS);
    }

    if (subcommand === "start") {
      const delay = parseDuration(interaction.options.getString("duration", true));
      if (!delay) {
        return answer(Status.REFUSED, "giveawayBadDuration");
      }
      if (delay < MIN_GIVEAWAY_MS || delay > MAX_GIVEAWAY_MS) {
        return answer(Status.REFUSED, "giveawayOutOfRange");
      }
      const prize = interaction.options.getString("prize", true).trim();
      if (!prize) {
        return answer(Status.REFUSED, "giveawayNoPrize");
      }
      if (giveaways.running(guildId).length >= MAX_RUNNING_GIVEAWAYS) {
        return answer(Status.REFUSED, "giveawayTooMany", { max: MAX_RUNNING_GIVEAWAYS });
      }
      const channel = interaction.options.getChannel("channel") ?? interaction.channel;
      const me = guild.members.me;
      if (!channel?.isTextBased?.() || !me || !channel.permissionsFor(me)?.has(POST_PERMISSIONS)) {
        return answer(Status.FAILED, "giveawayCannotPost", { channel: `<#${channel?.id ?? interaction.channelId}>` });
      }
      const role = interaction.options.getRole("role");
      const requiredRoleId = role && role.id !== guildId ? role.id : null;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const createdAt = now();
      const giveaway = giveaways.create({
        guildId,
        channelId: channel.id,
        hostId: interaction.user.id,
        prize,
        winnerCount: interaction.options.getInteger("winners") ?? 1,
        requiredRoleId,
        createdAt,
        endsAt: createdAt + delay,
      });
      let message;
      try {
        message = await channel.send(buildGiveawayMessage(giveaway, { language: giveawayLanguage(guild, forcedLanguage), entries: 0 }));
      } catch (error) {
        giveaways.delete(giveaway.id);
        if (isPermissionError(error)) {
          return answer(Status.FAILED, "giveawayCannotPost", { channel: `<#${channel.id}>` });
        }
        throw error;
      }
      giveaways.setMessage(giveaway.id, message.id);
      logger.info("Giveaway started", { guildId, giveaway: giveaway.id, endsAt: giveaway.endsAt });
      return answer(Status.SUCCESS, "giveawayStarted", {
        id: giveaway.id,
        prize,
        channel: `<#${channel.id}>`,
        when: timestamp(giveaway.endsAt, "R"),
        duration: formatDuration(delay),
      });
    }

    const giveaway = giveaways.get(interaction.options.getInteger("giveaway", true));
    if (!giveaway || giveaway.guildId !== guildId) {
      return answer(Status.REFUSED, "giveawayNotFound");
    }
    const values = { id: giveaway.id, prize: giveaway.prize };

    if (subcommand === "end") {
      if (giveaway.endedAt !== null) {
        return answer(Status.REFUSED, "giveawayAlreadyEnded", values);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ended = await endGiveaway({ giveaway, guild, store: giveaways, logger, forcedLanguage, now, random });
      if (!ended) {
        return answer(Status.REFUSED, "giveawayAlreadyEnded", values);
      }
      return answer(Status.SUCCESS, "giveawayEndedNow", { ...values, count: ended.winnerIds.length });
    }

    if (subcommand === "reroll") {
      if (giveaway.endedAt === null) {
        return answer(Status.REFUSED, "giveawayNotEnded", values);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const winners = await rerollGiveaway({
        giveaway,
        guild,
        store: giveaways,
        logger,
        forcedLanguage,
        count: interaction.options.getInteger("winners") ?? 1,
        random,
      });
      return winners.length > 0
        ? answer(Status.SUCCESS, "giveawayRerolled", { ...values, winners: winners.map((id) => `<@${id}>`).join(", ") })
        : answer(Status.REFUSED, "giveawayRerollNoOne", values);
    }

    // cancel
    if (giveaway.endedAt !== null) {
      return answer(Status.REFUSED, "giveawayAlreadyEnded", values);
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const entries = giveaways.countEntries(giveaway.id);
    giveaways.delete(giveaway.id);
    await showCancelled({ giveaway, guild, entries, forcedLanguage }).catch((error) =>
      logger.debug("Couldn't mark a giveaway's message as cancelled", { guildId, giveaway: giveaway.id, error }),
    );
    return answer(Status.SUCCESS, "giveawayCancelled", values);
  }

  // Suggests running giveaways (end, cancel) or ended ones (reroll).
  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").toLowerCase();
    const list =
      interaction.options.getSubcommand() === "reroll" ? giveaways.ended(interaction.guildId) : giveaways.running(interaction.guildId);
    const choices = list
      .filter((giveaway) => !typed || String(giveaway.id) === typed || giveaway.prize.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((giveaway) => ({ name: `#${giveaway.id} ${giveaway.prize}`.slice(0, 100), value: giveaway.id }));
    await interaction.respond(choices);
  }

  // A member clicking "Enter" (or clicking again to leave). Not posted in the
  // logs channel: a big giveaway would flood it.
  async function handleButton(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const reply = async (key, values = {}) => {
      await interaction.reply({ content: translate(language, key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    };
    const giveaway = giveaways.get(parseButtonId(interaction.customId));
    if (!interaction.inCachedGuild() || !giveaway || giveaway.guildId !== interaction.guildId) {
      return reply("giveawayGone");
    }
    if (giveaway.endedAt !== null || giveaway.endsAt <= now()) {
      return reply("giveawayClosed");
    }
    if (giveaway.requiredRoleId && !interaction.member.roles.cache.has(giveaway.requiredRoleId)) {
      return reply("giveawayNeedsRole", { role: `<@&${giveaway.requiredRoleId}>` });
    }
    const entered = giveaways.toggleEntry(giveaway.id, interaction.user.id);
    refreshSoon(giveaway, interaction.guild);
    return reply(entered ? "giveawayJoined" : "giveawayLeft", { prize: giveaway.prize });
  }

  return {
    name: COMMAND_NAME,
    data: buildGiveawayCommandData(),
    execute,
    autocomplete,
    componentPrefixes: { [BUTTON_PREFIX]: { label: "Giveaway button", handle: handleButton } },
  };
}
