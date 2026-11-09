import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLogChannelPoster } from "../src/logs/logChannel.js";
import {
  caseRoute,
  LOG_ROUTES,
  LogRoute,
  ROUTE_DEFAULTS,
  ROUTE_PARENTS,
  routeChain,
  routedChannelId,
  ticketRoute,
} from "../src/logs/logRoutes.js";
import { CaseAction } from "../src/moderation/caseStore.js";
import { MOD_LOG_SETTINGS } from "../src/moderation/modLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { TICKET_EVENTS } from "../src/tickets/ticketLog.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const BOT_ID = "200000000000000001";
const LOGS = "800000000000000001";
const MOD_LOG = "800000000000000002";
const CASES = "800000000000000003";
const BANS = "800000000000000004";
const TICKETS = "800000000000000005";

describe("log routes", () => {
  it("has a route for every case action and ticket event", () => {
    for (const action of Object.values(CaseAction)) {
      expect(LOG_ROUTES).toContain(caseRoute(action));
      expect(caseRoute(action)).not.toBe(LogRoute.CASES);
    }
    for (const event of TICKET_EVENTS) {
      expect(LOG_ROUTES).toContain(ticketRoute(event));
    }
    expect(caseRoute("something new")).toBe(LogRoute.CASES);
  });

  it("puts every specific route in a group that exists", () => {
    for (const [route, parent] of Object.entries(ROUTE_PARENTS)) {
      expect(LOG_ROUTES).toContain(route);
      expect(LOG_ROUTES).toContain(parent);
      expect(ROUTE_DEFAULTS[route]).toBe(ROUTE_DEFAULTS[parent]);
    }
    expect(ROUTE_DEFAULTS[LogRoute.TICKET_CLOSED]).toBe("ticketLog");
    expect(ROUTE_DEFAULTS[LogRoute.MEMBER_JOIN]).toBe("serverLog");
  });

  it("looks at the route first, then its group", () => {
    expect(routeChain(LogRoute.CASE_BAN)).toEqual([LogRoute.CASE_BAN, LogRoute.CASES]);
    expect(routeChain(LogRoute.AUTOMOD)).toEqual([LogRoute.AUTOMOD]);
    expect(routeChain([LogRoute.TICKET_OPENED, LogRoute.MOD_ACTIONS])).toEqual([LogRoute.TICKET_OPENED, LogRoute.MOD_ACTIONS]);
    expect(routeChain(undefined)).toEqual([]);
  });

  it("finds the most specific channel picked", async () => {
    const settings = new GuildSettings();
    expect(routedChannelId(settings, GUILD_ID, LogRoute.CASE_BAN)).toBeUndefined();
    await settings.set(GUILD_ID, Setting.LOG_ROUTES, { cases: CASES });
    expect(routedChannelId(settings, GUILD_ID, LogRoute.CASE_BAN)).toBe(CASES);
    await settings.set(GUILD_ID, Setting.LOG_ROUTES, { cases: CASES, caseBan: BANS });
    expect(routedChannelId(settings, GUILD_ID, LogRoute.CASE_BAN)).toBe(BANS);
    expect(routedChannelId(settings, GUILD_ID, LogRoute.CASE_KICK)).toBe(CASES);
    expect(routedChannelId(settings, GUILD_ID, LogRoute.PURGE)).toBeUndefined();
  });

  it("names every route on the dashboard, in every language", () => {
    const page = readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8");
    const english = JSON.parse(readFileSync(new URL("../src/dashboard/public/locales/en.json", import.meta.url), "utf8"));
    for (const route of LOG_ROUTES) {
      // Ticket routes are made from the ticket events on the page ("opened" -> "ticketOpened").
      const event = route.startsWith("ticket") ? `${route[6].toLowerCase()}${route.slice(7)}` : null;
      expect(page, route).toContain(`"${event ?? route}"`);
      const label = event ? english[`ticketEvent_${event}`] : (english[`logRoute_${route}`] ?? english[`logEvent_${route}`]);
      expect(label, route).toBeTruthy();
    }
  });
});

describe("posting with log routes", () => {
  function setup() {
    const channels = new Map();
    const webhooks = new Map();
    for (const id of [LOGS, MOD_LOG, CASES, BANS, TICKETS]) {
      const webhook = {
        id: `7${id.slice(1)}`,
        channelId: id,
        token: "token",
        owner: { id: BOT_ID },
        send: vi.fn(async () => ({ id: "600000000000000001", channelId: id })),
      };
      webhooks.set(id, webhook);
      channels.set(id, {
        id,
        isTextBased: () => true,
        permissionsFor: () => ({ has: (flag) => [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageWebhooks].includes(flag) }),
        send: vi.fn(),
        fetchWebhooks: vi.fn(async () => [webhook]),
      });
    }
    const guild = { id: GUILD_ID, members: { me: { id: BOT_ID, user: { id: BOT_ID, username: "Rabble" } } }, channels: { cache: channels } };
    const settings = new GuildSettings();
    const poster = createLogChannelPoster({ guildSettings: settings, logger: fakeLogger() });
    const build = () => ({ embed: new EmbedBuilder().setDescription("entry") });
    return { guild, settings, poster, build, webhooks, channels };
  }

  it("sends each kind to its own channel through that channel's webhook, else the global one", async () => {
    const { guild, settings, poster, build, webhooks, channels } = setup();
    await settings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS);
    await settings.set(GUILD_ID, Setting.LOG_ROUTES, { cases: CASES, caseBan: BANS });

    await poster.post(guild, MOD_LOG_SETTINGS, build, { route: LogRoute.CASE_BAN });
    await poster.post(guild, MOD_LOG_SETTINGS, build, { route: LogRoute.CASE_WARN });
    await poster.post(guild, MOD_LOG_SETTINGS, build, { route: LogRoute.PURGE });

    expect(webhooks.get(BANS).send).toHaveBeenCalledTimes(1);
    expect(webhooks.get(CASES).send).toHaveBeenCalledTimes(1);
    // No mod-log channel: the logs channel.
    expect(webhooks.get(LOGS).send).toHaveBeenCalledTimes(1);
    for (const id of [BANS, CASES, LOGS]) {
      expect(channels.get(id).fetchWebhooks).toHaveBeenCalledTimes(1);
    }

    await settings.set(GUILD_ID, Setting.MOD_LOG_CHANNEL, MOD_LOG);
    await poster.post(guild, MOD_LOG_SETTINGS, build, { route: LogRoute.PURGE });
    expect(webhooks.get(MOD_LOG).send).toHaveBeenCalledTimes(1);
  });

  it("counts a log as on when only one kind has a channel", async () => {
    const { guild, settings, poster } = setup();
    expect(poster.isEnabled(guild, [Setting.SERVER_LOG_CHANNEL], LogRoute.MEMBER_JOIN)).toBe(false);
    await settings.set(GUILD_ID, Setting.LOG_ROUTES, { memberJoin: TICKETS });
    expect(poster.isEnabled(guild, [Setting.SERVER_LOG_CHANNEL], LogRoute.MEMBER_JOIN)).toBe(true);
    expect(poster.isEnabled(guild, [Setting.SERVER_LOG_CHANNEL], LogRoute.MEMBER_LEAVE)).toBe(false);
  });
});
