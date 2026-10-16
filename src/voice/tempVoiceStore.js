// Remembers the voice channels the bot made for join-to-create (/voice), so
// they can be deleted when they empty, even after a restart.

import { openDatabase } from "../storage/database.js";

const toChannel = (row) =>
  row ? { channelId: row.channel_id, guildId: row.guild_id, ownerId: row.owner_id, createdAt: Number(row.created_at) } : undefined;

export class TempVoiceStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      add: db.prepare("INSERT OR REPLACE INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)"),
      get: db.prepare("SELECT * FROM temp_voice_channels WHERE channel_id = ?"),
      byOwner: db.prepare("SELECT * FROM temp_voice_channels WHERE guild_id = ? AND owner_id = ?"),
      setOwner: db.prepare("UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?"),
      remove: db.prepare("DELETE FROM temp_voice_channels WHERE channel_id = ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM temp_voice_channels WHERE guild_id = ?"),
      all: db.prepare("SELECT * FROM temp_voice_channels"),
    };
  }

  add({ channelId, guildId, ownerId, createdAt = Date.now() }) {
    this.#statements.add.run(channelId, guildId, ownerId, createdAt);
  }

  get(channelId) {
    return toChannel(this.#statements.get.get(channelId));
  }

  // The channels a member owns in a server (normally one).
  byOwner(guildId, ownerId) {
    return this.#statements.byOwner.all(guildId, ownerId).map(toChannel);
  }

  setOwner(channelId, ownerId) {
    this.#statements.setOwner.run(ownerId, channelId);
  }

  remove(channelId) {
    return this.#statements.remove.run(channelId).changes > 0;
  }

  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }

  all() {
    return this.#statements.all.all().map(toChannel);
  }
}
