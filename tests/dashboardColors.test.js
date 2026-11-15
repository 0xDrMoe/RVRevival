import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDashboard } from "../src/dashboard/app.js";
import { CaseStore } from "../src/moderation/caseStore.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { closeDatabase, openDatabase } from "../src/storage/database.js";
import { fakeLogger } from "./helpers/fakes.js";

const URL_ORIGIN = "https://dash.example.com";
const GUILD_ID = "900000000000000001";
const USER_ID = "300000000000000001";
const BOT_ROLE = "700000000000000009";
const RED = "700000000000000011";
const MANAGE_GUILD = String(1 << 5);

const config = {
  token: ["a".repeat(24), "b".repeat(6), "c".repeat(27)].join("."),
  clientId: "100000000000000001",
  clientSecret: "client-secret",
  url: URL_ORIGIN,
  port: 3080,
  sessionSecret: "x".repeat(40),
};

// A fake Discord whose roles really change, so the routes' role moves can be checked.
function fakeDiscord({ features = [] } = {}) {
  let next = 50;
  const roles = [
    { id: GUILD_ID, name: "@everyone", color: 0, position: 0, managed: false },
    { id: BOT_ROLE, name: "Rabble", color: 0, position: 5, managed: true },
  ];
  return {
    roles,
    clientId: config.clientId,
    authorizeUrl: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
    exchangeCode: vi.fn(async () => ({ accessToken: "user-access-token", expiresInSeconds: 604800 })),
    revokeToken: vi.fn(async () => {}),
    fetchUser: vi.fn(async () => ({ id: USER_ID, username: "moe", global_name: "Moe", avatar: null })),
    fetchUserGuilds: vi.fn(async () => [{ id: GUILD_ID, name: "Test", icon: null, owner: false, permissions: MANAGE_GUILD }]),
    botGuildIds: vi.fn(async () => new Set([GUILD_ID])),
    botReach: vi.fn(async () => ({ servers: 1, members: 10 })),
    guild: vi.fn(async (id) => ({ id, name: "Test", icon: null, features, roles: roles.map((role) => ({ ...role })), emojis: [] })),
    channels: vi.fn(async () => []),
    member: vi.fn(async () => null),
    botMember: vi.fn(async () => ({ nick: null, avatar: null, banner: null, roles: [BOT_ROLE] })),
    postMessage: vi.fn(async () => ({})),
    createRole: vi.fn(async (guildId, body) => {
      const role = { id: `7000000000000001${next++}`, name: body.name, color: body.colors.primary_color, position: 1, managed: false };
      roles.forEach((entry) => {
        if (entry.position >= 1 && entry.id !== GUILD_ID) {
          entry.position += 1;
        }
      });
      roles.push(role);
      return role;
    }),
    editRole: vi.fn(async (guildId, roleId, body) => ({ id: roleId, ...body })),
    deleteRole: vi.fn(async (guildId, roleId) => {
      roles.splice(roles.findIndex((role) => role.id === roleId), 1);
    }),
    setRolePositions: vi.fn(async (guildId, changes) => {
      for (const change of changes) {
        roles.find((role) => role.id === change.id).position = change.position;
      }
    }),
  };
}

