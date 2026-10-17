import { ChannelType } from "discord.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboardConfig } from "../src/config.js";
import { buildDashboard, idCreatedAt } from "../src/dashboard/app.js";
import { canManage, DiscordApiError } from "../src/dashboard/discordApi.js";
import { SessionStore } from "../src/dashboard/sessions.js";
import { checkSettingChanges, InvalidSetting } from "../src/dashboard/settingsRules.js";
import { defaultAutomod } from "../src/automod/config.js";
import { DEFAULT_LEVELING } from "../src/leveling/config.js";
import { LevelStore } from "../src/leveling/levelStore.js";
import { TicketStore } from "../src/tickets/ticketStore.js";
import { MemberEvent, MemberEventStore } from "../src/members/memberEventStore.js";
import { SavedRoles, SavedRoleStore } from "../src/members/savedRoleStore.js";
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
    user: vi.fn(async () => null),
    ban: vi.fn(async () => null),
    searchMembers: vi.fn(async () => []),
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
      { id: ROLE_ID, name: "Mods", country: false, color: 0, position: 3, managed: false, hoist: false, mentionable: false, permissions: "0", emoji: null },
    ]);
    expect(ok.json().channels.map((channel) => channel.id)).toEqual([TEXT_ID, LOGS_ID, VOICE_ID]);

    expect((await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}`, cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${NO_BOT_GUILD_ID}`, cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/guilds/not-an-id", cookies })).statusCode).toBe(404);
  });

  it("marks the roles named after a country, the way /country finds them", async () => {
    discord.guild.mockImplementation(async (id) => ({
      id,
      name: "Rumbleverse Revival",
      roles: [
        { id: "700000000000000011", name: "Canada", position: 4, managed: false },
        { id: "700000000000000012", name: "  côte d’ivoire ", position: 3, managed: false },
        { id: "700000000000000013", name: "Canada Fans", position: 2, managed: false },
        { id: "700000000000000014", name: "Canada", position: 1, managed: true },
      ],
    }));
    const cookies = await login();
    const { roles } = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies })).json();
    expect(roles.map((role) => role.country)).toEqual([true, true, false, false]);
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

  it("saves skipped setup steps in order and refuses unknown ones", async () => {
    const cookies = await login();
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { setupSkipped: ["welcome", "country", "welcome"] });
    expect(saved.json().settings.setupSkipped).toEqual(["country", "welcome"]);
    const unknown = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { setupSkipped: ["everything"] });
    expect(unknown.statusCode).toBe(400);
    const cleared = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { setupSkipped: [] });
    expect(cleared.json().settings.setupSkipped).toBeUndefined();
  });

  it("shows automod with its defaults, and saves a valid configuration", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);
    const cookies = await login();
    const guild = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(guild.json().settings.automod).toEqual(defaultAutomod());

    const wanted = defaultAutomod();
    wanted.enabled = true;
    wanted.rules.invites = { enabled: true, action: "warn" };
    wanted.rules.links.allowedDomains = ["https://www.YouTube.com/"];
    wanted.exemptRoleIds = [ROLE_ID];
    wanted.exemptChannelIds = [VOICE_ID];
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { automod: wanted });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.automod.rules.links.allowedDomains).toEqual(["youtube.com"]);
    expect(guildSettings.get(GUILD_ID, Setting.AUTOMOD)).toMatchObject({ enabled: true, exemptRoleIds: [ROLE_ID] });
    const [, logged] = discord.postMessage.mock.calls.at(-1);
    expect(logged.embeds[0].description).toContain("**Automod:** off → on · Invite link (warn)");

    const bad = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      automod: { ...wanted, timeoutMinutes: 0 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid-setting", setting: "automod" });
    const foreign = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      automod: { ...wanted, exemptRoleIds: [GUILD_ID] },
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("shows leveling with its defaults, saves it and refuses roles the bot shouldn't give", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);
    const cookies = await login();
    const guild = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(guild.json().settings.leveling).toEqual({ ...DEFAULT_LEVELING });

    const wanted = {
      ...DEFAULT_LEVELING,
      enabled: true,
      announce: "channel",
      announceChannelId: TEXT_ID,
      message: "  GG {user}, level {level}!  ",
      rewards: [{ level: 10, roleId: ROLE_ID }],
      noXpChannelIds: [VOICE_ID],
    };
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { leveling: wanted });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.leveling).toMatchObject({ enabled: true, message: "GG {user}, level {level}!", noXpChannelIds: [VOICE_ID] });
    const [, logged] = discord.postMessage.mock.calls.at(-1);
    expect(logged.embeds[0].description).toContain(`**Leveling:** off · announce here → on · announce channel · rewards 10: <@&${ROLE_ID}>`);

    // Saving the same thing again changes nothing and logs nothing.
    const posts = discord.postMessage.mock.calls.length;
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { leveling: { ...wanted, message: "GG {user}, level {level}!" } });
    expect(discord.postMessage.mock.calls.length).toBe(posts);

    const refusals = [
      { ...wanted, announceChannelId: VOICE_ID },
      { ...wanted, rewards: [{ level: 0, roleId: ROLE_ID }] },
      { ...wanted, rewards: [{ level: 5, roleId: GUILD_ID }] },
      { ...wanted, rewards: [{ level: 5, roleId: ROLE_ID }, { level: 6, roleId: ROLE_ID }] },
      { ...wanted, enabled: "yes" },
    ];
    for (const leveling of refusals) {
      const bad = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { leveling });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: "invalid-setting", setting: "leveling" });
    }
    discord.guild.mockImplementation(async (id) => ({
      id,
      name: "Rumbleverse Revival",
      roles: [{ id: ROLE_ID, name: "Admins", position: 5, managed: false, permissions: String(1 << 3) }],
    }));
    const admin = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { leveling: wanted });
    expect(admin.statusCode).toBe(400);
  });

  it("shows the XP leaderboard a page at a time, and a member's level in their history", async () => {
    const levels = new LevelStore(db);
    for (let index = 0; index < 30; index += 1) {
      levels.setXp(GUILD_ID, `3000000000000001${String(index).padStart(2, "0")}`, (index + 1) * 100, `member${index}`);
    }
    levels.setXp(GUILD_ID, "300000000000000999", 0, "nobody");
    const cookies = await login();
    const first = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/levels`, cookies })).json();
    expect(first).toMatchObject({ enabled: false, page: 1, pageSize: 25, total: 30 });
    expect(first.entries).toHaveLength(25);
    expect(first.entries[0]).toMatchObject({ rank: 1, userId: "300000000000000129", userTag: "member29", xp: 3000, level: 8 });
    const second = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/levels?page=2`, cookies })).json();
    expect(second.entries.map((entry) => entry.rank)).toEqual([26, 27, 28, 29, 30]);
    const silly = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/levels?page=-4`, cookies })).json();
    expect(silly.page).toBe(1);

    store.createCase({ guildId: GUILD_ID, action: CaseAction.NOTE, userId: "300000000000000100", moderatorId: USER_ID });
    const history = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/300000000000000100`, cookies })).json();
    expect(history.level).toEqual({ level: 1, current: 0, needed: 155, xp: 100, messages: 0, rank: 30 });
    store.createCase({ guildId: GUILD_ID, action: CaseAction.NOTE, userId: "300000000000000999", moderatorId: USER_ID });
    const none = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/300000000000000999`, cookies })).json();
    expect(none.level).toBeNull();
  });

  it("saves the community settings and shows the default messages", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);
    const cookies = await login();
    const guild = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(guild.json().communityDefaults.welcomeMessage).toContain("{user}");
    expect(guild.json().guild.community).toBe(false);

    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      welcomeChannelId: TEXT_ID,
      welcomeMessage: "  Hi {user}\r\nWelcome!  ",
      welcomeDm: "   ",
      autoroleIds: [ROLE_ID],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({ welcomeChannelId: TEXT_ID, welcomeMessage: "Hi {user}\nWelcome!", autoroleIds: [ROLE_ID] });
    expect(guildSettings.get(GUILD_ID, Setting.WELCOME_DM)).toBeUndefined();
    const [, logged] = discord.postMessage.mock.calls.at(-1);
    expect(logged.embeds[0].description).toContain('**Welcome message:** *none* → "Hi {user} Welcome!"');

    const tooLong = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { leaveMessage: "x".repeat(1001) });
    expect(tooLong.json()).toMatchObject({ error: "invalid-setting", setting: "leaveMessage" });
    const voice = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { leaveChannelId: VOICE_ID });
    expect(voice.statusCode).toBe(400);

    const ADMIN_ROLE = "700000000000000002";
    const BOT_ROLE = "700000000000000003";
    discord.guild.mockImplementation(async (id) => ({
      id,
      name: "Rumbleverse Revival",
      roles: [
        { id: ADMIN_ROLE, name: "Admins", position: 5, managed: false, permissions: String(1 << 3) },
        { id: BOT_ROLE, name: "Some bot", position: 4, managed: true, permissions: "0" },
      ],
    }));
    for (const roleId of [ADMIN_ROLE, BOT_ROLE]) {
      const refused = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { autoroleIds: [roleId] });
      expect(refused.json()).toMatchObject({ error: "invalid-setting", setting: "autoroleIds" });
    }
  });

  it("saves custom commands, cleaned and sorted, and refuses bad ones", async () => {
    const cookies = await login();
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      tags: [
        { name: "Rules", content: " Be nice\r\nNo spam " },
        { name: "download", content: "https://example.com" },
      ],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.tags).toEqual([
      { name: "download", content: "https://example.com" },
      { name: "rules", content: "Be nice\nNo spam" },
    ]);
    for (const tags of [
      [{ name: "a:b", content: "x" }],
      [{ name: "faq", content: "  " }],
      [{ name: "faq", content: "x" }, { name: "FAQ", content: "y" }],
      [{ name: "faq", content: "x".repeat(2001) }],
    ]) {
      const refused = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { tags });
      expect(refused.json()).toMatchObject({ error: "invalid-setting", setting: "tags" });
    }
    const cleared = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { tags: [] });
    expect(cleared.json().settings.tags).toBeUndefined();
  });

  it("saves auto-responders and refuses ones limited to a voice channel", async () => {
    const cookies = await login();
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      autoResponders: [{ trigger: " Server IP ", match: "word", reply: "play.example.com", channelId: TEXT_ID }],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.autoResponders).toEqual([{ trigger: "server ip", match: "word", reply: "play.example.com", channelId: TEXT_ID }]);
    const refused = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      autoResponders: [{ trigger: "ip", reply: "x", channelId: VOICE_ID }],
    });
    expect(refused.json()).toMatchObject({ error: "invalid-setting", setting: "autoResponders" });
  });

  it("schedules, lists and deletes messages", async () => {
    const cookies = await login();
    const at = Date.now() + 60 * 60 * 1000;
    const added = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/scheduled`, {
      channelId: TEXT_ID,
      content: " Weekly news\r\n ",
      at,
      intervalMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(added.statusCode).toBe(200);
    // Without Mention Everyone, mentions won't ping.
    expect(added.json().message).toMatchObject({ channelId: TEXT_ID, content: "Weekly news", nextAt: at, allowMentions: false });
    const id = added.json().message.id;

    const list = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/scheduled`, cookies });
    expect(list.json()).toMatchObject({ max: 25, messages: [{ id, content: "Weekly news" }] });

    for (const body of [
      { channelId: VOICE_ID, content: "x", at, intervalMs: null },
      { channelId: TEXT_ID, content: " ", at, intervalMs: null },
      { channelId: TEXT_ID, content: "x", at: Date.now() - 1000, intervalMs: null },
      { channelId: TEXT_ID, content: "x", at, intervalMs: 60_000 },
    ]) {
      const refused = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/scheduled`, body);
      expect(refused.statusCode).toBe(400);
    }

    const deleted = await write(cookies, "DELETE", `/api/guilds/${GUILD_ID}/scheduled/${id}`);
    expect(deleted.json()).toEqual({ ok: true });
    const again = await write(cookies, "DELETE", `/api/guilds/${GUILD_ID}/scheduled/${id}`);
    expect(again.statusCode).toBe(404);
  });

  it("records every dashboard change on the Activity page, even without a logs channel", async () => {
    const cookies = await login();
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { modRoleId: ROLE_ID });
    const at = Date.now() + 60 * 60 * 1000;
    const added = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/scheduled`, { channelId: TEXT_ID, content: "Hi", at, intervalMs: null });
    expect(discord.postMessage).not.toHaveBeenCalled();

    const page = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/activity`, cookies });
    expect(page.statusCode).toBe(200);
    const { entries, next } = page.json();
    expect(next).toBeNull();
    expect(entries.map((entry) => entry.summary)).toEqual([
      `**Scheduled message #${added.json().message.id} added** for <#${TEXT_ID}>`,
      "**Settings changed**",
    ]);
    expect(entries[1]).toMatchObject({ userId: USER_ID, userName: "Moe" });
    expect(entries[1].lines.join("\n")).toContain(ROLE_ID);

    const older = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/activity?before=${entries[1].id}`, cookies });
    expect(older.json()).toEqual({ entries: [], next: null });
  });

  it("saves birthday settings and refuses bad time zones and moderator roles", async () => {
    const cookies = await login();
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      birthdays: { channelId: TEXT_ID, roleId: null, message: " 🎂 {user}! ", timezone: "Europe/London" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.birthdays).toEqual({ channelId: TEXT_ID, roleId: null, message: "🎂 {user}!", timezone: "Europe/London" });
    for (const birthdays of [
      { channelId: TEXT_ID, timezone: "Nowhere/City" },
      { channelId: VOICE_ID, timezone: "UTC" },
      { roleId: GUILD_ID, timezone: "UTC" },
    ]) {
      const refused = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { birthdays });
      expect(refused.json()).toMatchObject({ error: "invalid-setting", setting: "birthdays" });
    }
    const off = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { birthdays: { channelId: null, roleId: null } });
    expect(off.json().settings.birthdays).toBeUndefined();
  });

  it("never saves role panels from the dashboard", async () => {
    const cookies = await login();
    const response = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { rolePanels: [] });
    expect(response.statusCode).toBe(400);
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

  it("finds members by name, or anyone by user ID", async () => {
    const cookies = await login();
    const MEMBER_ID = "300000000000000009";
    discord.searchMembers.mockResolvedValue([
      { nick: "Champ", user: { id: MEMBER_ID, username: "rumbler", global_name: "Rumbler", avatar: null } },
    ]);
    const byName = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members?q=rum`, cookies });
    expect(byName.json().members).toEqual([
      { id: MEMBER_ID, username: "rumbler", displayName: "Champ", avatar: null, bot: false, inServer: true },
    ]);
    expect(discord.searchMembers).toHaveBeenCalledWith(GUILD_ID, "rum");

    discord.user.mockResolvedValue({ id: MEMBER_ID, username: "rumbler", global_name: null, avatar: "abc" });
    const byId = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members?q=${MEMBER_ID}`, cookies });
    expect(byId.json().members).toEqual([
      { id: MEMBER_ID, username: "rumbler", displayName: "rumbler", avatar: "abc", bot: false, inServer: false },
    ]);

    const empty = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members?q=`, cookies });
    expect(empty.statusCode).toBe(400);
    const tooLong = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members?q=${"a".repeat(33)}`, cookies });
    expect(tooLong.statusCode).toBe(400);
  });

  it("shows a member's history: cases, roles, joins and leaves", async () => {
    const cookies = await login();
    const MEMBER_ID = "300000000000000009";
    const events = new MemberEventStore(db);
    events.record(GUILD_ID, MEMBER_ID, MemberEvent.JOIN, 1000);
    events.record(GUILD_ID, MEMBER_ID, MemberEvent.LEAVE, 2000);
    events.record(GUILD_ID, MEMBER_ID, MemberEvent.JOIN, 3000);
    store.createCase({ guildId: GUILD_ID, action: CaseAction.WARN, userId: MEMBER_ID, userTag: "rumbler", moderatorId: USER_ID, reason: "Spam" });
    store.createCase({ guildId: GUILD_ID, action: CaseAction.NOTE, userId: MEMBER_ID, moderatorId: USER_ID, reason: "Alt?" });
    const timeoutEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    discord.member.mockImplementation(async (guildId, userId) =>
      userId === MEMBER_ID
        ? {
            nick: null,
            joined_at: "2026-01-02T00:00:00.000Z",
            communication_disabled_until: timeoutEnd,
            roles: [ROLE_ID, "700000000000000099"],
            user: { id: MEMBER_ID, username: "rumbler", global_name: "Rumbler", avatar: null },
          }
        : null,
    );

    const response = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/${MEMBER_ID}`, cookies });
    expect(response.statusCode).toBe(200);
    const history = response.json();
    expect(history.user).toMatchObject({ id: MEMBER_ID, username: "rumbler", displayName: "Rumbler", createdAt: idCreatedAt(MEMBER_ID) });
    expect(history.member).toEqual({
      joinedAt: Date.parse("2026-01-02T00:00:00.000Z"),
      timedOutUntil: Date.parse(timeoutEnd),
      // Roles the server no longer has are left out.
      roles: [{ id: ROLE_ID, name: "Mods", color: 0 }],
    });
    expect(history.caseCounts).toEqual({ warn: 1, note: 1 });
    expect(history.cases.map((entry) => entry.action)).toEqual(["note", "warn"]);
    expect(history.events).toEqual([
      { kind: "join", at: 3000 },
      { kind: "leave", at: 2000 },
      { kind: "join", at: 1000 },
    ]);
    expect(history.joins).toBe(2);
    expect(history.tickets).toEqual([]);
    expect(history.banned).toBeNull();
    expect(history.quarantine).toBeNull();
    expect(discord.ban).not.toHaveBeenCalled();

    new SavedRoleStore(db).save({ guildId: GUILD_ID, userId: MEMBER_ID, kind: SavedRoles.QUARANTINE, roleIds: [ROLE_ID], reason: "alt", moderatorId: USER_ID, savedAt: 9_000 });
    const quarantined = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/${MEMBER_ID}`, cookies });
    expect(quarantined.json().quarantine).toEqual({ since: 9_000, reason: "alt", moderatorId: USER_ID, roleIds: [ROLE_ID] });
  });

  it("shows someone who left and was banned, from their cases alone if Discord doesn't know them", async () => {
    const cookies = await login();
    const GONE_ID = "300000000000000008";
    store.createCase({
      guildId: GUILD_ID,
      action: CaseAction.BAN,
      userId: GONE_ID,
      userTag: "spammer",
      moderatorId: USER_ID,
      durationMs: 60 * 60 * 1000,
      expiresAt: Date.now() + 60 * 60 * 1000,
      pendingUnban: true,
    });
    discord.ban.mockResolvedValue({ reason: "Scam links" });
    const response = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/${GONE_ID}`, cookies });
    const history = response.json();
    expect(history.member).toBeNull();
    expect(history.user).toMatchObject({ id: GONE_ID, username: "spammer", displayName: "spammer" });
    expect(history.banned).toEqual({ reason: "Scam links" });
    expect(history.tempBanEndsAt).toBeGreaterThan(Date.now());

    // Nobody Discord knows and no cases: not found.
    const unknown = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/300000000000000007`, cookies });
    expect(unknown.statusCode).toBe(404);
    // A failed ban lookup (no Ban Members permission) doesn't break the page.
    discord.ban.mockRejectedValue(Object.assign(new Error("Missing Permissions"), { status: 403 }));
    const noPermission = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/members/${GONE_ID}`, cookies });
    expect(noPermission.json().banned).toBeNull();
  });

  it("lets members with a dashboard role see member history", async () => {
    await guildSettings.set(OTHER_GUILD_ID, Setting.DASHBOARD_ROLES, [ROLE_ID]);
    discord.member.mockImplementation(async (guildId, userId) => (userId === USER_ID ? { roles: [ROLE_ID] } : null));
    const cookies = await login();
    store.createCase({ guildId: OTHER_GUILD_ID, action: CaseAction.WARN, userId: "300000000000000009", moderatorId: USER_ID });
    const response = await app.inject({ method: "GET", url: `/api/guilds/${OTHER_GUILD_ID}/members/300000000000000009`, cookies });
    expect(response.statusCode).toBe(200);
  });

  it("lists tickets with names, filters them, and shows and downloads a transcript", async () => {
    const MEMBER_ID = "300000000000000009";
    const ticketStore = new TicketStore(db);
    for (let index = 0; index < 30; index += 1) {
      const ticket = ticketStore.open({ guildId: GUILD_ID, userId: index === 29 ? MEMBER_ID : `3000000000000002${String(index).padStart(2, "0")}`, subject: `Ticket ${index}`, createdAt: index });
      if (index < 28) {
        ticketStore.close(ticket.id, { closedBy: USER_ID, closedAt: 100 + index, reason: "Done" });
      }
    }
    ticketStore.setTranscript(ticketStore.byNumber(GUILD_ID, 1).id, "Ticket #1 · Rumbleverse Revival\nhello", 2);
    discord.member.mockImplementation(async (guildId, userId) =>
      userId === MEMBER_ID ? { nick: "Champ", roles: [], user: { id: MEMBER_ID, username: "rumbler" } } : null,
    );
    const cookies = await login();

    const first = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets`, cookies })).json();
    expect(first.tickets).toHaveLength(25);
    expect(first.tickets[0]).toMatchObject({ number: 30, userId: MEMBER_ID, userName: "Champ", closedAt: null, hasTranscript: false });
    expect(first).toMatchObject({ next: 6, openCount: 2, panel: false });
    const rest = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets?before=6`, cookies })).json();
    expect(rest.tickets.map((ticket) => ticket.number)).toEqual([5, 4, 3, 2, 1]);
    expect(rest.next).toBeNull();
    const open = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets?status=open`, cookies })).json();
    expect(open.tickets.map((ticket) => ticket.number)).toEqual([30, 29]);
    const mine = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets?user=${MEMBER_ID}`, cookies })).json();
    expect(mine.tickets.map((ticket) => ticket.number)).toEqual([30]);
    const bad = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets?user=nope`, cookies });
    expect(bad.statusCode).toBe(400);

    const one = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets/1`, cookies })).json();
    expect(one.ticket).toMatchObject({ number: 1, closeReason: "Done", hasTranscript: true, messageCount: 2 });
    expect(one.transcript).toContain("hello");
    const file = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets/1?download=1`, cookies });
    expect(file.headers["content-disposition"]).toBe('attachment; filename="ticket-0001.txt"');
    expect(file.body).toContain("hello");
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets/2?download=1`, cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/tickets/99`, cookies })).statusCode).toBe(404);
  });

  it("saves raid protection and refuses bad values", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);
    const cookies = await login();
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { joinGate: { minAgeDays: 7, action: "kick", alertJoins: 10 } });
    expect(saved.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.JOIN_GATE)).toEqual({ minAgeDays: 7, action: "kick", alertJoins: 10 });
    const [, logged] = discord.postMessage.mock.calls.at(-1);
    expect(logged.embeds[0].description).toContain("**Raid protection:** *none* → kick accounts under 7 days · alert at 10 joins a minute");
    for (const joinGate of [{ minAgeDays: 0, action: "kick", alertJoins: null }, { minAgeDays: 5, action: "ban", alertJoins: null }, { minAgeDays: null, action: "kick", alertJoins: 1 }]) {
      const bad = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { joinGate });
      expect(bad.json()).toMatchObject({ error: "invalid-setting", setting: "joinGate" });
    }
    // The lockdown itself can't be written from the dashboard.
    const lockdown = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { lockdown: { channels: [] } });
    expect(lockdown.statusCode).toBe(400);
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { joinGate: null });
    expect(guildSettings.get(GUILD_ID, Setting.JOIN_GATE)).toBeUndefined();
  });

  it("lets only the server owner change anti-nuke", async () => {
    const MOD_ID = "300000000000000077";
    const cookies = await login();
    const antiNuke = {
      enabled: true,
      punishment: "strip",
      limits: { channelDelete: 3, channelCreate: 6, roleDelete: 3, ban: 8, kick: 8, webhookCreate: 3 },
      trustedUserIds: [MOD_ID],
    };
    const refused = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { antiNuke });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "owner-only", setting: "antiNuke" });
    // Sending it back unchanged (the page saves every field) is fine.
    const unchanged = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, {
      antiNuke: { ...antiNuke, enabled: false, trustedUserIds: [] },
    });
    expect(unchanged.statusCode).toBe(200);

    const base = discord.guild.getMockImplementation();
    discord.guild.mockImplementation(async (id) => ({ ...(await base(id)), owner_id: USER_ID }));
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { antiNuke });
    expect(saved.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.ANTI_NUKE)).toEqual(antiNuke);
    const page = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(page.json()).toMatchObject({ isOwner: true, settings: { antiNuke }, people: { [MOD_ID]: null } });
  });

  it("lets only the owner or whoever added the bot change command permissions", async () => {
    const cookies = await login();
    const rules = { ban: { roleIds: [ROLE_ID] } };
    const refused = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { commandRules: rules });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "permissions-only", setting: "commandRules" });
    const preview = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/permissions/preset`, { preset: "oneTeam", roles: { moderator: ROLE_ID } });
    expect(preview.statusCode).toBe(403);

    // Whoever added the bot, from the audit log, is remembered.
    discord.botInviter = vi.fn(async () => USER_ID);
    const page = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies });
    expect(page.json()).toMatchObject({ canManagePermissions: true, botInviterId: USER_ID });
    expect(page.json().commands).toContainEqual({ name: "ban", permission: "4", roleMode: "grant" });
    expect(guildSettings.get(GUILD_ID, Setting.BOT_INVITER)).toBe(USER_ID);

    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { commandRules: rules });
    expect(saved.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.COMMAND_RULES)).toEqual({
      ban: { disabled: false, roleIds: [ROLE_ID], blockedRoleIds: [], channelIds: [] },
    });
    expect((await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { commandRules: { nope: { disabled: true } } })).statusCode).toBe(400);
  });

  it("previews and applies a premade permission setup", async () => {
    const base = discord.guild.getMockImplementation();
    discord.guild.mockImplementation(async (id) => ({ ...(await base(id)), owner_id: USER_ID }));
    const cookies = await login();
    const url = `/api/guilds/${GUILD_ID}/permissions/preset`;
    expect((await write(cookies, "POST", url, { preset: "oneTeam", roles: {} })).statusCode).toBe(400);

    const preview = await write(cookies, "POST", url, { preset: "oneTeam", roles: { moderator: ROLE_ID } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true });
    expect(preview.json().changes.map((change) => change.setting).sort()).toEqual(
      [Setting.DASHBOARD_ROLES, Setting.MOD_ROLE, Setting.PERMISSION_PRESET, Setting.STAFF_ROLE].sort(),
    );
    expect(guildSettings.get(GUILD_ID, Setting.MOD_ROLE)).toBeUndefined();

    const applied = await write(cookies, "POST", url, { preset: "oneTeam", roles: { moderator: ROLE_ID }, dryRun: false });
    expect(applied.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.MOD_ROLE)).toBe(ROLE_ID);
    expect(guildSettings.get(GUILD_ID, Setting.DASHBOARD_ROLES)).toEqual([ROLE_ID]);
    expect(guildSettings.get(GUILD_ID, Setting.PERMISSION_PRESET)).toBe("oneTeam");

    // Changing the command rules by hand afterwards makes the setup custom.
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { commandRules: { kick: { disabled: true } } });
    expect(guildSettings.get(GUILD_ID, Setting.PERMISSION_PRESET)).toBe("custom");
  });

  it("posts dashboard changes in their own log channel when one is set", async () => {
    const cookies = await login();
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { logsChannelId: LOGS_ID, logRoutes: { dashboard: TEXT_ID } });
    discord.postMessage.mockClear();
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { welcomeMessage: "Hi {user}" });
    expect(discord.postMessage).toHaveBeenCalledWith(TEXT_ID, expect.anything());
    expect((await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { logRoutes: { cases: VOICE_ID } })).statusCode).toBe(400);
  });

  it("takes a ban appeal from a banned member and lets staff decide it", async () => {
    discord.unban = vi.fn(async () => {});
    discord.dm = vi.fn(async () => ({}));
    const cookies = await login();
    const appealUrl = `/api/appeals/${GUILD_ID}`;

    // Appeals are off until staff turn them on.
    expect((await app.inject({ method: "GET", url: appealUrl, cookies })).json()).toMatchObject({ state: "closed" });
    expect((await app.inject({ method: "GET", url: `/api/appeals/${NO_BOT_GUILD_ID}`, cookies })).statusCode).toBe(404);
    const appeals = { enabled: true, channelId: TEXT_ID, questions: ["Why were you banned?"], cooldownDays: 7 };
    expect((await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { appeals })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: appealUrl, cookies })).json()).toMatchObject({ state: "not-banned" });

    discord.ban.mockImplementation(async () => ({ reason: "spam", user: { id: USER_ID } }));
    const form = (await app.inject({ method: "GET", url: appealUrl, cookies })).json();
    expect(form).toMatchObject({ state: "can-appeal", banReason: "spam", questions: ["Why were you banned?"], guild: { id: GUILD_ID } });
    expect((await write(cookies, "POST", appealUrl, { answers: [] })).statusCode).toBe(400);
    const sent = await write(cookies, "POST", appealUrl, { answers: [" I spammed, sorry. "] });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().appeal).toMatchObject({ number: 1, status: "open" });
    expect(discord.postMessage).toHaveBeenCalledWith(TEXT_ID, expect.objectContaining({ embeds: [expect.objectContaining({ title: "Ban appeal #1" })] }));
    expect(JSON.stringify(discord.postMessage.mock.calls.at(-1)[1])).toContain(`${URL_ORIGIN}/#/g/${GUILD_ID}/appeals?appeal=1`);
    // One open appeal at a time.
    expect((await write(cookies, "POST", appealUrl, { answers: ["again"] })).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: appealUrl, cookies })).json()).toMatchObject({ state: "pending" });

    const list = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/appeals?status=open`, cookies })).json();
    expect(list).toMatchObject({ openCount: 1, more: false, appeals: [{ number: 1, banReason: "spam", answers: [{ question: "Why were you banned?", answer: "I spammed, sorry." }] }] });
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/appeals/1`, cookies })).json().appeal.number).toBe(1);
    expect((await write(cookies, "POST", `/api/guilds/${GUILD_ID}/appeals/1`, { decision: "maybe" })).statusCode).toBe(400);

    const accepted = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/appeals/1`, { decision: "accept", reason: "Second chance" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().appeal).toMatchObject({ status: "accepted", decidedBy: USER_ID, decisionReason: "Second chance" });
    expect(discord.unban).toHaveBeenCalledWith(GUILD_ID, USER_ID, expect.stringContaining("Appeal #1 accepted"));
    expect(store.listCases(GUILD_ID, USER_ID).find((entry) => entry.action === CaseAction.UNBAN)).toMatchObject({ userId: USER_ID, moderatorId: USER_ID });
    expect(discord.dm).toHaveBeenCalledWith(USER_ID, { content: "Your ban appeal for **Rumbleverse Revival** was accepted. You can join again.\nReason: Second chance" });
    expect((await write(cookies, "POST", `/api/guilds/${GUILD_ID}/appeals/1`, { decision: "deny" })).statusCode).toBe(409);
  });

  it("makes someone wait after a denied appeal", async () => {
    discord.dm = vi.fn(async () => ({}));
    const cookies = await login();
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { appeals: { enabled: true, channelId: null, questions: [], cooldownDays: 7 } });
    discord.ban.mockImplementation(async () => ({ reason: null }));
    const form = (await app.inject({ method: "GET", url: `/api/appeals/${GUILD_ID}`, cookies })).json();
    expect(form.questions).toEqual([null]);
    await write(cookies, "POST", `/api/appeals/${GUILD_ID}`, { answers: ["please"] });
    const denied = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/appeals/1`, { decision: "deny" });
    expect(denied.json().appeal.status).toBe("denied");
    expect(discord.dm.mock.calls[0][1].content).toBe("Your ban appeal for **Rumbleverse Revival** was denied.");
    const after = (await app.inject({ method: "GET", url: `/api/appeals/${GUILD_ID}`, cookies })).json();
    expect(after.state).toBe("cooldown");
    expect(after.cooldownEndsAt).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect((await write(cookies, "POST", `/api/appeals/${GUILD_ID}`, { answers: ["again"] })).statusCode).toBe(409);
  });

  it("shows the country guide's built-in text and fixed buttons", async () => {
    const cookies = await login();
    const { countryGuide } = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies })).json();
    expect(countryGuide.defaults).toMatchObject({ title: "Get your country role", stepsTitle: "How to get it", color: 0x5865f2 });
    expect(countryGuide.buttons.flat().map((button) => button.label)).toContain("Type my country");
    expect(countryGuide.post).toBeNull();
  });

  it("posts the country guide and updates it when its wording is saved", async () => {
    const cookies = await login();
    discord.postMessage = vi.fn(async () => ({ id: "610000000000000001" }));
    expect((await write(cookies, "POST", `/api/guilds/${GUILD_ID}/country-guide`, { channelId: VOICE_ID })).statusCode).toBe(400);

    const posted = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/country-guide`, { channelId: TEXT_ID });
    expect(posted.json().post).toEqual({ channelId: TEXT_ID, messageId: "610000000000000001" });
    const [channelId, payload] = discord.postMessage.mock.calls.find(([id]) => id === TEXT_ID);
    expect(channelId).toBe(TEXT_ID);
    expect(payload.embeds[0].title).toBe("Get your country role");
    expect(payload.components.flatMap((row) => row.components.map((button) => button.custom_id))).toContain("country-guide:translate");

    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { countryGuide: { title: "Pick your flag", color: 0xeb459e } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.countryGuide).toEqual({ title: "Pick your flag", color: 0xeb459e });
    const [editChannel, editId, edit] = discord.editMessage.mock.calls.at(-1);
    expect([editChannel, editId]).toEqual([TEXT_ID, "610000000000000001"]);
    expect(edit.embeds[0]).toMatchObject({ title: "Pick your flag", color: 0xeb459e });

    // The buttons can't be changed.
    const buttons = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { countryGuide: { buttons: [] } });
    expect(buttons.statusCode).toBe(400);
  });

  it("forgets a posted country guide that was deleted", async () => {
    const cookies = await login();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_GUIDE_POST, { channelId: TEXT_ID, messageId: "610000000000000001" });
    discord.editMessage = vi.fn(async () => {
      throw new DiscordApiError(404, "Unknown Message");
    });
    const saved = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { countryGuide: { title: "Pick your flag" } });
    expect(saved.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.COUNTRY_GUIDE_POST)).toBeUndefined();
  });

  it("saves ticket types and redraws the posted panel", async () => {
    const cookies = await login();
    const ticketCategories = [{ id: "bugs", label: "Bug report", emoji: "🐞", description: null, staffRoleId: ROLE_ID, questions: ["What happened?"] }];
    // No panel yet: just saved.
    expect((await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { ticketCategories })).statusCode).toBe(200);
    expect(discord.editMessage).not.toHaveBeenCalled();

    await guildSettings.set(GUILD_ID, Setting.TICKETS, { channelId: TEXT_ID, messageId: "600000000000000001", staffRoleId: null, title: "Help desk", message: null });
    const both = [...ticketCategories, { id: "other", label: "Other", emoji: null, description: "Anything else", staffRoleId: null, questions: [] }];
    expect((await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { ticketCategories: both })).statusCode).toBe(200);
    const [channelId, messageId, payload] = discord.editMessage.mock.calls[0];
    expect([channelId, messageId]).toEqual([TEXT_ID, "600000000000000001"]);
    expect(payload.embeds[0]).toMatchObject({ title: "Help desk", fields: [{ name: "Other", value: "Anything else" }] });
    expect(payload.components[0].components.map((button) => button.custom_id)).toEqual(["tk:open:bugs", "tk:open:other"]);

    // A panel from before titles were saved keeps its text: only the buttons change.
    await guildSettings.set(GUILD_ID, Setting.TICKETS, { channelId: TEXT_ID, messageId: "600000000000000001", staffRoleId: null });
    await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { ticketCategories: null });
    expect(discord.editMessage.mock.calls[1][2]).toEqual({ components: [expect.objectContaining({ components: [expect.objectContaining({ custom_id: "tk:open" })] })] });

    const bad = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { ticketCategories: [{ ...ticketCategories[0], emoji: "nope" }] });
    expect(bad.statusCode).toBe(400);
  });

  it("posts and edits the bot's messages from the embed builder", async () => {
    const posted = new Map();
    discord.postMessage = vi.fn(async (channelId, body) => {
      const id = "810000000000000001";
      posted.set(id, { id, author: { id: config.clientId }, ...body });
      return { id };
    });
    discord.editMessage = vi.fn(async (channelId, id, body) => posted.set(id, { ...posted.get(id), ...body }));
    discord.message = vi.fn(async (channelId, id) => posted.get(id) ?? null);
    const cookies = await login();
    const message = { content: "Hello", embed: { title: "Patch notes", description: "Big changes", color: 0x5865f2, fields: [] } };

    expect((await write(cookies, "POST", `/api/guilds/${GUILD_ID}/messages`, { channelId: VOICE_ID, message })).statusCode).toBe(400);
    expect((await write(cookies, "POST", `/api/guilds/${GUILD_ID}/messages`, { channelId: TEXT_ID, message: { content: "" } })).statusCode).toBe(400);
    const sent = await write(cookies, "POST", `/api/guilds/${GUILD_ID}/messages`, { channelId: TEXT_ID, message });
    expect(sent.statusCode).toBe(200);
    expect(discord.postMessage).toHaveBeenCalledWith(TEXT_ID, { content: "Hello", embeds: [{ title: "Patch notes", description: "Big changes", color: 0x5865f2 }] });
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/messages`, cookies })).json().messages).toMatchObject([{ summary: "Patch notes", channelId: TEXT_ID, sentBy: USER_ID }]);

    const link = `https://discord.com/channels/${GUILD_ID}/${TEXT_ID}/810000000000000001`;
    const found = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/messages/lookup?link=${encodeURIComponent(link)}`, cookies });
    expect(found.json()).toMatchObject({ channelId: TEXT_ID, messageId: "810000000000000001", message: { content: "Hello", embed: { title: "Patch notes" } } });
    const otherServer = `https://discord.com/channels/${OTHER_GUILD_ID}/${TEXT_ID}/810000000000000001`;
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/messages/lookup?link=${encodeURIComponent(otherServer)}`, cookies })).statusCode).toBe(400);

    const edited = await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/messages/${TEXT_ID}/810000000000000001`, { message: { content: "", embed: { title: "Patch notes v2" } } });
    expect(edited.statusCode).toBe(200);
    expect(discord.editMessage).toHaveBeenCalledWith(TEXT_ID, "810000000000000001", { content: "", embeds: [{ title: "Patch notes v2" }] });
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/messages`, cookies })).json().messages[0]).toMatchObject({ summary: "Patch notes v2", editedBy: USER_ID });

    // Someone else's message can't be edited.
    posted.set("810000000000000002", { id: "810000000000000002", author: { id: USER_ID }, content: "mine" });
    expect((await write(cookies, "PUT", `/api/guilds/${GUILD_ID}/messages/${TEXT_ID}/810000000000000002`, { message: { content: "x" } })).statusCode).toBe(400);
  });

  it("follows and unfollows feeds", async () => {
    await app.close();
    const rss = `<rss><channel><title>Patch News</title><item><title>One</title><guid>1</guid></item></channel></rss>`;
    const feedFetchOptions = {
      fetchImpl: vi.fn(async (url) => (String(url) === "https://example.com/rss" ? new Response(rss) : new Response("", { status: 404 }))),
      lookup: vi.fn(async () => [{ address: "93.184.216.34" }]),
    };
    app = await buildDashboard({ config, db, discord, guildSettings, store, logger: fakeLogger(), feedFetchOptions });
    const cookies = await login();
    const add = (body) => write(cookies, "POST", `/api/guilds/${GUILD_ID}/feeds`, { kind: "rss", source: "https://example.com/rss", channelId: TEXT_ID, ...body });

    expect((await add({ kind: "tiktok" })).statusCode).toBe(400);
    expect((await add({ channelId: VOICE_ID })).statusCode).toBe(400);
    expect((await add({ roleId: GUILD_ID })).statusCode).toBe(400);
    expect((await add({ message: "x".repeat(501) })).statusCode).toBe(400);
    expect((await add({ source: "http://127.0.0.1/" })).json()).toMatchObject({ error: "blocked" });
    const added = await add({ roleId: ROLE_ID, message: "New: {title}" });
    expect(added.statusCode).toBe(200);
    expect(added.json().feed).toMatchObject({ id: 1, name: "Patch News", roleId: ROLE_ID, message: "New: {title}" });
    expect((await add({})).statusCode).toBe(409);

    const list = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/feeds`, cookies });
    expect(list.json()).toMatchObject({ max: 10, feeds: [{ id: 1, kind: "rss", channelId: TEXT_ID }] });
    expect((await write(cookies, "DELETE", `/api/guilds/${GUILD_ID}/feeds/2`)).statusCode).toBe(404);
    expect((await write(cookies, "DELETE", `/api/guilds/${GUILD_ID}/feeds/1`)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/feeds`, cookies })).json().feeds).toEqual([]);
  });

  it("adds, renames and removes server stats counters", async () => {
    discord.deleteChannel = vi.fn(async () => {});
    const cookies = await login();
    const base = `/api/guilds/${GUILD_ID}/counters`;
    expect((await write(cookies, "POST", base, { template: "no number" })).statusCode).toBe(400);
    expect((await write(cookies, "POST", base, { template: "{members}", categoryId: TEXT_ID })).statusCode).toBe(400);
    const added = await write(cookies, "POST", base, { template: "👥 Members: {members}" });
    expect(added.statusCode).toBe(200);
    const { id } = added.json().counter;
    expect(guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS)).toEqual([{ id, template: "👥 Members: {members}", channelId: null, categoryId: null, error: null }]);

    expect((await write(cookies, "PATCH", `${base}/${id}`, { template: "Members {members}" })).json().counter.template).toBe("Members {members}");
    expect((await write(cookies, "PATCH", `${base}/ffffffff`, { template: "{members}" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: base, cookies })).json()).toMatchObject({ max: 5, counters: [{ id, template: "Members {members}" }], presets: { members: expect.any(String) } });

    await guildSettings.set(GUILD_ID, Setting.STATS_COUNTERS, [{ id, template: "{members}", channelId: VOICE_ID }]);
    expect((await write(cookies, "DELETE", `${base}/${id}`)).json()).toEqual({ ok: true, channelDeleted: true });
    expect(discord.deleteChannel).toHaveBeenCalledWith(GUILD_ID, VOICE_ID, expect.any(String));
    expect(guildSettings.get(GUILD_ID, Setting.STATS_COUNTERS)).toEqual([]);
  });

  it("posts, replaces and removes sticky messages", async () => {
    let next = 0;
    discord.postMessage = vi.fn(async () => ({ id: `81000000000000010${next++}` }));
    discord.deleteMessage = vi.fn(async () => {});
    const cookies = await login();
    const url = `/api/guilds/${GUILD_ID}/stickies`;
    expect((await write(cookies, "PUT", `${url}/${VOICE_ID}`, { content: "Hi" })).statusCode).toBe(400);
    expect((await write(cookies, "PUT", `${url}/${TEXT_ID}`, { content: "  " })).statusCode).toBe(400);
    expect((await write(cookies, "PUT", `${url}/${TEXT_ID}`, { content: "Read the rules" })).json().sticky).toMatchObject({ channelId: TEXT_ID, content: "Read the rules", posted: true });
    expect(discord.postMessage).toHaveBeenCalledWith(TEXT_ID, { content: "Read the rules" });
    await write(cookies, "PUT", `${url}/${TEXT_ID}`, { content: "Read the rules, please" });
    expect(discord.deleteMessage).toHaveBeenCalledWith(TEXT_ID, "810000000000000100");
    expect((await app.inject({ method: "GET", url, cookies })).json()).toMatchObject({ max: 10, stickies: [{ channelId: TEXT_ID, content: "Read the rules, please" }] });
    expect((await write(cookies, "DELETE", `${url}/${TEXT_ID}`)).statusCode).toBe(200);
    expect(discord.deleteMessage).toHaveBeenLastCalledWith(TEXT_ID, "810000000000000101");
    expect((await write(cookies, "DELETE", `${url}/${TEXT_ID}`)).statusCode).toBe(404);
  });

  it("downloads a settings backup and restores it after a preview", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_ID);
    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    const cookies = await login();
    const download = await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/backup`, cookies });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toMatch(new RegExp(`attachment; filename="settings-${GUILD_ID}-\\d{4}-\\d{2}-\\d{2}\\.json"`));
    const backup = download.json();
    expect(backup.settings).toEqual({ [Setting.LOGS_CHANNEL]: LOGS_ID, [Setting.STAFF_ROLE]: ROLE_ID });

    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, TEXT_ID);
    const url = `/api/guilds/${GUILD_ID}/backup/restore`;
    backup.settings[Setting.MOD_LOG_CHANNEL] = VOICE_ID;
    const preview = (await write(cookies, "POST", url, { backup, dryRun: true })).json();
    expect(preview).toMatchObject({
      dryRun: true,
      changes: [{ setting: Setting.LOGS_CHANNEL, label: "Logs channel" }],
      skipped: [{ setting: Setting.MOD_LOG_CHANNEL, reason: "invalid", label: "Mod-log channel" }],
      unchanged: 1,
    });
    expect(guildSettings.get(GUILD_ID, Setting.LOGS_CHANNEL)).toBe(TEXT_ID);

    expect((await write(cookies, "POST", url, { backup, dryRun: false })).json()).toMatchObject({ dryRun: false, changes: [{ setting: Setting.LOGS_CHANNEL }] });
    expect(guildSettings.get(GUILD_ID, Setting.LOGS_CHANNEL)).toBe(LOGS_ID);
    expect(guildSettings.get(GUILD_ID, Setting.MOD_LOG_CHANNEL)).toBeUndefined();

    const refused = await write(cookies, "POST", url, { backup: { format: "nope" } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "invalid-backup" });
  });

  it("shows the leaderboard for the last 7 days", async () => {
    const levels = new LevelStore(db);
    levels.setXp(GUILD_ID, USER_ID, 5000, "moe");
    levels.addXp({ guildId: GUILD_ID, userId: "300000000000000002", userTag: "kaz", amount: 30 });
    const cookies = await login();
    const week = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/levels?period=week`, cookies })).json();
    expect(week).toMatchObject({ period: "week", total: 1, entries: [{ rank: 1, userTag: "kaz", gained: 30, xp: 30 }] });
    const all = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}/levels?period=bogus`, cookies })).json();
    expect(all).toMatchObject({ period: "all", total: 2, entries: [{ userTag: "moe", gained: null }, { userTag: "kaz" }] });
  });

  it("saves media-only channels", async () => {
    const cookies = await login();
    const url = `/api/guilds/${GUILD_ID}/settings`;
    expect((await write(cookies, "PUT", url, { mediaOnly: { channelIds: [VOICE_ID], allowLinks: true } })).statusCode).toBe(400);
    expect((await write(cookies, "PUT", url, { mediaOnly: { channelIds: [TEXT_ID], allowLinks: false } })).statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.MEDIA_ONLY)).toEqual({ channelIds: [TEXT_ID], allowLinks: false });
    const settings = (await app.inject({ method: "GET", url: `/api/guilds/${GUILD_ID}`, cookies })).json().settings;
    expect(settings.mediaOnly).toEqual({ channelIds: [TEXT_ID], allowLinks: false });
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
  it("reads when an account was made from its ID", () => {
    expect(idCreatedAt("175928847299117063")).toBe(Date.parse("2016-04-30T11:18:25.796Z"));
  });


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

  it("checks the starboard settings", () => {
    const server = { guildId: GUILD_ID, roles: [], channels: [{ id: TEXT_ID, type: ChannelType.GuildText }] };
    expect(checkSettingChanges({ starboard: { channelId: TEXT_ID, threshold: 5, emoji: " ⭐ ", extra: 1 } }, server)).toEqual({
      starboard: { channelId: TEXT_ID, threshold: 5, emoji: "⭐" },
    });
    expect(checkSettingChanges({ starboard: null }, server)).toEqual({ starboard: null });
    expect(() => checkSettingChanges({ starboard: { channelId: "1", threshold: 3, emoji: "⭐" } }, server)).toThrow(InvalidSetting);
    expect(() => checkSettingChanges({ starboard: { channelId: TEXT_ID, threshold: 0, emoji: "⭐" } }, server)).toThrow(InvalidSetting);
    expect(() => checkSettingChanges({ starboard: { channelId: TEXT_ID, threshold: 3, emoji: "star" } }, server)).toThrow(InvalidSetting);
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
