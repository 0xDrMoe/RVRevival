// The music player.
//
//   /play query [file] [next]     a song, playlist, link, file or search
//   /search query [next]          the 5 best SoundCloud matches to pick from
//   /radio station                an internet radio station (suggested as you type)
//   /queue view [page]            what's playing and what's next
//   /queue remove | move | skipto | shuffle | clear | removedupes | leavecleanup
//   /music now                    the song playing, with its buttons
//   /music skip                   skips (or votes to, without the DJ role)
//   /music stop | pause | resume | back | replay
//   /music seek time | forward [seconds] | rewind [seconds]
//   /music loop mode | volume level | autoplay enabled | filter name
//   /music lyrics [query]         the song's lyrics (LRCLIB)
//   /music grab                   DMs you the song playing
//   /music settings [...]         DJ role, DJ-only, vote skip, longest song,
//                                 24/7, volume, queue size, Now playing
//                                 messages, when to leave (Manage Server)
//   /playlist create | play | add | remove | show | list | rename | delete
//                                 your own saved playlists, on any server
//
// Members must be in the bot's voice channel to control it. With a DJ role
// (music/config.js), only DJs and Manage Server can skip, stop or change the
// queue, except: anyone can add songs (unless DJ-only mode is on), remove
// their own, skip their own or vote to skip others, and someone alone with
// the bot can do anything.
//
// Sources: see music/sources.js. YouTube isn't one: YouTube doesn't allow it.

import { randomBytes } from "node:crypto";
import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { checkMusic, InvalidMusic, MAX_LEAVE_MINUTES, MAX_QUEUE, MAX_SONG_MINUTES, MAX_VOLUME, MIN_QUEUE, MIN_VOLUME, normalizeMusic } from "../music/config.js";
import { FILTER_NAMES, isFilter } from "../music/filters.js";
import { createLyrics } from "../music/lyrics.js";
import { MusicError } from "../music/net.js";
import { grabMessage, LOOP_MODES, lyricsMessage, MusicButton, playlistMessage, QUEUE_PAGE_PREFIX, queueMessage, SEARCH_PREFIX, SEARCH_RESULTS, searchMessage } from "../music/nowPlaying.js";
import { createMusic } from "../music/player.js";
import { cleanPlaylistName, MAX_PLAYLIST_NAME, MAX_PLAYLIST_TRACKS, MAX_PLAYLISTS, PlaylistError, PlaylistStore } from "../music/playlistStore.js";
import { isStationId, stationLabel, stationTrack } from "../music/radio.js";
import { formatTime, trackLabel } from "../music/track.js";
import { Setting } from "../settings/guildSettings.js";
import { sendDm } from "../utils/dms.js";
import { withDescription } from "./moderation.js";

const MAX_PLAYLIST = 100;
// How long search results can be picked from.
const SEARCH_TTL_MS = 2 * 60_000;
const MAX_SEARCHES = 500;
// /music forward and rewind.
const DEFAULT_JUMP_SECONDS = 10;
const MAX_JUMP_SECONDS = 600;

// "1:30", "90", "1:02:03" → milliseconds, or null.
export function parseTime(text) {
  const parts = String(text ?? "").trim().split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d{1,5}$/.test(part))) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

export function buildPlayCommandData() {
  const command = new SlashCommandBuilder().setName("play").setContexts(InteractionContextType.Guild);
  return withDescription(command, "playCommandDescription")
    .addStringOption((option) => withDescription(option.setName("query"), "playQueryOptionDescription").setMaxLength(500))
    .addAttachmentOption((option) => withDescription(option.setName("file"), "playFileOptionDescription"))
    .addBooleanOption((option) => withDescription(option.setName("next"), "playNextOptionDescription"))
    .toJSON();
}

export function buildSearchCommandData() {
  const command = new SlashCommandBuilder().setName("search").setContexts(InteractionContextType.Guild);
  return withDescription(command, "searchCommandDescription")
    .addStringOption((option) => withDescription(option.setName("query"), "searchQueryOptionDescription").setRequired(true).setMaxLength(200))
    .addBooleanOption((option) => withDescription(option.setName("next"), "playNextOptionDescription"))
    .toJSON();
}

export function buildRadioCommandData() {
  const command = new SlashCommandBuilder().setName("radio").setContexts(InteractionContextType.Guild);
  return withDescription(command, "radioCommandDescription")
    .addStringOption((option) => withDescription(option.setName("station"), "radioStationOptionDescription").setRequired(true).setMaxLength(100).setAutocomplete(true))
    .toJSON();
}

const FILTER_CHOICES = () => FILTER_NAMES.map((name) => ({ name: translate("en", `musicFilter_${name}`), name_localizations: discordLocalizations(`musicFilter_${name}`), value: name }));
const LOOP_CHOICES = () => LOOP_MODES.map((mode) => ({ name: translate("en", `musicLoop_${mode}`), name_localizations: discordLocalizations(`musicLoop_${mode}`), value: mode }));
const position = (option) => withDescription(option.setName("position"), "musicPositionOptionDescription").setRequired(true).setMinValue(1);
const seconds = (option) => withDescription(option.setName("seconds"), "musicSecondsOptionDescription").setMinValue(1).setMaxValue(MAX_JUMP_SECONDS);

