// The quote book (/quote, the Make it a quote app, the dashboard's Quotes
// page), in data/bot.db: table quotes, numbered per server, plus the members
// who opted out of being quoted (quote_optouts). See migration 40.

import { inTransaction, openDatabase } from "../storage/database.js";

export const MAX_QUOTE_LENGTH = 4000;
export const MAX_QUOTES_PER_SERVER = 10_000;
export const QUOTE_PAGE_SIZE = 10;

// How a quote was made.
export const QuoteVia = Object.freeze({ APP: "app", COMMAND: "command", REACTION: "reaction" });

export class QuoteError extends Error {
  name = "QuoteError";
  // reason: duplicate | full
  constructor(reason, quote) {
    super(reason);
    this.reason = reason;
    this.quote = quote;
  }
}

function toQuote(row) {
  if (!row) {
    return undefined;
  }
  let style = null;
  try {
    style = row.style ? JSON.parse(row.style) : null;
  } catch {
    style = null;
  }
  return {
    guildId: row.guild_id,
    number: row.number,
    content: row.content,
    authorId: row.author_id,
    authorName: row.author_name,
    authorUsername: row.author_username,
    authorAvatar: row.author_avatar ?? null,
    channelId: row.channel_id ?? null,
    messageId: row.message_id ?? null,
    saidAt: row.said_at,
    addedBy: row.added_by,
    addedAt: row.added_at,
    via: row.via,
    private: row.private === 1,
    nsfw: row.nsfw === 1,
    style,
    cardChannelId: row.card_channel_id ?? null,
    cardMessageId: row.card_message_id ?? null,
    editedAt: row.edited_at ?? null,
  };
}

