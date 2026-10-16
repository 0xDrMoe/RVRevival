import { ChannelType } from "discord.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboardConfig } from "../src/config.js";
import { buildDashboard } from "../src/dashboard/app.js";
import { canManage, DiscordApiError } from "../src/dashboard/discordApi.js";
import { SessionStore } from "../src/dashboard/sessions.js";
import { checkSettingChanges, InvalidSetting } from "../src/dashboard/settingsRules.js";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { closeDatabase, openDatabase } from "../src/storage/database.js";
import { fakeLogger } from "./helpers/fakes.js";

const URL_ORIGIN = "https://dash.example.com";
const GUILD_ID = "900000000000000001";
const OTHER_GUILD_ID = "900000000000000002";
const NO_BOT_GUILD_ID = "900000000000000003";
const USER_ID = "300000000000000001";
const ROLE_ID = "700000000000000001";
const TEXT_ID = "800000000000000001";
const LOGS_ID = "800000000000000002";
const VOICE_ID = "800000000000000003";
const SECRET = "x".repeat(40);
const MANAGE_GUILD = String(1 << 5);

const config = {
  token: ["a".repeat(24), "b".repeat(6), "c".repeat(27)].join("."),
  clientId: "100000000000000001",
  clientSecret: "client-secret",
  url: URL_ORIGIN,
  port: 3080,
  sessionSecret: SECRET,
};

function fakeDiscord() {
  return {
    clientId: config.clientId,
    authorizeUrl: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
    exchangeCode: vi.fn(async () => ({ accessToken: "user-access-token", expiresInSeconds: 604800 })),
    revokeToken: vi.fn(async () => {}),
    fetchUser: vi.fn(async () => ({ id: USER_ID, username: "moe", global_name: "Moe", avatar: null })),
    fetchUserGuilds: vi.fn(async () => [
      { id: GUILD_ID, name: "Rumbleverse Revival", icon: null, owner: false, permissions: MANAGE_GUILD },
      { id: OTHER_GUILD_ID, name: "Just a member", icon: null, owner: false, permissions: "0" },
      { id: NO_BOT_GUILD_ID, name: "My own server", icon: "abc", owner: true, permissions: "0" },
    ]),
    botGuildIds: vi.fn(async () => new Set([GUILD_ID, OTHER_GUILD_ID])),
    guild: vi.fn(async (id) => ({
      id,
      name: "Rumbleverse Revival",
      icon: null,
      roles: [
        { id, name: "@everyone", color: 0, position: 0, managed: false },
        { id: ROLE_ID, name: "Mods", color: 0, position: 3, managed: false },
      ],
    })),
    channels: vi.fn(async () => [
      { id: TEXT_ID, name: "general", type: ChannelType.GuildText, position: 1 },
      { id: LOGS_ID, name: "bot-logs", type: ChannelType.GuildText, position: 2 },
      { id: VOICE_ID, name: "Voice", type: ChannelType.GuildVoice, position: 3 },
    ]),
    member: vi.fn(async () => null),
    postMessage: vi.fn(async () => ({})),
    editMessage: vi.fn(async () => ({})),
  };
}