export function buildMusicCommandData() {
  const command = new SlashCommandBuilder().setName("music").setContexts(InteractionContextType.Guild);
  const plain = (name) => (sub) => withDescription(sub.setName(name), `music_${name}Description`);
  return withDescription(command, "musicCommandDescription")
    .addSubcommand(plain("now"))
    .addSubcommand(plain("skip"))
    .addSubcommand(plain("stop"))
    .addSubcommand(plain("pause"))
    .addSubcommand(plain("resume"))
    .addSubcommand(plain("back"))
    .addSubcommand((sub) => plain("seek")(sub).addStringOption((option) => withDescription(option.setName("time"), "musicTimeOptionDescription").setRequired(true).setMaxLength(12)))
    .addSubcommand((sub) => plain("forward")(sub).addIntegerOption(seconds))
    .addSubcommand((sub) => plain("rewind")(sub).addIntegerOption(seconds))
    .addSubcommand(plain("replay"))
    .addSubcommand((sub) => plain("loop")(sub).addStringOption((option) => withDescription(option.setName("mode"), "musicLoopOptionDescription").setRequired(true).addChoices(...LOOP_CHOICES())))
    .addSubcommand((sub) =>
      plain("volume")(sub).addIntegerOption((option) => withDescription(option.setName("level"), "musicVolumeOptionDescription").setRequired(true).setMinValue(MIN_VOLUME).setMaxValue(MAX_VOLUME)),
    )
    .addSubcommand((sub) => plain("autoplay")(sub).addBooleanOption((option) => withDescription(option.setName("enabled"), "musicAutoplayOptionDescription").setRequired(true)))
    .addSubcommand((sub) => plain("filter")(sub).addStringOption((option) => withDescription(option.setName("name"), "musicFilterOptionDescription").setRequired(true).addChoices(...FILTER_CHOICES())))
    .addSubcommand((sub) => plain("lyrics")(sub).addStringOption((option) => withDescription(option.setName("query"), "musicLyricsQueryOptionDescription").setMaxLength(200)))
    .addSubcommand(plain("grab"))
    .addSubcommand((sub) =>
      plain("settings")(sub)
        .addRoleOption((option) => withDescription(option.setName("dj-role"), "musicDjRoleOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("no-dj-role"), "musicNoDjOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("dj-only"), "musicDjOnlyOptionDescription"))
        .addIntegerOption((option) => withDescription(option.setName("vote-skip"), "musicVoteSkipOptionDescription").setMinValue(0).setMaxValue(100))
        .addIntegerOption((option) => withDescription(option.setName("max-length"), "musicMaxLengthOptionDescription").setMinValue(0).setMaxValue(MAX_SONG_MINUTES))
        .addBooleanOption((option) => withDescription(option.setName("stay"), "musicStayOptionDescription"))
        .addIntegerOption((option) => withDescription(option.setName("volume"), "musicDefaultVolumeOptionDescription").setMinValue(MIN_VOLUME).setMaxValue(MAX_VOLUME))
        .addIntegerOption((option) => withDescription(option.setName("queue-size"), "musicQueueSizeOptionDescription").setMinValue(MIN_QUEUE).setMaxValue(MAX_QUEUE))
        .addBooleanOption((option) => withDescription(option.setName("announce"), "musicAnnounceOptionDescription"))
        .addIntegerOption((option) => withDescription(option.setName("leave-after"), "musicLeaveAfterOptionDescription").setMinValue(0).setMaxValue(MAX_LEAVE_MINUTES)),
    )
    .toJSON();
}

export function buildQueueCommandData() {
  const command = new SlashCommandBuilder().setName("queue").setContexts(InteractionContextType.Guild);
  const plain = (name) => (sub) => withDescription(sub.setName(name), `queue_${name}Description`);
  return withDescription(command, "queueCommandDescription")
    .addSubcommand((sub) => plain("view")(sub).addIntegerOption((option) => withDescription(option.setName("page"), "musicPageOptionDescription").setMinValue(1)))
    .addSubcommand((sub) => plain("remove")(sub).addIntegerOption(position))
    .addSubcommand((sub) =>
      plain("move")(sub)
        .addIntegerOption((option) => withDescription(option.setName("from"), "musicFromOptionDescription").setRequired(true).setMinValue(1))
        .addIntegerOption((option) => withDescription(option.setName("to"), "musicToOptionDescription").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) => plain("skipto")(sub).addIntegerOption(position))
    .addSubcommand(plain("shuffle"))
    .addSubcommand(plain("clear"))
    .addSubcommand(plain("removedupes"))
    .addSubcommand(plain("leavecleanup"))
    .toJSON();
}

