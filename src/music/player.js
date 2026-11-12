// Music players: one per server that's playing, each with its voice
// connection, queue and "Now playing" message. Nothing is saved: a restart
// ends every session.
//
// Voice uses @discordjs/voice, which speaks Discord's end-to-end encrypted
// voice (DAVE, required since March 2026). See music/stream.js for the audio.
//
// The bot leaves when the queue is done or nobody is listening, after the
// server's leaveAfterMinutes (music/config.js). While nobody is listening the
// song pauses, and carries on if someone comes back first.
//
// MUSIC_MAX_PLAYERS caps how many servers can play at once (25 by default),
// so a small VPS isn't overrun.

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { ChannelType } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { derivedSetting, Setting } from "../settings/guildSettings.js";
import { canPost, deleteMessage } from "../utils/rateLimits.js";
import { normalizeMusic } from "./config.js";
import { MusicError } from "./net.js";
import { nowPlayingMessage } from "./nowPlaying.js";
import { createRadio } from "./radio.js";
import { createResolver } from "./sources.js";
import { openAudio as defaultOpenAudio } from "./stream.js";

const JOIN_TIMEOUT_MS = 20_000;
const RECONNECT_MS = 5_000;
// A song that ends this soon after starting failed (a broken link, say).
const FAILED_WITHIN_MS = 1_500;
const MAX_FAILURES_IN_A_ROW = 5;
export const DEFAULT_MAX_PLAYERS = 25;

// The voice functions, swappable in tests.
export const discordVoice = { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState };

const humansIn = (channel) => (channel?.members ? [...channel.members.values()].filter((member) => !member.user?.bot).length : 0);