describe("dashboard", () => {
  let db;
  let discord;
  let guildSettings;
  let store;
  let app;

  beforeEach(async () => {
    db = openDatabase();
    discord = fakeDiscord();
    guildSettings = new GuildSettings(db);
    store = new CaseStore(db);
    app = await buildDashboard({ config, db, discord, guildSettings, store, logger: fakeLogger() });
  });

  afterEach(async () => {
    await app.close();
    closeDatabase(db);
  });

  // Logs in through Discord (faked) and returns the session cookie header.
  async function login() {
    const start = await app.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = start.cookies.find((cookie) => cookie.name === "rv_oauth_state");
    const state = new URL(start.headers.location).searchParams.get("state");
    const callback = await app.inject({
      method: "GET",
      url: `/auth/callback?code=abc&state=${state}`,
      cookies: { rv_oauth_state: stateCookie.value },
    });
    expect(callback.headers.location).toBe("/");
    const session = callback.cookies.find((cookie) => cookie.name === "rv_session");
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
    return { rv_session: session.value };
  }

  const write = (cookies, method, url, payload) =>
    app.inject({ method, url, cookies, payload, headers: { origin: URL_ORIGIN } });

  it("serves the page with strict security headers", async () => {
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Rumbleverse Revival");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("logs in with Discord and lists only the servers the person can manage", async () => {
    const cookies = await login();
    const me = await app.inject({ method: "GET", url: "/api/me", cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: USER_ID, username: "Moe" });
    expect(me.json().guilds).toEqual([
      { id: GUILD_ID, name: "Rumbleverse Revival", icon: null, botPresent: true, access: "manage" },
      { id: NO_BOT_GUILD_ID, name: "My own server", icon: "abc", botPresent: false, access: "manage" },
    ]);
    expect(me.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a login whose state doesn't match", async () => {
    const start = await app.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = start.cookies.find((cookie) => cookie.name === "rv_oauth_state");
    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=forged",
      cookies: { rv_oauth_state: stateCookie.value },
    });
    expect(callback.headers.location).toBe("/#/?login=failed");
    expect(callback.cookies.some((cookie) => cookie.name === "rv_session" && cookie.value)).toBe(false);
    expect(discord.exchangeCode).not.toHaveBeenCalled();
  });

  it("needs a login for the API", async () => {
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies: { rv_session: "made-up" } });
    expect(wrong.statusCode).toBe(401);
  });

  it("only opens servers the person manages and the bot is in", async () => {
    const cookies = await login();
    const ok = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().access).toBe("manage");
    expect(ok.json().roles).toEqual([
      { id: ROLE_ID, name: "Mods", color: 0, position: 3, managed: false, hoist: false, mentionable: false, permissions: "0", emoji: null },
    ]);
    expect(ok.json().channels.map((channel) => channel.id)).toEqual([TEXT_ID, LOGS_ID, VOICE_ID]);

    expect((await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}`, cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${NO_BOT_GUILD_ID}`, cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/guilds/not-an-id", cookies })).statusCode).toBe(404);
  });

  it("re-reads the server list from Discord only every few minutes", async () => {
    const cookies = await login();
    await app.inject({ method: "GET", url: "/api/me", cookies });
    await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(discord.fetchUserGuilds).toHaveBeenCalledTimes(1);
    await app.inject({ method: "GET", url: "/api/me?refresh=1", cookies });
    expect(discord.fetchUserGuilds).toHaveBeenCalledTimes(2);
  });

  it("ends the session when Discord no longer accepts the login", async () => {
    const cookies = await login();
    discord.fetchUserGuilds.mockRejectedValue(new DiscordApiError(401, "Unauthorized"));
    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(401);
    discord.fetchUserGuilds.mockResolvedValue([]);
    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(401);
  });

  it("saves settings, posts the change in the logs channel and refuses other sites", async () => {
    const cookies = await login();
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);

    const forged = await app.inject({
      method: "PUT",
      url: `/api/guilds/${GUILD_ID}/settings`,
      cookies,
      payload: { modRoleId: ROLE_ID },
      headers: { origin: "https://evil.example" },
    });
    expect(forged.statusCode).toBe(403);
    expect(guildSettings.get(GUILD_ID, Setting.MOD_ROLE)).toBeUndefined();

    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      modRoleId: ROLE_ID,
      disabledLogEvents: ["memberJoin"],
      logIgnoredChannels: [VOICE_ID],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({ modRoleId: ROLE_ID, disabledLogEvents: ["memberJoin"] });
    expect(guildSettings.getList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS)).toEqual([VOICE_ID]);
    const [channelId, payload] = discord.postMessage.mock.calls[0];
    expect(channelId).toBe(LOGS_ID);
    expect(payload.embeds[0].description).toContain(`**Mod role:** *none* → <@&${ROLE_ID}>`);

    const cleared = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { modRoleId: null });
    expect(cleared.json().settings.modRoleId).toBeUndefined();
  });

  it("rejects invalid settings without saving any of them", async () => {
    const cookies = await login();
    const cases = [
      { modRoleId: GUILD_ID },
      { staffRoleId: "700000000000000099" },
      { logsChannelId: VOICE_ID },
      { disabledLogEvents: ["everything"] },
      { somethingElse: "1" },
      { modRoleId: ROLE_ID, logsChannelId: "nope" },
    ];
    for (const payload of cases) {
      const response = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(guildSettings.all(GUILD_ID)).toEqual({});
  });

  it("searches, edits and deletes cases", async () => {
    const cookies = await login();
    for (const action of [CaseAction.WARN, CaseAction.BAN, CaseAction.WARN]) {
      store.createCase({ guildId: GUILD_ID, action, userId: USER_ID, moderatorId: "2", reason: "spam" });
    }
    store.setLogMessage(GUILD_ID, 3, LOGS_ID, "600000000000000001");

    const warns = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases?action=warn`, cookies });
    expect(warns.json().cases.map((entry) => entry.number)).toEqual([3, 1]);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases?user=abc`, cookies })).statusCode).toBe(400);

    const edited = await write(cookies, "PATCH", `/api/guilds/${GUILD_ID}/cases/3`, { reason: "  alt account " });
    expect(edited.json().case.reason).toBe("alt account");
    expect(discord.editMessage).toHaveBeenCalledWith(LOGS_ID, "600000000000000001", expect.objectContaining({ embeds: expect.any(Array) }));

    const tooLong = await write(cookies, "PATCH", `/api/guilds/${GUILD_ID}/cases/3`, { reason: "x".repeat(513) });
    expect(tooLong.statusCode).toBe(400);

    expect((await write(cookies, "DELETE", `/api/guilds/${GUILD_ID}/cases/2`)).statusCode).toBe(200);
    expect(store.getCase(GUILD_ID, 2)).toBeUndefined();
    expect((await write(cookies, "DELETE", `/api/guilds/${GUILD_ID}/cases/2`)).statusCode).toBe(404);
  });

  it("lets members with a dashboard role see the cases but not the settings", async () => {
    const cookies = await login();
    await guildSettings.set(OTHER_GUILD_ID, Setting.DASHBOARD_ROLES, [ROLE_ID]);
    discord.member.mockResolvedValue({ roles: [ROLE_ID] });

    const me = (await app.inject({ method: "GET", url: "/api/me", cookies })).json();
    expect(me.guilds.find((guild) => guild.id === OTHER_GUILD_ID)).toMatchObject({ access: "cases", botPresent: true });
    expect(discord.member).toHaveBeenCalledWith(OTHER_GUILD_ID, USER_ID);

    const guild = await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}`, cookies });
    expect(guild.json()).toMatchObject({ access: "cases", settings: null, channels: [], roles: [] });
    expect((await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}/cases`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}/stats`, cookies })).statusCode).toBe(200);
    const settings = await write(cookies, "PUT", `/api/guilds/${OTHER_GUILD_ID}/settings`, { modRoleId: ROLE_ID });
    expect(settings.statusCode).toBe(403);

    // Losing the role (or the setting) closes the door again.
    discord.member.mockResolvedValue({ roles: [] });
    expect((await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}/cases`, cookies })).statusCode).toBe(403);
    discord.member.mockResolvedValue(null);
    const after = (await app.inject({ method: "GET", url: "/api/me", cookies })).json();
    expect(after.guilds.map((entry) => entry.id)).not.toContain(OTHER_GUILD_ID);
  });

  it("saves dashboard roles", async () => {
    const cookies = await login();
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { dashboardRoleIds: [ROLE_ID, ROLE_ID] });
    expect(saved.json().settings.dashboardRoleIds).toEqual([ROLE_ID]);
    const everyone = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { dashboardRoleIds: [GUILD_ID] });
    expect(everyone.statusCode).toBe(400);
  });

  it("filters cases by moderator, actions, dates and text", async () => {
    const cookies = await login();
    const moderator = "300000000000000009";
    const add = (action, fields) =>
      store.createCase({ guildId: GUILD_ID, action, userId: USER_ID, moderatorId: "2", ...fields });
    add(CaseAction.WARN, { reason: "spam links", createdAt: 1_000 });
    add(CaseAction.BAN, { moderatorId: moderator, reason: "raid", createdAt: 2_000 });
    add(CaseAction.KICK, { userTag: "spammer#1", createdAt: 3_000 });
    add(CaseAction.NOTE, { reason: "100% sure", createdAt: 4_000 });

    const search = async (query) =>
      (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases?${query}`, cookies })).json();
    expect((await search(`moderator=${moderator}`)).cases.map((entry) => entry.number)).toEqual([2]);
    expect((await search("action=ban,kick")).cases.map((entry) => entry.number)).toEqual([3, 2]);
    expect((await search("from=2000&to=4000")).cases.map((entry) => entry.number)).toEqual([3, 2]);
    expect((await search("q=SPAM")).cases.map((entry) => entry.number)).toEqual([3, 1]);
    expect((await search("q=100%25")).cases.map((entry) => entry.number)).toEqual([4]);
    expect((await search("q=%25")).cases.map((entry) => entry.number)).toEqual([4]);
    expect((await search("action=warn")).total).toBe(1);

    for (const bad of ["action=ban,everything", "from=yesterday", "moderator=me", `q=${"x".repeat(101)}`]) {
      const response = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases?${bad}`, cookies });
      expect(response.statusCode, bad).toBe(400);
    }
  });

  it("exports cases as CSV that spreadsheets won't run", async () => {
    const cookies = await login();
    store.createCase({ guildId: GUILD_ID, action: CaseAction.WARN, userId: USER_ID, moderatorId: "2", reason: '=HYPERLINK("x")' });
    store.createCase({ guildId: GUILD_ID, action: CaseAction.BAN, userId: USER_ID, moderatorId: "2", reason: "line\nbreak, comma", durationMs: 3_600_000 });
    const response = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases/export?action=warn,ban`, cookies });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="cases-${GUILD_ID}.csv"`);
    const lines = response.body.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toMatch(/^Case,Action,Member ID/);
    expect(lines[1]).toContain('"line\nbreak, comma",60,');
    expect(lines[2]).toContain(`'=HYPERLINK(""x"")`);
  });

  it("counts cases per day in the viewer's time zone", async () => {
    const cookies = await login();
    const now = Date.now();
    store.createCase({ guildId: GUILD_ID, action: CaseAction.BAN, userId: USER_ID, moderatorId: "2", moderatorTag: "mod", createdAt: now });
    store.createCase({ guildId: GUILD_ID, action: CaseAction.WARN, userId: USER_ID, moderatorId: "2", createdAt: now - 40 * 86_400_000 });
    const stats = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/stats?tz=240`, cookies })).json();
    expect(stats.days).toBe(30);
    expect(stats.dayStarts).toHaveLength(30);
    expect(stats.perDay).toEqual([{ day: 29, action: "ban", total: 1 }]);
    expect(stats.dayStarts[29]).toBeLessThanOrEqual(now);
    expect(stats.dayStarts[29] + 86_400_000).toBeGreaterThan(now);
    expect(stats.topModerators).toEqual([{ id: "2", tag: "mod", total: 1 }]);
    expect(stats.caseCounts).toEqual({ ban: 1, warn: 1 });
    expect(stats.recent.map((entry) => entry.number)).toEqual([2, 1]);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/stats?tz=9999`, cookies })).statusCode).toBe(400);
  });

  it("pages through cases", async () => {
    const cookies = await login();
    for (let index = 0; index < 55; index += 1) {
      store.createCase({ guildId: GUILD_ID, action: CaseAction.NOTE, userId: USER_ID, moderatorId: "2" });
    }
    const first = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases`, cookies })).json();
    expect(first.cases).toHaveLength(50);
    expect(first.nextBefore).toBe(6);
    const second = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/cases?before=6`, cookies })).json();
    expect(second.cases.map((entry) => entry.number)).toEqual([5, 4, 3, 2, 1]);
    expect(second.nextBefore).toBeNull();
  });

  it("logs out and forgets the session", async () => {
    const cookies = await login();
    expect((await write(cookies, "POST", "/auth/logout")).statusCode).toBe(200);
    expect(discord.revokeToken).toHaveBeenCalledWith("user-access-token");
    expect((await app.inject({ method: "GET", url: "/api/me", cookies })).statusCode).toBe(401);
  });
});

