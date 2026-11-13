// A song (or radio station) in a queue. Tracks are plain objects:
//
//   id          random, so each queued copy of a song is told apart
//   title, artist, url (the page to link to), artworkUrl, durationMs (null when unknown)
//   source      where the audio comes from (Source); null until a Spotify,
//               Apple Music or Deezer song is matched to a free copy
//   via         the service a link was read from (Via), or null
//   live        a radio station or live stream: no length, never ends on its own
//   stream      what the source needs to open the audio when the song starts
//               (SoundCloud: { id }, Bandcamp: { page, trackId }, others: { url })
//   lookup      for songs from Spotify, Apple Music and Deezer: { title, artist,
//               durationMs }, matched on SoundCloud just before the song plays
//   requestedBy the member's user ID

import { randomBytes } from "node:crypto";

export const Source = Object.freeze({
  SOUNDCLOUD: "soundcloud",
  BANDCAMP: "bandcamp",
  AUDIUS: "audius",
  JAMENDO: "jamendo",
  RADIO: "radio",
  LINK: "link",
  FILE: "file",
});

export const Via = Object.freeze({
  SPOTIFY: "spotify",
  APPLE: "apple",
  DEEZER: "deezer",
});

// Display names, the same in every language.
export const SOURCE_NAMES = Object.freeze({
  soundcloud: "SoundCloud",
  bandcamp: "Bandcamp",
  audius: "Audius",
  jamendo: "Jamendo",
  radio: "Radio",
  link: "Link",
  file: "File",
  spotify: "Spotify",
  apple: "Apple Music",
  deezer: "Deezer",
});

const MAX_TITLE = 200;
const MAX_ARTIST = 100;

const clean = (text, max) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
const httpsOnly = (link) => (typeof link === "string" && /^https:\/\/\S+$/.test(link) && link.length <= 1000 ? link : null);

export function makeTrack({ title, artist = "", url = null, artworkUrl = null, durationMs = null, source = null, via = null, live = false, stream = null, lookup = null }) {
  return {
    id: randomBytes(4).toString("hex"),
    title: clean(title, MAX_TITLE) || "Untitled",
    artist: clean(artist, MAX_ARTIST),
    url: httpsOnly(url) ?? (typeof url === "string" && /^http:\/\/\S+$/.test(url) ? url.slice(0, 1000) : null),
    artworkUrl: httpsOnly(artworkUrl),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
    source,
    via,
    live: Boolean(live),
    stream,
    lookup,
    requestedBy: null,
  };
}

// 3:05, 1:02:03, or "LIVE" for radio.
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "?:??";
  }
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// "Artist - Title", for lists.
export const trackLabel = (track) => (track.artist && !track.title.toLowerCase().includes(track.artist.toLowerCase()) ? `${track.artist} - ${track.title}` : track.title);