// Options: guildSettings, logger, forcedLanguage; resolver, radio, voice,
// openAudio, maxPlayers and setTimer/clearTimer for tests.
export function createMusic({
  guildSettings,
  logger,
  forcedLanguage,
  resolver = createResolver(),
  radio = createRadio(),
  voice = discordVoice,
  openAudio = defaultOpenAudio,
  maxPlayers = Number(process.env.MUSIC_MAX_PLAYERS) || DEFAULT_MAX_PLAYERS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const players = new Map();
  const settingsFor = (guildId) => derivedSetting(guildSettings, guildId, Setting.MUSIC, normalizeMusic);

  class GuildPlayer {
    queue = [];
    current = null;
    loop = "off";
    paused = false;
    // Paused because nobody was listening (resumes when someone comes back).
    autoPaused = false;
    failures = 0;
    #audio = null;
    #resource = null;
    #nowPlaying = null;
    #leaveTimer = null;
    #chain = Promise.resolve();
    #skipping = false;
    #destroyed = false;
    #startedAt = 0;

    constructor({ guild, channel, textChannel }) {
      this.guild = guild;
      this.guildId = guild.id;
      this.channelId = channel.id;
      this.textChannel = textChannel ?? null;
      this.volume = settingsFor(guild.id).defaultVolume;
      this.audioPlayer = voice.createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      this.audioPlayer.on("error", (error) => logger.warn("A song stopped with an error", { guildId: this.guildId, error: error?.message }));
      this.audioPlayer.on("stateChange", (before, after) => {
        if (before.status !== AudioPlayerStatus.Idle && after.status === AudioPlayerStatus.Idle) {
          this.#serial(() => this.#finished(before.resource));
        }
      });
    }

    get language() {
      return pickLanguage(this.guild.preferredLocale, forcedLanguage);
    }

    get settings() {
      return settingsFor(this.guildId);
    }

    get voiceChannel() {
      return this.guild.channels.cache.get(this.channelId) ?? null;
    }

    get destroyed() {
      return this.#destroyed;
    }

    // What the commands and the "Now playing" message show.
    state() {
      return {
        guildId: this.guildId,
        channelId: this.channelId,
        current: this.current,
        queue: this.queue,
        loop: this.loop,
        paused: this.paused,
        volume: this.volume,
        positionMs: this.#resource?.playbackDuration ?? 0,
      };
    }

    // Runs player changes one at a time, so a skip and a song ending can't both start the next song.
    #serial(task) {
      this.#chain = this.#chain.then(task).catch((error) => logger.error("The music player crashed", { guildId: this.guildId, error }));
      return this.#chain;
    }

    async connect() {
      const channel = this.voiceChannel;
      this.connection = voice.joinVoiceChannel({ channelId: this.channelId, guildId: this.guildId, adapterCreator: this.guild.voiceAdapterCreator, selfDeaf: true });
      this.connection.on("stateChange", (before, after) => {
        if (after.status === VoiceConnectionStatus.Disconnected) {
          // Moved by someone (it reconnects on its own) or kicked from the channel.
          Promise.race([
            voice.entersState(this.connection, VoiceConnectionStatus.Signalling, RECONNECT_MS),
            voice.entersState(this.connection, VoiceConnectionStatus.Connecting, RECONNECT_MS),
          ]).catch(() => this.destroy());
        } else if (after.status === VoiceConnectionStatus.Destroyed) {
          this.destroy();
        }
      });
      this.connection.subscribe(this.audioPlayer);
      try {
        await voice.entersState(this.connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
      } catch {
        this.destroy();
        throw new MusicError("cant-join", "Couldn't connect to the voice channel.");
      }
      // A Stage: the bot asks to speak (it becomes a speaker with Mute Members, else it requests to).
      if (channel?.type === ChannelType.GuildStageVoice) {
        await this.guild.members.me?.voice?.setSuppressed(false).catch(() => this.guild.members.me?.voice?.setRequestToSpeak?.(true).catch(() => {}));
      }
    }

    // Adds tracks (to the end, or next). Starts playing if nothing is.
    // Returns how many were added (the queue has a size limit).
    add(tracks, { next = false, requestedBy }) {
      const room = Math.max(0, this.settings.maxQueue - this.queue.length);
      const added = tracks.slice(0, room).map((track) => ({ ...track, requestedBy }));
      if (next) {
        this.queue.unshift(...added);
      } else {
        this.queue.push(...added);
      }
      if (added.length > 0 && !this.current) {
        this.#cancelLeave();
        this.#serial(() => this.#playNext());
      } else if (added.length > 0) {
        this.#refreshNowPlaying();
      }
      return added.length;
    }

    async #playNext() {
      if (this.#destroyed) {
        return;
      }
      const previous = this.current;
      let next;
      if (previous && this.loop === "track" && !this.#skipping) {
        next = previous;
      } else {
        if (previous && this.loop === "queue") {
          this.queue.push(previous);
        }
        next = this.queue.shift() ?? null;
      }
      this.#skipping = false;
      this.current = next;
      this.paused = false;
      if (!next) {
        await this.#clearNowPlaying();
        this.#scheduleLeave("done");
        return;
      }
      this.#cancelLeave();
      // A skip while a song was still loading: the old audio can't be left running.
      this.#audio?.stop();
      this.#audio = null;
      this.#resource = null;
      try {
        const ready = await resolver.ready(next);
        if (this.#destroyed || this.current !== next) {
          return;
        }
        this.current = { ...ready, id: next.id, requestedBy: next.requestedBy };
        this.#audio = await openAudio(this.current, { soundcloud: resolver.soundcloud, bandcamp: resolver.bandcamp, logger });
        if (this.#destroyed) {
          this.#audio.stop();
          return;
        }
        this.#resource = voice.createAudioResource(this.#audio.stream, { inputType: StreamType.Raw, inlineVolume: true, metadata: this.current });
        this.#resource.volume?.setVolume(this.volume / 100);
        this.audioPlayer.play(this.#resource);
        this.#startedAt = Date.now();
        await this.#announce();
      } catch (error) {
        await this.#failed(next, error);
      }
    }

    async #finished(resource) {
      if (this.#destroyed || resource !== this.#resource) {
        return;
      }
      const audio = this.#audio;
      this.#audio = null;
      this.#resource = null;
      audio?.stop();
      const playedMs = resource?.playbackDuration ?? 0;
      if (!this.#skipping && this.current && playedMs < FAILED_WITHIN_MS && Date.now() - this.#startedAt < 30_000) {
        logger.warn("A song failed to play", { guildId: this.guildId, source: this.current.source, ffmpeg: audio?.errors?.join(" | ") });
        const failed = this.current;
        // Don't loop a song that can't play.
        if (this.loop === "track") {
          this.#skipping = true;
        }
        await this.#failed(failed, new MusicError("unreachable", "The audio stopped right away."), { alreadyCurrent: true });
        return;
      }
      this.failures = 0;
      await this.#playNext();
    }

    async #failed(track, error, { alreadyCurrent = false } = {}) {
      const reason = error instanceof MusicError ? error.reason : "unreachable";
      if (!(error instanceof MusicError)) {
        logger.warn("Couldn't start a song", { guildId: this.guildId, source: track.source, error });
      }
      this.failures += 1;
      await this.#say(translate(this.language, "musicSkippedBroken", { title: track.title, reason: translate(this.language, `musicError_${reason}`) }));
      if (this.failures >= MAX_FAILURES_IN_A_ROW) {
        await this.#say(translate(this.language, "musicTooManyFailures"));
        this.destroy();
        return;
      }
      if (alreadyCurrent || this.current === track || this.current?.id === track.id) {
        this.#skipping = true;
        await this.#playNext();
      }
    }

    // Posts a note in the channel /play was used in (when the bot may).
    async #say(content) {
      if (!this.textChannel || !canPost(this.textChannel)) {
        return null;
      }
      return this.textChannel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
    }

    async #announce() {
      await this.#clearNowPlaying();
      if (!this.settings.announce || !this.textChannel || !canPost(this.textChannel, { embeds: true })) {
        return;
      }
      this.#nowPlaying = await this.textChannel.send(this.nowPlaying()).catch((error) => {
        logger.warn("Couldn't post the now playing message", { guildId: this.guildId, error: error?.message });
        return null;
      });
    }

    nowPlaying() {
      return nowPlayingMessage(this.state(), { language: this.language, guildSettings });
    }

    // Brings the "Now playing" message up to date (pause, loop, queue size).
    #refreshNowPlaying() {
      if (this.#nowPlaying && this.current) {
        this.#nowPlaying.edit(this.nowPlaying()).catch(() => {
          this.#nowPlaying = null;
        });
      }
    }

    // Called when a button already updated the message itself.
    nowPlayingUpdated(message) {
      this.#nowPlaying = message ?? this.#nowPlaying;
    }

    async #clearNowPlaying() {
      const message = this.#nowPlaying;
      this.#nowPlaying = null;
      if (message) {
        await deleteMessage(message).catch(() => message.edit({ components: [] }).catch(() => {}));
      }
    }

    skip() {
      if (!this.current) {
        return false;
      }
      this.#skipping = true;
      if (this.#resource) {
        this.audioPlayer.stop(true);
      } else {
        this.#serial(() => this.#playNext());
      }
      return true;
    }

    pause() {
      if (!this.current || this.paused) {
        return false;
      }
      this.paused = this.audioPlayer.pause(true);
      this.autoPaused = false;
      this.#refreshNowPlaying();
      return this.paused;
    }

    resume() {
      if (!this.current || !this.paused) {
        return false;
      }
      this.paused = !this.audioPlayer.unpause();
      this.autoPaused = false;
      this.#refreshNowPlaying();
      return !this.paused;
    }

    setLoop(mode) {
      this.loop = mode;
      this.#refreshNowPlaying();
    }

    setVolume(percent) {
      this.volume = percent;
      this.#resource?.volume?.setVolume(percent / 100);
      this.#refreshNowPlaying();
    }

    shuffle() {
      for (let index = this.queue.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [this.queue[index], this.queue[other]] = [this.queue[other], this.queue[index]];
      }
      this.#refreshNowPlaying();
    }

    // Removes the song at a queue position (1 = next). Returns it, or null.
    remove(position) {
      const [removed] = position >= 1 && position <= this.queue.length ? this.queue.splice(position - 1, 1) : [];
      this.#refreshNowPlaying();
      return removed ?? null;
    }

    // Moves a song from one queue position to another. Returns it, or null.
    move(from, to) {
      if (from < 1 || from > this.queue.length || to < 1 || to > this.queue.length) {
        return null;
      }
      const [track] = this.queue.splice(from - 1, 1);
      this.queue.splice(to - 1, 0, track);
      return track;
    }

    clear() {
      const count = this.queue.length;
      this.queue = [];
      this.#refreshNowPlaying();
      return count;
    }

    // Someone joined or left the bot's channel.
    listenersChanged() {
      if (this.#destroyed) {
        return;
      }
      if (humansIn(this.voiceChannel) === 0) {
        if (this.current && !this.paused) {
          this.paused = this.audioPlayer.pause(true);
          this.autoPaused = this.paused;
          this.#refreshNowPlaying();
        }
        this.#scheduleLeave("empty");
      } else {
        if (this.autoPaused) {
          this.resume();
        }
        if (this.current) {
          this.#cancelLeave();
        }
      }
    }

    #scheduleLeave(reason) {
      this.#cancelLeave();
      const minutes = this.settings.leaveAfterMinutes;
      const leave = () => {
        if (this.settings.announce) {
          this.#say(translate(this.language, reason === "empty" ? "musicLeftEmpty" : "musicLeftDone", { channel: `<#${this.channelId}>` }));
        }
        this.destroy();
      };
      if (minutes === 0) {
        leave();
        return;
      }
      this.#leaveTimer = setTimer(leave, minutes * 60_000);
      this.#leaveTimer?.unref?.();
    }

    #cancelLeave() {
      if (this.#leaveTimer) {
        clearTimer(this.#leaveTimer);
        this.#leaveTimer = null;
      }
    }

    // Stops everything and leaves the channel.
    destroy() {
      if (this.#destroyed) {
        return;
      }
      this.#destroyed = true;
      this.#cancelLeave();
      this.queue = [];
      this.current = null;
      this.#audio?.stop();
      this.#audio = null;
      this.audioPlayer.stop(true);
      if (this.connection && this.connection.state?.status !== VoiceConnectionStatus.Destroyed) {
        try {
          this.connection.destroy();
        } catch {
          // Already gone.
        }
      }
      this.#clearNowPlaying();
      if (players.get(this.guildId) === this) {
        players.delete(this.guildId);
      }
    }
  }

  return {
    resolver,
    radio,

    get(guildId) {
      const player = players.get(guildId);
      return player && !player.destroyed ? player : null;
    },

    get count() {
      return players.size;
    },

    // The server's player, joining `channel` first if there's none.
    // Throws MusicError("busy") when too many servers are playing.
    async join({ guild, channel, textChannel }) {
      const existing = this.get(guild.id);
      if (existing) {
        if (textChannel) {
          existing.textChannel = textChannel;
        }
        return existing;
      }
      if (players.size >= maxPlayers) {
        throw new MusicError("busy", "Too many servers are playing music right now.");
      }
      const player = new GuildPlayer({ guild, channel, textChannel });
      players.set(guild.id, player);
      await player.connect();
      return player;
    },

    // Keeps players in step with their channel: the bot moved or kicked,
    // listeners coming and going.
    voiceStateUpdate(before, after) {
      const guildId = after?.guild?.id ?? before?.guild?.id;
      const player = guildId && this.get(guildId);
      if (!player) {
        return;
      }
      const botId = player.guild.members.me?.id ?? player.guild.client?.user?.id;
      if (after.id === botId) {
        if (!after.channelId) {
          player.destroy();
          return;
        }
        player.channelId = after.channelId;
        player.listenersChanged();
        return;
      }
      if (before.channelId === player.channelId || after.channelId === player.channelId) {
        player.listenersChanged();
      }
    },

    // A server removed the bot.
    guildDeleted(guildId) {
      this.get(guildId)?.destroy();
    },

    stopAll() {
      for (const player of [...players.values()]) {
        player.destroy();
      }
    },
  };
}
