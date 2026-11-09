// Log routing: every kind of log entry can go to its own channel (the
// dashboard's Logging page, "Where each log goes"). The setting is
// { route: channelId }. Some routes are groups ("All moderation cases") with
// more specific routes under them ("Bans"): an entry goes to its own route's
// channel, else its group's, else wherever that part of the logs goes (the
// logs, mod-log, server-log or ticket log channel). Only where entries go is
// changed here: what is logged and how it's posted stay in the logs themselves.

import { Setting } from "../settings/guildSettings.js";

// The values are stored in the settings, so never rename one.
export const LogRoute = Object.freeze({
  // Logs channel
  COMMANDS: "commands", // command and button uses
  BOT_DELETIONS: "botDeletions", // messages the bot deleted, like in the /country channel
  DASHBOARD: "dashboard", // changes made on the dashboard

  // Mod-log channel
  CASES: "cases", // group: every moderation case
  CASE_BAN: "caseBan",
  CASE_SOFTBAN: "caseSoftban",
  CASE_UNBAN: "caseUnban",
  CASE_KICK: "caseKick",
  CASE_TIMEOUT: "caseTimeout",
  CASE_UNTIMEOUT: "caseUntimeout",
  CASE_WARN: "caseWarn",
  CASE_NOTE: "caseNote",
  MOD_ACTIONS: "modActions", // group: moderation actions that aren't cases
  WARNINGS_CLEARED: "warningsCleared",
  CHANNEL_LOCK: "channelLock",
  SLOWMODE: "slowmode",
  ROLE_CHANGE: "roleChange",
  NICKNAME_CHANGE: "nicknameChange",
  PURGE: "purge",
  MASS_ROLE: "massRole",
  TEMP_ROLE: "tempRole",
  QUARANTINE: "quarantine",
  AUTOMOD: "automod", // messages automod deleted
  PROTECTION: "protection", // group: raid and anti-nuke
  RAID_ALERT: "raidAlert",
  RAID_LOCKDOWN: "raidLockdown",
  ANTI_NUKE: "antiNuke",

  // Server-log channel, named like serverLog.js's LogEvent.
  MESSAGE_EDIT: "messageEdit",
  MESSAGE_DELETE: "messageDelete",
  BULK_DELETE: "bulkDelete",
  MEMBER_JOIN: "memberJoin",
  MEMBER_LEAVE: "memberLeave",
  MEMBER_UPDATE: "memberUpdate",

  // Ticket log channel, named "ticket" + tickets/ticketLog.js's TicketEvent.
  TICKET_OPENED: "ticketOpened",
  TICKET_CLOSED: "ticketClosed",
  TICKET_REOPENED: "ticketReopened",
  TICKET_MEMBER_ADDED: "ticketMemberAdded",
  TICKET_MEMBER_REMOVED: "ticketMemberRemoved",
  TICKET_RENAMED: "ticketRenamed",
  TICKET_DELETED: "ticketDeleted",
  TICKET_CLAIMED: "ticketClaimed",
  TICKET_UNCLAIMED: "ticketUnclaimed",
  TICKET_RATED: "ticketRated",
});
export const LOG_ROUTES = Object.values(LogRoute);

// The group each specific route belongs to.
export const ROUTE_PARENTS = Object.freeze({
  ...Object.fromEntries(
    ["caseBan", "caseSoftban", "caseUnban", "caseKick", "caseTimeout", "caseUntimeout", "caseWarn", "caseNote"].map((route) => [route, LogRoute.CASES]),
  ),
  ...Object.fromEntries(
    ["warningsCleared", "channelLock", "slowmode", "roleChange", "nicknameChange", "purge", "massRole", "tempRole", "quarantine"].map((route) => [
      route,
      LogRoute.MOD_ACTIONS,
    ]),
  ),
  ...Object.fromEntries(["raidAlert", "raidLockdown", "antiNuke"].map((route) => [route, LogRoute.PROTECTION])),
});

