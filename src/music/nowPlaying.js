// The "Now playing" message, its buttons and the queue list.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
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
  BACK: "music:back",
  SHUFFLE: "music:shuffle",
});

// Queue pages: "mqueue:<page>". Search results: "msearch:<session>:<pick | cancel>".
export const QUEUE_PAGE_PREFIX = "mqueue:";
export const SEARCH_PREFIX = "msearch:";
export const SEARCH_RESULTS = 5;

export const LOOP_MODES = ["off", "track", "queue"];

// "SoundCloud", or "Spotify → SoundCloud" for a matched song.
export const sourceLabel = (track) => (track.via ? `${SOURCE_NAMES[track.via]} → ${SOURCE_NAMES[track.source] ?? "?"}` : (SOURCE_NAMES[track.source] ?? "?"));

const linked = (track) => {
  const label = trackLabel(track).replace(/[[\]]/g, "");
  return track.url ? `[${label}](<${track.url}>)` : label;
};

// "▬▬▬▬🔘▬▬▬▬▬▬▬▬▬▬" for how far the song is, or null without a length.
export function progressBar(positionMs, durationMs, size = 16) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(positionMs)) {
    return null;
  }
  const at = Math.min(size - 1, Math.max(0, Math.floor((positionMs / durationMs) * size)));
  return `${"▬".repeat(at)}🔘${"▬".repeat(size - 1 - at)}`;
}

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
    .setDescription([track.artist, track.live ? null : progressBar(state.positionMs, track.durationMs)].filter(Boolean).join("\n\n") || null)
    .addFields(
      { name: text("musicLength"), value: track.live ? "🔴 LIVE" : `${formatTime(state.positionMs)} / ${formatTime(track.durationMs ?? NaN)}`, inline: true },
      { name: text("musicSource"), value: sourceLabel(track), inline: true },
      { name: text("musicRequestedBy"), value: track.requestedBy ? `<@${track.requestedBy}>` : track.autoplay ? text("musicAutoplayName") : "-", inline: true },
    )
    .setFooter({ text: `${text("musicFooter", { volume: state.volume, loop: text(`musicLoop_${state.loop}`), count: state.queue.length })}${state.autoplay ? ` · ${text("musicAutoplayName")}` : ""}${state.filter && state.filter !== "off" ? ` · 🎚️ ${text(`musicFilter_${state.filter}`)}` : ""}` });
  if (track.url) {
    embed.setURL(track.url);
  }
  if (track.artworkUrl) {
    embed.setThumbnail(track.artworkUrl);
  }
  return { embeds: [embed], components: controls(state, language), allowedMentions: { parse: [] } };
}

export function controls(state, language) {
  const text = (key) => translate(language, key);
  const main = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(MusicButton.TOGGLE).setStyle(ButtonStyle.Secondary).setEmoji(state.paused ? "▶️" : "⏸️").setLabel(text(state.paused ? "musicButtonResume" : "musicButtonPause")),
    new ButtonBuilder().setCustomId(MusicButton.SKIP).setStyle(ButtonStyle.Secondary).setEmoji("⏭️").setLabel(text("musicButtonSkip")),
    new ButtonBuilder().setCustomId(MusicButton.STOP).setStyle(ButtonStyle.Danger).setEmoji("⏹️").setLabel(text("musicButtonStop")),
    new ButtonBuilder().setCustomId(MusicButton.LOOP).setStyle(state.loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji(state.loop === "track" ? "🔂" : "🔁").setLabel(text(`musicLoop_${state.loop}`)),
    new ButtonBuilder().setCustomId(MusicButton.QUEUE).setStyle(ButtonStyle.Secondary).setEmoji("📜").setLabel(text("musicButtonQueue")),
  );
  const more = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(MusicButton.BACK).setStyle(ButtonStyle.Secondary).setEmoji("⏮️").setLabel(text("musicButtonBack")).setDisabled((state.history?.length ?? 0) === 0),
    new ButtonBuilder().setCustomId(MusicButton.SHUFFLE).setStyle(ButtonStyle.Secondary).setEmoji("🔀").setLabel(text("musicButtonShuffle")).setDisabled(state.queue.length < 2),
  );
  return [main, more];
}

