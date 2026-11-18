// The AI assistant's knowledge base: articles a server writes on the
// dashboard's AI assistant page (the FAQ, rules, how-tos). The assistant only
// answers from these (and the server's tags, when it's allowed to), so staff
// control what it says. Kept in the bot's SQLite database.

import { openDatabase } from "../storage/database.js";

export const MAX_ARTICLES = 100;
export const MAX_ARTICLE_TITLE = 100;
export const MAX_ARTICLE_BODY = 4000;

function toArticle(row) {
  return row
    ? {
        id: row.id,
        guildId: row.guild_id,
        title: row.title,
        body: row.body,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      }
    : undefined;
}

export class InvalidArticle extends Error {
  name = "InvalidArticle";
}

// What staff typed, ready to save. Throws InvalidArticle.
export function cleanArticle({ title, body } = {}) {
  const cleanTitle = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  const cleanBody = typeof body === "string" ? body.replace(/\r\n?/g, "\n").trim() : "";
  if (!cleanTitle || cleanTitle.length > MAX_ARTICLE_TITLE) {
    throw new InvalidArticle(`An article's title is 1 to ${MAX_ARTICLE_TITLE} characters.`);
  }
  if (!cleanBody || cleanBody.length > MAX_ARTICLE_BODY) {
    throw new InvalidArticle(`An article is 1 to ${MAX_ARTICLE_BODY} characters.`);
  }
  return { title: cleanTitle, body: cleanBody };
}

export class KnowledgeStore {
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      list: db.prepare("SELECT * FROM kb_articles WHERE guild_id = ? ORDER BY title COLLATE NOCASE, id"),
      get: db.prepare("SELECT * FROM kb_articles WHERE guild_id = ? AND id = ?"),
      count: db.prepare("SELECT COUNT(*) AS total FROM kb_articles WHERE guild_id = ?"),
      insert: db.prepare("INSERT INTO kb_articles (guild_id, title, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *"),
      update: db.prepare("UPDATE kb_articles SET title = ?, body = ?, updated_by = ?, updated_at = ? WHERE guild_id = ? AND id = ? RETURNING *"),
      delete: db.prepare("DELETE FROM kb_articles WHERE guild_id = ? AND id = ? RETURNING *"),
      deleteGuild: db.prepare("DELETE FROM kb_articles WHERE guild_id = ?"),
    };
  }

  list(guildId) {
    return this.#statements.list.all(guildId).map(toArticle);
  }

  get(guildId, id) {
    return toArticle(this.#statements.get.get(guildId, id));
  }

  count(guildId) {
    return this.#statements.count.get(guildId).total;
  }

  // Undefined when the server already has MAX_ARTICLES. Throws InvalidArticle.
  add(guildId, article, { by, at = Date.now() }) {
    const { title, body } = cleanArticle(article);
    if (this.count(guildId) >= MAX_ARTICLES) {
      return undefined;
    }
    return toArticle(this.#statements.insert.get(guildId, title, body, by, at));
  }

  // Undefined when there's no such article. Throws InvalidArticle.
  update(guildId, id, article, { by, at = Date.now() }) {
    const { title, body } = cleanArticle(article);
    return toArticle(this.#statements.update.get(title, body, by, at, guildId, id));
  }

  delete(guildId, id) {
    return toArticle(this.#statements.delete.get(guildId, id));
  }

  deleteGuild(guildId) {
    this.#statements.deleteGuild.run(guildId);
  }
}