// Which part of the logs each route belongs to, and so where it goes without
// a route: "logs", "modLog", "serverLog" or "ticketLog".
const SECTION_OF = {
  logs: ["commands", "botDeletions", "dashboard"],
  serverLog: ["messageEdit", "messageDelete", "bulkDelete", "memberJoin", "memberLeave", "memberUpdate"],
};
export const ROUTE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    LOG_ROUTES.map((route) => [
      route,
      SECTION_OF.logs.includes(route)
        ? "logs"
        : SECTION_OF.serverLog.includes(route)
          ? "serverLog"
          : route.startsWith("ticket")
            ? "ticketLog"
            : "modLog",
    ]),
  ),
);

// The route for a moderation case's action ("ban" -> "caseBan").
export const caseRoute = (action) => {
  const route = `case${String(action).charAt(0).toUpperCase()}${String(action).slice(1)}`;
  return LOG_ROUTES.includes(route) ? route : LogRoute.CASES;
};

// The route for a ticket event ("opened" -> "ticketOpened").
export const ticketRoute = (event) => {
  const route = `ticket${String(event).charAt(0).toUpperCase()}${String(event).slice(1)}`;
  return LOG_ROUTES.includes(route) ? route : undefined;
};

// The routes to look at for `route`, most specific first: the route, then its
// group. `route` can also be a list (each one is followed by its group).
export function routeChain(route) {
  const chain = [];
  for (const name of [route].flat()) {
    if (!name) {
      continue;
    }
    for (const step of [name, ROUTE_PARENTS[name]]) {
      if (step && !chain.includes(step)) {
        chain.push(step);
      }
    }
  }
  return chain;
}

export class InvalidLogRoutes extends Error {
  name = "InvalidLogRoutes";
}

const SNOWFLAKE = /^\d{17,20}$/;

// The saved routes, without unknown kinds. Never throws.
export function normalizeLogRoutes(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(
    LOG_ROUTES.filter((route) => typeof value[route] === "string" && SNOWFLAKE.test(value[route])).map((route) => [route, value[route]]),
  );
}

// Checks routes from the dashboard. `isChannel(id)` says whether an ID is a
// channel of the server the bot can post in. Returns what to save (null when
// there are none). Throws InvalidLogRoutes.
export function checkLogRoutes(value, { isChannel }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidLogRoutes("Send the log channels as an object.");
  }
  const routes = {};
  for (const [route, channelId] of Object.entries(value)) {
    if (!LOG_ROUTES.includes(route)) {
      throw new InvalidLogRoutes(`Unknown kind of log entry "${route}".`);
    }
    if (channelId === null || channelId === "") {
      continue;
    }
    if (typeof channelId !== "string" || !isChannel(channelId)) {
      throw new InvalidLogRoutes("Pick a text or announcement channel from this server for each kind of log entry.");
    }
    routes[route] = channelId;
  }
  const clean = normalizeLogRoutes(routes);
  return Object.keys(clean).length > 0 ? clean : null;
}

// The channel picked for `route` (or, failing that, its group) in this server,
// or undefined. `route` can be a list, looked at in order.
export function routedChannelId(guildSettings, guildId, route) {
  const chain = routeChain(route);
  if (chain.length === 0) {
    return undefined;
  }
  const routes = normalizeLogRoutes(guildSettings?.get(guildId, Setting.LOG_ROUTES));
  return chain.map((name) => routes[name]).find(Boolean);
}

// The routes without `channelId` (it was deleted), or undefined if none pointed there.
export function withoutChannel(saved, channelId) {
  const routes = normalizeLogRoutes(saved);
  if (!Object.values(routes).includes(channelId)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(routes).filter(([, id]) => id !== channelId));
}

export const describeLogRoutes = (value) => {
  const routes = Object.entries(normalizeLogRoutes(value));
  return routes.length > 0 ? routes.map(([route, id]) => `${route} → <#${id}>`).join(" · ") : "*none*";
};
