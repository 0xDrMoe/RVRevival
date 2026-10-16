// Posts new YouTube videos, subreddit posts and RSS items in a channel.
//
//   /feed add type source channel [role] [message]   follow something (up to 10 per server)
//   /feed remove id                                   stop following it
//   /feed list                                        what the server follows
//
// Needs Manage Server. The bot checks every 10 minutes and posts only items
// that appear after the feed was added (feeds/feedPoller.js). Also on the
// dashboard's Feeds page.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { addFeed, FeedDuplicate, FeedError, FeedLimit, MAX_FEED_MESSAGE_LENGTH } from "../feeds/feeds.js";
import { FEED_KINDS } from "../feeds/fetchFeed.js";
import { MAX_FEEDS } from "../feeds/feedStore.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "feed";
const KIND_ICONS = { youtube: "📺", reddit: "🟠", rss: "📰" };

export function buildFeedCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "feedCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "feedAddDescription")
        .addStringOption((option) =>
          withDescription(option.setName("type"), "feedTypeOptionDescription")
            .setRequired(true)
            .addChoices(...FEED_KINDS.map((kind) => ({ name: translate("en", `feedType_${kind}`), name_localizations: discordLocalizations(`feedType_${kind}`), value: kind }))),
        )
        .addStringOption((option) => withDescription(option.setName("source"), "feedSourceOptionDescription").setRequired(true).setMaxLength(500))
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "feedChannelOptionDescription").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addRoleOption((option) => withDescription(option.setName("role"), "feedRoleOptionDescription"))
        .addStringOption((option) => withDescription(option.setName("message"), "feedMessageOptionDescription").setMaxLength(MAX_FEED_MESSAGE_LENGTH)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "feedRemoveDescription").addIntegerOption((option) =>
        withDescription(option.setName("id"), "feedIdOptionDescription").setRequired(true).setMinValue(1),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "feedListDescription"))
    .toJSON();
}

const FEED_ERROR_KEYS = {
  "bad-source": "feedErrorBadSource",
  blocked: "feedErrorBlocked",
  unreachable: "feedErrorUnreachable",
  "not-a-feed": "feedErrorNotAFeed",
};

const POSTING = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

// Options: store (FeedStore), forcedLanguage, fetchOptions (tests), now
export function createFeedCommand({ store, forcedLanguage, fetchOptions, logger, now = Date.now }) {
  async function add(interaction, answer) {
    const guild = interaction.guild;
    const kind = interaction.options.getString("type", true);
    const source = interaction.options.getString("source", true);
    const channel = interaction.options.getChannel("channel", true);
    const role = interaction.options.getRole("role");
    const values = { channel: `<#${channel.id}>` };
    const me = guild.members.me;
    const usable = guild.channels.cache.get(channel.id);
    if (!usable || !POSTING.includes(usable.type) || !usable.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return answer(Status.REFUSED, "feedCannotPost", values);
    }
    if (role?.id === guild.id) {
      return answer(Status.REFUSED, "feedRoleEveryone");
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let feed;
    try {
      feed = await addFeed({
        store,
        guildId: guild.id,
        kind,
        source,
        channelId: channel.id,
        roleId: role?.id ?? null,
        message: interaction.options.getString("message"),
        createdBy: interaction.user.id,
        fetchOptions,
        now,
      });
    } catch (error) {
      if (error instanceof FeedLimit) {
        return answer(Status.REFUSED, "feedFull", { max: MAX_FEEDS });
      }
      if (error instanceof FeedDuplicate) {
        return answer(Status.REFUSED, "feedDuplicate", values);
      }
      if (error instanceof FeedError) {
        return answer(Status.FAILED, FEED_ERROR_KEYS[error.reason] ?? "feedErrorUnreachable");
      }
      throw error;
    }
    logger?.info("Feed added", { guildId: guild.id, feedId: feed.id, kind });
    return answer(Status.SUCCESS, "feedAdded", { ...values, name: feed.name, id: feed.id });
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
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
    }
    switch (interaction.options.getSubcommand()) {
      case "add":
        return add(interaction, answer);
      case "remove": {
        const id = interaction.options.getInteger("id", true);
        return store.delete(interaction.guildId, id) ? answer(Status.SUCCESS, "feedRemoved", { id }) : answer(Status.REFUSED, "feedNoSuch", { id });
      }
      case "list": {
        const feeds = store.list(interaction.guildId);
        if (feeds.length === 0) {
          return answer(Status.SUCCESS, "feedListEmpty");
        }
        const lines = feeds.map(
          (feed) =>
            `\`${feed.id}\` ${KIND_ICONS[feed.kind] ?? "📰"} **${feed.name}** → <#${feed.channelId}>${feed.roleId ? ` · <@&${feed.roleId}>` : ""}${feed.lastError ? ` · ⚠️ ${feed.lastError.slice(0, 80)}` : ""}`,
        );
        return answer(Status.SUCCESS, "feedList", { count: feeds.length, max: MAX_FEEDS, list: lines.join("\n") });
      }
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildFeedCommandData(), execute };
}