// LIKE pattern for `text` anywhere, with % and _ taken literally.
const likeAnywhere = (text) => `%${String(text).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export class QuoteStore {
  #db;
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    const db = this.#db;
    this.#statements = {
      get: db.prepare("SELECT * FROM quotes WHERE guild_id = ? AND number = ?"),
      byMessage: db.prepare("SELECT * FROM quotes WHERE guild_id = ? AND message_id = ?"),
      byCard: db.prepare("SELECT * FROM quotes WHERE guild_id = ? AND card_message_id = ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM quotes WHERE guild_id = ?"),
      nextNumber: db.prepare(`
        INSERT INTO quote_counters (guild_id, last) VALUES (?, 1)
        ON CONFLICT (guild_id) DO UPDATE SET last = last + 1
        RETURNING last`),
      insert: db.prepare(`
        INSERT INTO quotes (guild_id, number, content, author_id, author_name, author_username, author_avatar, channel_id, message_id,
                            said_at, added_by, added_at, via, private, nsfw, style, card_channel_id, card_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`),
      setCard: db.prepare("UPDATE quotes SET card_channel_id = ?, card_message_id = ? WHERE guild_id = ? AND number = ?"),
      setStyle: db.prepare("UPDATE quotes SET style = ? WHERE guild_id = ? AND number = ?"),
      setAuthor: db.prepare("UPDATE quotes SET author_name = ?, author_username = ?, author_avatar = ? WHERE guild_id = ? AND number = ?"),
      setContent: db.prepare("UPDATE quotes SET content = ?, edited_at = ? WHERE guild_id = ? AND number = ?"),
      delete: db.prepare("DELETE FROM quotes WHERE guild_id = ? AND number = ? RETURNING *"),
      deleteGuild: db.prepare("DELETE FROM quotes WHERE guild_id = ?"),
      deleteCounter: db.prepare("DELETE FROM quote_counters WHERE guild_id = ?"),
      optedOut: db.prepare("SELECT 1 FROM quote_optouts WHERE user_id = ?"),
      optOut: db.prepare("INSERT INTO quote_optouts (user_id, at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING"),
      optIn: db.prepare("DELETE FROM quote_optouts WHERE user_id = ?"),
      authors: db.prepare("SELECT author_id, MAX(author_name) AS name, COUNT(*) AS total FROM quotes WHERE guild_id = ? GROUP BY author_id ORDER BY total DESC LIMIT ?"),
    };
  }

  get(guildId, number) {
    return toQuote(this.#statements.get.get(guildId, number));
  }

  // The quote made from a message, if there is one.
  byMessage(guildId, messageId) {
    return toQuote(this.#statements.byMessage.get(guildId, messageId));
  }

  // The quote a card message shows.
  byCard(guildId, cardMessageId) {
    return toQuote(this.#statements.byCard.get(guildId, cardMessageId));
  }

  count(guildId) {
    return Number(this.#statements.count.get(guildId).total);
  }

  // Saves a new quote and returns it with its number. Throws QuoteError
  // "duplicate" (with the existing quote) when the message is already quoted,
  // "full" when the server has MAX_QUOTES_PER_SERVER.
  add({ guildId, content, authorId, authorName, authorUsername, authorAvatar = null, channelId = null, messageId = null, saidAt, addedBy, addedAt, via, private: hidden = false, nsfw = false, style = null }) {
    return inTransaction(this.#db, () => {
      if (messageId) {
        const existing = this.byMessage(guildId, messageId);
        if (existing) {
          throw new QuoteError("duplicate", existing);
        }
      }
      if (this.count(guildId) >= MAX_QUOTES_PER_SERVER) {
        throw new QuoteError("full");
      }
      const { last: number } = this.#statements.nextNumber.get(guildId);
      this.#statements.insert.run(
        guildId,
        number,
        String(content).slice(0, MAX_QUOTE_LENGTH),
        authorId,
        String(authorName).slice(0, 100),
        String(authorUsername).slice(0, 100),
        authorAvatar,
        channelId,
        messageId,
        saidAt,
        addedBy,
        addedAt,
        via,
        hidden ? 1 : 0,
        nsfw ? 1 : 0,
        style ? JSON.stringify(style) : null,
      );
      return this.get(guildId, number);
    });
  }

  setCard(guildId, number, channelId, messageId) {
    this.#statements.setCard.run(channelId, messageId, guildId, number);
  }

  setStyle(guildId, number, style) {
    this.#statements.setStyle.run(style ? JSON.stringify(style) : null, guildId, number);
  }

  // Refreshes the name, username and avatar a card shows.
  setAuthor(guildId, number, { name, username, avatar }) {
    this.#statements.setAuthor.run(String(name).slice(0, 100), String(username).slice(0, 100), avatar ?? null, guildId, number);
  }

  // Staff fixing a quote's text (marked edited).
  setContent(guildId, number, content, at) {
    return this.#statements.setContent.run(String(content).slice(0, MAX_QUOTE_LENGTH), at, guildId, number).changes > 0;
  }

  // Deletes a quote and returns it (undefined if it was already gone).
  delete(guildId, number) {
    return toQuote(this.#statements.delete.get(guildId, number));
  }

  // Every quote of a server, when the bot leaves it for good.
  deleteGuild(guildId) {
    inTransaction(this.#db, () => {
      this.#statements.deleteGuild.run(guildId);
      this.#statements.deleteCounter.run(guildId);
    });
  }

  // Quotes matching a filter, newest first, a page at a time.
  //   authorId     only this member's quotes
  //   text         only quotes containing this (any case)
  //   hidePrivate  leave out quotes from channels @everyone can't see
  //   hideNsfw     leave out quotes from age-restricted channels
  //   page         from 1
  // Returns { quotes, total, page, pages }.
  search(guildId, { authorId = null, text = null, hidePrivate = false, hideNsfw = false, page = 1, pageSize = QUOTE_PAGE_SIZE } = {}) {
    const { where, values } = this.#filter(guildId, { authorId, text, hidePrivate, hideNsfw });
    const total = Number(this.#db.prepare(`SELECT COUNT(*) AS total FROM quotes WHERE ${where}`).get(...values).total);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
    const rows = this.#db
      .prepare(`SELECT * FROM quotes WHERE ${where} ORDER BY number DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (current - 1) * pageSize);
    return { quotes: rows.map(toQuote), total, page: current, pages };
  }

  // One random quote matching the filter (see search), or undefined.
  random(guildId, { authorId = null, text = null, hidePrivate = false, hideNsfw = false, random = Math.random } = {}) {
    const { where, values } = this.#filter(guildId, { authorId, text, hidePrivate, hideNsfw });
    const total = Number(this.#db.prepare(`SELECT COUNT(*) AS total FROM quotes WHERE ${where}`).get(...values).total);
    if (total === 0) {
      return undefined;
    }
    const offset = Math.min(total - 1, Math.floor(random() * total));
    return toQuote(this.#db.prepare(`SELECT * FROM quotes WHERE ${where} ORDER BY number LIMIT 1 OFFSET ?`).get(...values, offset));
  }

  // The most quoted members: [{ authorId, name, total }].
  topAuthors(guildId, limit = 10) {
    return this.#statements.authors.all(guildId, limit).map((row) => ({ authorId: row.author_id, name: row.name, total: Number(row.total) }));
  }

  #filter(guildId, { authorId, text, hidePrivate, hideNsfw }) {
    const parts = ["guild_id = ?"];
    const values = [guildId];
    if (authorId) {
      parts.push("author_id = ?");
      values.push(authorId);
    }
    if (text) {
      parts.push("(content LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\')");
      values.push(likeAnywhere(text), likeAnywhere(text));
    }
    if (hidePrivate) {
      parts.push("private = 0");
    }
    if (hideNsfw) {
      parts.push("nsfw = 0");
    }
    return { where: parts.join(" AND "), values };
  }

  // --- Opting out -------------------------------------------------------------

  isOptedOut(userId) {
    return Boolean(this.#statements.optedOut.get(userId));
  }

  optOut(userId, at = Date.now()) {
    this.#statements.optOut.run(userId, at);
  }

  optIn(userId) {
    return this.#statements.optIn.run(userId).changes > 0;
  }
}
