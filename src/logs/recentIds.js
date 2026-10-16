// Remembers IDs for a short while. Used for messages the bot deletes itself
// (the /country channel, /purge), so the server log doesn't report them twice.

export class RecentIds {
  #expiresAt = new Map();
  #ttlMs;
  #now;

  constructor({ ttlMs = 60_000, now = Date.now } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  add(...ids) {
    const expiresAt = this.#now() + this.#ttlMs;
    for (const id of ids.flat()) {
      // Re-inserting keeps the map ordered by expiry.
      this.#expiresAt.delete(id);
      this.#expiresAt.set(id, expiresAt);
    }
    this.#prune();
  }

  has(id) {
    const expiresAt = this.#expiresAt.get(id);
    return expiresAt !== undefined && expiresAt > this.#now();
  }

  // Oldest entries come first, so stop at the first one still valid.
  #prune() {
    const now = this.#now();
    for (const [id, expiresAt] of this.#expiresAt) {
      if (expiresAt > now) {
        break;
      }
      this.#expiresAt.delete(id);
    }
  }
}