export function buildPlaylistCommandData() {
  const command = new SlashCommandBuilder().setName("playlist").setContexts(InteractionContextType.Guild);
  const plain = (name) => (sub) => withDescription(sub.setName(name), `playlist_${name}Description`);
  const name = (option) => withDescription(option.setName("name"), "playlistNameOptionDescription").setRequired(true).setMaxLength(MAX_PLAYLIST_NAME).setAutocomplete(true);
  return withDescription(command, "playlistCommandDescription")
    .addSubcommand((sub) => plain("create")(sub).addStringOption((option) => withDescription(option.setName("name"), "playlistNewNameOptionDescription").setRequired(true).setMaxLength(MAX_PLAYLIST_NAME)))
    .addSubcommand((sub) =>
      plain("play")(sub)
        .addStringOption(name)
        .addBooleanOption((option) => withDescription(option.setName("shuffle"), "playlistShuffleOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("next"), "playNextOptionDescription")),
    )
    .addSubcommand((sub) =>
      plain("add")(sub)
        .addStringOption(name)
        .addStringOption((option) => withDescription(option.setName("query"), "playlistAddQueryOptionDescription").setMaxLength(500))
        .addBooleanOption((option) => withDescription(option.setName("queue"), "playlistAddQueueOptionDescription")),
    )
    .addSubcommand((sub) => plain("remove")(sub).addStringOption(name).addIntegerOption(position))
    .addSubcommand((sub) => plain("show")(sub).addStringOption(name).addIntegerOption((option) => withDescription(option.setName("page"), "musicPageOptionDescription").setMinValue(1)))
    .addSubcommand(plain("list"))
    .addSubcommand((sub) => plain("rename")(sub).addStringOption(name).addStringOption((option) => withDescription(option.setName("new-name"), "playlistNewNameOptionDescription").setRequired(true).setMaxLength(MAX_PLAYLIST_NAME)))
    .addSubcommand((sub) => plain("delete")(sub).addStringOption(name))
    .toJSON();
}

const humansIn = (channel) => (channel?.members ? [...channel.members.values()].filter((member) => !member.user?.bot).length : 0);

// Options: guildSettings, forcedLanguage, logger, music (music/player.js;
// made here when left out, so the commands can be listed without one),
// playlists (music/playlistStore.js), lyrics (music/lyrics.js), dm (tests).
export function createMusicCommands({ guildSettings, forcedLanguage, logger, music, playlists, lyrics, dm = sendDm }) {
  let made = music ?? null;
  const player = () => (made ??= createMusic({ guildSettings, logger, forcedLanguage }));
  let savedPlaylists = playlists ?? null;
  const playlistStore = () => (savedPlaylists ??= new PlaylistStore());
  let lyricsSource = lyrics ?? null;
  const lyricsFinder = () => (lyricsSource ??= createLyrics());
  const settingsOf = (guildId) => normalizeMusic(guildSettings.get(guildId, Setting.MUSIC));

  // A helper for answering one interaction in the member's language.
  function replier(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}, { publicly = false } = {}) => {
      const payload = { content: text(key, values).trim(), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(publicly ? payload : { ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };
    return { language, text, answer };
  }

  const isManager = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

  // The server's DJ role, when it still exists.
  function djRoleOf(interaction) {
    const { djRoleId } = settingsOf(interaction.guildId);
    return djRoleId && interaction.guild?.roles?.cache?.has(djRoleId) ? djRoleId : null;
  }

  // Whether the member counts as a DJ: there's no DJ role, they have it,
  // they have Manage Server, or they're alone with the bot.
  function isDj(interaction, active) {
    const djRoleId = djRoleOf(interaction);
    if (!djRoleId || isManager(interaction) || interaction.member?.roles?.cache?.has(djRoleId)) {
      return true;
    }
    const channelId = active?.channelId ?? interaction.member?.voice?.channelId;
    return Boolean(active) && interaction.member?.voice?.channelId === channelId && humansIn(active.voiceChannel) <= 1;
  }

  // Why this member can't control the player, as [key, values], or null.
  // `own`: the song involved is one they added.
  function refusal(interaction, active, { own = false } = {}) {
    if (!active) {
      return ["musicNothingPlaying", {}];
    }
    const inChannel = interaction.member?.voice?.channelId === active.channelId;
    if (!inChannel && !isManager(interaction)) {
      return ["musicSameChannel", { channel: `<#${active.channelId}>` }];
    }
    if (own || isDj(interaction, active)) {
      return null;
    }
    return ["musicDjOnly", { role: `<@&${djRoleOf(interaction)}>` }];
  }

  // Checks the member can start music here and joins their channel.
  // Returns { channel, active } or { refused: [key, values] }.
  function joinCheck(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel || !VOICE_TYPES.includes(channel.type)) {
      return { refused: ["musicJoinVoice", {}] };
    }
    const active = player().get(interaction.guildId);
    if (active && active.channelId !== channel.id) {
      return { refused: ["musicSameChannel", { channel: `<#${active.channelId}>` }] };
    }
    if (settingsOf(interaction.guildId).djOnly && !isDj(interaction, active)) {
      return { refused: ["musicDjOnlyAdd", { role: `<@&${djRoleOf(interaction)}>` }] };
    }
    if (!active) {
      const me = interaction.guild.members.me;
      const permissions = me && channel.permissionsFor(me);
      if (permissions && !permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        return { refused: ["musicCantJoin", { channel: `<#${channel.id}>` }] };
      }
      if (channel.joinable === false) {
        return { refused: ["musicChannelFull", { channel: `<#${channel.id}>` }] };
      }
    }
    return { channel, active };
  }

  const errorKey = (error) => `musicError_${error.reason}`;

  // Adds tracks (resolved by `load(limit)`) and says what happened.
  // `next` puts them at the front; `start` acknowledges the interaction
  // (a reply that's public, by default); `announce` also tells the channel
  // (for picks from private search results); `shuffle` mixes them first.
  async function queueUp(interaction, load, { next = interaction.options?.getBoolean?.("next") ?? false, start = () => interaction.deferReply(), announce = false, shuffle = false } = {}) {
    const { text, answer } = replier(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const check = joinCheck(interaction);
    if (check.refused) {
      return answer(Status.REFUSED, ...check.refused);
    }
    if (next && check.active) {
      const refused = refusal(interaction, check.active);
      if (refused) {
        return answer(Status.REFUSED, ...refused);
      }
    }
    const settings = settingsOf(interaction.guildId);
    const room = settings.maxQueue - (check.active?.queue.length ?? 0);
    if (room <= 0) {
      return answer(Status.REFUSED, "musicQueueFull", { max: settings.maxQueue });
    }
    await start();
    let found;
    try {
      found = await load(Math.min(MAX_PLAYLIST, room));
    } catch (error) {
      if (error instanceof MusicError) {
        return answer(Status.FAILED, errorKey(error));
      }
      throw error;
    }
    const maxMs = settings.maxSongMinutes * 60_000;
    const fits = (track) => maxMs === 0 || track.live || !track.durationMs || track.durationMs <= maxMs;
    const tracks = found.tracks.filter(fits);
    const tooLong = found.tracks.length - tracks.length;
    if (tracks.length === 0) {
      return answer(Status.REFUSED, "musicTooLong", { max: settings.maxSongMinutes });
    }
    if (shuffle) {
      shuffleInPlace(tracks);
    }
    let active;
    try {
      active = await player().join({ guild: interaction.guild, channel: check.channel, textChannel: interaction.channel });
    } catch (error) {
      if (error instanceof MusicError) {
        return answer(Status.FAILED, errorKey(error));
      }
      throw error;
    }
    const waiting = active.queue.length;
    const wasPlaying = Boolean(active.current);
    const added = active.add(tracks, { next, requestedBy: interaction.user.id });
    const extra = [
      found.skipped > 0 ? text("musicSkippedNotFree", { count: found.skipped }) : null,
      tooLong > 0 ? text("musicSkippedTooLong", { count: tooLong, max: settings.maxSongMinutes }) : null,
      added < tracks.length ? text("musicQueueCut", { max: settings.maxQueue }) : null,
    ]
      .filter(Boolean)
      .join(" ");
    const first = tracks[0];
    const values = {
      title: trackLabel(first),
      count: added,
      name: found.name ?? trackLabel(first),
      position: next ? 1 : waiting + 1,
      extra,
    };
    const key = added > 1 || found.name ? "musicAddedMany" : wasPlaying ? "musicAddedOne" : "musicPlayingNow";
    const outcome = await answer(Status.SUCCESS, key, values);
    if (announce) {
      await interaction
        .followUp({ content: text("musicPickedBy", { user: `<@${interaction.user.id}>`, title: values.title }), allowedMentions: { parse: [] } })
        .catch(() => {});
    }
    return outcome;
  }

  // Search results waiting for a pick: session → { userId, guildId, tracks, next, at }.
  const searches = new Map();
  const forgetOldSearches = () => {
    for (const [session, search] of searches) {
      if (Date.now() - search.at > SEARCH_TTL_MS || searches.size > MAX_SEARCHES) {
        searches.delete(session);
      }
    }
  };

  async function searchCommand(interaction) {
    const { language, answer } = replier(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const check = joinCheck(interaction);
    if (check.refused) {
      return answer(Status.REFUSED, ...check.refused);
    }
    const query = interaction.options.getString("query", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let tracks;
    try {
      tracks = await player().resolver.search(query, { limit: SEARCH_RESULTS });
    } catch (error) {
      if (error instanceof MusicError) {
        return answer(Status.FAILED, errorKey(error));
      }
      throw error;
    }
    forgetOldSearches();
    const session = randomBytes(6).toString("hex");
    searches.set(session, { userId: interaction.user.id, guildId: interaction.guildId, tracks, next: interaction.options.getBoolean("next") ?? false, at: Date.now() });
    await interaction.editReply(searchMessage(tracks, { language, guildSettings, guildId: interaction.guildId, query, session }));
    return result(Status.SUCCESS, "musicSearchTitle", { query });
  }

  // A pick (button or menu) from search results: "msearch:<session>:<index | menu | cancel>".
  async function searchPick(interaction) {
    const { text } = replier(interaction);
    const [, session, choice] = interaction.customId.split(":");
    const search = searches.get(session);
    if (!search || Date.now() - search.at > SEARCH_TTL_MS) {
      searches.delete(session);
      await interaction.update({ content: text("musicSearchExpired"), embeds: [], components: [] });
      return null;
    }
    if (search.userId !== interaction.user.id) {
      await interaction.reply({ content: text("musicSearchNotYours"), flags: MessageFlags.Ephemeral });
      return null;
    }
    if (choice === "cancel") {
      searches.delete(session);
      await interaction.update({ content: text("musicSearchCancelled"), embeds: [], components: [] });
      return null;
    }
    const index = choice === "menu" ? Number(interaction.values?.[0]) : Number(choice);
    const track = search.tracks[index];
    if (!track) {
      return null;
    }
    searches.delete(session);
    return queueUp(interaction, async () => ({ tracks: [track], skipped: 0, name: null }), {
      next: search.next,
      start: () => interaction.update({ content: text("musicSearchAdding", { title: trackLabel(track) }), embeds: [], components: [] }),
      announce: true,
    });
  }

  async function play(interaction) {
    const query = interaction.options.getString("query");
    const file = interaction.options.getAttachment("file");
    if (!query && !file) {
      return replier(interaction).answer(Status.REFUSED, "musicNeedQuery");
    }
    return queueUp(interaction, async (limit) => {
      if (file) {
        return { tracks: [player().resolver.fileTrack(file)], skipped: 0, name: null };
      }
      return player().resolver.resolve(query, { limit });
    });
  }

  async function radioCommand(interaction) {
    const typed = interaction.options.getString("station", true);
    return queueUp(interaction, async () => {
      const station = isStationId(typed) ? await player().radio.byId(typed) : (await player().radio.search(typed, { limit: 1 }))[0];
      if (!station) {
        throw new MusicError("not-found", "No such station.");
      }
      return { tracks: [stationTrack(station)], skipped: 0, name: null };
    });
  }

  async function radioAutocomplete(interaction) {
    const typed = interaction.options.getFocused();
    const stations = typed.trim().length >= 2 ? await player().radio.search(typed, { limit: 15 }).catch(() => []) : [];
    await interaction.respond(stations.map((station) => ({ name: stationLabel(station), value: station.id })));
  }

  async function settingsCommand(interaction, { answer, text }) {
    if (!isManager(interaction)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
    }
    const saved = settingsOf(interaction.guildId);
    const options = interaction.options;
    const djRole = options.getRole("dj-role");
    const given = (value, key) => (value === null || value === undefined ? {} : { [key]: value });
    const changes = {
      ...(djRole ? { djRoleId: djRole.id } : {}),
      ...(options.getBoolean("no-dj-role") ? { djRoleId: null, djOnly: false } : {}),
      ...given(options.getBoolean("dj-only"), "djOnly"),
      ...given(options.getInteger("vote-skip"), "voteSkipPercent"),
      ...given(options.getInteger("max-length"), "maxSongMinutes"),
      ...given(options.getBoolean("stay"), "stay247"),
      ...given(options.getInteger("volume"), "defaultVolume"),
      ...given(options.getInteger("queue-size"), "maxQueue"),
      ...given(options.getBoolean("announce"), "announce"),
      ...given(options.getInteger("leave-after"), "leaveAfterMinutes"),
    };
    const onOff = (on) => text(on ? "musicOn" : "musicOff");
    const show = (config, key) =>
      answer(Status.SUCCESS, key, {
        dj: config.djRoleId ? `<@&${config.djRoleId}>` : text("musicNoDj"),
        djOnly: onOff(config.djOnly),
        voteSkip: config.voteSkipPercent === 0 ? text("musicOff") : `${config.voteSkipPercent}%`,
        maxLength: config.maxSongMinutes === 0 ? text("musicNoLimit") : config.maxSongMinutes,
        stay: onOff(config.stay247),
        volume: config.defaultVolume,
        queue: config.maxQueue,
        announce: onOff(config.announce),
        leave: config.leaveAfterMinutes,
      });
    if (Object.keys(changes).length === 0) {
      return show(saved, "musicSettingsShow");
    }
    const djRoleAfter = "djRoleId" in changes ? changes.djRoleId : saved.djRoleId;
    if (changes.djOnly === true && !djRoleAfter) {
      return answer(Status.REFUSED, "musicDjOnlyNeedsRole");
    }
    const roles = interaction.guild.roles.cache;
    let value;
    try {
      value = checkMusic({ ...saved, ...changes }, { isRole: (id) => id !== interaction.guildId && roles.has(id) });
    } catch (error) {
      if (error instanceof InvalidMusic) {
        return answer(Status.REFUSED, "musicSettingsBad");
      }
      throw error;
    }
    await guildSettings.set(interaction.guildId, Setting.MUSIC, value);
    // 24/7 turned off while idle: the player can leave as usual again.
    player().get(interaction.guildId)?.listenersChanged();
    return show(normalizeMusic(value), "musicSettingsSaved");
  }

  // Skips, or counts a vote when the member isn't a DJ (vote skip).
  async function skipOrVote(interaction, active, { answer }) {
    const user = `<@${interaction.user.id}>`;
    const publicly = { publicly: true };
    const own = active?.current?.requestedBy === interaction.user.id;
    const refused = refusal(interaction, active, { own });
    const title = active?.current ? trackLabel(active.current) : null;
    if (!refused) {
      return active.skip() ? answer(Status.SUCCESS, "musicSkipped", { title, user }, publicly) : answer(Status.REFUSED, "musicNothingPlaying");
    }
    const percent = settingsOf(interaction.guildId).voteSkipPercent;
    if (refused[0] !== "musicDjOnly" || percent === 0 || !active.current) {
      return answer(Status.REFUSED, ...refused);
    }
    const vote = active.voteSkip(interaction.user.id, percent);
    return vote.skipped
      ? answer(Status.SUCCESS, "musicVoteSkipped", { title, votes: vote.votes, needed: vote.needed }, publicly)
      : answer(Status.SUCCESS, "musicVoteCounted", { user, votes: vote.votes, needed: vote.needed }, publicly);
  }

  async function lyricsCommand(interaction, { language, answer }, active) {
    const query = interaction.options.getString("query");
    const song = query ? { title: query, artist: "" } : active?.current;
    if (!song) {
      return answer(Status.REFUSED, "musicNothingPlaying");
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let found;
    try {
      found = await lyricsFinder().find({ title: song.lookup?.title ?? song.title, artist: song.lookup?.artist ?? song.artist, durationMs: song.durationMs ?? null });
    } catch (error) {
      if (error instanceof MusicError) {
        return answer(Status.FAILED, error.reason === "not-found" ? "musicLyricsNotFound" : errorKey(error), { title: song.title });
      }
      throw error;
    }
    if (!found) {
      return answer(Status.FAILED, "musicLyricsNotFound", { title: song.title });
    }
    await interaction.editReply(lyricsMessage(found, { language, guildSettings, guildId: interaction.guildId }));
    return result(Status.SUCCESS, "musicLyricsTitle");
  }

  async function grabCommand(interaction, { language, answer }, active) {
    if (!active?.current) {
      return answer(Status.REFUSED, "musicNothingPlaying");
    }
    try {
      await dm(interaction.user, grabMessage(active.current, { language, guildName: interaction.guild.name, positionMs: active.positionMs }));
    } catch {
      return answer(Status.FAILED, "musicGrabClosed");
    }
    return answer(Status.SUCCESS, "musicGrabbed", { title: trackLabel(active.current) });
  }

  async function musicCommand(interaction) {
    const reply = replier(interaction);
    const { answer } = reply;
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const sub = interaction.options.getSubcommand();
    const active = player().get(interaction.guildId);
    switch (sub) {
      case "settings":
        return settingsCommand(interaction, reply);
      case "now":
        if (!active?.current) {
          return answer(Status.REFUSED, "musicNothingPlaying");
        }
        await interaction.reply({ ...active.nowPlaying(), flags: MessageFlags.Ephemeral });
        return result(Status.SUCCESS, "musicNowPlayingTitle");
      case "lyrics":
        return lyricsCommand(interaction, reply, active);
      case "grab":
        return grabCommand(interaction, reply, active);
      case "skip":
        return skipOrVote(interaction, active, reply);
    }

    if (sub === "seek" && parseTime(interaction.options.getString("time")) === null) {
      return answer(Status.REFUSED, "musicBadTime");
    }
    const refused = refusal(interaction, active);
    if (refused) {
      return answer(Status.REFUSED, ...refused);
    }
    const user = `<@${interaction.user.id}>`;
    const publicly = { publicly: true };
    switch (sub) {
      case "stop":
        active.destroy();
        return answer(Status.SUCCESS, "musicStopped", { user }, publicly);
      case "pause":
        return active.pause() ? answer(Status.SUCCESS, "musicPausedBy", { user }, publicly) : answer(Status.REFUSED, "musicAlreadyPaused");
      case "resume":
        return active.resume() ? answer(Status.SUCCESS, "musicResumedBy", { user }, publicly) : answer(Status.REFUSED, "musicNotPaused");
      case "back": {
        const previous = active.back();
        return previous ? answer(Status.SUCCESS, "musicWentBack", { title: trackLabel(previous), user }, publicly) : answer(Status.REFUSED, "musicNoHistory");
      }
      case "seek":
      case "replay": {
        const ms = sub === "replay" ? 0 : parseTime(interaction.options.getString("time"));
        if (!active.current) {
          return answer(Status.REFUSED, "musicNothingPlaying");
        }
        return active.seek(ms) ? answer(Status.SUCCESS, "musicSeeked", { time: formatTime(ms), user }, publicly) : answer(Status.REFUSED, "musicCantSeek");
      }
      case "forward":
      case "rewind": {
        const step = (interaction.options.getInteger("seconds") ?? DEFAULT_JUMP_SECONDS) * 1000;
        if (!active.current) {
          return answer(Status.REFUSED, "musicNothingPlaying");
        }
        const at = active.forward(sub === "forward" ? step : -step);
        return at === null ? answer(Status.REFUSED, "musicCantSeek") : answer(Status.SUCCESS, "musicSeeked", { time: formatTime(at), user }, publicly);
      }
      case "loop": {
        const mode = interaction.options.getString("mode", true);
        active.setLoop(mode);
        return answer(Status.SUCCESS, "musicLoopSet", { mode: reply.text(`musicLoop_${mode}`), user }, publicly);
      }
      case "volume": {
        const level = interaction.options.getInteger("level", true);
        active.setVolume(level);
        return answer(Status.SUCCESS, "musicVolumeSet", { volume: level, user }, publicly);
      }
      case "autoplay": {
        const enabled = interaction.options.getBoolean("enabled", true);
        active.setAutoplay(enabled);
        return answer(Status.SUCCESS, enabled ? "musicAutoplayOn" : "musicAutoplayOff", { user }, publicly);
      }
      case "filter": {
        const name = interaction.options.getString("name", true);
        if (!isFilter(name)) {
          return answer(Status.REFUSED, "musicSettingsBad");
        }
        active.setFilter(name);
        return answer(Status.SUCCESS, name === "off" ? "musicFilterOff" : "musicFilterSet", { filter: reply.text(`musicFilter_${name}`), user }, publicly);
      }
    }
    return undefined;
  }

  async function queueCommand(interaction) {
    const reply = replier(interaction);
    const { answer } = reply;
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const sub = interaction.options.getSubcommand();
    const active = player().get(interaction.guildId);
    if (sub === "view") {
      if (!active) {
        return answer(Status.REFUSED, "musicNothingPlaying");
      }
      await interaction.reply({ ...queueMessage(active.state(), { language: reply.language, guildSettings, page: interaction.options.getInteger("page") ?? 1 }), flags: MessageFlags.Ephemeral });
      return result(Status.SUCCESS, "musicQueueTitle");
    }
    const position = interaction.options.getInteger("position");
    const own = sub === "remove" && active?.queue[position - 1]?.requestedBy === interaction.user.id;
    const refused = refusal(interaction, active, { own });
    if (refused) {
      return answer(Status.REFUSED, ...refused);
    }
    const user = `<@${interaction.user.id}>`;
    const publicly = { publicly: true };
    switch (sub) {
      case "remove": {
        const removed = active.remove(position);
        return removed ? answer(Status.SUCCESS, "musicRemoved", { title: trackLabel(removed), user }, publicly) : answer(Status.REFUSED, "musicNoSuchPosition", { count: active.queue.length });
      }
      case "move": {
        const to = interaction.options.getInteger("to", true);
        const moved = active.move(interaction.options.getInteger("from", true), to);
        return moved ? answer(Status.SUCCESS, "musicMoved", { title: trackLabel(moved), position: to, user }, publicly) : answer(Status.REFUSED, "musicNoSuchPosition", { count: active.queue.length });
      }
      case "skipto": {
        const target = active.skipTo(position);
        return target ? answer(Status.SUCCESS, "musicSkippedTo", { title: trackLabel(target), user }, publicly) : answer(Status.REFUSED, "musicNoSuchPosition", { count: active.queue.length });
      }
      case "shuffle":
        if (active.queue.length < 2) {
          return answer(Status.REFUSED, "musicNothingToShuffle");
        }
        active.shuffle();
        return answer(Status.SUCCESS, "musicShuffled", { count: active.queue.length, user }, publicly);
      case "clear":
        return answer(Status.SUCCESS, "musicCleared", { count: active.clear(), user }, publicly);
      case "removedupes":
        return answer(Status.SUCCESS, "musicRemovedDupes", { count: active.removeDuplicates(), user }, publicly);
      case "leavecleanup":
        return answer(Status.SUCCESS, "musicLeaveCleanup", { count: active.removeAbsent(), user }, publicly);
    }
    return undefined;
  }

  // /playlist: members' own saved playlists.
  async function playlistCommand(interaction) {
    const reply = replier(interaction);
    const { language, answer } = reply;
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const store = playlistStore();
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();
    const typedName = interaction.options.getString("name") ?? "";
    const failed = (error) => {
      if (error instanceof PlaylistError) {
        return answer(Status.REFUSED, `playlistError_${error.reason}`, { name: cleanPlaylistName(typedName) ?? typedName.slice(0, MAX_PLAYLIST_NAME), max: error.reason === "full" ? MAX_PLAYLIST_TRACKS : MAX_PLAYLISTS });
      }
      throw error;
    };
    if (sub === "list") {
      const list = store.list(userId);
      if (list.length === 0) {
        return answer(Status.SUCCESS, "playlistNone");
      }
      const lines = list.map((playlist) => reply.text("playlistListLine", { name: playlist.name, count: playlist.size }));
      return answer(Status.SUCCESS, "playlistList", { count: list.length, max: MAX_PLAYLISTS, list: lines.join("\n") });
    }
    if (sub === "create") {
      try {
        const made = store.create(userId, typedName);
        return answer(Status.SUCCESS, "playlistCreated", { name: made.name });
      } catch (error) {
        return failed(error);
      }
    }
    const playlist = store.get(userId, typedName);
    if (!playlist) {
      return failed(new PlaylistError("missing"));
    }
    const name = playlist.name;
    switch (sub) {
      case "delete":
        store.delete(userId, name);
        return answer(Status.SUCCESS, "playlistDeleted", { name });
      case "rename":
        try {
          return answer(Status.SUCCESS, "playlistRenamed", { name, newName: store.rename(userId, name, interaction.options.getString("new-name", true)) });
        } catch (error) {
          return failed(error);
        }
      case "show":
        await interaction.reply({ ...playlistMessage(playlist, { language, page: interaction.options.getInteger("page") ?? 1 }), flags: MessageFlags.Ephemeral });
        return result(Status.SUCCESS, "musicPlaylistTitle", { name });
      case "remove": {
        const removed = store.remove(userId, name, interaction.options.getInteger("position", true));
        return removed ? answer(Status.SUCCESS, "playlistRemoved", { title: trackLabel(removed), name }) : answer(Status.REFUSED, "musicNoSuchPosition", { count: playlist.tracks.length });
      }
      case "add":
        return playlistAdd(interaction, reply, playlist);
      case "play":
        if (playlist.tracks.length === 0) {
          return answer(Status.REFUSED, "playlistEmpty", { name });
        }
        return queueUp(interaction, async (limit) => ({ tracks: playlist.tracks.slice(0, limit), skipped: 0, name }), { shuffle: interaction.options.getBoolean("shuffle") ?? false });
    }
    return undefined;
  }

  // /playlist add: a link or search, the whole queue, or the song playing.
  async function playlistAdd(interaction, { answer }, playlist) {
    const store = playlistStore();
    const query = interaction.options.getString("query");
    const wholeQueue = interaction.options.getBoolean("queue") ?? false;
    const active = player().get(interaction.guildId);
    let tracks;
    if (query) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        tracks = (await player().resolver.resolve(query, { limit: Math.max(1, MAX_PLAYLIST_TRACKS - playlist.tracks.length) })).tracks;
      } catch (error) {
        if (error instanceof MusicError) {
          return answer(Status.FAILED, errorKey(error));
        }
        throw error;
      }
    } else if (active?.current) {
      tracks = wholeQueue ? [active.current, ...active.queue] : [active.current];
    } else {
      return answer(Status.REFUSED, "playlistAddWhat");
    }
    let saved;
    try {
      saved = store.add(interaction.user.id, playlist.name, tracks);
    } catch (error) {
      if (error instanceof PlaylistError) {
        return answer(Status.REFUSED, `playlistError_${error.reason}`, { name: playlist.name, max: MAX_PLAYLIST_TRACKS });
      }
      throw error;
    }
    if (saved.added === 0) {
      return answer(Status.REFUSED, "playlistNothingSaved");
    }
    return answer(Status.SUCCESS, saved.added === 1 ? "playlistAddedOne" : "playlistAddedMany", { title: trackLabel(tracks[0]), count: saved.added, name: playlist.name, skipped: saved.skipped });
  }

  async function playlistAutocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").toLocaleLowerCase("en");
    const list = playlistStore().list(interaction.user.id);
    await interaction.respond(
      list
        .filter((playlist) => playlist.name.toLocaleLowerCase("en").includes(typed))
        .slice(0, 25)
        .map((playlist) => ({ name: `${playlist.name} (${playlist.size})`.slice(0, 100), value: playlist.name })),
    );
  }

  // The buttons under "Now playing".
  async function button(interaction) {
    const reply = replier(interaction);
    const { language, answer } = reply;
    const active = interaction.inCachedGuild() ? player().get(interaction.guildId) : null;
    if (!active?.current) {
      await interaction.update({ components: [] }).catch(() => {});
      return null;
    }
    if (interaction.customId === MusicButton.QUEUE) {
      await interaction.reply({ ...queueMessage(active.state(), { language, guildSettings }), flags: MessageFlags.Ephemeral });
      return null;
    }
    if (interaction.customId === MusicButton.SKIP) {
      return skipOrVote(interaction, active, reply);
    }
    const refused = refusal(interaction, active);
    if (refused) {
      return answer(Status.REFUSED, ...refused);
    }
    const user = `<@${interaction.user.id}>`;
    switch (interaction.customId) {
      case MusicButton.TOGGLE:
        if (active.paused) {
          active.resume();
        } else {
          active.pause();
        }
        await interaction.update(active.nowPlaying());
        active.nowPlayingUpdated(interaction.message);
        return result(Status.SUCCESS, active.paused ? "musicPausedBy" : "musicResumedBy", { user });
      case MusicButton.LOOP: {
        const mode = LOOP_MODES[(LOOP_MODES.indexOf(active.loop) + 1) % LOOP_MODES.length];
        active.setLoop(mode);
        await interaction.update(active.nowPlaying());
        active.nowPlayingUpdated(interaction.message);
        return result(Status.SUCCESS, "musicLoopSet", { mode, user });
      }
      case MusicButton.STOP:
        active.destroy();
        return answer(Status.SUCCESS, "musicStopped", { user }, { publicly: true });
      case MusicButton.BACK: {
        const previous = active.back();
        return previous ? answer(Status.SUCCESS, "musicWentBack", { title: trackLabel(previous), user }, { publicly: true }) : answer(Status.REFUSED, "musicNoHistory");
      }
      case MusicButton.SHUFFLE:
        if (active.queue.length < 2) {
          return answer(Status.REFUSED, "musicNothingToShuffle");
        }
        active.shuffle();
        return answer(Status.SUCCESS, "musicShuffled", { count: active.queue.length, user }, { publicly: true });
    }
    return null;
  }

  // ◀ ▶ under a queue page: "mqueue:<page>".
  async function queuePage(interaction) {
    const { language, text } = replier(interaction);
    const active = interaction.inCachedGuild() ? player().get(interaction.guildId) : null;
    if (!active) {
      await interaction.update({ content: text("musicNothingPlaying"), embeds: [], components: [] });
      return null;
    }
    const page = Number(interaction.customId.slice(QUEUE_PAGE_PREFIX.length)) || 1;
    await interaction.update(queueMessage(active.state(), { language, guildSettings, page }));
    return null;
  }

  const components = Object.fromEntries(
    [
      [MusicButton.TOGGLE, "Music: pause or resume"],
      [MusicButton.SKIP, "Music: skip"],
      [MusicButton.STOP, "Music: stop"],
      [MusicButton.LOOP, "Music: loop"],
      [MusicButton.QUEUE, "Music: queue"],
      [MusicButton.BACK, "Music: back"],
      [MusicButton.SHUFFLE, "Music: shuffle"],
    ].map(([id, label]) => [id, { label, handle: button }]),
  );

  return [
    { name: "play", data: buildPlayCommandData(), execute: play, components },
    {
      name: "search",
      data: buildSearchCommandData(),
      execute: searchCommand,
      componentPrefixes: { [SEARCH_PREFIX]: { label: "Music: pick a search result", handle: searchPick } },
    },
    { name: "radio", data: buildRadioCommandData(), execute: radioCommand, autocomplete: radioAutocomplete },
    {
      name: "queue",
      data: buildQueueCommandData(),
      execute: queueCommand,
      componentPrefixes: { [QUEUE_PAGE_PREFIX]: { label: "Music: queue page", handle: queuePage } },
    },
    { name: "music", data: buildMusicCommandData(), execute: musicCommand },
    { name: "playlist", data: buildPlaylistCommandData(), execute: playlistCommand, autocomplete: playlistAutocomplete },
  ];
}

// Fisher-Yates, in place.
function shuffleInPlace(list) {
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}
