// The web dashboard: a small JSON API plus the static page in public/.
//
//   GET  /auth/login                      sends the person to Discord to log in
//   GET  /auth/callback                   Discord sends them back here
//   POST /auth/logout
//   GET  /api/me                          who is logged in, and the servers they can open
//   GET  /api/guilds/:id                  a server's settings, channels, roles and case counts
//   GET  /api/guilds/:id/stats            numbers for the overview page (?tz=)
//   PUT  /api/guilds/:id/settings         change some settings
//   GET  /api/guilds/:id/cases            search cases (?user=&moderator=&action=&from=&to=&q=&before=)
//   GET  /api/guilds/:id/cases/export     the same search as a CSV file
//   PATCH  /api/guilds/:id/cases/:number  change a case's reason
//   DELETE /api/guilds/:id/cases/:number  delete a case
//   GET  /api/guilds/:id/members          find members by name, or a user by ID (?q=)
//   GET  /api/guilds/:id/members/:user    one person's history: cases, tickets, joins, leaves, roles, level
//   GET  /api/guilds/:id/levels           the XP leaderboard (?page=&period=all|week|month)
//   GET  /api/guilds/:id/tickets          support tickets (?status=open|closed|all&user=&before=)
//   GET  /api/guilds/:id/tickets/:number  one ticket, its history and transcript (?download=1 for a .txt file)
//   POST /api/guilds/:id/permissions/preset  preview or apply a premade permission setup
//   POST   /api/guilds/:id/role-panels           post a new role panel
//   PUT    /api/guilds/:id/role-panels/:panel    change a role panel (edits its message)
//   DELETE /api/guilds/:id/role-panels/:panel    delete a role panel and its message
//
// Two levels of access to a server the bot is in:
//   - "manage": Manage Server, Administrator or the owner. Everything.
//   - "cases": anyone with one of the server's dashboard roles (a setting). The
//     overview, the cases, member history and tickets, but not the settings.
// The bot's permission settings (command rules, premade setups) can only be
// changed by the server owner or whoever added the bot.
// That is checked on every request: permissions against their Discord server
// list (re-read at most every few minutes), roles against the bot's view of
// the member (re-read at most every 30 seconds).
// Every change is posted in the server's logs channel, like bot commands are.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { constants as zlib } from "node:zlib";
import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { normalizeAutomod } from "../automod/config.js";
import { countryList, normalizeName } from "../countries/countries.js";
import { normalizeAntiNuke } from "../raid/antiNuke.js";
import { levelProgress, normalizeLeveling } from "../leveling/config.js";
import { LevelStore, Period, PERIODS, periodStart } from "../leveling/levelStore.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { CaseAction } from "../moderation/caseStore.js";
import { MemberEventStore } from "../members/memberEventStore.js";
import { TicketStore } from "../tickets/ticketStore.js";
import { SavedRoles, SavedRoleStore } from "../members/savedRoleStore.js";
import { TempRoleStore } from "../tempRoles/tempRoleStore.js";
import { AppealStatus, APPEAL_STATUSES, AppealStore } from "../appeals/appealStore.js";
import { appealQuestions, MAX_ANSWER_LENGTH, normalizeAppeals } from "../appeals/config.js";
import { normalizeCategories } from "../tickets/categories.js";
import { checkMessage, editableMessage, InvalidMessage, messageSummary, parseMessageLink } from "../messages/embedMessage.js";
import { inviteLink } from "../guilds/invite.js";
import { SentMessageStore } from "../messages/sentMessageStore.js";
import { addFeed, addYoutubeFeeds, countFeeds, defaultFeedMessages, FeedDuplicate, FeedError, FeedLimit, MAX_FEED_MESSAGE_LENGTH, YOUTUBE_TYPES, youtubeChannelOf } from "../feeds/feeds.js";
import { variableError } from "./public/variables.js";
import { FEED_KINDS } from "../feeds/fetchFeed.js";
import { FeedStore, MAX_FEEDS } from "../feeds/feedStore.js";
import { createLiveApis } from "../feeds/liveApis.js";
import { normalizeMediaOnly } from "../community/mediaOnly.js";
import { checkPanelInput, InvalidPanel, MAX_PANELS, panelMessage, panelsOf } from "../community/rolePanels.js";
import { KeyedLock } from "../utils/keyedLock.js";
import { BACKUP_LIMITS, buildBackup, InvalidBackup, planRestore, readBackupFile, settingLabel } from "./backup.js";
import { MAX_STICKIES, MAX_STICKY_LENGTH, StickyStore } from "../sticky/stickyStore.js";
import { BotStatsStore } from "../stats/botStats.js";
import { checkTemplate, COUNTER_PRESETS, InvalidCounter, MAX_COUNTERS, newCounterId, normalizeCounters } from "../stats/statsCounters.js";
import { buildPanelComponents, buildPanelMessage, panelLook, TICKET_COLOR } from "../tickets/tickets.js";
import { DEFAULT_NAME_FORMAT, normalizeLook } from "../tickets/panel.js";
import { checkTicketSupport, normalizeTicketSupport } from "../tickets/support.js";
import { normalizeWarnThresholds } from "../moderation/warnThresholds.js";
import { BUILT_IN_GUIDE_KEYS, buildPostedGuide } from "../commands/countryHelp.js";
import { CONTINENT_EMOJI } from "../commands/countryPicker.js";
import { continentOf, CONTINENTS } from "../countries/continents.js";
import { DEFAULT_GUIDE_COLOR } from "../countries/guide.js";
import { REGION_KEYS, regionList } from "../countries/options.js";
import { ScheduledMessageStore } from "../scheduled/scheduledMessageStore.js";
import { MAX_DELAY_MS, MAX_INTERVAL_MS, MAX_SCHEDULED, MAX_SCHEDULED_LENGTH, MIN_INTERVAL_MS } from "../scheduled/scheduler.js";
import { buildCaseEmbed } from "../moderation/modLog.js";
import { Setting } from "../settings/guildSettings.js";
import { ActivityStore } from "./activityStore.js";
import { serverCheckup } from "./checkup.js";
import { CommandUsageStore } from "../stats/commandUsage.js";
import { canManage, DiscordApiError } from "./discordApi.js";
import { SESSION_DAYS, SessionStore } from "./sessions.js";
import { checkSettingChanges, describeValue, InvalidSetting, SETTING_RULES } from "./settingsRules.js";
import { LogRoute, routedChannelId } from "../logs/logRoutes.js";
import { brandingOf, InvalidBranding, planBrandingChange } from "../branding/branding.js";
import { botCommandCatalog } from "../permissions/catalog.js";
import { normalizeCommandRules } from "../permissions/commandRules.js";
import { CUSTOM, InvalidPreset, planPreset } from "../permissions/presets.js";

const PUBLIC_FOLDER = fileURLToPath(new URL("./public/", import.meta.url));

// For text put into the page's HTML.
const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Addresses the page draws itself (public/app.js routes them).
export const PAGE_PATHS = ["/servers", "/guide", "/status", "/changelog", "/appeal/:guildId", "/g/:guildId", "/g/:guildId/:page"];
// The pages anyone can read, for the sitemap.
export const PUBLIC_PAGES = ["/", "/guide", "/status", "/changelog", "/terms", "/privacy"];
const VERSIONED_ASSET = /^\/[\w./-]+\.(?:js|css)\?v=[0-9a-f]{12}$/;
const LONG_LIVED_ASSET = /^\/(?:fonts\/[\w.-]+|og-image\.jpg|favicon\.svg)$/;

// A short hash of everything in public/, so links carrying it change on deploy.
export function assetVersion(folder = PUBLIC_FOLDER) {
  const hash = createHash("sha256");
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = `${path}${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${full}/`);
      } else {
        hash.update(entry.name).update(readFileSync(full));
      }
    }
  };
  walk(folder.endsWith("/") ? folder : `${folder}/`);
  return hash.digest("hex").slice(0, 12);
}

