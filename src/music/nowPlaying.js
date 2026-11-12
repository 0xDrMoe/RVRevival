// The "Now playing" message, its buttons and the queue list.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { accentColor } from "../branding/branding.js";
import { translate } from "../i18n/i18n.js";
import { formatTime, SOURCE_NAMES, trackLabel } from "./track.js";

export const MUSIC_COLOR = 0xff5ec4;
export const QUEUE_PAGE_SIZE = 10;

export const MusicButton = Object.freeze({
  TOGGLE: "music:toggle",
  SKIP: "music:skip",
  STOP: "music:stop",
  LOOP: "music:loop",
  QUEUE: "music:queue",
});

export const LOOP_MODES = ["off", "track", "queue"];

// "SoundCloud", or "Spotify → SoundCloud" for a matched song.
export const sourceLabel = (track) => (track.via ? `${SOURCE_NAMES[track.via]} → ${SOURCE_NAMES[track.source] ?? "?"}` : (SOURCE_NAMES[track.source] ?? "?"));

const linked = (track) => {
  const label = trackLabel(track).replace(/[[\]]/g, "");
  return track.url ? `[${label}](<${track.url}>)` : label;
};

// One line of the queue: "3. [Artist - Title](link) · 3:05 · <@user>".
export const queueLine = (track, position) =>
  `${position}. ${linked(track)} · ${track.live ? "LIVE" : formatTime(track.durationMs ?? NaN)}${track.requestedBy ? ` · <@${track.requestedBy}>` : ""}`;

// The message's embed and buttons. `state` is player.state().
export function nowPlayingMessage(state, { language, guildSettings }) {
  const text = (key, values) => translate(language, key, values);
  const track = state.current;
  const embed = new EmbedBuilder()
    .setColor(accentColor(guildSettings, state.guildId, MUSIC_COLOR))
    .setAuthor({ name: text(state.paused ? "musicPausedTitle" : "musicNowPlayingTitle") })
    .setTitle(track.title.slice(0, 256))
    .setDescription(track.artist || null)
    .addFields(
      { name: text("musicLength"), value: track.live ? "🔴 LIVE" : `${formatTime(state.positionMs)} / ${formatTime(track.durationMs ?? NaN)}`, inline: true },
      { name: text("musicSource"), value: sourceLabel(track), inline: true },
      { name: text("musicRequestedBy"), value: track.requestedBy ? `<@${track.requestedBy}>` : "-", inline: true },
    )
    .setFooter({ text: text("musicFooter", { volume: state.volume, loop: text(`musicLoop_${state.loop}`), count: state.queue.length }) });
  if (track.url) {
    embed.setURL(track.url);
  }
  if (track.artworkUrl) {
    embed.setThumbnail(track.artworkUrl);
  }
  return { embeds: [embed], components: [controls(state, language)], allowedMentions: { parse: [] } };
}

export function controls(state, language) {
  const text = (key) => translate(language, key);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(MusicButton.TOGGLE).setStyle(ButtonStyle.Secondary).setEmoji(state.paused ? "▶️" : "⏸️").setLabel(text(state.paused ? "musicButtonResume" : "musicButtonPause")),
    new ButtonBuilder().setCustomId(MusicButton.SKIP).setStyle(ButtonStyle.Secondary).setEmoji("⏭️").setLabel(text("musicButtonSkip")),
    new ButtonBuilder().setCustomId(MusicButton.STOP).setStyle(ButtonStyle.Danger).setEmoji("⏹️").setLabel(text("musicButtonStop")),
    new ButtonBuilder().setCustomId(MusicButton.LOOP).setStyle(state.loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji(state.loop === "track" ? "🔂" : "🔁").setLabel(text(`musicLoop_${state.loop}`)),
    new ButtonBuilder().setCustomId(MusicButton.QUEUE).setStyle(ButtonStyle.Secondary).setEmoji("📜").setLabel(text("musicButtonQueue")),
  );
}

// The queue, one page: the song playing and up to 10 waiting.
export function queueMessage(state, { language, guildSettings, page = 1 }) {
  const text = (key, values) => translate(language, key, values);
  const pages = Math.max(1, Math.ceil(state.queue.length / QUEUE_PAGE_SIZE));
  const shown = Math.min(Math.max(1, page), pages);
  const start = (shown - 1) * QUEUE_PAGE_SIZE;
  const lines = state.queue.slice(start, start + QUEUE_PAGE_SIZE).map((track, index) => queueLine(track, start + index + 1));
  const total = state.queue.reduce((sum, track) => sum + (track.durationMs ?? 0), 0);
  const embed = new EmbedBuilder()
    .setColor(accentColor(guildSettings, state.guildId, MUSIC_COLOR))
    .setTitle(text("musicQueueTitle"))
    .setDescription(
      [
        state.current ? `**${text("musicNowPlayingTitle")}:** ${queueLine(state.current, "▶").slice(3)}` : text("musicNothingPlaying"),
        "",
        lines.length > 0 ? lines.join("\n") : text("musicQueueEmpty"),
      ]
        .join("\n")
        .slice(0, 4000),
    )
    .setFooter({ text: text("musicQueueFooter", { count: state.queue.length, length: formatTime(total), page: shown, pages, loop: text(`musicLoop_${state.loop}`) }) });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}
