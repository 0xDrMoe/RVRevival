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
    expect(discord.ban).not.toHaveBeenCalled();
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