export function publicRobots(baseUrl) {
  return [
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /auth/",
    "Disallow: /g/",
    "Disallow: /servers",
    "Disallow: /appeal/",
    "Allow: /",
    "",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

export function publicSitemap(baseUrl) {
  const urls = PUBLIC_PAGES.map((path) => `  <url><loc>${escapeHtml(baseUrl + path)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}


// LEGAL_CONTACT as shown on the Terms and Privacy pages: an email address or
// web address becomes a link. Until it's set, the pages say so plainly.
function contactHtml(contact) {
  if (!contact) {
    return '<strong class="legal-placeholder">[Contact not set yet: add LEGAL_CONTACT to the dashboard\'s .env]</strong>';
  }
  const text = escapeHtml(contact);
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact)) {
    return `<a href="mailto:${text}">${text}</a>`;
  }
  if (/^https:\/\/\S+$/.test(contact)) {
    return `<a href="${text}" rel="noopener">${text}</a>`;
  }
  return text;
}
const SESSION_COOKIE = "rv_session";
const STATE_COOKIE = "rv_oauth_state";
// How long a person's Discord server list (and their permissions) is trusted.
const GUILD_LIST_MS = 5 * 60 * 1000;
// How long the landing page's public numbers are reused before they're counted again.
const PUBLIC_STATS_MS = 2 * 60 * 1000;
const MAX_REASON_LENGTH = 512;
const CASES_PAGE = 50;
const EXPORT_LIMIT = 10_000;
const LEADERBOARD_PAGE = 25;
const TICKETS_PAGE = 25;
// Settings the posted ticket panel is drawn from.
const TICKET_PANEL_SETTINGS = [Setting.TICKET_PANEL, Setting.TICKET_CATEGORIES];
const MAX_TICKET_NAMES = 40;
const TICKET_STATUSES = ["open", "closed", "all"];
const MAX_LEADERBOARD_PAGE = 400;
const MAX_SEARCH_LENGTH = 100;
const STATS_DAYS = 30;
// How long a failed look-up of who added the bot is trusted.
const INVITER_RETRY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_ID = /^\d{17,20}$/;
const CASE_ACTIONS = Object.values(CaseAction);
const MAX_MEMBER_QUERY = 32;
const HISTORY_CASES = 100;
// Discord IDs hold the time they were made, counted from the start of 2015.
const DISCORD_EPOCH = 1420070400000n;

export const Access = Object.freeze({ MANAGE: "manage", CASES: "cases" });

// What the browser gets for a case.
const caseJson = (moderationCase) => ({
  number: moderationCase.number,
  action: moderationCase.action,
  userId: moderationCase.userId,
  userTag: moderationCase.userTag ?? null,
  moderatorId: moderationCase.moderatorId,
  moderatorTag: moderationCase.moderatorTag ?? null,
  reason: moderationCase.reason ?? null,
  durationMs: moderationCase.durationMs ?? null,
  expiresAt: moderationCase.expiresAt ?? null,
  dmSent: moderationCase.dmSent ?? null,
  createdAt: moderationCase.createdAt,
  updatedAt: moderationCase.updatedAt ?? null,
});

// What the browser gets for a role.
// Country roles are named after a country, the same test /country uses.
const COUNTRY_NAMES = new Set(countryList.countries.map((country) => normalizeName(country.name)));

const roleJson = ({ id, name, color, position, managed, hoist, mentionable, permissions, unicode_emoji: emoji }) => ({
  id,
  name,
  country: !managed && COUNTRY_NAMES.has(normalizeName(name)),
  color,
  position,
  managed,
  hoist: hoist ?? false,
  mentionable: mentionable ?? false,
  permissions: permissions ?? "0",
  emoji: emoji ?? null,
});

// What the browser gets for one of the server's own emojis. `available` is
// false when the server lost the boost level it needs.
const emojiJson = ({ id, name, animated, available }) => ({
  id,
  name,
  animated: Boolean(animated),
  available: available !== false,
});

// The case search filters from a query string, or { error } for a 400 reply.
export function parseCaseFilters(query = {}) {
  const { user, moderator, action, from, to, q } = query;
  if (user && !DISCORD_ID.test(user)) {
    return { error: "bad-user", message: "Paste a user ID (17 to 20 digits)." };
  }
  if (moderator && !DISCORD_ID.test(moderator)) {
    return { error: "bad-moderator", message: "Paste a moderator's user ID (17 to 20 digits)." };
  }
  const actions = action ? [...new Set(String(action).split(","))] : [];
  if (!actions.every((name) => CASE_ACTIONS.includes(name))) {
    return { error: "bad-action" };
  }
  const time = (value) => (value === undefined || value === "" ? undefined : Number(value));
  const [fromMs, toMs] = [time(from), time(to)];
  if ([fromMs, toMs].some((value) => value !== undefined && !(Number.isSafeInteger(value) && value >= 0))) {
    return { error: "bad-date" };
  }
  const text = typeof q === "string" ? q.trim() : "";
  if (text.length > MAX_SEARCH_LENGTH) {
    return { error: "bad-search", message: `Search for at most ${MAX_SEARCH_LENGTH} characters.` };
  }
  return {
    filters: {
      userId: user || undefined,
      moderatorId: moderator || undefined,
      actions: actions.length > 0 ? actions : undefined,
      from: fromMs,
      to: toMs,
      text: text || undefined,
    },
  };
}

// One CSV cell. Cells a spreadsheet would run as a formula get a leading '.
function csvCell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// When a Discord account (or anything with an ID) was made.
export const idCreatedAt = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

// What the browser gets for a person in a member search.
const memberResultJson = (user, member) => ({
  id: user.id,
  username: user.username,
  displayName: member?.nick ?? user.global_name ?? user.username,
  avatar: user.avatar ?? null,
  bot: user.bot ?? false,
  inServer: Boolean(member),
});

const sameText = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Options:
//   config          from loadDashboardConfig
//   db              the open database (shared with the bot)
//   discord         from createDiscordApi
//   guildSettings   GuildSettings on the same database
//   store           CaseStore on the same database
//   logger
// `feedFetchOptions` replaces fetch and DNS for feeds in tests, `live` the Twitch and Kick APIs.
export async function buildDashboard({ config, db, discord, guildSettings, store, logger, feedFetchOptions, live: liveApis }) {
  const live = liveApis ?? createLiveApis(config.live);
  const sessions = new SessionStore(db, { secret: config.sessionSecret });
  const memberEvents = new MemberEventStore(db);
  const tickets = new TicketStore(db);
  const levels = new LevelStore(db);
  const scheduledMessages = new ScheduledMessageStore(db);
  const activity = new ActivityStore(db);
  const commandUsage = new CommandUsageStore(db);
  const savedRoles = new SavedRoleStore(db);
  const tempRoles = new TempRoleStore(db);
  const appeals = new AppealStore(db);
  const sentMessages = new SentMessageStore(db);
  const feeds = new FeedStore(db);
  const stickies = new StickyStore(db);
  const botStats = new BotStatsStore(db);
  const inviteUrl = inviteLink(discord.clientId);
  const secureCookies = config.url.startsWith("https://");
  const cookieOptions = { path: "/", httpOnly: true, secure: secureCookies, sameSite: "lax" };

  // nginx (or Caddy) on the same machine forwards requests to us.
  const app = Fastify({ logger: false, trustProxy: "127.0.0.1", bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });
  // Brotli's default (quality 11) is too slow to run on every request; 5 is
  // nearly as small. nginx passes compressed responses through as they are.
  await app.register(fastifyCompress, { brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } } });
  await app.register(fastifyStatic, { root: PUBLIC_FOLDER, index: false });

  // The page itself, with the site's address filled in for link previews
  // (Discord and other sites want absolute URLs there). Always revalidated, so
  // a deploy shows at once.
  // %VERSION% changes whenever a file in public/ does, so the page's script
  // and stylesheet links can be cached for a year and still update on deploy.
  const baseUrl = config.url.replace(/\/+$/, "");
  const page = readFileSync(new URL("./public/index.html", import.meta.url), "utf8")
    .replaceAll("%BASE_URL%", escapeHtml(baseUrl))
    .replaceAll("%VERSION%", assetVersion());
  const sendPage = (request, reply) => reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(page);
  app.get("/", sendPage);
  app.get("/index.html", sendPage);
  // Addresses the page draws itself (public/app.js routes them). Anything else
  // that isn't a file or an API route stays a 404.
  for (const path of PAGE_PATHS) {
    app.get(path, sendPage);
  }

  // For search engines: the public pages, and the ones not worth crawling.
  const robots = publicRobots(baseUrl);
  const sitemap = publicSitemap(baseUrl);
  app.get("/robots.txt", (request, reply) => reply.header("Cache-Control", "public, max-age=86400").type("text/plain; charset=utf-8").send(robots));
  app.get("/sitemap.xml", (request, reply) => reply.header("Cache-Control", "public, max-age=86400").type("application/xml; charset=utf-8").send(sitemap));

  // For uptime monitors (UptimeRobot, Better Stack and so on): 200 while the
  // dashboard answers. /healthz/bot is 503 while the bot has missed its
  // heartbeats, so a monitor can alert when the bot itself is down.
  const health = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  app.get("/healthz", health, async (request, reply) => {
    const { online, upSince } = botStats.totals();
    return reply.header("Cache-Control", "no-store").send({ dashboard: "ok", bot: online ? "online" : "offline", upSince });
  });
  app.get("/healthz/bot", health, async (request, reply) => {
    const { online, upSince, ping } = botStats.totals();
    return reply
      .header("Cache-Control", "no-store")
      .code(online ? 200 : 503)
      .send({ bot: online ? "online" : "offline", upSince, ping });
  });

  // The Terms of Service and Privacy Policy, linked from the landing page and
  // given to Discord in the Developer Portal. Plain pages, readable without JavaScript.
  for (const name of ["terms", "privacy"]) {
    const legalPage = readFileSync(new URL(`./legal/${name}.html`, import.meta.url), "utf8")
      .replaceAll("%BASE_URL%", escapeHtml(config.url.replace(/\/+$/, "")))
      .replaceAll("%CONTACT%", contactHtml(config.legalContact));
    app.get(`/${name}`, (request, reply) => reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(legalPage));
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    // Older browsers ignore frame-ancestors.
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    // Browsers only ever reach the site over HTTPS once they've seen it there.
    if (secureCookies) {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/")) {
      reply.header("Cache-Control", "no-store");
    } else if (reply.statusCode === 200 && VERSIONED_ASSET.test(request.url)) {
      // Linked with ?v=<version of public/>: a new deploy changes the link.
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
    } else if (reply.statusCode === 200 && LONG_LIVED_ASSET.test(request.url)) {
      reply.header("Cache-Control", "public, max-age=604800");
    }
    return payload;
  });

  // Changes can only come from our own page: browsers always send Origin on
  // these requests, and another site can't fake it.
  app.addHook("onRequest", async (request, reply) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== config.url) {
      return reply.code(403).send({ error: "bad-origin" });
    }
    // Pick up settings the bot (or another dashboard tab) changed.
    if (request.url.startsWith("/api/")) {
      guildSettings.reloadIfChanged();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.code ?? "bad-request", message: error.message });
    }
    logger.error("Dashboard request failed", { method: request.method, url: request.url, error });
    return reply.code(500).send({ error: "internal" });
  });

  // Clear out expired logins every hour.
  const cleanup = setInterval(() => sessions.deleteExpired(), 60 * 60 * 1000);
  cleanup.unref();
  app.addHook("onClose", async () => clearInterval(cleanup));

  // --- Logging in -----------------------------------------------------------

  const authLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.get("/auth/login", authLimit, async (request, reply) => {
    const state = randomBytes(16).toString("base64url");
    reply.setCookie(STATE_COOKIE, state, { ...cookieOptions, signed: true, maxAge: 600 });
    return reply.redirect(discord.authorizeUrl(state));
  });

  app.get("/auth/callback", authLimit, async (request, reply) => {
    const { code, state, error } = request.query ?? {};
    const saved = request.unsignCookie(request.cookies[STATE_COOKIE] ?? "");
    reply.clearCookie(STATE_COOKIE, cookieOptions);
    if (error || !code || !saved.valid || !sameText(saved.value, state)) {
      return reply.redirect("/?login=failed");
    }
    let token;
    let user;
    try {
      token = await discord.exchangeCode(String(code));
      user = await discord.fetchUser(token.accessToken);
    } catch (loginError) {
      logger.warn("Dashboard login failed", { error: loginError });
      return reply.redirect("/?login=failed");
    }
    // Logging in again replaces this browser's old login instead of leaving it behind.
    // (Its Discord token isn't revoked: Discord may end the new one with it.)
    sessions.delete(request.cookies[SESSION_COOKIE]);
    const sessionToken = sessions.create({
      userId: user.id,
      username: user.global_name ?? user.username,
      avatar: user.avatar,
      accessToken: token.accessToken,
      expiresInSeconds: token.expiresInSeconds,
    });
    reply.setCookie(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: SESSION_DAYS * 24 * 60 * 60 });
    logger.info("Dashboard login", { userId: user.id });
    return reply.redirect("/servers");
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = sessions.get(token);
    if (session) {
      await discord.revokeToken(session.accessToken);
    }
    sessions.delete(token);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });

  // --- Who is asking --------------------------------------------------------

  // The logged-in person, or a 401 reply.
  function requireSession(request, reply) {
    const token = request.cookies[SESSION_COOKIE];
    const session = sessions.get(token);
    if (!session) {
      reply.code(401).send({ error: "login" });
      return undefined;
    }
    return { ...session, token };
  }

  // The servers this person might open: the ones they manage, and the ones the
  // bot is in (where a dashboard role could let them in). [{ id, name, icon,
  // manage }], from Discord at most every GUILD_LIST_MS (or right away with
  // `refresh`). Lists saved by older versions only held managed servers.
  async function knownGuilds(session, { refresh = false } = {}) {
    const fresh = session.guilds && Date.now() - session.guildsLoadedAt < GUILD_LIST_MS;
    if (fresh && !refresh) {
      return session.guilds.map((guild) => ({ manage: true, ...guild }));
    }
    const [userGuilds, botGuilds] = await Promise.all([discord.fetchUserGuilds(session.accessToken), discord.botGuildIds()]);
    const guilds = userGuilds
      .filter((guild) => canManage(guild) || botGuilds.has(guild.id))
      .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon ?? null, manage: canManage(guild) }));
    sessions.setGuilds(session.token, guilds);
    return guilds;
  }

  // Access.MANAGE, Access.CASES or undefined, for one entry of knownGuilds.
  async function accessTo(session, guild) {
    if (guild.manage) {
      return Access.MANAGE;
    }
    const roles = guildSettings.getList(guild.id, Setting.DASHBOARD_ROLES);
    if (roles.length === 0) {
      return undefined;
    }
    const member = await discord.member(guild.id, session.userId);
    return member?.roles?.some((role) => roles.includes(role)) ? Access.CASES : undefined;
  }

  // Ends the session if Discord no longer accepts its access token.
  async function withDiscordLogin(session, reply, work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 401) {
        sessions.delete(session.token);
        reply.clearCookie(SESSION_COOKIE, cookieOptions);
        return reply.code(401).send({ error: "login" });
      }
      throw error;
    }
  }

  // The session, server and access level for /api/guilds/:id routes, or
  // undefined after replying 401, 403 or 404. `manage` routes need Access.MANAGE.
  async function requireGuild(request, reply, { manage = false } = {}) {
    const session = requireSession(request, reply);
    if (!session) {
      return undefined;
    }
    const guildId = request.params.id;
    if (!DISCORD_ID.test(guildId)) {
      reply.code(404).send({ error: "not-found" });
      return undefined;
    }
    const guilds = await withDiscordLogin(session, reply, () => knownGuilds(session));
    if (reply.sent) {
      return undefined;
    }
    const guild = guilds.find((entry) => entry.id === guildId);
    if (!guild) {
      reply.code(403).send({ error: "forbidden" });
      return undefined;
    }
    if (!(await discord.botGuildIds()).has(guildId)) {
      reply.code(404).send({ error: "bot-not-in-server" });
      return undefined;
    }
    const access = await accessTo(session, guild);
    if (!access || (manage && access !== Access.MANAGE)) {
      reply.code(403).send({ error: "forbidden" });
      return undefined;
    }
    return { session, guildId, access };
  }

  // Who added the bot: saved the first time the audit log shows it, since the
  // audit log only keeps 45 days. Failed look-ups are retried after a while.
  const inviterLookups = new Map();
  async function botInviterId(guildId) {
    const saved = guildSettings.get(guildId, Setting.BOT_INVITER);
    if (saved || typeof discord.botInviter !== "function") {
      return saved ?? null;
    }
    const failedAt = inviterLookups.get(guildId);
    if (failedAt && Date.now() - failedAt < INVITER_RETRY_MS) {
      return null;
    }
    const inviterId = await discord.botInviter(guildId);
    if (!inviterId) {
      inviterLookups.set(guildId, Date.now());
      return null;
    }
    inviterLookups.delete(guildId);
    await guildSettings.set(guildId, Setting.BOT_INVITER, inviterId);
    return inviterId;
  }

  // The server owner and whoever added the bot may change who can do what.
  const canManagePermissions = async (guild, userId) => guild.owner_id === userId || (await botInviterId(guild.id)) === userId;

  // A server's settings for the browser. Automod and leveling always come with
  // every default filled in, so the page can show them as they are.
  const settingsJson = (guildId) => ({
    ...guildSettings.all(guildId),
    [Setting.AUTOMOD]: normalizeAutomod(guildSettings.get(guildId, Setting.AUTOMOD)),
    [Setting.LEVELING]: normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING)),
    [Setting.ANTI_NUKE]: normalizeAntiNuke(guildSettings.get(guildId, Setting.ANTI_NUKE)),
    [Setting.APPEALS]: normalizeAppeals(guildSettings.get(guildId, Setting.APPEALS)),
    [Setting.MEDIA_ONLY]: normalizeMediaOnly(guildSettings.get(guildId, Setting.MEDIA_ONLY)),
    // With the title and text of panels set up before the look was saved on its own.
    [Setting.TICKET_PANEL]: panelLook(guildSettings, guildId),
    [Setting.TICKET_SUPPORT]: normalizeTicketSupport(guildSettings.get(guildId, Setting.TICKET_SUPPORT)),
    [Setting.WARN_THRESHOLDS]: normalizeWarnThresholds(guildSettings.get(guildId, Setting.WARN_THRESHOLDS)),
  });

  // Settings saved in a fuller form than the dashboard sends, made comparable.
  const rulesOrNull = (saved) => {
    const rules = normalizeCommandRules(saved);
    return Object.keys(rules).length > 0 ? rules : null;
  };
  const NORMALIZE = {
    [Setting.AUTOMOD]: normalizeAutomod,
    [Setting.LEVELING]: normalizeLeveling,
    [Setting.ANTI_NUKE]: normalizeAntiNuke,
    [Setting.APPEALS]: normalizeAppeals,
    [Setting.MEDIA_ONLY]: normalizeMediaOnly,
    [Setting.COMMAND_RULES]: rulesOrNull,
    [Setting.TICKET_PANEL]: (saved) => (saved ? normalizeLook(saved) : null),
    [Setting.TICKET_SUPPORT]: (saved) => checkTicketSupport(normalizeTicketSupport(saved)),
    [Setting.WARN_THRESHOLDS]: (saved) => {
      const list = normalizeWarnThresholds(saved);
      return list.length > 0 ? list : null;
    },
  };
  const savedValue = (guildId, setting) => {
    const saved = guildSettings.get(guildId, setting);
    return NORMALIZE[setting] ? NORMALIZE[setting](saved) : saved;
  };
  const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  // Settings only the owner (anti-nuke) or the owner and whoever added the bot
  // (command permissions) may change. Returns the 403 body, or null.
  async function refuseRestricted(guildId, guild, session, changes) {
    const changed = (setting) => !sameValue(savedValue(guildId, setting), changes[setting]);
    const ownerOnly = Object.keys(changes).filter((setting) => SETTING_RULES[setting].ownerOnly && changed(setting));
    if (ownerOnly.length > 0 && guild.owner_id !== session.userId) {
      return { error: "owner-only", setting: ownerOnly[0], message: "Only the server owner can change this." };
    }
    const permissionsOnly = Object.keys(changes).filter((setting) => SETTING_RULES[setting].permissionsOnly && changed(setting));
    if (permissionsOnly.length > 0 && !(await canManagePermissions(guild, session.userId))) {
      return { error: "permissions-only", setting: permissionsOnly[0], message: "Only the server owner or whoever added the bot can change this." };
    }
    return null;
  }

  // Saves `changes` ({ setting: value | null }, already checked). Returns the
  // log lines for those that changed, and what each was before and after
  // ({ setting: { before, after } }) so the Activity page can undo it.
  async function saveSettings(guildId, guild, changes) {
    const lines = [];
    const undo = {};
    let ticketPanelChanged = false;
    for (const [setting, value] of Object.entries(changes)) {
      // Unsaved automod, leveling or anti-nuke means the defaults, which is what the page was shown.
      const before = savedValue(guildId, setting);
      if (sameValue(before, value)) {
        continue;
      }
      if (value === null) {
        await guildSettings.clear(guildId, setting);
      } else {
        await guildSettings.set(guildId, setting, value);
      }
      lines.push(`**${SETTING_RULES[setting].label}:** ${describeValue(setting, before)} → ${describeValue(setting, value)}`);
      undo[setting] = { before: before ?? null, after: savedValue(guildId, setting) ?? null };
      ticketPanelChanged ||= TICKET_PANEL_SETTINGS.includes(setting);
      if ([Setting.COUNTRY_GUIDE, Setting.COUNTRY_CHANNEL, Setting.COUNTRY_ROLES].includes(setting) && !(await redrawCountryGuide(guildId, guild))) {
        lines.push("The posted country guide couldn't be updated; post it again from the Country page.");
      }
    }
    // Once, after both the look and the categories are saved.
    if (ticketPanelChanged && !(await redrawTicketPanel(guildId, guild))) {
      lines.push("The ticket panel couldn't be updated; post it again with `/tickets panel`.");
    }
    return { lines, undo };
  }

  // Gives the posted ticket panel the current look and categories. Panels
  // posted before titles were saved keep their text and only get new
  // buttons, until a look is saved. Returns false if Discord refused (the
  // message was deleted, say).
  async function redrawTicketPanel(guildId, guild) {
    const panel = guildSettings.get(guildId, Setting.TICKETS);
    if (!panel?.channelId) {
      return true;
    }
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const categories = normalizeCategories(guildSettings.get(guildId, Setting.TICKET_CATEGORIES));
    const look = panelLook(guildSettings, guildId);
    let payload;
    if ("title" in panel || guildSettings.get(guildId, Setting.TICKET_PANEL)) {
      const message = buildPanelMessage(language, { look, categories, color: brandingOf(guildSettings, guildId).color ?? undefined });
      payload = { embeds: message.embeds.map((embed) => embed.toJSON()), components: message.components.map((row) => row.toJSON()) };
    } else {
      payload = { components: buildPanelComponents(language, { look, categories }).map((row) => row.toJSON()) };
    }
    try {
      await discord.editMessage(panel.channelId, panel.messageId, payload);
      return true;
    } catch (error) {
      logger.warn("Couldn't update the ticket panel", { guildId, error });
      return false;
    }
  }

  // What the ticket panel and new tickets say when the look leaves it empty,
  // in the server's language, for the Tickets page's placeholders and preview.
  const ticketDefaults = (guildId, guild) => {
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const text = (key) => translate(language, key);
    return {
      title: text("ticketPanelDefaultTitle"),
      description: text("ticketPanelDefaultMessage"),
      buttonLabel: text("ticketOpenButton"),
      menuPlaceholder: text("ticketMenuPlaceholder"),
      intro: text("ticketWelcome"),
      introNoStaff: text("ticketWelcomeNoStaff"),
      staffWord: text("ticketStaffWord"),
      subject: text("ticketSubject"),
      closeButton: text("ticketCloseButton"),
      claimButton: text("ticketClaimButton"),
      nameFormat: DEFAULT_NAME_FORMAT,
      // The colour panels use when neither the look nor Branding sets one.
      color: brandingOf(guildSettings, guildId).color ?? TICKET_COLOR,
      brandColor: brandingOf(guildSettings, guildId).color,
      staffRoleId: guildSettings.get(guildId, Setting.TICKETS)?.staffRoleId ?? null,
      posted: Boolean(guildSettings.get(guildId, Setting.TICKETS)?.channelId),
    };
  };

  // The country guide's built-in text (for countries and for regions), the
  // labels of its fixed buttons and the places members can pick, in the
  // server's language, for the Country page's form, place list and preview.
  const countryGuideInfo = (guildId, guild) => {
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const builtIn = (keys) => ({ ...Object.fromEntries(Object.entries(keys).map(([part, key]) => [part, translate(language, key)])), color: DEFAULT_GUIDE_COLOR });
    return {
      defaults: Object.fromEntries(Object.entries(BUILT_IN_GUIDE_KEYS).map(([mode, keys]) => [mode, builtIn(keys)])),
      fallbackNote: translate(language, "helpFallbackNote"),
      channelNote: translate(language, "helpChannelNote"),
      removeNotes: { countries: translate(language, "helpRemoveNote"), regions: translate(language, "helpRemoveRegionNote") },
      labels: {
        type: translate(language, "pickButtonLabel"),
        remove: { countries: translate(language, "pickRemoveLabel"), regions: translate(language, "pickRemoveRegionLabel") },
        translate: translate(language, "translateButtonLabel"),
      },
      continents: CONTINENTS.map((id) => ({ id, label: translate(language, REGION_KEYS[id]), emoji: CONTINENT_EMOJI[id] })),
      places: {
        countries: countryList.countries.map((country) => ({ code: country.code, name: country.name, continent: continentOf(country.code) ?? null })),
        regions: regionList.countries.map((region) => ({ code: region.code, name: region.name })),
      },
      post: guildSettings.get(guildId, Setting.COUNTRY_GUIDE_POST) ?? null,
    };
  };

  const countryGuideMessage = (guildId, guild, channelId) =>
    buildPostedGuide(pickLanguage(guild.preferred_locale, config.forcedLanguage), {
      isCountryChannel: channelId === guildSettings.get(guildId, Setting.COUNTRY_CHANNEL),
      guide: guildSettings.get(guildId, Setting.COUNTRY_GUIDE),
      places: guildSettings.get(guildId, Setting.COUNTRY_ROLES),
    });

  // Gives the last posted country guide the saved wording. Returns false if
  // Discord refused; a deleted guide is forgotten.
  async function redrawCountryGuide(guildId, guild) {
    const post = guildSettings.get(guildId, Setting.COUNTRY_GUIDE_POST);
    if (!post?.channelId) {
      return true;
    }
    try {
      await discord.editMessage(post.channelId, post.messageId, countryGuideMessage(guildId, guild, post.channelId));
      return true;
    } catch (error) {
      if (error.status === 404) {
        await guildSettings.clear(guildId, Setting.COUNTRY_GUIDE_POST);
      }
      logger.warn("Couldn't update the posted country guide", { guildId, error });
      return false;
    }
  }

  const communityDefaults = (guild) => {
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    return {
      [Setting.WELCOME_MESSAGE]: translate(language, "welcomeDefaultWelcome"),
      [Setting.LEAVE_MESSAGE]: translate(language, "welcomeDefaultLeave"),
      levelUpMessage: translate(language, "levelUpDefault"),
      birthdayMessage: translate(language, "birthdayDefaultMessage"),
      // Per feed kind, what a feed with no message of its own posts.
      feedMessages: defaultFeedMessages(language),
    };
  };

  // Records what someone did on the dashboard (Activity page) and posts it in
  // the server's logs channel when there is one.
  async function logAction(guildId, session, summary, lines = [], undo = null) {
    try {
      activity.add({ guildId, userId: session.userId, userName: session.username, summary, lines, undo });
    } catch (error) {
      logger.warn("Couldn't save a dashboard change", { guildId, error });
    }
    const channelId = routedChannelId(guildSettings, guildId, LogRoute.DASHBOARD) ?? guildSettings.get(guildId, Setting.LOGS_CHANNEL);
    if (!channelId) {
      return;
    }
    const embed = {
      color: 0x5865f2,
      author: { name: `${session.username} · dashboard` },
      description: [summary, ...lines].join("\n").slice(0, 4096),
      footer: { text: `User ID ${session.userId}` },
      timestamp: new Date().toISOString(),
    };
    await discord.postMessage(channelId, { embeds: [embed] }).catch((error) =>
      logger.warn("Couldn't post a dashboard change in the logs channel", { guildId, error }),
    );
  }

  // --- API ------------------------------------------------------------------

  app.get("/api/me", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return reply;
    }
    return withDiscordLogin(session, reply, async () => {
      const guilds = await knownGuilds(session, { refresh: request.query?.refresh === "1" });
      const botGuilds = await discord.botGuildIds();
      const listed = await Promise.all(
        guilds.map(async (guild) => {
          const botPresent = botGuilds.has(guild.id);
          // A role lookup fails if the bot just left; then the server isn't listed.
          const access = botPresent ? await accessTo(session, guild).catch(() => undefined) : guild.manage && Access.MANAGE;
          if (!access) {
            return undefined;
          }
          return { id: guild.id, name: guild.name, icon: guild.icon, botPresent, access };
        }),
      );
      return {
        user: { id: session.userId, username: session.username, avatar: session.avatar ?? null },
        guilds: listed.filter(Boolean),
        inviteUrl,
      };
    });
  });

  // The public landing page's numbers. Only totals across every server, never
  // anything about one server or one person, and worked out at most once per
  // PUBLIC_STATS_MS however many people load the page.
  let publicStats;
  app.get("/api/public/stats", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => {
    if (publicStats && publicStats.expiresAt > Date.now()) {
      return publicStats.value;
    }
    // Without Discord the page still shows the bot's own numbers.
    const reach = await discord.botReach().catch((error) => {
      logger.warn("Couldn't count the bot's servers for the landing page", { error });
      return { servers: null, members: null };
    });
    const value = { ...reach, ...botStats.totals(), inviteUrl };
    publicStats = { value, expiresAt: Date.now() + PUBLIC_STATS_MS };
    return value;
  });

  app.get("/api/guilds/:id", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const manage = access.access === Access.MANAGE;
    const [guild, channels] = await Promise.all([discord.guild(guildId), manage ? discord.channels(guildId) : []]);
    return {
      guild: {
        id: guild.id,
        name: guild.name,
        icon: guild.icon ?? null,
        memberCount: guild.approximate_member_count ?? null,
        onlineCount: guild.approximate_presence_count ?? null,
        // Community servers have Discord's Onboarding, which the Community page recommends over autoroles.
        community: Array.isArray(guild.features) && guild.features.includes("COMMUNITY"),
      },
      access: access.access,
      // Anti-nuke can only be changed by the owner.
      isOwner: guild.owner_id === access.session.userId,
      // Command rules and premade setups: the owner or whoever added the bot.
      canManagePermissions: manage ? await canManagePermissions(guild, access.session.userId) : false,
      botInviterId: manage ? await botInviterId(guildId) : null,
      // Every command, for the command permissions table.
      commands: manage ? botCommandCatalog() : [],
      // Names for the user IDs the settings mention (anti-nuke's trusted people).
      people: manage ? await peopleNames(guildId, normalizeAntiNuke(guildSettings.get(guildId, Setting.ANTI_NUKE)).trustedUserIds) : {},
      // People with a dashboard role only see the cases, not how the server is set up.
      settings: manage ? settingsJson(guildId) : null,
      channels: channels
        .map(({ id, name, type, parent_id: parentId, position }) => ({ id, name, type, parentId: parentId ?? null, position }))
        .sort((a, b) => a.position - b.position),
      roles: manage
        ? guild.roles
            .filter((role) => role.id !== guildId)
            .map(roleJson)
            .sort((a, b) => b.position - a.position)
        : [],
      // The server's own emojis, for the emoji pickers (GET /guilds/:id includes them).
      emojis: manage ? (guild.emojis ?? []).filter((emoji) => emoji.id && emoji.name).map(emojiJson) : [],
      caseCounts: store.countGuildCases(guildId),
      // What the bot posts when no welcome or leave message is set, in the server's language.
      communityDefaults: manage ? communityDefaults(guild) : null,
      countryGuide: manage ? countryGuideInfo(guildId, guild) : null,
      ticketDefaults: manage ? ticketDefaults(guildId, guild) : null,
    };
  });

  // Top commands (30 days) and the server checkup, for the Overview.
  async function overviewExtras(guildId) {
    const [guild, channels, me] = await Promise.all([
      discord.guild(guildId),
      discord.channels(guildId),
      discord.botMember(guildId).catch((error) => {
        logger.debug("Couldn't read the bot's member for the checkup", { guildId, error });
        return null;
      }),
    ]);
    return {
      commandUsage: commandUsage.top(guildId, { days: STATS_DAYS }),
      checkup: serverCheckup({ guildId, guild, channels, me, settings: guildSettings.all(guildId) }),
    };
  }

  app.get("/api/guilds/:id/stats", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    // The viewer's time zone, as Date.getTimezoneOffset() gives it (minutes behind UTC).
    const tz = Number(request.query?.tz ?? 0);
    if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) {
      return reply.code(400).send({ error: "bad-time-zone" });
    }
    const dayOffsetMs = tz * 60 * 1000;
    const today = Math.floor((Date.now() - dayOffsetMs) / DAY_MS);
    const firstDay = today - (STATS_DAYS - 1);
    const stats = store.caseStats(access.guildId, { since: firstDay * DAY_MS + dayOffsetMs, dayOffsetMs });
    return {
      days: STATS_DAYS,
      firstDay,
      dayStarts: Array.from({ length: STATS_DAYS }, (_, index) => (firstDay + index) * DAY_MS + dayOffsetMs),
      perDay: stats.perDay.map((entry) => ({ ...entry, day: entry.day - firstDay })),
      topModerators: stats.topModerators,
      topMembers: stats.topMembers,
      runningTempBans: stats.runningTempBans,
      caseCounts: store.countGuildCases(access.guildId),
      recent: store.searchCases(access.guildId, { limit: 6 }).map(caseJson),
      // The rest of the Overview in the same request, for people who manage the server.
      ...(access.access === Access.MANAGE ? await overviewExtras(access.guildId) : {}),
    };
  });

  app.put("/api/guilds/:id/settings", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    let changes;
    try {
      changes = checkSettingChanges(request.body, { guildId, channels, roles: guild.roles });
    } catch (error) {
      if (error instanceof InvalidSetting) {
        return reply.code(400).send({ error: "invalid-setting", setting: error.setting ?? null, message: error.message });
      }
      throw error;
    }

    const refused = await refuseRestricted(guildId, guild, session, changes);
    if (refused) {
      return reply.code(403).send(refused);
    }
    const permissionsOnly = Object.keys(changes).filter((setting) => SETTING_RULES[setting].permissionsOnly && !sameValue(savedValue(guildId, setting), changes[setting]));
    // Hand-made command rules no longer match the premade setup that was applied.
    if (
      permissionsOnly.includes(Setting.COMMAND_RULES) &&
      !(Setting.PERMISSION_PRESET in changes) &&
      guildSettings.get(guildId, Setting.PERMISSION_PRESET)
    ) {
      changes[Setting.PERMISSION_PRESET] = CUSTOM;
    }

    const { lines, undo } = await saveSettings(guildId, guild, changes);
    if (lines.length > 0) {
      logger.info("Dashboard settings change", { guildId, userId: session.userId, settings: Object.keys(changes) });
      await logAction(guildId, session, "**Settings changed**", lines, undo);
    }
    return { settings: settingsJson(guildId) };
  });

  app.get("/api/guilds/:id/cases", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { filters, error, message } = parseCaseFilters(request.query);
    if (error) {
      return reply.code(400).send({ error, message });
    }
    const before = request.query?.before;
    const beforeNumber = before === undefined ? undefined : Number(before);
    if (beforeNumber !== undefined && !Number.isInteger(beforeNumber)) {
      return reply.code(400).send({ error: "bad-page" });
    }
    const cases = store.searchCases(access.guildId, { ...filters, before: beforeNumber, limit: CASES_PAGE + 1 });
    const page = cases.slice(0, CASES_PAGE);
    return {
      cases: page.map(caseJson),
      nextBefore: cases.length > CASES_PAGE ? page.at(-1).number : null,
      // Only counted for the first page.
      total: beforeNumber === undefined ? store.countMatchingCases(access.guildId, filters) : null,
    };
  });

  app.get("/api/guilds/:id/cases/export", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { filters, error, message } = parseCaseFilters(request.query);
    if (error) {
      return reply.code(400).send({ error, message });
    }
    const header = ["Case", "Action", "Member ID", "Member", "Moderator ID", "Moderator", "Reason", "Duration (minutes)", "Date (UTC)"];
    const rows = store.searchCases(access.guildId, { ...filters, limit: EXPORT_LIMIT }).map((entry) => [
      entry.number,
      entry.action,
      entry.userId,
      entry.userTag,
      entry.moderatorId,
      entry.moderatorTag,
      entry.reason,
      entry.durationMs ? Math.round(entry.durationMs / 60000) : "",
      new Date(entry.createdAt).toISOString(),
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="cases-${access.guildId}.csv"`)
      .send(`\uFEFF${csv}\r\n`);
  });

  // The case number from the URL, or undefined after replying 404.
  function caseNumber(request, reply) {
    const number = Number(request.params.number);
    if (!Number.isInteger(number) || number < 1) {
      reply.code(404).send({ error: "not-found" });
      return undefined;
    }
    return number;
  }

  app.patch("/api/guilds/:id/cases/:number", async (request, reply) => {
    const access = await requireGuild(request, reply);
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const reason = request.body?.reason;
    if (typeof reason !== "string" || reason.trim().length > MAX_REASON_LENGTH) {
      return reply.code(400).send({ error: "bad-reason", message: `Reasons are at most ${MAX_REASON_LENGTH} characters.` });
    }
    const { guildId, session } = access;
    const updated = store.updateReason(guildId, number, reason.trim() || undefined);
    if (!updated) {
      return reply.code(404).send({ error: "not-found" });
    }
    // Update the case's post in the mod log, like /case reason does.
    if (updated.logChannelId && updated.logMessageId) {
      await discord
        .editMessage(updated.logChannelId, updated.logMessageId, { embeds: [buildCaseEmbed(updated).toJSON()] })
        .catch((error) => logger.warn("Couldn't update a case's mod-log post", { guildId, number, error }));
    }
    await logAction(guildId, session, `**Case #${number} reason changed**`, [updated.reason ?? "*no reason*"]);
    return { case: caseJson(updated) };
  });

  app.delete("/api/guilds/:id/cases/:number", async (request, reply) => {
    const access = await requireGuild(request, reply);
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const { guildId, session } = access;
    const existing = store.getCase(guildId, number);
    if (!existing || !store.deleteCase(guildId, number)) {
      return reply.code(404).send({ error: "not-found" });
    }
    await logAction(guildId, session, `**Case #${number} deleted** (${existing.action} of <@${existing.userId}>)`);
    return { ok: true };
  });

  // --- Member history ------------------------------------------------------

  const searchLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  app.get("/api/guilds/:id/members", searchLimit, async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const query = typeof request.query?.q === "string" ? request.query.q.trim() : "";
    if (query.length === 0 || query.length > MAX_MEMBER_QUERY) {
      return reply.code(400).send({ error: "bad-search", message: `Search for 1 to ${MAX_MEMBER_QUERY} characters.` });
    }
    const { guildId } = access;
    if (DISCORD_ID.test(query)) {
      const member = await discord.member(guildId, query);
      const user = member?.user ?? (await discord.user(query));
      return { members: user ? [memberResultJson(user, member)] : [] };
    }
    const found = await discord.searchMembers(guildId, query);
    return { members: found.map((member) => memberResultJson(member.user, member)) };
  });

  app.get("/api/guilds/:id/members/:user", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const userId = request.params.user;
    if (!DISCORD_ID.test(userId)) {
      return reply.code(404).send({ error: "not-found" });
    }
    const [member, guild] = await Promise.all([discord.member(guildId, userId), discord.guild(guildId)]);
    const user = member?.user ?? (await discord.user(userId));
    const cases = store.listCases(guildId, userId, HISTORY_CASES);
    if (!user && cases.length === 0) {
      return reply.code(404).send({ error: "not-found" });
    }
    // Only looked up for people who aren't in the server. Without Ban Members, Discord refuses (403).
    const ban = member ? null : await discord.ban(guildId, userId).catch(() => null);
    const rolesById = new Map(guild.roles.map((role) => [role.id, role]));
    const now = Date.now();
    const tempBan = cases.find((entry) => entry.action === CaseAction.BAN && entry.pendingUnban && entry.expiresAt > now);
    const timedOutUntil = member?.communication_disabled_until ? Date.parse(member.communication_disabled_until) : null;
    return {
      user: {
        id: userId,
        username: user?.username ?? cases[0].userTag ?? null,
        displayName: member?.nick ?? user?.global_name ?? user?.username ?? cases[0].userTag ?? null,
        avatar: user?.avatar ?? null,
        bot: user?.bot ?? false,
        createdAt: idCreatedAt(userId),
      },
      member: member
        ? {
            joinedAt: member.joined_at ? Date.parse(member.joined_at) : null,
            timedOutUntil: timedOutUntil > now ? timedOutUntil : null,
            roles: member.roles
              .map((roleId) => rolesById.get(roleId))
              .filter(Boolean)
              .sort((a, b) => b.position - a.position)
              .map(({ id, name, color }) => ({ id, name, color })),
          }
        : null,
      banned: ban ? { reason: ban.reason ?? null } : null,
      quarantine: (() => {
        const saved = savedRoles.get(guildId, userId, SavedRoles.QUARANTINE);
        return saved ? { since: saved.savedAt, reason: saved.reason, moderatorId: saved.moderatorId, roleIds: saved.roleIds } : null;
      })(),
      tempBanEndsAt: tempBan?.expiresAt ?? null,
      tempRoles: tempRoles.listForUser(guildId, userId).map((entry) => ({
        roleId: entry.roleId,
        roleName: rolesById.get(entry.roleId)?.name ?? null,
        expiresAt: entry.expiresAt,
      })),
      caseCounts: store.countCases(guildId, userId),
      cases: cases.map(caseJson),
      events: memberEvents.list(guildId, userId),
      joins: memberEvents.countJoins(guildId, userId),
      tickets: tickets.listForUser(guildId, userId).map((ticket) => ({
        number: ticket.number,
        subject: ticket.subject,
        threadId: ticket.threadId,
        createdAt: ticket.createdAt,
        closedAt: ticket.closedAt,
        closeReason: ticket.closeReason,
        hasTranscript: ticket.hasTranscript,
      })),
      level: levelJson(guildId, userId),
    };
  });

  // --- Tickets -------------------------------------------------------------

  // Names for the people on a page of tickets, from Discord (cached).
  async function peopleNames(guildId, userIds) {
    const entries = await Promise.all(
      [...new Set(userIds.filter(Boolean))].map(async (userId) => {
        const member = await discord.member(guildId, userId).catch(() => null);
        const user = member?.user ?? (await discord.user(userId).catch(() => null));
        return [userId, member?.nick ?? user?.global_name ?? user?.username ?? null];
      }),
    );
    return Object.fromEntries(entries);
  }

  const ticketJson = (ticket, names = {}) => ({
    number: ticket.number,
    userId: ticket.userId,
    userName: names[ticket.userId] ?? null,
    subject: ticket.subject,
    category: ticket.categoryLabel,
    threadId: ticket.threadId,
    createdAt: ticket.createdAt,
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    closedByName: names[ticket.closedBy] ?? null,
    closeReason: ticket.closeReason,
    hasTranscript: ticket.hasTranscript,
    messageCount: ticket.messageCount,
    claimedBy: ticket.claimedBy,
    claimedByName: names[ticket.claimedBy] ?? null,
    firstResponseAt: ticket.firstResponseAt,
    rating: ticket.rating,
  });

  app.get("/api/guilds/:id/tickets", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const query = request.query ?? {};
    const status = TICKET_STATUSES.includes(query.status) ? query.status : "all";
    const userId = typeof query.user === "string" && query.user !== "" ? query.user : null;
    if (userId !== null && !DISCORD_ID.test(userId)) {
      return reply.code(400).send({ error: "bad-user", message: "Use a Discord user ID." });
    }
    const before = Number.parseInt(query.before ?? "", 10);
    const found = tickets.search(guildId, {
      status,
      userId,
      before: Number.isInteger(before) && before > 0 ? before : null,
      limit: TICKETS_PAGE + 1,
    });
    const page = found.slice(0, TICKETS_PAGE);
    const names = await peopleNames(guildId, page.flatMap((ticket) => [ticket.userId, ticket.closedBy, ticket.claimedBy]));
    return {
      tickets: page.map((ticket) => ticketJson(ticket, names)),
      next: found.length > TICKETS_PAGE ? page.at(-1).number : null,
      openCount: tickets.countOpen(guildId),
      stats: tickets.stats(guildId, Date.now() - STATS_DAYS * DAY_MS),
      panel: Boolean(guildSettings.get(guildId, Setting.TICKETS)?.channelId),
    };
  });

  app.get("/api/guilds/:id/tickets/:number", async (request, reply) => {
    const access = await requireGuild(request, reply);
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const { guildId } = access;
    const ticket = tickets.byNumber(guildId, number);
    if (!ticket) {
      return reply.code(404).send({ error: "not-found" });
    }
    const transcript = tickets.transcript(guildId, number) ?? null;
    if (request.query?.download === "1") {
      if (transcript === null) {
        return reply.code(404).send({ error: "no-transcript" });
      }
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="ticket-${String(number).padStart(4, "0")}.txt"`)
        .send(transcript);
    }
    const events = tickets.events(ticket.id);
    // Names for the first people only, so a busy ticket can't make hundreds of Discord requests.
    const people = [...new Set([ticket.userId, ticket.closedBy, ticket.claimedBy, ...events.flatMap((event) => [event.actorId, ...event.userIds])].filter(Boolean))];
    const names = await peopleNames(guildId, people.slice(0, MAX_TICKET_NAMES));
    return {
      ticket: ticketJson(ticket, names),
      transcript,
      events: events.map((event) => ({
        event: event.event,
        actorId: event.actorId,
        actorName: names[event.actorId] ?? null,
        people: event.userIds.map((id) => ({ id, name: names[id] ?? null })),
        detail: event.detail,
        at: event.createdAt,
      })),
    };
  });

  // --- Leveling ------------------------------------------------------------

  // A member's level, or null if they have no XP.
  const levelJson = (guildId, userId) => {
    const entry = levels.get(guildId, userId);
    if (!entry || entry.xp <= 0) {
      return null;
    }
    const config = normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING));
    return { ...levelProgress(entry.xp, config), xp: entry.xp, messages: entry.messages, rank: levels.rank(guildId, userId) };
  };

  app.get("/api/guilds/:id/levels", async (request, reply) => {
    const access = await requireGuild(request, reply);
    if (!access) {
      return reply;
    }
    const { guildId } = access;
    const requested = Number.parseInt(request.query?.page ?? "1", 10);
    const page = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_LEADERBOARD_PAGE) : 1;
    const offset = (page - 1) * LEADERBOARD_PAGE;
    const period = PERIODS.includes(request.query?.period) ? request.query.period : Period.ALL;
    const since = periodStart(period);
    const total = since === undefined ? levels.count(guildId) : levels.countSince(guildId, since);
    const range = { limit: LEADERBOARD_PAGE, offset };
    const entries = since === undefined ? levels.top(guildId, range) : levels.topSince(guildId, since, range);
    const config = normalizeLeveling(guildSettings.get(guildId, Setting.LEVELING));
    return {
      enabled: config.enabled,
      period,
      page,
      pageSize: LEADERBOARD_PAGE,
      total,
      entries: entries.map((entry, index) => ({
        rank: offset + index + 1,
        userId: entry.userId,
        userTag: entry.userTag,
        xp: entry.xp,
        gained: entry.gained ?? null,
        messages: entry.messages,
        ...levelProgress(entry.xp, config),
      })),
    };
  });

  // --- Scheduled messages --------------------------------------------------

  const SCHEDULE_CHANNELS = [0, 5]; // text, announcement
  const MENTION_EVERYONE = (1n << 17n) | (1n << 3n); // Mention Everyone, or Administrator

  // Whether someone may ping @everyone and roles in this server, from their roles.
  async function canMentionEveryone(guild, userId) {
    if (guild.owner_id === userId) {
      return true;
    }
    const member = await discord.member(guild.id, userId).catch(() => null);
    const roleIds = new Set([guild.id, ...(member?.roles ?? [])]);
    const permissions = guild.roles
      .filter((role) => roleIds.has(role.id))
      .reduce((total, role) => total | BigInt(role.permissions ?? 0), 0n);
    return (permissions & MENTION_EVERYONE) !== 0n;
  }

  const scheduledJson = (message, names = {}) => ({
    id: message.id,
    channelId: message.channelId,
    content: message.content,
    nextAt: message.nextAt,
    intervalMs: message.intervalMs,
    allowMentions: message.allowMentions,
    createdBy: message.createdBy,
    createdByName: names[message.createdBy] ?? null,
    createdAt: message.createdAt,
  });

  app.get("/api/guilds/:id/scheduled", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const messages = scheduledMessages.list(access.guildId);
    const names = await peopleNames(access.guildId, messages.map((message) => message.createdBy));
    return { messages: messages.map((message) => scheduledJson(message, names)), max: MAX_SCHEDULED };
  });

  app.post("/api/guilds/:id/scheduled", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const body = request.body ?? {};
    const refuse = (message) => reply.code(400).send({ error: "invalid-scheduled", message });
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    if (!channels.some((channel) => channel.id === body.channelId && SCHEDULE_CHANNELS.includes(channel.type))) {
      return refuse("Pick a text or announcement channel from this server.");
    }
    const content = typeof body.content === "string" ? body.content.replace(/\r\n?/g, "\n").trim() : "";
    if (!content || content.length > MAX_SCHEDULED_LENGTH) {
      return refuse(`Write a message of 1 to ${MAX_SCHEDULED_LENGTH} characters.`);
    }
    const now = Date.now();
    if (!Number.isSafeInteger(body.at) || body.at <= now || body.at > now + MAX_DELAY_MS) {
      return refuse("Pick a time in the future, within a year.");
    }
    const intervalMs = body.intervalMs ?? null;
    if (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) {
      return refuse("Repeat at most once an hour and at least once a year.");
    }
    if (scheduledMessages.count(guildId) >= MAX_SCHEDULED) {
      return refuse(`This server already has ${MAX_SCHEDULED} scheduled messages. Delete one first.`);
    }
    const saved = scheduledMessages.add({
      guildId,
      channelId: body.channelId,
      content,
      nextAt: body.at,
      intervalMs,
      allowMentions: await canMentionEveryone(guild, session.userId),
      createdBy: session.userId,
      createdAt: now,
    });
    await logAction(guildId, session, `**Scheduled message #${saved.id} added** for <#${saved.channelId}>`, [
      `First post: <t:${Math.floor(saved.nextAt / 1000)}:f>${intervalMs ? ` · repeats every ${Math.round(intervalMs / 3_600_000)}h` : ""}`,
    ]);
    return { message: scheduledJson(saved) };
  });

  app.delete("/api/guilds/:id/scheduled/:number", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    if (!scheduledMessages.deleteInGuild(access.guildId, number)) {
      return reply.code(404).send({ error: "not-found" });
    }
    await logAction(access.guildId, access.session, `**Scheduled message #${number} deleted**`);
    return { ok: true };
  });

  // --- Ban appeals ------------------------------------------------------------
  //
  // Anyone logged in can open a server's appeal page; only people the server
  // banned can send an appeal there. Staff accept (which lifts the ban) or deny.

  const DAY_MS = 24 * 60 * 60 * 1000;
  const appealLimit = { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } };

  const appealJson = (appeal, names = {}) => ({
    number: appeal.number,
    userId: appeal.userId,
    userTag: appeal.userTag,
    userName: names[appeal.userId] ?? null,
    banReason: appeal.banReason,
    answers: appeal.answers,
    status: appeal.status,
    createdAt: appeal.createdAt,
    decidedAt: appeal.decidedAt,
    decidedBy: appeal.decidedBy,
    decidedByName: names[appeal.decidedBy] ?? null,
    decisionReason: appeal.decisionReason,
  });

  // Where someone stands with a server's appeals: closed (appeals are off),
  // not-banned, pending (an appeal is open), cooldown (recently denied) or
  // can-appeal. Returns { state, ban, latest, cooldownEndsAt, config }.
  async function appealState(guildId, userId) {
    const config = normalizeAppeals(guildSettings.get(guildId, Setting.APPEALS));
    const latest = appeals.latestFor(guildId, userId);
    if (!config.enabled) {
      return { state: "closed", latest, config };
    }
    // Without Ban Members the bot can't check (403); treat it as not banned.
    const ban = await discord.ban(guildId, userId).catch(() => null);
    const cooldownEndsAt =
      latest?.status === AppealStatus.DENIED && config.cooldownDays > 0 ? latest.decidedAt + config.cooldownDays * DAY_MS : null;
    const state = !ban
      ? "not-banned"
      : latest?.status === AppealStatus.OPEN
        ? "pending"
        : cooldownEndsAt && cooldownEndsAt > Date.now()
          ? "cooldown"
          : "can-appeal";
    return { state, ban, latest, cooldownEndsAt, config };
  }

  // The appeal page's server, or undefined after replying 404.
  async function appealGuild(request, reply) {
    const guildId = request.params.guildId;
    if (!DISCORD_ID.test(guildId) || !(await discord.botGuildIds()).has(guildId)) {
      reply.code(404).send({ error: "not-found" });
      return undefined;
    }
    return discord.guild(guildId);
  }

  app.get("/api/appeals/:guildId", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return reply;
    }
    const guild = await appealGuild(request, reply);
    if (!guild) {
      return reply;
    }
    const { state, ban, latest, cooldownEndsAt, config: appealConfig } = await appealState(guild.id, session.userId);
    return {
      guild: { id: guild.id, name: guild.name, icon: guild.icon ?? null },
      state,
      banReason: ban?.reason ?? null,
      questions: appealQuestions(appealConfig),
      maxAnswer: MAX_ANSWER_LENGTH,
      latest: latest
        ? { number: latest.number, status: latest.status, createdAt: latest.createdAt, decidedAt: latest.decidedAt, decisionReason: latest.decisionReason }
        : null,
      cooldownEndsAt: state === "cooldown" ? cooldownEndsAt : null,
    };
  });

  app.post("/api/appeals/:guildId", appealLimit, async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return reply;
    }
    const guild = await appealGuild(request, reply);
    if (!guild) {
      return reply;
    }
    const { state, ban, config: appealConfig } = await appealState(guild.id, session.userId);
    if (state !== "can-appeal") {
      return reply.code(409).send({ error: state });
    }
    const questions = appealQuestions(appealConfig);
    const answers = Array.isArray(request.body?.answers) ? request.body.answers : [];
    const cleaned = answers.map((answer) => (typeof answer === "string" ? answer.replace(/\r\n?/g, "\n").trim() : ""));
    if (cleaned.length !== questions.length || cleaned.some((answer) => !answer || answer.length > MAX_ANSWER_LENGTH)) {
      return reply.code(400).send({ error: "bad-answers", message: `Answer every question (up to ${MAX_ANSWER_LENGTH} characters each).` });
    }
    const appeal = appeals.add({
      guildId: guild.id,
      userId: session.userId,
      userTag: session.username,
      banReason: ban?.reason ?? null,
      answers: questions.map((question, index) => ({ question, answer: cleaned[index] })),
    });
    logger.info("Ban appeal sent", { guildId: guild.id, number: appeal.number });

    // Tell staff where they asked, or in the mod-log or logs channel.
    const channelId =
      appealConfig.channelId ?? guildSettings.get(guild.id, Setting.MOD_LOG_CHANNEL) ?? guildSettings.get(guild.id, Setting.LOGS_CHANNEL);
    if (channelId) {
      const embed = {
        color: 0xfee75c,
        title: `Ban appeal #${appeal.number}`,
        description: `<@${session.userId}> (${session.username}) asks to be unbanned.`,
        fields: [
          { name: "Ban reason", value: (appeal.banReason ?? "*none given*").slice(0, 1024) },
          ...appeal.answers.map((entry) => ({ name: (entry.question ?? "Why should the ban be lifted?").slice(0, 256), value: entry.answer.slice(0, 1024) })),
          { name: "Decide", value: `${config.url}/g/${guild.id}/appeals?appeal=${appeal.number}` },
        ],
        footer: { text: `User ID ${session.userId}` },
        timestamp: new Date(appeal.createdAt).toISOString(),
      };
      await discord.postMessage(channelId, { embeds: [embed] }).catch((error) =>
        logger.warn("Couldn't post a ban appeal for staff", { guildId: guild.id, error }),
      );
    }
    return { appeal: { number: appeal.number, status: appeal.status, createdAt: appeal.createdAt } };
  });

  app.get("/api/guilds/:id/appeals", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const status = APPEAL_STATUSES.includes(request.query?.status) ? request.query.status : undefined;
    const page = Math.max(0, Number.parseInt(request.query?.page ?? "0", 10) || 0);
    const list = appeals.list(access.guildId, { status, limit: 26, offset: page * 25 });
    const shown = list.slice(0, 25);
    const names = await peopleNames(access.guildId, shown.flatMap((appeal) => [appeal.userId, appeal.decidedBy]));
    return { appeals: shown.map((appeal) => appealJson(appeal, names)), more: list.length > 25, openCount: appeals.countOpen(access.guildId) };
  });

  app.get("/api/guilds/:id/appeals/:number", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const appeal = appeals.get(access.guildId, number);
    if (!appeal) {
      return reply.code(404).send({ error: "not-found" });
    }
    const names = await peopleNames(access.guildId, [appeal.userId, appeal.decidedBy]);
    return { appeal: appealJson(appeal, names) };
  });

  app.post("/api/guilds/:id/appeals/:number", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    const number = access && caseNumber(request, reply);
    if (!number) {
      return reply;
    }
    const { guildId, session } = access;
    const decision = request.body?.decision;
    if (decision !== "accept" && decision !== "deny") {
      return reply.code(400).send({ error: "bad-decision" });
    }
    const reason = typeof request.body?.reason === "string" ? request.body.reason.trim().slice(0, MAX_REASON_LENGTH) || null : null;
    const appeal = appeals.get(guildId, number);
    if (!appeal) {
      return reply.code(404).send({ error: "not-found" });
    }
    if (appeal.status !== AppealStatus.OPEN) {
      return reply.code(409).send({ error: "already-decided" });
    }

    if (decision === "accept") {
      try {
        await discord.unban(guildId, appeal.userId, `Appeal #${number} accepted by ${session.username}${reason ? `: ${reason}` : ""}`);
      } catch (error) {
        // Already unbanned (10026 Unknown Ban) is fine; anything else isn't.
        if (error.status !== 404) {
          logger.warn("Couldn't lift a ban for an accepted appeal", { guildId, number, error });
          return reply.code(502).send({ error: "unban-failed", message: "Discord refused to lift the ban. Does the bot have Ban Members?" });
        }
      }
      const unbanCase = store.createCase({
        guildId,
        action: CaseAction.UNBAN,
        userId: appeal.userId,
        userTag: appeal.userTag ?? undefined,
        moderatorId: session.userId,
        moderatorTag: session.username,
        reason: `Appeal #${number} accepted${reason ? `: ${reason}` : ""}`,
      });
      const logChannelId = guildSettings.get(guildId, Setting.MOD_LOG_CHANNEL) ?? guildSettings.get(guildId, Setting.LOGS_CHANNEL);
      if (logChannelId) {
        const posted = await discord.postMessage(logChannelId, { embeds: [buildCaseEmbed(unbanCase).toJSON()] }).catch(() => null);
        if (posted?.id) {
          store.setLogMessage(guildId, unbanCase.number, logChannelId, posted.id);
        }
      }
    }
    const decided = appeals.decide(guildId, number, {
      status: decision === "accept" ? AppealStatus.ACCEPTED : AppealStatus.DENIED,
      decidedBy: session.userId,
      reason,
    });
    if (!decided) {
      return reply.code(409).send({ error: "already-decided" });
    }

    // Let them know, in the server's language. Fails quietly when DMs are closed.
    const guild = await discord.guild(guildId);
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const lines = [translate(language, decision === "accept" ? "appealAcceptedDm" : "appealDeniedDm", { server: guild.name })];
    if (reason) {
      lines.push(translate(language, "dmReason", { reason }));
    }
    await discord.dm(appeal.userId, { content: lines.join("\n").slice(0, 2000) }).catch(() => {});
    await logAction(guildId, session, `**Ban appeal #${number} ${decision === "accept" ? "accepted" : "denied"}** for <@${appeal.userId}>`, reason ? [reason] : []);
    const names = await peopleNames(guildId, [decided.userId, decided.decidedBy]);
    return { appeal: appealJson(decided, names) };
  });

  // --- Embed builder ------------------------------------------------------------

  // Posts and edits the bot's own messages: some text and one embed.
  const POSTABLE = new Set([0, 5]); // text and announcement channels

  // The checked message body, or undefined after replying 400.
  function messageBody(request, reply) {
    try {
      return checkMessage(request.body?.message);
    } catch (error) {
      if (error instanceof InvalidMessage) {
        reply.code(400).send({ error: "invalid-message", message: error.message });
        return undefined;
      }
      throw error;
    }
  }

  // Discord's refusals, in words.
  function discordRefused(reply, error) {
    if (error.status === 403) {
      return reply.code(403).send({ error: "bot-forbidden", message: "The bot can't post there. It needs View Channel, Send Messages and Embed Links in that channel." });
    }
    if (error.status === 404) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    if (error.status === 400) {
      return reply.code(400).send({ error: "discord-refused", message: "Discord refused the message. Check the image and icon links." });
    }
    throw error;
  }

  const sentJson = (entry, names = {}) => ({ ...entry, sentByName: names[entry.sentBy] ?? null, editedByName: names[entry.editedBy] ?? null });

  app.get("/api/guilds/:id/messages", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const list = sentMessages.list(access.guildId, 25);
    const names = await peopleNames(access.guildId, list.flatMap((entry) => [entry.sentBy, entry.editedBy]));
    return { messages: list.map((entry) => sentJson(entry, names)) };
  });

  app.post("/api/guilds/:id/messages", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const channelId = request.body?.channelId;
    const channels = await discord.channels(guildId);
    if (!channels.some((channel) => channel.id === channelId && POSTABLE.has(channel.type))) {
      return reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
    }
    const body = messageBody(request, reply);
    if (!body) {
      return reply;
    }
    let posted;
    try {
      posted = await discord.postMessage(channelId, body);
    } catch (error) {
      return discordRefused(reply, error);
    }
    const entry = sentMessages.add({ guildId, channelId, messageId: posted.id, summary: messageSummary(body), sentBy: session.userId });
    await logAction(guildId, session, `**Message posted** in <#${channelId}>`, [entry.summary]);
    return { message: sentJson(entry, { [session.userId]: session.username }) };
  });

  // Finds a bot message by its link, to edit it.
  app.get("/api/guilds/:id/messages/lookup", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const link = parseMessageLink(request.query?.link);
    if (!link || link.guildId !== access.guildId) {
      return reply.code(400).send({ error: "bad-link", message: "Paste a message link from this server (right-click the message → Copy Message Link)." });
    }
    const channels = await discord.channels(access.guildId);
    if (!channels.some((channel) => channel.id === link.channelId)) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    let message;
    try {
      message = await discord.message(link.channelId, link.messageId);
    } catch (error) {
      return discordRefused(reply, error);
    }
    if (!message) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    if (message.author?.id !== discord.clientId) {
      return reply.code(400).send({ error: "not-bot-message", message: "The bot can only edit its own messages." });
    }
    return { channelId: link.channelId, messageId: link.messageId, message: editableMessage(message) };
  });

  app.put("/api/guilds/:id/messages/:channelId/:messageId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const { channelId, messageId } = request.params;
    if (!DISCORD_ID.test(channelId) || !DISCORD_ID.test(messageId)) {
      return reply.code(400).send({ error: "bad-id" });
    }
    const channels = await discord.channels(guildId);
    if (!channels.some((channel) => channel.id === channelId)) {
      return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
    }
    const body = messageBody(request, reply);
    if (!body) {
      return reply;
    }
    try {
      const current = await discord.message(channelId, messageId);
      if (!current) {
        sentMessages.delete(guildId, messageId);
        return reply.code(404).send({ error: "not-found", message: "That message or channel is gone." });
      }
      if (current.author?.id !== discord.clientId) {
        return reply.code(400).send({ error: "not-bot-message", message: "The bot can only edit its own messages." });
      }
      await discord.editMessage(channelId, messageId, body);
    } catch (error) {
      return discordRefused(reply, error);
    }
    const summary = messageSummary(body);
    sentMessages.edited(guildId, messageId, { summary, editedBy: session.userId });
    await logAction(guildId, session, `**Message edited** in <#${channelId}>`, [summary, `https://discord.com/channels/${guildId}/${channelId}/${messageId}`]);
    return { ok: true };
  });

  // --- Branding ---------------------------------------------------------------

  // The bot's nickname, avatar and banner in this server are Discord's
  // per-server profile; the embed colour is saved here (see
  // branding/branding.js).
  const CDN = "https://cdn.discordapp.com";
  const imageUrl = (hash, path) => (hash ? `${CDN}/${path}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=512` : null);
  const brandingJson = (guildId, member, user) => {
    const userId = user?.id ?? discord.clientId;
    return {
      ...brandingOf(guildSettings, guildId),
      nickname: member?.nick ?? null,
      avatarUrl: imageUrl(member?.avatar, `guilds/${guildId}/users/${userId}/avatars`),
      bannerUrl: imageUrl(member?.banner, `guilds/${guildId}/users/${userId}/banners`),
      defaults: {
        name: user?.global_name ?? user?.username ?? "Rabble",
        avatarUrl: imageUrl(user?.avatar, `avatars/${userId}`),
        bannerUrl: imageUrl(user?.banner, `banners/${userId}`),
      },
    };
  };

  app.get("/api/guilds/:id/branding", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const [member, user] = await Promise.all([discord.botMember(access.guildId), discord.botUser()]);
    return brandingJson(access.guildId, member, user);
  });

  // Images come as data: URLs the page has already shrunk (an avatar is at
  // most 512×512), so 3 MB of JSON is enough for both.
  app.patch(
    "/api/guilds/:id/branding",
    { bodyLimit: 3 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const access = await requireGuild(request, reply, { manage: true });
      if (!access) {
        return reply;
      }
      const { guildId, session } = access;
      const before = brandingOf(guildSettings, guildId);
      let plan;
      try {
        plan = planBrandingChange(request.body, before);
      } catch (error) {
        if (error instanceof InvalidBranding) {
          return reply.code(400).send({ error: "invalid", message: error.message });
        }
        throw error;
      }
      let member;
      if (Object.keys(plan.profile).length > 0) {
        try {
          member = await discord.editBotProfile(guildId, plan.profile, `Branding changed on the dashboard by ${session.username}`);
        } catch (error) {
          return profileRefused(reply, error);
        }
      }
      const saved = { color: plan.saved.color ?? null };
      if (saved.color === null) {
        await guildSettings.clear(guildId, Setting.BRANDING);
      } else {
        await guildSettings.set(guildId, Setting.BRANDING, saved);
      }
      const changed = [
        plan.profile.nick !== undefined && (plan.profile.nick === null ? "Nickname reset" : `Nickname: ${plan.profile.nick}`),
        plan.profile.avatar !== undefined && (plan.profile.avatar === null ? "Avatar reset" : "New avatar"),
        plan.profile.banner !== undefined && (plan.profile.banner === null ? "Banner reset" : "New banner"),
        saved.color !== before.color && (saved.color === null ? "Embed colour reset" : `Embed colour: #${saved.color.toString(16).padStart(6, "0")}`),
      ].filter(Boolean);
      await logAction(guildId, session, "**Bot branding changed**", changed);
      const [current, user] = await Promise.all([member ?? discord.botMember(guildId), discord.botUser()]);
      return brandingJson(guildId, current, user);
    },
  );

  // Discord's answers to a profile change, in words.
  function profileRefused(reply, error) {
    if (error?.name?.startsWith("RateLimitError")) {
      const seconds = Math.max(1, Math.ceil((error.retryAfter ?? 0) / 1000));
      return reply.code(429).send({ error: "rate-limited", message: `Discord limits how often the bot's profile can change. Try again in ${seconds} seconds.` });
    }
    if (error.status === 403) {
      return reply.code(403).send({ error: "bot-forbidden", message: "The bot needs the Change Nickname permission to set its nickname here." });
    }
    if (error.status === 400) {
      return reply.code(400).send({ error: "discord-refused", message: "Discord refused that. Check the nickname and images, then try again." });
    }
    throw error;
  }

  // --- Country guide ----------------------------------------------------------

  // Posts the /country-help guide with the saved wording. Its buttons are
  // always the bot's own, so they can't be changed from here.
  app.post("/api/guilds/:id/country-guide", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const channelId = request.body?.channelId;
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    if (!channels.some((channel) => channel.id === channelId && POSTABLE.has(channel.type))) {
      return reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
    }
    let posted;
    try {
      posted = await discord.postMessage(channelId, countryGuideMessage(guildId, guild, channelId));
    } catch (error) {
      return discordRefused(reply, error);
    }
    const post = { channelId, messageId: posted.id };
    await guildSettings.set(guildId, Setting.COUNTRY_GUIDE_POST, post);
    await logAction(guildId, session, `**Country guide posted** in <#${channelId}>`, [`https://discord.com/channels/${guildId}/${channelId}/${posted.id}`]);
    return { post };
  });

  // --- Feeds ------------------------------------------------------------------

  const mentionText = (guildId, roleId) => (!roleId ? "nobody" : roleId === guildId ? "@everyone" : `<@&${roleId}>`);

  const feedJson = (feed) => ({
    id: feed.id,
    kind: feed.kind,
    source: feed.source,
    name: feed.name,
    channelId: feed.channelId,
    roleId: feed.roleId,
    message: feed.message,
    createdAt: feed.createdAt,
    checkedAt: feed.checkedAt,
    postedAt: feed.postedAt,
    lastError: feed.lastError,
    // Feeds with the same YouTube channel and posting channel show as one.
    youtubeChannel: youtubeChannelOf(feed),
  });

  // Checks where a feed posts, who it pings and its message, and answers 400
  // when one is wrong. @everyone (the role with the server's ID) only for
  // people who may ping it themselves.
  async function refuseFeedSettings(reply, guildId, session, { channelId, roleId, message }) {
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    if (typeof channelId !== "string" || !channels.some((channel) => channel.id === channelId && POSTABLE.has(channel.type))) {
      reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
      return true;
    }
    if (roleId !== null && (typeof roleId !== "string" || !guild.roles.some((role) => role.id === roleId))) {
      reply.code(400).send({ error: "bad-role", message: "Pick a role from this server." });
      return true;
    }
    if (roleId === guildId && !(await canMentionEveryone(guild, session.userId))) {
      reply.code(403).send({ error: "no-everyone", message: "Only people who can ping @everyone in this server can pick it." });
      return true;
    }
    if (message !== null && (typeof message !== "string" || message.length > MAX_FEED_MESSAGE_LENGTH)) {
      reply.code(400).send({ error: "bad-message", message: `The message is at most ${MAX_FEED_MESSAGE_LENGTH} characters.` });
      return true;
    }
    const variableProblem = message !== null && variableError(message, "feed");
    if (variableProblem) {
      reply.code(400).send({ error: "bad-message", message: variableProblem });
      return true;
    }
    return false;
  }

  app.get("/api/guilds/:id/feeds", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    return { feeds: feeds.list(access.guildId).map(feedJson), count: countFeeds(feeds, access.guildId), max: MAX_FEEDS, live: { twitch: Boolean(live.twitch), kick: Boolean(live.kick) } };
  });

  // Adding reads the feed once, which can take a few seconds. YouTube takes
  // `types` (any of videos, shorts, live; all three when left out) and
  // `messages` (one per type, else `message`) and saves one feed per type,
  // answered as `feeds`; `feed` is the first of them.
  app.post("/api/guilds/:id/feeds", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const { kind, source, channelId, roleId = null, message = null, types = Object.keys(YOUTUBE_TYPES), messages = {} } = request.body ?? {};
    if (!FEED_KINDS.includes(kind) || typeof source !== "string") {
      return reply.code(400).send({ error: "bad-feed", message: "Pick what kind of feed it is and type what to follow." });
    }
    const youtube = kind === "youtube";
    if (youtube && (!Array.isArray(types) || types.length === 0 || types.length > 3 || !types.every((type) => Object.hasOwn(YOUTUBE_TYPES, type)))) {
      return reply.code(400).send({ error: "no-types", message: "Pick at least one of videos, Shorts or live streams." });
    }
    const typeMessages = youtube && messages && typeof messages === "object" && !Array.isArray(messages) ? Object.fromEntries(types.map((type) => [type, messages[type] ?? message])) : {};
    if (await refuseFeedSettings(reply, guildId, session, { channelId, roleId, message })) {
      return reply;
    }
    for (const typeMessage of Object.values(typeMessages)) {
      if (await refuseFeedSettings(reply, guildId, session, { channelId, roleId, message: typeMessage })) {
        return reply;
      }
    }
    let added;
    try {
      const options = { store: feeds, guildId, source, channelId, roleId, message, createdBy: session.userId, fetchOptions: feedFetchOptions, live };
      added = youtube ? await addYoutubeFeeds({ ...options, types, messages: typeMessages }) : [await addFeed({ ...options, kind })];
    } catch (error) {
      if (error instanceof FeedLimit || error instanceof FeedDuplicate) {
        return reply.code(409).send({ error: "feed-refused", message: error.message });
      }
      if (error instanceof FeedError) {
        return reply.code(400).send({ error: error.reason, message: error.message });
      }
      throw error;
    }
    const [feed] = added;
    await logAction(
      guildId,
      session,
      `**Feed added:** ${feed.name} → <#${channelId}>`,
      added.map((item) => item.url),
    );
    return { feed: feedJson(feed), feeds: added.map(feedJson) };
  });

  // Changes where a feed posts, who it pings and its message. What it
  // follows can't change: remove it and add another.
  app.patch("/api/guilds/:id/feeds/:feedId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const id = Number.parseInt(request.params.feedId, 10);
    const feed = Number.isInteger(id) ? feeds.get(id) : undefined;
    if (!feed || feed.guildId !== guildId) {
      return reply.code(404).send({ error: "not-found" });
    }
    const body = request.body ?? {};
    const channelId = body.channelId ?? feed.channelId;
    const roleId = body.roleId === undefined ? feed.roleId : body.roleId;
    const message = body.message === undefined ? feed.message : typeof body.message === "string" ? body.message.trim() || null : body.message;
    // Someone who can't ping @everyone may still edit a feed that already does.
    const pingsEveryoneAlready = roleId === guildId && feed.roleId === guildId;
    if (await refuseFeedSettings(reply, guildId, session, { channelId, roleId: pingsEveryoneAlready ? null : roleId, message })) {
      return reply;
    }
    if (channelId !== feed.channelId && feeds.find(guildId, feed.url, channelId)) {
      return reply.code(409).send({ error: "feed-refused", message: "That feed already posts in that channel." });
    }
    const updated = feeds.update(guildId, id, { channelId, roleId, message });
    const changes = [
      channelId !== feed.channelId ? `Channel: <#${feed.channelId}> → <#${channelId}>` : null,
      roleId !== feed.roleId ? `Ping: ${mentionText(guildId, feed.roleId)} → ${mentionText(guildId, roleId)}` : null,
      message !== feed.message ? "Message changed" : null,
    ].filter(Boolean);
    await logAction(guildId, session, `**Feed edited:** ${feed.name}`, changes.length ? changes : ["No changes"]);
    return { feed: feedJson(updated) };
  });

  app.delete("/api/guilds/:id/feeds/:feedId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const id = Number.parseInt(request.params.feedId, 10);
    const feed = Number.isInteger(id) ? feeds.get(id) : undefined;
    if (!feed || feed.guildId !== access.guildId) {
      return reply.code(404).send({ error: "not-found" });
    }
    feeds.delete(access.guildId, id);
    await logAction(access.guildId, access.session, `**Feed removed:** ${feed.name}`, []);
    return { ok: true };
  });

  // --- Server stats ---------------------------------------------------------
  // The bot creates the channel for a new counter within a minute and renames
  // them as counts change (stats/statsUpdater.js); the dashboard only edits the list.

  const statsCounters = (guildId) => normalizeCounters(guildSettings.get(guildId, Setting.STATS_COUNTERS));

  app.get("/api/guilds/:id/counters", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    return { counters: statsCounters(access.guildId), presets: COUNTER_PRESETS, max: MAX_COUNTERS };
  });

  // Checks a template and category from the request body; null after replying 400.
  async function counterBody(request, reply, guildId) {
    let template;
    try {
      template = checkTemplate(request.body?.template);
    } catch (error) {
      if (error instanceof InvalidCounter) {
        reply.code(400).send({ error: "bad-template", message: error.message });
        return null;
      }
      throw error;
    }
    const categoryId = request.body?.categoryId ?? null;
    if (categoryId !== null && !(await discord.channels(guildId)).some((channel) => channel.id === categoryId && channel.type === 4 /* category */)) {
      reply.code(400).send({ error: "bad-category", message: "Pick a category from this server." });
      return null;
    }
    return { template, categoryId };
  }

  app.post("/api/guilds/:id/counters", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const counters = statsCounters(guildId);
    if (counters.length >= MAX_COUNTERS) {
      return reply.code(409).send({ error: "stats-full", message: `A server can have up to ${MAX_COUNTERS} counters.` });
    }
    const body = await counterBody(request, reply, guildId);
    if (!body) {
      return reply;
    }
    const counter = { id: newCounterId(), ...body, channelId: null, error: null };
    await guildSettings.set(guildId, Setting.STATS_COUNTERS, [...counters, counter]);
    await logAction(guildId, session, `**Stats counter added:** ${counter.template}`, []);
    return { counter };
  });

  app.patch("/api/guilds/:id/counters/:counterId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const counters = statsCounters(guildId);
    const counter = counters.find((each) => each.id === request.params.counterId);
    if (!counter) {
      return reply.code(404).send({ error: "not-found" });
    }
    let template;
    try {
      template = checkTemplate(request.body?.template);
    } catch (error) {
      if (error instanceof InvalidCounter) {
        return reply.code(400).send({ error: "bad-template", message: error.message });
      }
      throw error;
    }
    const updated = { ...counter, template };
    await guildSettings.set(
      guildId,
      Setting.STATS_COUNTERS,
      counters.map((each) => (each.id === counter.id ? updated : each)),
    );
    await logAction(guildId, session, `**Stats counter renamed:** ${counter.template} → ${template}`, []);
    return { counter: updated };
  });

  app.delete("/api/guilds/:id/counters/:counterId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const counters = statsCounters(guildId);
    const counter = counters.find((each) => each.id === request.params.counterId);
    if (!counter) {
      return reply.code(404).send({ error: "not-found" });
    }
    await guildSettings.set(
      guildId,
      Setting.STATS_COUNTERS,
      counters.filter((each) => each.id !== counter.id),
    );
    let channelDeleted = !counter.channelId;
    if (counter.channelId) {
      channelDeleted = await discord
        .deleteChannel(guildId, counter.channelId, "Server stats counter removed on the dashboard")
        .then(() => true)
        .catch((error) => error?.status === 404);
    }
    await logAction(guildId, session, `**Stats counter removed:** ${counter.template}`, []);
    return { ok: true, channelDeleted };
  });

  // --- Sticky messages ------------------------------------------------------
  // Saving posts the sticky right away; the bot keeps it at the bottom after that.

  const stickyJson = (sticky) => ({ channelId: sticky.channelId, content: sticky.content, createdBy: sticky.createdBy, updatedAt: sticky.updatedAt, posted: Boolean(sticky.messageId) });

  app.get("/api/guilds/:id/stickies", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    return { stickies: stickies.list(access.guildId).map(stickyJson), max: MAX_STICKIES, maxLength: MAX_STICKY_LENGTH };
  });

  app.put("/api/guilds/:id/stickies/:channelId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const { channelId } = request.params;
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!content || content.length > MAX_STICKY_LENGTH) {
      return reply.code(400).send({ error: "bad-content", message: `A sticky message is 1 to ${MAX_STICKY_LENGTH} characters.` });
    }
    const channels = await discord.channels(guildId);
    if (!channels.some((channel) => channel.id === channelId && POSTABLE.has(channel.type))) {
      return reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
    }
    const existing = stickies.get(channelId);
    if (existing && existing.guildId !== guildId) {
      return reply.code(400).send({ error: "bad-channel", message: "Pick a text or announcement channel." });
    }
    if (!existing && stickies.count(guildId) >= MAX_STICKIES) {
      return reply.code(409).send({ error: "stickies-full", message: `A server can have up to ${MAX_STICKIES} sticky messages.` });
    }
    let posted;
    try {
      posted = await discord.postMessage(channelId, { content });
    } catch (error) {
      return discordRefused(reply, error);
    }
    if (existing?.messageId) {
      await discord.deleteMessage(channelId, existing.messageId).catch(() => {});
    }
    const sticky = stickies.set({ channelId, guildId, content, messageId: posted.id, createdBy: session.userId });
    await logAction(guildId, session, `**Sticky message ${existing ? "changed" : "added"}** in <#${channelId}>`, [content.replace(/\s+/g, " ").slice(0, 200)]);
    return { sticky: stickyJson(sticky) };
  });

  app.delete("/api/guilds/:id/stickies/:channelId", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const sticky = stickies.get(request.params.channelId);
    if (!sticky || sticky.guildId !== access.guildId) {
      return reply.code(404).send({ error: "not-found" });
    }
    stickies.delete(sticky.channelId);
    if (sticky.messageId) {
      await discord.deleteMessage(sticky.channelId, sticky.messageId).catch(() => {});
    }
    await logAction(access.guildId, access.session, `**Sticky message removed** from <#${sticky.channelId}>`, []);
    return { ok: true };
  });

  // --- Role panels ------------------------------------------------------------
  // The same panels /rolepanel makes (community/rolePanels.js), with the same
  // checks. Saving posts or edits the panel's message first and only then
  // saves it, so a panel Discord refused is never saved half done. Changes
  // here take turns per server.

  const panelLocks = new KeyedLock();
  const panelLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  const panelNumber = (text) => (/^\d{1,6}$/.test(text ?? "") ? Number(text) : undefined);

  // What checkPanelInput needs: where panels may go, the server's roles, and
  // how high the bot's and this person's roles reach.
  async function panelContext(guildId, session) {
    const [guild, channels, botMember, member] = await Promise.all([
      discord.guild(guildId),
      discord.channels(guildId),
      discord.botMember(guildId).catch(() => null),
      discord.member(guildId, session.userId).catch(() => null),
    ]);
    const highest = (roleIds) => Math.max(0, ...guild.roles.filter((role) => roleIds?.includes(role.id)).map((role) => role.position));
    return {
      guild,
      guildId,
      roles: guild.roles,
      channelIds: new Set(channels.filter((channel) => POSTABLE.has(channel.type)).map((channel) => channel.id)),
      botTop: highest(botMember?.roles),
      adminTop: highest(member?.roles),
      isOwner: guild.owner_id === session.userId,
    };
  }

  // Edits the panel's message, or posts it (again) when it's new, was
  // deleted or moves to another channel. Returns the panel with its message ID.
  async function publishRolePanel(guildId, guild, panel, previous) {
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    const roleName = (roleId) => guild.roles.find((role) => role.id === roleId)?.name;
    const message = panelMessage(panel, roleName, translate(language, "rolePanelEmpty"), brandingOf(guildSettings, guildId).color ?? undefined);
    const payload = { embeds: message.embeds.map((embed) => embed.toJSON()), components: message.components.map((row) => row.toJSON()) };
    const sameChannel = Boolean(previous?.messageId) && previous.channelId === panel.channelId;
    if (sameChannel) {
      try {
        await discord.editMessage(panel.channelId, previous.messageId, payload);
        return { ...panel, messageId: previous.messageId };
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }
      }
    }
    const posted = await discord.postMessage(panel.channelId, payload);
    if (previous?.messageId && !sameChannel) {
      await discord.deleteMessage(previous.channelId, previous.messageId).catch(() => {});
    }
    return { ...panel, messageId: posted.id };
  }

  const savePanels = (guildId, panels) =>
    panels.length > 0 ? guildSettings.set(guildId, Setting.ROLE_PANELS, panels) : guildSettings.clear(guildId, Setting.ROLE_PANELS);

  function panelRefused(reply, error) {
    if (error.status === 400) {
      return reply.code(400).send({ error: "discord-refused", message: "Discord refused the panel. Check the emojis: a server emoji must be one the bot can use." });
    }
    return discordRefused(reply, error);
  }

  // Creates (panelId null) or changes a panel.
  async function saveRolePanel(request, reply, panelId) {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const context = await panelContext(guildId, session);
    let content;
    try {
      content = checkPanelInput(request.body, context);
    } catch (error) {
      if (error instanceof InvalidPanel) {
        return reply.code(400).send({ error: "invalid-panel", message: error.message });
      }
      throw error;
    }
    return panelLocks.run(guildId, async () => {
      // /rolepanel may have changed the panels from the bot's process.
      guildSettings.reloadIfChanged();
      const panels = panelsOf(guildSettings, guildId);
      const current = panelId === null ? undefined : panels.find((panel) => panel.id === panelId);
      if (panelId !== null && !current) {
        return reply.code(404).send({ error: "not-found", message: "That role panel was deleted. Reload the page." });
      }
      if (!current && panels.length >= MAX_PANELS) {
        return reply.code(409).send({ error: "panels-full", message: `A server can have up to ${MAX_PANELS} role panels.` });
      }
      const draft = { id: current?.id ?? Math.max(0, ...panels.map((panel) => panel.id)) + 1, ...content, messageId: current?.messageId ?? null };
      let posted;
      try {
        posted = await publishRolePanel(guildId, context.guild, draft, current);
      } catch (error) {
        return panelRefused(reply, error);
      }
      await savePanels(guildId, current ? panels.map((panel) => (panel === current ? posted : panel)) : [...panels, posted]);
      logger.info("Role panel saved from the dashboard", { guildId, userId: session.userId, panel: posted.id, roles: posted.roles.length });
      const roles = posted.roles.map((entry) => `<@&${entry.roleId}>`).join(" ");
      await logAction(guildId, session, `**Role panel ${current ? "changed" : "posted"}:** #${posted.id} ${posted.title} in <#${posted.channelId}>`, roles ? [roles] : []);
      return { panel: posted, settings: settingsJson(guildId) };
    });
  }

  app.post("/api/guilds/:id/role-panels", panelLimit, (request, reply) => saveRolePanel(request, reply, null));

  app.put("/api/guilds/:id/role-panels/:panelId", panelLimit, (request, reply) => {
    const panelId = panelNumber(request.params.panelId);
    return panelId === undefined ? reply.code(404).send({ error: "not-found" }) : saveRolePanel(request, reply, panelId);
  });

  app.delete("/api/guilds/:id/role-panels/:panelId", panelLimit, async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const panelId = panelNumber(request.params.panelId);
    return panelLocks.run(guildId, async () => {
      guildSettings.reloadIfChanged();
      const panels = panelsOf(guildSettings, guildId);
      const panel = panels.find((entry) => entry.id === panelId);
      if (!panel) {
        return reply.code(404).send({ error: "not-found", message: "That role panel was already deleted." });
      }
      if (panel.messageId) {
        await discord.deleteMessage(panel.channelId, panel.messageId).catch(() => {});
      }
      await savePanels(guildId, panels.filter((entry) => entry !== panel));
      await logAction(guildId, session, `**Role panel deleted:** #${panel.id} ${panel.title}`, []);
      return { settings: settingsJson(guildId) };
    });
  });

  // --- Backup ---------------------------------------------------------------

  app.get("/api/guilds/:id/backup", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const guild = await discord.guild(guildId);
    const backup = buildBackup({ guildId, guildName: guild.name, settings: guildSettings.all(guildId), secret: config.sessionSecret });
    await logAction(guildId, session, "**Settings backup downloaded**", []);
    const day = backup.exportedAt.slice(0, 10);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="settings-${guildId}-${day}.json"`)
      .send(JSON.stringify(backup, null, 2));
  });

  // { file, fileName, dryRun }: what restoring the uploaded file would change
  // (dryRun), or restores it. `file` is the file's text exactly as uploaded:
  // the server checks the file itself (readBackupFile), never a copy the
  // browser already parsed.
  // Room for the file's text once it's escaped into the JSON body.
  const restoreBodyLimit = BACKUP_LIMITS.bytes * 2 + 4096;
  app.post("/api/guilds/:id/backup/restore", { bodyLimit: restoreBodyLimit, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const body = request.body;
    const fields = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    if (!fields || fields.some((key) => !["file", "fileName", "dryRun"].includes(key)) || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) {
      return reply.code(400).send({ error: "invalid-backup", message: "Pick the .json file the Backup page downloaded." });
    }
    let backup;
    try {
      backup = readBackupFile(body.file, body.fileName);
    } catch (error) {
      if (error instanceof InvalidBackup) {
        return reply.code(400).send({ error: "invalid-backup", message: error.message });
      }
      throw error;
    }
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    let plan;
    try {
      plan = planRestore(backup, {
        guildId,
        channels,
        roles: guild.roles,
        isOwner: guild.owner_id === session.userId,
        canManagePermissions: await canManagePermissions(guild, session.userId),
        current: guildSettings.all(guildId),
        secret: config.sessionSecret,
      });
    } catch (error) {
      if (error instanceof InvalidBackup) {
        return reply.code(400).send({ error: "invalid-backup", message: error.message });
      }
      throw error;
    }
    const summary = {
      changes: Object.keys(plan.apply).map((setting) => ({ setting, label: settingLabel(setting) })),
      skipped: plan.skipped.map((entry) => ({ ...entry, label: settingLabel(entry.setting) })),
      unchanged: plan.unchanged,
    };
    if (body.dryRun !== false) {
      return { dryRun: true, ...summary };
    }
    for (const [setting, value] of Object.entries(plan.apply)) {
      if (value === null) {
        await guildSettings.clear(guildId, setting);
      } else {
        await guildSettings.set(guildId, setting, value);
      }
    }
    if (TICKET_PANEL_SETTINGS.some((setting) => setting in plan.apply)) {
      await redrawTicketPanel(guildId, guild);
    }
    await logAction(
      guildId,
      session,
      `**Settings restored from a backup** (${summary.changes.length} changed, ${summary.skipped.length} skipped)`,
      summary.changes.map((change) => change.label),
    );
    return { dryRun: false, ...summary };
  });

  // --- Permissions ----------------------------------------------------------

  // { preset, roles: { moderator, helper }, dryRun }: what a premade setup
  // would change ({ changes: [{ setting, label, before, after }] }), or applies it.
  app.post("/api/guilds/:id/permissions/preset", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    if (!(await canManagePermissions(guild, session.userId))) {
      return reply.code(403).send({ error: "permissions-only", message: "Only the server owner or whoever added the bot can change this." });
    }
    const roles = request.body?.roles && typeof request.body.roles === "object" ? request.body.roles : {};
    const isRole = (id) => typeof id === "string" && id !== guildId && guild.roles.some((role) => role.id === id && !role.managed);
    let changes;
    try {
      const plan = planPreset(request.body?.preset, { roles, isRole, current: guildSettings.all(guildId) });
      changes = checkSettingChanges(plan, { guildId, channels, roles: guild.roles });
    } catch (error) {
      if (error instanceof InvalidPreset || error instanceof InvalidSetting) {
        return reply.code(400).send({ error: "invalid-preset", message: error.message });
      }
      throw error;
    }
    const summary = Object.entries(changes)
      .filter(([setting, value]) => !sameValue(savedValue(guildId, setting), value))
      .map(([setting, value]) => ({ setting, label: SETTING_RULES[setting].label, before: savedValue(guildId, setting) ?? null, after: value }));
    if (request.body?.dryRun !== false) {
      return { dryRun: true, changes: summary };
    }
    const { lines, undo } = await saveSettings(guildId, guild, changes);
    if (lines.length > 0) {
      logger.info("Dashboard permission setup applied", { guildId, userId: session.userId, preset: request.body.preset });
      await logAction(guildId, session, "**Permission setup applied**", lines, undo);
    }
    return { dryRun: false, changes: summary, settings: settingsJson(guildId) };
  });

  // --- Activity -------------------------------------------------------------

  app.get("/api/guilds/:id/activity", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const before = Number.parseInt(request.query?.before ?? "", 10);
    const user = typeof request.query?.user === "string" && request.query.user ? request.query.user : null;
    if (user !== null && !DISCORD_ID.test(user)) {
      return reply.code(400).send({ error: "bad-user" });
    }
    const text = typeof request.query?.q === "string" ? request.query.q.slice(0, 100) : null;
    const page = activity.page(access.guildId, { before: Number.isSafeInteger(before) ? before : undefined, userId: user, text });
    // The people filter only needs loading with the first page.
    return Number.isSafeInteger(before) ? page : { ...page, people: activity.people(access.guildId) };
  });

  // Puts back what a settings change replaced. A setting someone changed
  // again since is left alone (listed in `skipped`).
  app.post("/api/guilds/:id/activity/:entry/undo", async (request, reply) => {
    const access = await requireGuild(request, reply, { manage: true });
    if (!access) {
      return reply;
    }
    const { guildId, session } = access;
    const entryId = Number.parseInt(request.params.entry, 10);
    const entry = Number.isSafeInteger(entryId) ? activity.get(guildId, entryId) : undefined;
    if (!entry?.undo) {
      return reply.code(404).send({ error: "cannot-undo", message: "This change can't be undone (it was already undone, or it wasn't a settings change)." });
    }
    const restore = {};
    const skipped = [];
    for (const [setting, { before, after }] of Object.entries(entry.undo)) {
      if (!SETTING_RULES[setting]) {
        continue;
      }
      if (sameValue(savedValue(guildId, setting), after)) {
        restore[setting] = before;
      } else {
        skipped.push(SETTING_RULES[setting].label);
      }
    }
    if (Object.keys(restore).length === 0) {
      return reply.code(409).send({ error: "changed-since", message: "Every setting in this change was changed again since, so there's nothing to undo.", skipped });
    }
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.channels(guildId)]);
    let changes;
    try {
      changes = checkSettingChanges(restore, { guildId, channels, roles: guild.roles });
    } catch (error) {
      if (error instanceof InvalidSetting) {
        return reply.code(409).send({ error: "invalid-setting", setting: error.setting ?? null, message: `This can't be undone: ${error.message}` });
      }
      throw error;
    }
    const refused = await refuseRestricted(guildId, guild, session, changes);
    if (refused) {
      return reply.code(403).send(refused);
    }
    if (!activity.markUndone(guildId, entryId)) {
      return reply.code(404).send({ error: "cannot-undo", message: "This change was already undone." });
    }
    const { lines, undo } = await saveSettings(guildId, guild, changes);
    if (skipped.length > 0) {
      lines.push(`Left as they are (changed again since): ${skipped.join(", ")}`);
    }
    logger.info("Dashboard change undone", { guildId, userId: session.userId, entry: entryId });
    await logAction(guildId, session, `**Undid a change** by ${entry.userName ?? entry.userId}`, lines, undo);
    return { settings: settingsJson(guildId), skipped };
  });

  return app;
}
