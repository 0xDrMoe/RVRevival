// Ticket support settings (Setting.TICKET_SUPPORT), set with /tickets
// auto-close and /tickets ratings or on the dashboard's Tickets page:
//
//   autoCloseHours  close a ticket after this many hours without a message
//                   (0 = never). A warning is posted first; any message resets it.
//   ratings         ask the member to rate the help (1 to 5 stars) by DM when
//                   their ticket closes.

export const MAX_AUTO_CLOSE_HOURS = 720;
// How long after the warning a still-quiet ticket closes: the idle time
// itself, but never more than 12 hours.
export const MAX_WARNING_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_TICKET_SUPPORT = Object.freeze({ autoCloseHours: 0, ratings: false });

export class InvalidTicketSupport extends Error {
  name = "InvalidTicketSupport";
}

// Never throws: anything odd falls back to the default.
export function normalizeTicketSupport(value) {
  const hours = Number(value?.autoCloseHours);
  return {
    autoCloseHours: Number.isInteger(hours) && hours > 0 && hours <= MAX_AUTO_CLOSE_HOURS ? hours : 0,
    ratings: value?.ratings === true,
  };
}

// For the dashboard: throws InvalidTicketSupport. Returns what to save (null = default).
export function checkTicketSupport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidTicketSupport("Send the ticket settings as an object.");
  }
  const { autoCloseHours, ratings } = value;
  if (!Number.isInteger(autoCloseHours) || autoCloseHours < 0 || autoCloseHours > MAX_AUTO_CLOSE_HOURS) {
    throw new InvalidTicketSupport(`Auto-close must be a whole number of hours from 0 (off) to ${MAX_AUTO_CLOSE_HOURS}.`);
  }
  if (typeof ratings !== "boolean") {
    throw new InvalidTicketSupport("Ratings must be true or false.");
  }
  return autoCloseHours === 0 && !ratings ? null : { autoCloseHours, ratings };
}

export function describeTicketSupport(value) {
  const support = normalizeTicketSupport(value);
  return `auto-close ${support.autoCloseHours ? `after ${support.autoCloseHours}h` : "off"}, ratings ${support.ratings ? "on" : "off"}`;
}

// What the auto-close check should do with an open ticket now: "warn",
// "close" or null. A ticket is idle from its last message (or opening).
export function idleStep(ticket, autoCloseHours, now = Date.now()) {
  if (!autoCloseHours) {
    return null;
  }
  if (ticket.idleWarnedAt !== null && ticket.idleWarnedAt !== undefined) {
    const wait = Math.min(autoCloseHours, MAX_WARNING_HOURS) * HOUR_MS;
    return now - ticket.idleWarnedAt >= wait ? "close" : null;
  }
  const idleSince = Math.max(ticket.lastActivityAt ?? 0, ticket.createdAt);
  return now - idleSince >= autoCloseHours * HOUR_MS ? "warn" : null;
}

export const warningHours = (autoCloseHours) => Math.min(autoCloseHours, MAX_WARNING_HOURS);
