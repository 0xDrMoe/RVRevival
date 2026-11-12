// The music player.
//
//   /play query [file] [next]     a song, playlist, link, file or search
//   /radio station                an internet radio station (suggested as you type)
//   /music queue [page]           what's playing and what's next
//   /music now                    the song playing, with its buttons
//   /music skip | stop | pause | resume | shuffle | clear
//   /music loop mode              off, the song, or the whole queue
//   /music volume level           1 to 150 %
//   /music remove position        takes a song out of the queue
//   /music move from to           moves a song in the queue
//   /music settings [...]         DJ role, volume, queue size, Now playing
//                                 messages, when to leave (Manage Server)
//
// Members must be in the bot's voice channel to control it. With a DJ role
// (music/config.js), only DJs and Manage Server can skip, stop or change the
// queue, except: anyone can add songs, skip or remove their own, and someone
// alone with the bot can do anything.
//
// Sources: see music/sources.js. YouTube isn't one: YouTube doesn't allow it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { checkMusic, InvalidMusic, MAX_LEAVE_MINUTES, MAX_QUEUE, MAX_VOLUME, MIN_QUEUE, MIN_VOLUME, normalizeMusic } from "../music/config.js";
import { MusicError } from "../music/net.js";
import { LOOP_MODES, MusicButton, queueMessage } from "../music/nowPlaying.js";
import { createMusic } from "../music/player.js";
import { isStationId, stationLabel, stationTrack } from "../music/radio.js";
import { trackLabel } from "../music/track.js";
import { Setting } from "../settings/guildSettings.js";
import { withDescription } from "./moderation.js";

const MAX_PLAYLIST = 100;
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

export function buildPlayCommandData() {
  const command = new SlashCommandBuilder().setName("play").setContexts(InteractionContextType.Guild);
  return withDescription(command, "playCommandDescription")
    .addStringOption((option) => withDescription(option.setName("query"), "playQueryOptionDescription").setMaxLength(500))
    .addAttachmentOption((option) => withDescription(option.setName("file"), "playFileOptionDescription"))
    .addBooleanOption((option) => withDescription(option.setName("next"), "playNextOptionDescription"))
    .toJSON();
}

export function buildRadioCommandData() {
  const command = new SlashCommandBuilder().setName("radio").setContexts(InteractionContextType.Guild);
  return withDescription(command, "radioCommandDescription")
    .addStringOption((option) => withDescription(option.setName("station"), "radioStationOptionDescription").setRequired(true).setMaxLength(100).setAutocomplete(true))
    .toJSON();
}