describe("dashboard color roles", () => {
  let db;
  let discord;
  let guildSettings;
  let app;

  async function start(options) {
    db = openDatabase();
    discord = fakeDiscord(options);
    guildSettings = new GuildSettings(db);
    app = await buildDashboard({ config, db, discord, guildSettings, store: new CaseStore(db), logger: fakeLogger() });
  }

  beforeEach(() => start());

  afterEach(async () => {
    await app.close();
    closeDatabase(db);
  });

  async function login() {
    const begin = await app.inject({ method: "GET", url: "/auth/login" });
    const stateCookie = begin.cookies.find((cookie) => cookie.name === "rv_oauth_state");
    const state = new URL(begin.headers.location).searchParams.get("state");
    const callback = await app.inject({ method: "GET", url: `/auth/callback?code=abc&state=${state}`, cookies: { rv_oauth_state: stateCookie.value } });
    return { rv_session: callback.cookies.find((cookie) => cookie.name === "rv_session").value };
  }

  const send = (cookies, method, url, payload) => app.inject({ method, url, cookies, payload, headers: { origin: URL_ORIGIN } });
  const base = `/api/guilds/${GUILD_ID}/colors`;

  it("needs a login", async () => {
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
  });

  it("adds colors as roles kept together under the bot, edits and deletes them", async () => {
    const cookies = await login();
    expect((await send(cookies, "GET", base)).json()).toMatchObject({ colors: [], gradients: false, max: 100, packRunning: false });

    const first = await send(cookies, "POST", base, { name: "Red", hex: "#ff0000" });
    expect(first.statusCode).toBe(200);
    const roleId = first.json().colors[0].roleId;
    expect(discord.createRole).toHaveBeenCalledWith(GUILD_ID, expect.objectContaining({ name: "Red", colors: { primary_color: 0xff0000 } }), "Color roles");

    await send(cookies, "POST", base, { name: "Blue", hex: "#0000ff" });
    const positions = Object.fromEntries(discord.roles.map((role) => [role.name, role.position]));
    // Color 1 on top, right under the bot's role.
    expect(positions.Rabble).toBeGreaterThan(positions.Red);
    expect(positions.Red).toBe(positions.Blue + 1);

    expect((await send(cookies, "POST", base, { name: "red", hex: "#ff0001" })).statusCode).toBe(409);
    expect((await send(cookies, "POST", base, { name: "Bad", hex: "nope" })).statusCode).toBe(400);
    expect((await send(cookies, "POST", base, { name: "Fade", hex: "#ff0000", hex2: "#0000ff" })).json().message).toContain("Gradient");

    const edited = await send(cookies, "PUT", `${base}/${roleId}`, { name: "Crimson", hex: "#dc143c" });
    expect(edited.json().colors[0]).toMatchObject({ name: "Crimson", hex: "#dc143c" });
    expect(discord.editRole).toHaveBeenCalledWith(GUILD_ID, roleId, { name: "Crimson", colors: { primary_color: 0xdc143c } }, "Color roles");

    expect((await send(cookies, "PUT", `${base.replace("/colors", "")}/settings`, { [Setting.COLOR_OPTIONS]: { joinColor: roleId } })).statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_OPTIONS)).toMatchObject({ joinColor: roleId });
    const deleted = await send(cookies, "DELETE", `${base}/${roleId}`);
    expect(deleted.json().colors.map((color) => color.name)).toEqual(["Blue"]);
    expect(discord.deleteRole).toHaveBeenCalledWith(GUILD_ID, roleId, "Color roles");
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_OPTIONS)?.joinColor).toBeUndefined();
    expect((await send(cookies, "DELETE", `${base}/${roleId}`)).statusCode).toBe(404);
  });

  it("makes gradient roles when the server has enhanced role styles", async () => {
    await app.close();
    closeDatabase(db);
    await start({ features: ["ENHANCED_ROLE_COLORS"] });
    const cookies = await login();
    const reply = await send(cookies, "POST", base, { name: "Fade", hex: "#ff0000", hex2: "#0000ff" });
    expect(reply.json().colors[0]).toMatchObject({ hex: "#ff0000", hex2: "#0000ff" });
    expect(discord.createRole).toHaveBeenCalledWith(GUILD_ID, expect.objectContaining({ colors: { primary_color: 0xff0000, secondary_color: 0x0000ff } }), "Color roles");
  });

  it("adds a pack in the background and sorts the list", async () => {
    const cookies = await login();
    expect((await send(cookies, "POST", `${base}/pack`, { pack: "nope" })).statusCode).toBe(400);
    const started = await send(cookies, "POST", `${base}/pack`, { pack: "neon" });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await send(cookies, "GET", base)).json()).toMatchObject({ packRunning: false, colors: expect.any(Array) }));
    await vi.waitFor(() => expect(guildSettings.get(GUILD_ID, Setting.COLORS)).toHaveLength(started.json().adding));
    expect((await send(cookies, "POST", `${base}/pack`, { pack: "neon" })).statusCode).toBe(409);

    const sorted = await send(cookies, "POST", `${base}/sort`, { by: "name" });
    const names = sorted.json().colors.map((color) => color.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // The roles follow the list: color 1 highest.
    const position = (roleId) => discord.roles.find((role) => role.id === roleId).position;
    const ids = sorted.json().colors.map((color) => color.roleId);
    expect(ids.every((id, index) => index === 0 || position(ids[index - 1]) > position(id))).toBe(true);
    expect((await send(cookies, "POST", `${base}/sort`, { by: "nope" })).statusCode).toBe(400);
  });

  it("draws the list picture", async () => {
    const cookies = await login();
    expect((await send(cookies, "GET", `${base}/image.png`)).statusCode).toBe(404);
    await send(cookies, "POST", base, { name: "Red", hex: "#ff0000" });
    const image = await send(cookies, "GET", `${base}/image.png`);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.subarray(1, 4).toString()).toBe("PNG");
  });

  it("refuses unknown roles", async () => {
    const cookies = await login();
    expect((await send(cookies, "PUT", `${base}/${RED}`, { name: "X", hex: "#000000" })).statusCode).toBe(404);
    expect((await send(cookies, "PUT", `${base}/abc`, { name: "X", hex: "#000000" })).statusCode).toBe(404);
  });
});
