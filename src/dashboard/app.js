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
//
// Two levels of access to a server the bot is in:
//   - "manage": Manage Server, Administrator or the owner. Everything.
//   - "cases": anyone with one of the server's dashboard roles (a setting). The
//     overview and the cases, but not the settings.
// That is checked on every request: permissions against their Discord server
// list (re-read at most every few minutes), roles against the bot's view of
// the member (re-read at most every 30 seconds).
// Every change is posted in the server's logs channel, like bot commands are.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { normalizeAutomod } from "../automod/config.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { CaseAction } from "../moderation/caseStore.js";
import { buildCaseEmbed } from "../moderation/modLog.js";
import { Setting } from "../settings/guildSettings.js";
import { canManage, DiscordApiError } from "./discordApi.js";
import { SESSION_DAYS, SessionStore } from "./sessions.js";
import { checkSettingChanges, describeValue, InvalidSetting, SETTING_RULES } from "./settingsRules.js";

const PUBLIC_FOLDER = fileURLToPath(new URL("./public/", import.meta.url));
const SESSION_COOKIE = "rv_session";
const STATE_COOKIE = "rv_oauth_state";
// How long a person's Discord server list (and their permissions) is trusted.
const GUILD_LIST_MS = 5 * 60 * 1000;
const MAX_REASON_LENGTH = 512;
const CASES_PAGE = 50;
const EXPORT_LIMIT = 10_000;
const MAX_SEARCH_LENGTH = 100;
const STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_ID = /^\d{17,20}$/;
const CASE_ACTIONS = Object.values(CaseAction);

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
const roleJson = ({ id, name, color, position, managed, hoist, mentionable, permissions, unicode_emoji: emoji }) => ({
  id,
  name,
  color,
  position,
  managed,
  hoist: hoist ?? false,
  mentionable: mentionable ?? false,
  permissions: permissions ?? "0",
  emoji: emoji ?? null,
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

const sameText = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Options:
//   config          from loadDashboardConfig
//   db              the open database (shared with the bot)
//   discord         from createDiscordApi
//   guildSettings   GuildSettings on the same database
//   store           CaseStore on the same database
//   logger
export async function buildDashboard({ config, db, discord, guildSettings, store, logger }) {
  const sessions = new SessionStore(db, { secret: config.sessionSecret });
  const secureCookies = config.url.startsWith("https://");
  const cookieOptions = { path: "/", httpOnly: true, secure: secureCookies, sameSite: "lax" };

  // nginx (or Caddy) on the same machine forwards requests to us.
  const app = Fastify({ logger: false, trustProxy: "127.0.0.1", bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(fastifyStatic, { root: PUBLIC_FOLDER, index: "index.html" });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/")) {
      reply.header("Cache-Control", "no-store");
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
      return reply.redirect("/#/?login=failed");
    }
    let token;
    let user;
    try {
      token = await discord.exchangeCode(String(code));
      user = await discord.fetchUser(token.accessToken);
    } catch (loginError) {
      logger.warn("Dashboard login failed", { error: loginError });
      return reply.redirect("/#/?login=failed");
    }
    const sessionToken = sessions.create({
      userId: user.id,
      username: user.global_name ?? user.username,
      avatar: user.avatar,
      accessToken: token.accessToken,
      expiresInSeconds: token.expiresInSeconds,
    });
    reply.setCookie(SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: SESSION_DAYS * 24 * 60 * 60 });
    logger.info("Dashboard login", { userId: user.id });
    return reply.redirect("/");
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

  // A server's settings for the browser. Automod always comes with every
  // default filled in, so the page can show it as it is.
  const settingsJson = (guildId) => ({
    ...guildSettings.all(guildId),
    [Setting.AUTOMOD]: normalizeAutomod(guildSettings.get(guildId, Setting.AUTOMOD)),
  });

  const communityDefaults = (guild) => {
    const language = pickLanguage(guild.preferred_locale, config.forcedLanguage);
    return {
      [Setting.WELCOME_MESSAGE]: translate(language, "welcomeDefaultWelcome"),
      [Setting.LEAVE_MESSAGE]: translate(language, "welcomeDefaultLeave"),
    };
  };

  // Posts what someone did on the dashboard in the server's logs channel.
  async function logAction(guildId, session, summary, lines = []) {
    const channelId = guildSettings.get(guildId, Setting.LOGS_CHANNEL);
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
        inviteUrl:
          `https://discord.com/oauth2/authorize?client_id=${discord.clientId}` +
          "&scope=bot+applications.commands&permissions=1374792314006",
      };
    });
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
      caseCounts: store.countGuildCases(guildId),
      // What the bot posts when no welcome or leave message is set, in the server's language.
      communityDefaults: manage ? communityDefaults(guild) : null,
    };
  });

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

    const lines = [];
    for (const [setting, value] of Object.entries(changes)) {
      const saved = guildSettings.get(guildId, setting);
      // Unsaved automod means the defaults, which is what the page was shown.
      const before = setting === Setting.AUTOMOD ? normalizeAutomod(saved) : saved;
      if (JSON.stringify(before ?? null) === JSON.stringify(value)) {
        continue;
      }
      if (value === null) {
        await guildSettings.clear(guildId, setting);
      } else {
        await guildSettings.set(guildId, setting, value);
      }
      lines.push(`**${SETTING_RULES[setting].label}:** ${describeValue(setting, before)} → ${describeValue(setting, value)}`);
    }
    if (lines.length > 0) {
      logger.info("Dashboard settings change", { guildId, userId: session.userId, settings: Object.keys(changes) });
      await logAction(guildId, session, "**Settings changed**", lines);
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

  return app;
}
