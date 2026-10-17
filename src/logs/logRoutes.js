// Log routing: each kind of log entry can go to its own channel (the
// dashboard's Permissions page, Advanced). The setting is { route: channelId };
// a kind without a channel goes where it always did (the logs, mod-log or
// server-log channel). Only where entries go is changed here: what is logged
// and how it's posted stay in the logs themselves.

import { Setting } from "../settings/guildSettings.js";

// The values are stored in the settings, so never rename one.
export const LogRoute = Object.freeze({
  COMMANDS: "commands", // command and button uses (logs channel)
  BOT_DELETIONS: "botDeletions", // messages the bot deleted, like in the /country channel (logs channel)
  DASHBOARD: "dashboard", // changes made on the dashboard (logs channel)
  CASES: "cases", // moderation cases (mod-log channel)
  MOD_ACTIONS: "modActions", // locks, purges, role changes, quarantines, tickets (mod-log channel)
  AUTOMOD: "automod", // messages automod deleted (mod-log channel)
  PROTECTION: "protection", // raid alerts and anti-nuke (mod-log channel)
  // The server-log events, named like serverLog.js's LogEvent.
  MESSAGE_EDIT: "messageEdit",
  MESSAGE_DELETE: "messageDelete",
  BULK_DELETE: "bulkDelete",
  MEMBER_JOIN: "memberJoin",
  MEMBER_LEAVE: "memberLeave",
  MEMBER_UPDATE: "memberUpdate",
});
export const LOG_ROUTES = Object.values(LogRoute);

// Where each kind goes without a route: "logs", "modLog" or "serverLog".
export const ROUTE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    LOG_ROUTES.map((route) => [
      route,
      [LogRoute.COMMANDS, LogRoute.BOT_DELETIONS, LogRoute.DASHBOARD].includes(route)
        ? "logs"
        : [LogRoute.CASES, LogRoute.MOD_ACTIONS, LogRoute.AUTOMOD, LogRoute.PROTECTION].includes(route)
          ? "modLog"
          : "serverLog",
    ]),
  ),
);

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

// The routed channel for `route` in this server, or undefined.
export const routedChannelId = (guildSettings, guildId, route) =>
  route ? normalizeLogRoutes(guildSettings?.get(guildId, Setting.LOG_ROUTES))[route] : undefined;

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
