// Dashboard logins, kept in the dashboard_sessions table of data/bot.db so they
// survive restarts.
//
// The browser holds a random session token in a cookie. Only its SHA-256 hash is
// stored, and the person's Discord access token is stored encrypted with a key
// made from DASHBOARD_SESSION_SECRET. A copy of the database alone can't be used
// to log in or to call Discord as anyone.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

const hash = (token) => createHash("sha256").update(token).digest("hex");

// AES-256-GCM: "iv.tag.ciphertext", each base64url.
function encryptor(secret) {
  const key = Buffer.from(hkdfSync("sha256", secret, "rv-dashboard", "access-token", 32));
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
    },
    // Undefined if it was encrypted with another secret or tampered with.
    decrypt(value) {
      try {
        const [iv, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64url"));
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}

function toSession(row, decrypt) {
  if (!row) {
    return undefined;
  }
  const accessToken = decrypt(row.access_token);
  if (!accessToken) {
    return undefined;
  }
  return {
    userId: row.user_id,
    username: row.username,
    avatar: row.avatar ?? undefined,
    accessToken,
    guilds: row.guilds ? JSON.parse(row.guilds) : undefined,
    guildsLoadedAt: row.guilds_loaded_at ?? undefined,
    expiresAt: row.expires_at,
  };
}

export class SessionStore {
  #statements;
  #crypto;
  #now;

  constructor(db, { secret, now = Date.now }) {
    this.#crypto = encryptor(secret);
    this.#now = now;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO dashboard_sessions (id_hash, user_id, username, avatar, access_token, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      get: db.prepare("SELECT * FROM dashboard_sessions WHERE id_hash = ? AND expires_at > ?"),
      setGuilds: db.prepare("UPDATE dashboard_sessions SET guilds = ?, guilds_loaded_at = ? WHERE id_hash = ?"),
      delete: db.prepare("DELETE FROM dashboard_sessions WHERE id_hash = ?"),
      deleteExpired: db.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= ?"),
    };
  }

  // Starts a session and returns the token for the cookie. It ends after
  // SESSION_DAYS, or sooner if Discord's access token expires first.
  create({ userId, username, avatar, accessToken, expiresInSeconds }) {
    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    const expiresAt = Math.min(now + SESSION_MS, now + (expiresInSeconds ?? Infinity) * 1000);
    this.#statements.insert.run(
      hash(token),
      userId,
      username,
      avatar ?? null,
      this.#crypto.encrypt(accessToken),
      now,
      expiresAt,
    );
    return token;
  }

  // The session for a cookie token, or undefined if it's unknown or expired.
  get(token) {
    if (typeof token !== "string" || token.length === 0) {
      return undefined;
    }
    return toSession(this.#statements.get.get(hash(token), this.#now()), this.#crypto.decrypt);
  }

  // Remembers the person's server list, so it isn't fetched on every request.
  setGuilds(token, guilds) {
    this.#statements.setGuilds.run(JSON.stringify(guilds), this.#now(), hash(token));
  }

  delete(token) {
    if (typeof token === "string") {
      this.#statements.delete.run(hash(token));
    }
  }

  deleteExpired() {
    return Number(this.#statements.deleteExpired.run(this.#now()).changes);
  }
}
