// Stores support tickets (/tickets) in the bot's SQLite database. Each ticket
// is a private thread; the row remembers who opened it, why, how it ended, and
// the conversation (saved as a transcript when it's closed). Each ticket's
// history (opened, closed, people added…) is kept in ticket_events.

import { inTransaction, openDatabase } from "../storage/database.js";

function toTicket(row) {
  return row
    ? {
        id: row.id,
        guildId: row.guild_id,
        number: row.number,
        userId: row.user_id,
        threadId: row.thread_id ?? null,
        subject: row.subject,
        categoryId: row.category_id ?? null,
        categoryLabel: row.category_label ?? null,
        createdAt: row.created_at,
        closedAt: row.closed_at ?? null,
        closedBy: row.closed_by ?? null,
        closeReason: row.close_reason ?? null,
        hasTranscript: row.transcript !== null && row.transcript !== undefined,
        messageCount: row.message_count ?? null,
        claimedBy: row.claimed_by ?? null,
        claimedAt: row.claimed_at ?? null,
        firstResponseAt: row.first_response_at ?? null,
        lastActivityAt: row.last_activity_at ?? null,
        idleWarnedAt: row.idle_warned_at ?? null,
        rating: row.rating ?? null,
      }
    : undefined;
}

// More would only come from someone renaming a thread over and over.
export const MAX_EVENTS_PER_TICKET = 200;

const splitIds = (text) => (text ? text.split(" ").filter(Boolean) : []);

function toEvent(row) {
  return {
    id: row.id,
    event: row.event,
    actorId: row.actor_id ?? null,
    userIds: splitIds(row.user_ids),
    detail: row.detail ?? null,
    createdAt: row.created_at,
  };
}

export class TicketStore {
  #db;
  #statements;

