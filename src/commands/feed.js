// Posts new YouTube videos, Shorts and live streams, Twitch and Kick streams
// going live, Bluesky and Mastodon posts, subreddit posts, GitHub releases and
// RSS items in a channel.
//
//   /feed add type source channel [role] [message] [videos] [shorts] [live]
//                                                     follow something (up to 20 per server);
//                                                     YouTube posts videos, Shorts and live
//                                                     streams unless one is turned off
//   /feed remove id                                   stop following it
//   /feed list                                        what the server follows
//
// Needs Manage Server. The bot checks every 10 minutes (YouTube live every 3,
// Twitch and Kick every 2) and
// posts only items that appear after the feed was added (feeds/feedPoller.js,
// feeds/livePoller.js). Also on the dashboard's Feeds page.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { variableRefusal } from "./commandHelpers.js";
import { addFeed, addYoutubeFeeds, countFeeds, FeedDuplicate, FeedError, FeedLimit, feedGroupKey, MAX_FEED_MESSAGE_LENGTH, YOUTUBE_TYPE_OF_KIND, YOUTUBE_TYPES } from "../feeds/feeds.js";
import { FEED_KINDS, FeedKind } from "../feeds/fetchFeed.js";
import { MAX_FEEDS } from "../feeds/feedStore.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "feed";
// YouTube Shorts and live streams are switches on the YouTube type, not types of their own.
const COMMAND_KINDS = FEED_KINDS.filter((kind) => kind !== FeedKind.YOUTUBE_SHORTS && kind !== FeedKind.YOUTUBE_LIVE);
const KIND_ICONS = {
  twitch: "🟣",
  kick: "🟢",
  bluesky: "🦋",
  mastodon: "🐘",
  reddit: "🟠",
  github: "📦",
  rss: "📰",
};

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
            .addChoices(...COMMAND_KINDS.map((kind) => ({ name: translate("en", `feedType_${kind}`), name_localizations: discordLocalizations(`feedType_${kind}`), value: kind }))),
        )
        .addStringOption((option) => withDescription(option.setName("source"), "feedSourceOptionDescription").setRequired(true).setMaxLength(500))
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "feedChannelOptionDescription").setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addRoleOption((option) => withDescription(option.setName("role"), "feedRoleOptionDescription"))
        .addStringOption((option) => withDescription(option.setName("message"), "feedMessageOptionDescription").setMaxLength(MAX_FEED_MESSAGE_LENGTH))
        .addBooleanOption((option) => withDescription(option.setName("videos"), "feedVideosOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("shorts"), "feedShortsOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("live"), "feedLiveOptionDescription")),
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
  "no-types": "feedYoutubeNoTypes",
};

// Errors that name the platform: Twitch or Kick.
const LIVE_ERROR_KEYS = {
  twitch: { "no-account": "feedErrorNoTwitchAccount", "not-configured": "feedErrorTwitchOff" },
  kick: { "no-account": "feedErrorNoKickAccount", "not-configured": "feedErrorKickOff" },
};

const POSTING = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

// Options: store (FeedStore), live (feeds/liveApis.js: the Twitch and Kick
// APIs that have keys), forcedLanguage, fetchOptions (tests), now
export function createFeedCommand({ store, live = {}, forcedLanguage, fetchOptions, logger, now = Date.now }) {
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
    // @everyone (the role with the server's ID) only for people who may ping it.
    const everyone = role?.id === guild.id;
    if (everyone && !interaction.memberPermissions.has(PermissionFlagsBits.MentionEveryone)) {
      return answer(Status.REFUSED, "feedRoleEveryone");
    }
    const message = interaction.options.getString("message");
    const refusal = message && variableRefusal(message, "feed");
    if (refusal) {
      return answer(Status.REFUSED, "variablesRefused", refusal);
    }
    // YouTube: every type unless switched off with videos/shorts/live:False.
    const youtube = kind === FeedKind.YOUTUBE;
    const types = youtube ? Object.keys(YOUTUBE_TYPES).filter((type) => interaction.options.getBoolean(type) !== false) : [];
    if (youtube && types.length === 0) {
      return answer(Status.REFUSED, "feedYoutubeNoTypes");
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let added;
    try {
      const options = { store, guildId: guild.id, source, channelId: channel.id, roleId: role?.id ?? null, message, createdBy: interaction.user.id, fetchOptions, live, now };
      added = youtube ? await addYoutubeFeeds({ ...options, types }) : [await addFeed({ ...options, kind })];
    } catch (error) {
      if (error instanceof FeedLimit) {
        return answer(Status.REFUSED, "feedFull", { max: MAX_FEEDS });
      }
      if (error instanceof FeedDuplicate) {
        return answer(Status.REFUSED, "feedDuplicate", values);
      }
      if (error instanceof FeedError) {
        return answer(Status.FAILED, LIVE_ERROR_KEYS[kind]?.[error.reason] ?? FEED_ERROR_KEYS[error.reason] ?? "feedErrorUnreachable");
      }
      throw error;
    }
    const [feed] = added;
    logger?.info("Feed added", { guildId: guild.id, feedIds: added.map((item) => item.id), kind });
    // Without Mention Everyone the post still goes out, it just pings no one.
    const note = everyone && !usable.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone) ? "feedEveryoneBotCantPing" : undefined;
    if (youtube) {
      const language = pickLanguage(interaction.locale, forcedLanguage);
      const posts = added.map((item) => `${translate(language, `feedYoutubeType_${YOUTUBE_TYPE_OF_KIND[item.kind]}`)} \`${item.id}\``).join(", ");
      return answer(Status.SUCCESS, "feedAddedYoutube", { ...values, name: feed.name, posts }, note);
    }
    return answer(Status.SUCCESS, "feedAdded", { ...values, name: feed.name, id: feed.id }, note);
  }

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}, noteKey) => {
      const content = noteKey ? `${text(key, values)}\n${text(noteKey, values)}` : text(key, values);
      const payload = { content, allowedMentions: { parse: [] } };
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
        // A YouTube channel posting in one channel is one line, with each
        // type's number (for /feed remove).
        const groups = new Map();
        for (const feed of feeds) {
          const key = feedGroupKey(feed);
          groups.set(key, [...(groups.get(key) ?? []), feed]);
        }
        const lines = [...groups.values()].map((group) => {
          const [feed] = group;
          const youtube = group.length > 1 || feed.kind in YOUTUBE_TYPE_OF_KIND;
          const ids = youtube ? group.map((item) => `${text(`feedYoutubeType_${YOUTUBE_TYPE_OF_KIND[item.kind]}`)} \`${item.id}\``).join(", ") : `\`${feed.id}\``;
          const ping = feed.roleId ? ` · ${feed.roleId === interaction.guildId ? "@everyone" : `<@&${feed.roleId}>`}` : "";
          const problems = group.filter((item) => item.lastError).map((item) => ` · ⚠️ ${item.lastError.slice(0, 80)}`).join("");
          return youtube
            ? `📺 **${feed.name}** → <#${feed.channelId}>${ping} · ${ids}${problems}`
            : `${ids} ${KIND_ICONS[feed.kind] ?? "📰"} **${feed.name}** → <#${feed.channelId}>${ping}${problems}`;
        });
        return answer(Status.SUCCESS, "feedList", { count: countFeeds(store, interaction.guildId), max: MAX_FEEDS, list: lines.join("\n") });
      }
    }
    return undefined;
  }

  return { name: COMMAND_NAME, data: buildFeedCommandData(), execute };
}