// The queue, one page: the song playing and up to 10 waiting, with buttons
// to turn the page when there's more than one.
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
  const components =
    pages > 1
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${QUEUE_PAGE_PREFIX}${shown - 1}`).setStyle(ButtonStyle.Secondary).setEmoji("◀️").setDisabled(shown <= 1),
            new ButtonBuilder().setCustomId(`${QUEUE_PAGE_PREFIX}${shown + 1}`).setStyle(ButtonStyle.Secondary).setEmoji("▶️").setDisabled(shown >= pages),
          ),
        ]
      : [];
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

// Search results to pick from: a numbered list, a menu, a button per result and Cancel.
export function searchMessage(tracks, { language, guildSettings, guildId, query, session }) {
  const text = (key, values) => translate(language, key, values);
  const length = (track) => (track.live ? "LIVE" : formatTime(track.durationMs ?? NaN));
  const embed = new EmbedBuilder()
    .setColor(accentColor(guildSettings, guildId, MUSIC_COLOR))
    .setTitle(text("musicSearchTitle", { query: query.slice(0, 200) }))
    .setDescription(tracks.map((track, index) => `**${index + 1}.** ${linked(track)} · ${length(track)} · ${SOURCE_NAMES[track.source] ?? "?"}`).join("\n").slice(0, 4000))
    .setFooter({ text: text("musicSearchFooter") });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SEARCH_PREFIX}${session}:menu`)
    .setPlaceholder(text("musicSearchPlaceholder"))
    .addOptions(
      tracks.map((track, index) => ({
        label: `${index + 1}. ${track.title}`.slice(0, 100),
        description: `${track.artist ? `${track.artist} · ` : ""}${length(track)} · ${SOURCE_NAMES[track.source] ?? "?"}`.slice(0, 100),
        value: String(index),
      })),
    );
  const numbers = new ActionRowBuilder().addComponents(
    ...tracks.map((track, index) => new ButtonBuilder().setCustomId(`${SEARCH_PREFIX}${session}:${index}`).setStyle(ButtonStyle.Primary).setLabel(String(index + 1))),
  );
  const cancel = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${SEARCH_PREFIX}${session}:cancel`).setStyle(ButtonStyle.Secondary).setLabel(text("musicSearchCancel")));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), numbers, cancel], allowedMentions: { parse: [] } };
}

// A song's lyrics: the first 4000 characters, with a link to the rest.
export function lyricsMessage(found, { language, guildSettings, guildId }) {
  const text = (key, values) => translate(language, key, values);
  const body = found.instrumental && !found.lyrics ? text("musicLyricsInstrumental") : found.lyrics;
  const cut = body.length > 4000 ? `${body.slice(0, 3990).replace(/\n[^\n]*$/, "")}\n…` : body;
  const embed = new EmbedBuilder()
    .setColor(accentColor(guildSettings, guildId, MUSIC_COLOR))
    .setAuthor({ name: text("musicLyricsTitle") })
    .setTitle(`${found.artist ? `${found.artist} - ` : ""}${found.title}`.slice(0, 256))
    .setDescription(cut)
    .setFooter({ text: text("musicLyricsFooter") });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

// The song playing, sent to a member's DMs (/music grab).
export function grabMessage(track, { language, guildName, positionMs }) {
  const text = (key, values) => translate(language, key, values);
  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setAuthor({ name: text("musicGrabTitle", { server: guildName }) })
    .setTitle(track.title.slice(0, 256))
    .setDescription(track.artist || null)
    .addFields(
      { name: text("musicLength"), value: track.live ? "🔴 LIVE" : formatTime(track.durationMs ?? NaN), inline: true },
      { name: text("musicSource"), value: sourceLabel(track), inline: true },
      ...(track.live || !positionMs ? [] : [{ name: text("musicGrabAt"), value: formatTime(positionMs), inline: true }]),
    );
  if (track.url) {
    embed.setURL(track.url);
  }
  if (track.artworkUrl) {
    embed.setThumbnail(track.artworkUrl);
  }
  return { embeds: [embed] };
}

// One page of a saved playlist (/playlist show).
export function playlistMessage(playlist, { language, page = 1 }) {
  const text = (key, values) => translate(language, key, values);
  const pages = Math.max(1, Math.ceil(playlist.tracks.length / QUEUE_PAGE_SIZE));
  const shown = Math.min(Math.max(1, page), pages);
  const start = (shown - 1) * QUEUE_PAGE_SIZE;
  const lines = playlist.tracks.slice(start, start + QUEUE_PAGE_SIZE).map((track, index) => queueLine({ ...track, requestedBy: null }, start + index + 1));
  const total = playlist.tracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0);
  const embed = new EmbedBuilder()
    .setColor(MUSIC_COLOR)
    .setTitle(text("musicPlaylistTitle", { name: playlist.name }).slice(0, 256))
    .setDescription((lines.length > 0 ? lines.join("\n") : text("musicPlaylistEmpty")).slice(0, 4000))
    .setFooter({ text: text("musicPlaylistFooter", { count: playlist.tracks.length, length: formatTime(total), page: shown, pages }) });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}