describe("dashboard sessions", () => {
  it("stores only a hash of the token and an encrypted access token", () => {
    const db = openDatabase();
    const sessions = new SessionStore(db, { secret: SECRET });
    const token = sessions.create({ userId: USER_ID, username: "Moe", accessToken: "secret-access-token" });
    const row = db.prepare("SELECT * FROM dashboard_sessions").get();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.access_token).not.toContain("secret-access-token");
    expect(sessions.get(token).accessToken).toBe("secret-access-token");

    // Another secret can't read it.
    expect(new SessionStore(db, { secret: "y".repeat(40) }).get(token)).toBeUndefined();
    closeDatabase(db);
  });

  it("expires sessions", () => {
    const db = openDatabase();
    let now = 1_000_000;
    const sessions = new SessionStore(db, { secret: SECRET, now: () => now });
    const token = sessions.create({ userId: USER_ID, username: "Moe", accessToken: "t", expiresInSeconds: 60 });
    now += 61_000;
    expect(sessions.get(token)).toBeUndefined();
    expect(sessions.deleteExpired()).toBe(1);
    closeDatabase(db);
  });
});

describe("dashboard helpers", () => {
  it("knows who can manage a server", () => {
    expect(canManage({ owner: true, permissions: "0" })).toBe(true);
    expect(canManage({ permissions: String(1 << 5) })).toBe(true);
    expect(canManage({ permissions: String(1 << 3) })).toBe(true);
    expect(canManage({ permissions: String(1 << 4) })).toBe(false);
  });

  it("cleans up list settings", () => {
    const server = { guildId: GUILD_ID, roles: [], channels: [{ id: TEXT_ID, type: ChannelType.GuildText }] };
    expect(checkSettingChanges({ disabledLogEvents: ["memberJoin", "messageEdit", "memberJoin"] }, server)).toEqual({
      disabledLogEvents: ["messageEdit", "memberJoin"],
    });
    expect(checkSettingChanges({ logIgnoredChannels: [] }, server)).toEqual({ logIgnoredChannels: null });
    expect(() => checkSettingChanges([], server)).toThrow(InvalidSetting);
  });

  it("reads the dashboard settings from the environment", () => {
    const env = {
      DISCORD_TOKEN: config.token,
      DISCORD_CLIENT_ID: config.clientId,
      DISCORD_CLIENT_SECRET: "s",
      DASHBOARD_URL: "https://rumbleverse.example.com/",
      DASHBOARD_SESSION_SECRET: SECRET,
    };
    expect(loadDashboardConfig(env)).toMatchObject({ url: "https://rumbleverse.example.com", port: 3080 });
    expect(() => loadDashboardConfig({ ...env, DASHBOARD_URL: "http://rumbleverse.example.com" })).toThrow(/https/);
    expect(() => loadDashboardConfig({ ...env, DASHBOARD_SESSION_SECRET: "short" })).toThrow(/32/);
  });
});

describe("settings shared between the bot and the dashboard", () => {
  it("picks up changes another process saved", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rumbleverse-shared-"));
    const file = join(folder, "bot.db");
    const botDb = openDatabase(file);
    const dashboardDb = openDatabase(file);
    const bot = new GuildSettings(botDb);
    const dashboard = new GuildSettings(dashboardDb);

    expect(bot.reloadIfChanged()).toBe(false);
    await dashboard.set(GUILD_ID, Setting.MOD_ROLE, ROLE_ID);
    expect(bot.get(GUILD_ID, Setting.MOD_ROLE)).toBeUndefined();
    expect(bot.reloadIfChanged()).toBe(true);
    expect(bot.get(GUILD_ID, Setting.MOD_ROLE)).toBe(ROLE_ID);

    await dashboard.clear(GUILD_ID, Setting.MOD_ROLE);
    bot.reloadIfChanged();
    expect(bot.get(GUILD_ID, Setting.MOD_ROLE)).toBeUndefined();

    closeDatabase(botDb);
    closeDatabase(dashboardDb);
    await rm(folder, { recursive: true, force: true });
  });
});
