// Members' saved playlists (/playlist), in data/bot.db, table music_playlists.
// A playlist belongs to the member and works on every server. Names are
// matched without caring about case.
//
// Each saved song keeps what's needed to play it again: the title, artist,
// link, length, source and stream. Uploaded files aren't saved (their links
// expire).

import { openDatabase } from "../storage/database.js";
import { makeTrack, Source, Via } from "./track.js";

export const MAX_PLAYLISTS = 25;
export const MAX_PLAYLIST_TRACKS = 200;
export const MAX_PLAYLIST_NAME = 50;

export class PlaylistError extends Error {
  name = "PlaylistError";
  // reason: exists | missing | too-many | full | bad-name
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
  }
}

// A playlist name as typed, tidied: spaces collapsed, at most 50 characters. Null when empty.
export function cleanPlaylistName(name) {
  const clean = String(name ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean && clean.length <= MAX_PLAYLIST_NAME ? clean : null;
}

const nameKey = (name) => name.toLocaleLowerCase("en");
const SOURCES = new Set(Object.values(Source));
const VIAS = new Set(Object.values(Via));
const scalar = (value) => (typeof value === "string" && value.length <= 1000) || Number.isFinite(value);

// Only the fields a stream uses, as strings or numbers.
function cleanStream(stream) {
  if (!stream || typeof stream !== "object") {
    return null;
  }
  const kept = Object.fromEntries(["id", "page", "trackId", "url"].filter((key) => scalar(stream[key])).map((key) => [key, stream[key]]));
  return Object.keys(kept).length > 0 ? kept : null;
}

// A queue track → what's saved, or null for one that can't be saved (an upload).
export function savedTrack(track) {
  if (!track || track.source === Source.FILE) {
    return null;
  }
  const lookup = track.lookup && typeof track.lookup === "object" ? { title: String(track.lookup.title ?? ""), artist: String(track.lookup.artist ?? ""), durationMs: Number(track.lookup.durationMs) || null } : null;
  const stream = cleanStream(track.stream);
  if (!stream && !lookup) {
    return null;
  }
  return {
    title: track.title,
    artist: track.artist ?? "",
    url: track.url ?? null,
    artworkUrl: track.artworkUrl ?? null,
    durationMs: track.durationMs ?? null,
    source: SOURCES.has(track.source) ? track.source : null,
    via: VIAS.has(track.via) ? track.via : null,
    live: Boolean(track.live),
    stream,
    lookup,
  };
}

// What's saved → a fresh queue track (a new ID each time).
function loadTrack(saved) {
  if (!saved || typeof saved !== "object") {
    return null;
  }
  const stream = cleanStream(saved.stream);
  const lookup = saved.lookup && typeof saved.lookup === "object" ? saved.lookup : null;
  const source = SOURCES.has(saved.source) && saved.source !== Source.FILE ? saved.source : null;
  if ((source && !stream) || (!source && !lookup)) {
    return null;
  }
  return makeTrack({ ...saved, source, via: VIAS.has(saved.via) ? saved.via : null, stream, lookup });
}

function parseTracks(json) {
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const toPlaylist = (row) =>
  row
    ? {
        userId: row.user_id,
        name: row.name,
        tracks: parseTracks(row.tracks).map(loadTrack).filter(Boolean),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

export class PlaylistStore {
  #db;
  #statements;

  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: this.#db.prepare("INSERT INTO music_playlists (user_id, name_key, name, tracks, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)"),
      get: this.#db.prepare("SELECT * FROM music_playlists WHERE user_id = ? AND name_key = ?"),
      list: this.#db.prepare("SELECT user_id, name, created_at, updated_at, json_array_length(tracks) AS size FROM music_playlists WHERE user_id = ? ORDER BY name_key"),
      count: this.#db.prepare("SELECT COUNT(*) AS total FROM music_playlists WHERE user_id = ?"),
      save: this.#db.prepare("UPDATE music_playlists SET tracks = ?, updated_at = ? WHERE user_id = ? AND name_key = ?"),
      rename: this.#db.prepare("UPDATE music_playlists SET name = ?, name_key = ?, updated_at = ? WHERE user_id = ? AND name_key = ?"),
      delete: this.#db.prepare("DELETE FROM music_playlists WHERE user_id = ? AND name_key = ? RETURNING name"),
      deleteUser: this.#db.prepare("DELETE FROM music_playlists WHERE user_id = ?"),
    };
  }

  // The member's playlists, by name: [{ name, size, updatedAt }].
  list(userId) {
    return this.#statements.list.all(userId).map((row) => ({ name: row.name, size: Number(row.size), updatedAt: row.updated_at }));
  }

  // { userId, name, tracks, createdAt, updatedAt }, or null.
  get(userId, name) {
    const clean = cleanPlaylistName(name);
    return clean ? toPlaylist(this.#statements.get.get(userId, nameKey(clean))) : null;
  }

  create(userId, name, now = Date.now()) {
    const clean = cleanPlaylistName(name);
    if (!clean) {
      throw new PlaylistError("bad-name");
    }
    if (this.get(userId, clean)) {
      throw new PlaylistError("exists");
    }
    if (Number(this.#statements.count.get(userId).total) >= MAX_PLAYLISTS) {
      throw new PlaylistError("too-many");
    }
    this.#statements.insert.run(userId, nameKey(clean), clean, now, now);
    return this.get(userId, clean);
  }

  // The removed playlist's name, or null.
  delete(userId, name) {
    const clean = cleanPlaylistName(name);
    return clean ? (this.#statements.delete.get(userId, nameKey(clean))?.name ?? null) : null;
  }

  rename(userId, name, newName, now = Date.now()) {
    const playlist = this.get(userId, name);
    const clean = cleanPlaylistName(newName);
    if (!playlist) {
      throw new PlaylistError("missing");
    }
    if (!clean) {
      throw new PlaylistError("bad-name");
    }
    if (nameKey(clean) !== nameKey(playlist.name) && this.get(userId, clean)) {
      throw new PlaylistError("exists");
    }
    this.#statements.rename.run(clean, nameKey(clean), now, userId, nameKey(playlist.name));
    return clean;
  }

  // Adds songs to the end. Returns { added, skipped }: songs that can't be
  // saved (uploads) are skipped, and the playlist stops at 200.
  add(userId, name, tracks, now = Date.now()) {
    const playlist = this.get(userId, name);
    if (!playlist) {
      throw new PlaylistError("missing");
    }
    const saved = playlist.tracks.map(savedTrack).filter(Boolean);
    const room = MAX_PLAYLIST_TRACKS - saved.length;
    if (room <= 0) {
      throw new PlaylistError("full");
    }
    const fresh = tracks.map(savedTrack).filter(Boolean);
    const added = fresh.slice(0, room);
    this.#statements.save.run(JSON.stringify([...saved, ...added]), now, userId, nameKey(playlist.name));
    return { added: added.length, skipped: tracks.length - added.length };
  }

  // Removes the song at a position (1 = first). Returns it, or null.
  remove(userId, name, position, now = Date.now()) {
    const playlist = this.get(userId, name);
    if (!playlist) {
      throw new PlaylistError("missing");
    }
    if (!Number.isInteger(position) || position < 1 || position > playlist.tracks.length) {
      return null;
    }
    const [removed] = playlist.tracks.splice(position - 1, 1);
    this.#statements.save.run(JSON.stringify(playlist.tracks.map(savedTrack).filter(Boolean)), now, userId, nameKey(playlist.name));
    return removed;
  }

  // Everything a member saved (for a data deletion request).
  deleteUser(userId) {
    return Number(this.#statements.deleteUser.run(userId).changes);
  }
}