export function buildMusicCommandData() {
  const command = new SlashCommandBuilder().setName("music").setContexts(InteractionContextType.Guild);
  const plain = (name) => (sub) => withDescription(sub.setName(name), `music_${name}Description`);
  return withDescription(command, "musicCommandDescription")
    .addSubcommand((sub) => plain("queue")(sub).addIntegerOption((option) => withDescription(option.setName("page"), "musicPageOptionDescription").setMinValue(1)))
    .addSubcommand(plain("now"))
    .addSubcommand(plain("skip"))
    .addSubcommand(plain("stop"))
    .addSubcommand(plain("pause"))
    .addSubcommand(plain("resume"))
    .addSubcommand((sub) =>
      plain("loop")(sub).addStringOption((option) =>
        withDescription(option.setName("mode"), "musicLoopOptionDescription")
          .setRequired(true)
          .addChoices(...LOOP_MODES.map((mode) => ({ name: translate("en", `musicLoop_${mode}`), name_localizations: discordLocalizations(`musicLoop_${mode}`), value: mode }))),
      ),
    )
    .addSubcommand(plain("shuffle"))
    .addSubcommand((sub) =>
      plain("volume")(sub).addIntegerOption((option) => withDescription(option.setName("level"), "musicVolumeOptionDescription").setRequired(true).setMinValue(MIN_VOLUME).setMaxValue(MAX_VOLUME)),
    )
    .addSubcommand((sub) => plain("remove")(sub).addIntegerOption((option) => withDescription(option.setName("position"), "musicPositionOptionDescription").setRequired(true).setMinValue(1)))
    .addSubcommand((sub) =>
      plain("move")(sub)
        .addIntegerOption((option) => withDescription(option.setName("from"), "musicFromOptionDescription").setRequired(true).setMinValue(1))
        .addIntegerOption((option) => withDescription(option.setName("to"), "musicToOptionDescription").setRequired(true).setMinValue(1)),
    )
    .addSubcommand(plain("clear"))
    .addSubcommand((sub) =>
      plain("settings")(sub)
        .addRoleOption((option) => withDescription(option.setName("dj-role"), "musicDjRoleOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("no-dj-role"), "musicNoDjOptionDescription"))
        .addIntegerOption((option) => withDescription(option.setName("volume"), "musicDefaultVolumeOptionDescription").setMinValue(MIN_VOLUME).setMaxValue(MAX_VOLUME))
        .addIntegerOption((option) => withDescription(option.setName("queue-size"), "musicQueueSizeOptionDescription").setMinValue(MIN_QUEUE).setMaxValue(MAX_QUEUE))
        .addBooleanOption((option) => withDescription(option.setName("announce"), "musicAnnounceOptionDescription"))
        .addIntegerOption((option) => withDescription(option.setName("leave-after"), "musicLeaveAfterOptionDescription").setMinValue(0).setMaxValue(MAX_LEAVE_MINUTES)),
    )
    .toJSON();
}

const humansIn = (channel) => (channel?.members ? [...channel.members.values()].filter((member) => !member.user?.bot).length : 0);

// Options: guildSettings, forcedLanguage, logger, music (music/player.js;
// made here when left out, so the commands can be listed without one).
export function createMusicCommands({ guildSettings, forcedLanguage, logger, music }) {
  let made = music ?? null;
  const player = () => (made ??= createMusic({ guildSettings, logger, forcedLanguage }));

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

  // Why this member can't control the player, as [key, values], or null.
  // `own`: the song involved is one they added.
  function refusal(interaction, active, { own = false } = {}) {
    if (!active) {
      return ["musicNothingPlaying", {}];
    }
    const member = interaction.member;
    const inChannel = member?.voice?.channelId === active.channelId;
    if (!inChannel && !isManager(interaction)) {
      return ["musicSameChannel", { channel: `<#${active.channelId}>` }];
    }
    const djRoleId = normalizeMusic(guildSettings.get(interaction.guildId, Setting.MUSIC)).djRoleId;
    const djExists = djRoleId && interaction.guild?.roles?.cache?.has(djRoleId);
    if (!djExists || own || isManager(interaction) || member?.roles?.cache?.has(djRoleId)) {
      return null;
    }
    if (inChannel && humansIn(active.voiceChannel) <= 1) {
      return null;
    }
    return ["musicDjOnly", { role: `<@&${djRoleId}>` }];
  }

  // Checks the member can start music here and joins their channel.
  // Returns { player } or { refused: [key, values] }.
  function joinCheck(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel || !VOICE_TYPES.includes(channel.type)) {
      return { refused: ["musicJoinVoice", {}] };
    }
    const active = player().get(interaction.guildId);
    if (active && active.channelId !== channel.id) {
      return { refused: ["musicSameChannel", { channel: `<#${active.channelId}>` }] };
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
  async function queueUp(interaction, load) {
    const { text, answer } = replier(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const check = joinCheck(interaction);
    if (check.refused) {
      return answer(Status.REFUSED, ...check.refused);
    }
    const next = interaction.options.getBoolean?.("next") ?? false;
    if (next && check.active) {
      const refused = refusal(interaction, check.active);
      if (refused) {
        return answer(Status.REFUSED, ...refused);
      }
    }
    const settings = normalizeMusic(guildSettings.get(interaction.guildId, Setting.MUSIC));
    const room = settings.maxQueue - (check.active?.queue.length ?? 0);
    if (room <= 0) {
      return answer(Status.REFUSED, "musicQueueFull", { max: settings.maxQueue });
    }
    await interaction.deferReply();
    let found;
    try {
      found = await load(Math.min(MAX_PLAYLIST, room));
    } catch (error) {
      if (error instanceof MusicError) {
        return answer(Status.FAILED, errorKey(error));
      }
      throw error;
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
    const added = active.add(found.tracks, { next, requestedBy: interaction.user.id });
    const extra = [found.skipped > 0 ? text("musicSkippedNotFree", { count: found.skipped }) : null, added < found.tracks.length ? text("musicQueueCut", { max: settings.maxQueue }) : null]
      .filter(Boolean)
      .join(" ");
    const first = found.tracks[0];
    const values = {
      title: trackLabel(first),
      count: added,
      name: found.name ?? trackLabel(first),
      position: next ? 1 : waiting + 1,
      extra,
    };
    if (added > 1 || found.name) {
      return answer(Status.SUCCESS, "musicAddedMany", values);
    }
    return answer(Status.SUCCESS, wasPlaying ? "musicAddedOne" : "musicPlayingNow", values);
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
    const saved = normalizeMusic(guildSettings.get(interaction.guildId, Setting.MUSIC));
    const options = interaction.options;
    const djRole = options.getRole("dj-role");
    const changes = {
      ...(djRole ? { djRoleId: djRole.id } : {}),
      ...(options.getBoolean("no-dj-role") ? { djRoleId: null } : {}),
      ...(options.getInteger("volume") !== null ? { defaultVolume: options.getInteger("volume") } : {}),
      ...(options.getInteger("queue-size") !== null ? { maxQueue: options.getInteger("queue-size") } : {}),
      ...(options.getBoolean("announce") !== null ? { announce: options.getBoolean("announce") } : {}),
      ...(options.getInteger("leave-after") !== null ? { leaveAfterMinutes: options.getInteger("leave-after") } : {}),
    };
    const show = (config, key) =>
      answer(Status.SUCCESS, key, {
        dj: config.djRoleId ? `<@&${config.djRoleId}>` : text("musicNoDj"),
        volume: config.defaultVolume,
        queue: config.maxQueue,
        announce: text(config.announce ? "musicOn" : "musicOff"),
        leave: config.leaveAfterMinutes,
      });
    if (Object.keys(changes).length === 0) {
      return show(saved, "musicSettingsShow");
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
    return show(normalizeMusic(value), "musicSettingsSaved");
  }

  async function musicCommand(interaction) {
    const reply = replier(interaction);
    const { answer } = reply;
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "settings") {
      return settingsCommand(interaction, reply);
    }
    const active = player().get(interaction.guildId);
    if (sub === "queue") {
      if (!active) {
        return answer(Status.REFUSED, "musicNothingPlaying");
      }
      await interaction.reply({ ...queueMessage(active.state(), { language: reply.language, guildSettings, page: interaction.options.getInteger("page") ?? 1 }), flags: MessageFlags.Ephemeral });
      return result(Status.SUCCESS, "musicQueueTitle");
    }
    if (sub === "now") {
      if (!active?.current) {
        return answer(Status.REFUSED, "musicNothingPlaying");
      }
      await interaction.reply({ ...active.nowPlaying(), flags: MessageFlags.Ephemeral });
      return result(Status.SUCCESS, "musicNowPlayingTitle");
    }

    const position = interaction.options.getInteger("position");
    const own = (sub === "skip" && active?.current?.requestedBy === interaction.user.id) || (sub === "remove" && active?.queue[position - 1]?.requestedBy === interaction.user.id);
    const refused = refusal(interaction, active, { own });
    if (refused) {
      return answer(Status.REFUSED, ...refused);
    }
    const user = `<@${interaction.user.id}>`;
    const publicly = { publicly: true };
    switch (sub) {
      case "skip": {
        const title = active.current ? trackLabel(active.current) : null;
        return active.skip() ? answer(Status.SUCCESS, "musicSkipped", { title, user }, publicly) : answer(Status.REFUSED, "musicNothingPlaying");
      }
      case "stop":
        active.destroy();
        return answer(Status.SUCCESS, "musicStopped", { user }, publicly);
      case "pause":
        return active.pause() ? answer(Status.SUCCESS, "musicPausedBy", { user }, publicly) : answer(Status.REFUSED, "musicAlreadyPaused");
      case "resume":
        return active.resume() ? answer(Status.SUCCESS, "musicResumedBy", { user }, publicly) : answer(Status.REFUSED, "musicNotPaused");
      case "loop": {
        const mode = interaction.options.getString("mode", true);
        active.setLoop(mode);
        return answer(Status.SUCCESS, "musicLoopSet", { mode: reply.text(`musicLoop_${mode}`), user }, publicly);
      }
      case "shuffle":
        if (active.queue.length < 2) {
          return answer(Status.REFUSED, "musicNothingToShuffle");
        }
        active.shuffle();
        return answer(Status.SUCCESS, "musicShuffled", { count: active.queue.length, user }, publicly);
      case "volume": {
        const level = interaction.options.getInteger("level", true);
        active.setVolume(level);
        return answer(Status.SUCCESS, "musicVolumeSet", { volume: level, user }, publicly);
      }
      case "remove": {
        const removed = active.remove(position);
        return removed ? answer(Status.SUCCESS, "musicRemoved", { title: trackLabel(removed), user }, publicly) : answer(Status.REFUSED, "musicNoSuchPosition", { count: active.queue.length });
      }
      case "move": {
        const moved = active.move(interaction.options.getInteger("from", true), interaction.options.getInteger("to", true));
        return moved
          ? answer(Status.SUCCESS, "musicMoved", { title: trackLabel(moved), position: interaction.options.getInteger("to", true), user }, publicly)
          : answer(Status.REFUSED, "musicNoSuchPosition", { count: active.queue.length });
      }
      case "clear": {
        const count = active.clear();
        return answer(Status.SUCCESS, "musicCleared", { count, user }, publicly);
      }
    }
    return undefined;
  }

  // The buttons under "Now playing".
  async function button(interaction) {
    const { language, answer } = replier(interaction);
    const active = interaction.inCachedGuild() ? player().get(interaction.guildId) : null;
    if (!active?.current) {
      await interaction.update({ components: [] }).catch(() => {});
      return null;
    }
    if (interaction.customId === MusicButton.QUEUE) {
      await interaction.reply({ ...queueMessage(active.state(), { language, guildSettings }), flags: MessageFlags.Ephemeral });
      return null;
    }
    const own = interaction.customId === MusicButton.SKIP && active.current.requestedBy === interaction.user.id;
    const refused = refusal(interaction, active, { own });
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
      case MusicButton.SKIP: {
        const title = trackLabel(active.current);
        active.skip();
        return answer(Status.SUCCESS, "musicSkipped", { title, user }, { publicly: true });
      }
      case MusicButton.STOP:
        active.destroy();
        return answer(Status.SUCCESS, "musicStopped", { user }, { publicly: true });
    }
    return null;
  }

  const components = Object.fromEntries(
    [
      [MusicButton.TOGGLE, "Music: pause or resume"],
      [MusicButton.SKIP, "Music: skip"],
      [MusicButton.STOP, "Music: stop"],
      [MusicButton.LOOP, "Music: loop"],
      [MusicButton.QUEUE, "Music: queue"],
    ].map(([id, label]) => [id, { label, handle: button }]),
  );

  return [
    { name: "play", data: buildPlayCommandData(), execute: play, components },
    { name: "radio", data: buildRadioCommandData(), execute: radioCommand, autocomplete: radioAutocomplete },
    { name: "music", data: buildMusicCommandData(), execute: musicCommand },
  ];
}
