// Messages members report to staff with the "Report message" app (right-click
// a message > Apps). Each report is posted in the mod-log channel (else the
// logs channel) with Delete, Time out and Dismiss buttons; the row remembers
// what happened to it, so the same message is only reported once while open.

import { openDatabase } from "../storage/database.js";

export const ReportStatus = Object.freeze({ OPEN: "open", DELETED: "deleted", TIMED_OUT: "timedOut", DISMISSED: "dismissed" });
// A member can send this many reports in REPORT_WINDOW_MS.
export const MAX_REPORTS_PER_WINDOW = 5;
export const REPORT_WINDOW_MS = 10 * 60 * 1000;
// "Reported 3 times in the last 30 days" on each report.
export const HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const toReport = (row) =>
  row
    ? {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        messageId: row.message_id,
        authorId: row.author_id,
        reporterId: row.reporter_id,
        reason: row.reason ?? null,
        createdAt: row.created_at,
        status: row.status,
        handledBy: row.handled_by ?? null,
        reportChannelId: row.report_channel_id ?? null,
        reportMessageId: row.report_message_id ?? null,
      }
    : undefined;

export class ReportStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      insert: db.prepare(`
        INSERT INTO message_reports (guild_id, channel_id, message_id, author_id, reporter_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      get: db.prepare("SELECT * FROM message_reports WHERE id = ?"),
      openForMessage: db.prepare("SELECT * FROM message_reports WHERE guild_id = ? AND message_id = ? AND status = 'open' LIMIT 1"),
      byReporterSince: db.prepare("SELECT COUNT(*) AS total FROM message_reports WHERE guild_id = ? AND reporter_id = ? AND created_at >= ?"),
      byAuthorSince: db.prepare("SELECT COUNT(*) AS total FROM message_reports WHERE guild_id = ? AND author_id = ? AND created_at >= ?"),
      setPost: db.prepare("UPDATE message_reports SET report_channel_id = ?, report_message_id = ? WHERE id = ?"),
      resolve: db.prepare("UPDATE message_reports SET status = ?, handled_by = ? WHERE id = ? AND status = 'open' RETURNING *"),
      remove: db.prepare("DELETE FROM message_reports WHERE id = ?"),
    };
  }

  add({ guildId, channelId, messageId, authorId, reporterId, reason = null, createdAt = Date.now() }) {
    return toReport(this.#statements.insert.get(guildId, channelId, messageId, authorId, reporterId, reason, createdAt));
  }

  get(id) {
    return toReport(this.#statements.get.get(id));
  }

  openForMessage(guildId, messageId) {
    return toReport(this.#statements.openForMessage.get(guildId, messageId));
  }

  // Whether this member may report again now.
  canReport(guildId, reporterId, now = Date.now()) {
    return Number(this.#statements.byReporterSince.get(guildId, reporterId, now - REPORT_WINDOW_MS).total) < MAX_REPORTS_PER_WINDOW;
  }

  // How often this member's messages were reported lately (this report included).
  recentAgainst(guildId, authorId, now = Date.now()) {
    return Number(this.#statements.byAuthorSince.get(guildId, authorId, now - HISTORY_DAYS * DAY_MS).total);
  }

  setPost(id, channelId, messageId) {
    this.#statements.setPost.run(channelId, messageId, id);
  }

  // Marks an open report handled. Returns it, or undefined if someone already did.
  resolve(id, status, handledBy) {
    return toReport(this.#statements.resolve.get(status, handledBy, id));
  }

  // For a report that couldn't be posted.
  remove(id) {
    this.#statements.remove.run(id);
  }
}