  // `database` is an open database, or a file name (":memory:" for tests).
  constructor(database = ":memory:") {
    this.#db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      nextNumber: this.#db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tickets WHERE guild_id = ?"),
      insert: this.#db.prepare(`
        INSERT INTO tickets (guild_id, number, user_id, subject, created_at, category_id, category_label)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      get: this.#db.prepare("SELECT * FROM tickets WHERE id = ?"),
      openForUser: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND closed_at IS NULL"),
      byThread: this.#db.prepare("SELECT * FROM tickets WHERE thread_id = ?"),
      listOpen: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND closed_at IS NULL ORDER BY number"),
      countOpen: this.#db.prepare("SELECT COUNT(*) AS total FROM tickets WHERE guild_id = ? AND closed_at IS NULL"),
      setThread: this.#db.prepare("UPDATE tickets SET thread_id = ? WHERE id = ?"),
      close: this.#db.prepare(`
        UPDATE tickets SET closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL RETURNING *`),
      delete: this.#db.prepare("DELETE FROM tickets WHERE id = ?"),
      deleteEvents: this.#db.prepare("DELETE FROM ticket_events WHERE ticket_id = ?"),
      reopen: this.#db.prepare(`
        UPDATE tickets SET closed_at = NULL, closed_by = NULL, close_reason = NULL WHERE id = ? AND closed_at IS NOT NULL RETURNING *`),
      countEvents: this.#db.prepare("SELECT COUNT(*) AS total FROM ticket_events WHERE ticket_id = ?"),
      addEvent: this.#db.prepare(`
        INSERT INTO ticket_events (guild_id, ticket_id, event, actor_id, user_ids, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      events: this.#db.prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id"),
      listForUser: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? ORDER BY number DESC LIMIT ?"),
      byNumber: this.#db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND number = ?"),
      setTranscript: this.#db.prepare("UPDATE tickets SET transcript = ?, message_count = ? WHERE id = ?"),
      transcript: this.#db.prepare("SELECT transcript FROM tickets WHERE guild_id = ? AND number = ?"),
      setTranscriptData: this.#db.prepare(`
        INSERT INTO ticket_transcripts (ticket_id, guild_id, data) VALUES (?, ?, ?)
        ON CONFLICT (ticket_id) DO UPDATE SET data = excluded.data`),
      transcriptData: this.#db.prepare(`
        SELECT data FROM ticket_transcripts
        WHERE ticket_id = (SELECT id FROM tickets WHERE guild_id = ? AND number = ?)`),
      deleteTranscriptData: this.#db.prepare("DELETE FROM ticket_transcripts WHERE ticket_id = ?"),
      guildOf: this.#db.prepare("SELECT guild_id FROM tickets WHERE id = ?"),
      // Newest first. :status is "open", "closed" or "all"; :userId and :before are optional.
      search: this.#db.prepare(`
        SELECT * FROM tickets
        WHERE guild_id = :guildId
          AND (:status = 'all' OR (:status = 'open' AND closed_at IS NULL) OR (:status = 'closed' AND closed_at IS NOT NULL))
          AND (:userId IS NULL OR user_id = :userId)
          AND (:before IS NULL OR number < :before)
        ORDER BY number DESC
        LIMIT :limit`),
      claim: this.#db.prepare("UPDATE tickets SET claimed_by = ?, claimed_at = ? WHERE id = ? AND closed_at IS NULL RETURNING *"),
      // A message in the ticket: it's active again (any idle warning is
      // forgotten), and the first message by someone other than the member is
      // the first response.
      activity: this.#db.prepare(`
        UPDATE tickets SET
          last_activity_at = :at,
          idle_warned_at = NULL,
          first_response_at = CASE WHEN first_response_at IS NULL AND :authorId <> user_id THEN :at ELSE first_response_at END
        WHERE id = :id AND closed_at IS NULL`),
      allOpen: this.#db.prepare("SELECT * FROM tickets WHERE closed_at IS NULL AND thread_id IS NOT NULL"),
      warned: this.#db.prepare("UPDATE tickets SET idle_warned_at = ? WHERE id = ? AND closed_at IS NULL"),
      rate: this.#db.prepare(`
        UPDATE tickets SET rating = ? WHERE id = ? AND user_id = ? AND closed_at IS NOT NULL AND rating IS NULL RETURNING *`),
      stats: this.#db.prepare(`
        SELECT
          SUM(CASE WHEN created_at >= :since THEN 1 ELSE 0 END) AS opened,
          SUM(CASE WHEN closed_at >= :since THEN 1 ELSE 0 END) AS closed,
          AVG(CASE WHEN created_at >= :since AND first_response_at IS NOT NULL THEN first_response_at - created_at END) AS first_response,
          AVG(CASE WHEN closed_at >= :since AND rating IS NOT NULL THEN rating END) AS rating,
          SUM(CASE WHEN closed_at >= :since AND rating IS NOT NULL THEN 1 ELSE 0 END) AS ratings
        FROM tickets WHERE guild_id = :guildId AND (created_at >= :since OR closed_at >= :since)`),
    };
  }

  // Opens a ticket for the member, or returns undefined if they already have
  // one open. Checked and saved together, so two clicks can't open two.
  // `category` is the panel button's { id, label }, if it had several.
  open({ guildId, userId, subject, category = null, createdAt = Date.now() }) {
    return inTransaction(this.#db, () => {
      if (this.#statements.openForUser.get(guildId, userId)) {
        return undefined;
      }
      const { next } = this.#statements.nextNumber.get(guildId);
      return toTicket(this.#statements.insert.get(guildId, next, userId, subject, createdAt, category?.id ?? null, category?.label ?? null));
    });
  }

  get(id) {
    return toTicket(this.#statements.get.get(id));
  }

  openForUser(guildId, userId) {
    return toTicket(this.#statements.openForUser.get(guildId, userId));
  }

  byThread(threadId) {
    return toTicket(this.#statements.byThread.get(threadId));
  }

  listOpen(guildId) {
    return this.#statements.listOpen.all(guildId).map(toTicket);
  }

  countOpen(guildId) {
    return Number(this.#statements.countOpen.get(guildId).total);
  }

  // A member's newest tickets, open or closed.
  listForUser(guildId, userId, limit = 20) {
    return this.#statements.listForUser.all(guildId, userId, limit).map(toTicket);
  }

  byNumber(guildId, number) {
    return toTicket(this.#statements.byNumber.get(guildId, number));
  }

  // Tickets newest first, a page at a time (`before` = the last number on the previous page).
  search(guildId, { status = "all", userId = null, before = null, limit = 50 } = {}) {
    return this.#statements.search.all({ guildId, status, userId, before, limit }).map(toTicket);
  }

  // `data` (transcripts/snapshot.js) is what the dashboard draws the page from.
  setTranscript(id, transcript, messageCount, data = undefined) {
    inTransaction(this.#db, () => {
      this.#statements.setTranscript.run(transcript, messageCount, id);
      if (data !== undefined) {
        const guildId = this.#statements.guildOf.get(id)?.guild_id;
        if (guildId) {
          this.#statements.setTranscriptData.run(id, guildId, JSON.stringify(data));
        }
      }
    });
  }

  // The saved transcript data (JSON text), or undefined for tickets closed
  // before transcripts were saved as data.
  transcriptData(guildId, number) {
    return this.#statements.transcriptData.get(guildId, number)?.data ?? undefined;
  }

  // The saved transcript text, or undefined.
  transcript(guildId, number) {
    return this.#statements.transcript.get(guildId, number)?.transcript ?? undefined;
  }

  setThread(id, threadId) {
    this.#statements.setThread.run(threadId, id);
  }

  // Closes an open ticket. Returns the closed ticket, or undefined if it was
  // already closed (so it's only announced once).
  close(id, { closedBy = null, reason = null, closedAt = Date.now() } = {}) {
    return toTicket(this.#statements.close.get(closedAt, closedBy, reason, id));
  }

  // Opens a closed ticket again. Returns it, or undefined if it was open
  // already or its member has opened another one since (one at a time).
  reopen(id) {
    return inTransaction(this.#db, () => {
      const ticket = toTicket(this.#statements.get.get(id));
      if (!ticket || ticket.closedAt === null || this.#statements.openForUser.get(ticket.guildId, ticket.userId)) {
        return undefined;
      }
      return toTicket(this.#statements.reopen.get(id));
    });
  }

  // For a ticket whose thread couldn't be made.
  delete(id) {
    inTransaction(this.#db, () => {
      this.#statements.deleteEvents.run(id);
      this.#statements.deleteTranscriptData.run(id);
      this.#statements.delete.run(id);
    });
  }

  // Adds to a ticket's history. Returns the event, or undefined once the
  // ticket has MAX_EVENTS_PER_TICKET.
  addEvent(ticket, { event, actorId = null, userIds = [], detail = null, createdAt = Date.now() }) {
    return inTransaction(this.#db, () => {
      if (Number(this.#statements.countEvents.get(ticket.id).total) >= MAX_EVENTS_PER_TICKET) {
        return undefined;
      }
      const row = this.#statements.addEvent.get(
        ticket.guildId,
        ticket.id,
        event,
        actorId,
        userIds.length > 0 ? userIds.join(" ") : null,
        detail,
        createdAt,
      );
      return toEvent(row);
    });
  }

  // Claims an open ticket for a staff member (null unclaims it). Returns the
  // ticket, or undefined if it's closed.
  claim(id, userId, at = Date.now()) {
    return toTicket(this.#statements.claim.get(userId, userId ? at : null, id));
  }

  // Someone wrote in the ticket.
  noteActivity(id, authorId, at = Date.now()) {
    this.#statements.activity.run({ id, authorId, at });
  }

  // Every open ticket with a thread, for the auto-close check.
  allOpen() {
    return this.#statements.allOpen.all().map(toTicket);
  }

  markIdleWarned(id, at = Date.now()) {
    this.#statements.warned.run(at, id);
  }

  // The member's rating of their closed ticket, once. Returns the ticket, or
  // undefined if it's someone else's, still open or already rated.
  rate(id, userId, rating) {
    return toTicket(this.#statements.rate.get(rating, id, userId));
  }

  // Since `since`: tickets opened and closed, the average time to the first
  // reply from someone else (ms) and the average rating, or null without any.
  stats(guildId, since) {
    const row = this.#statements.stats.get({ guildId, since });
    return {
      opened: Number(row.opened ?? 0),
      closed: Number(row.closed ?? 0),
      averageFirstResponseMs: row.first_response === null ? null : Math.round(row.first_response),
      averageRating: row.rating === null ? null : Math.round(row.rating * 10) / 10,
      ratings: Number(row.ratings ?? 0),
    };
  }

  // A ticket's history, oldest first.
  events(ticketId) {
    return this.#statements.events.all(ticketId).map(toEvent);
  }
}
