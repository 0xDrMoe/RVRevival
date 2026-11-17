import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDashboard } from "../src/dashboard/app.js";
import { CaseStore } from "../src/moderation/caseStore.js";
import { QuoteStore } from "../src/quotes/quoteStore.js";
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

const AUTHOR_ID = "300000000000000002";
const CHANNEL_ID = "500000000000000001";

describe("dashboard quotes", () => {
  let db;
  let discord;
  let guildSettings;
  let app;
  let quotes;

  beforeEach(async () => {
    db = openDatabase();
    discord = fakeDiscord();
    discord.channels = vi.fn(async () => [{ id: CHANNEL_ID, name: "quotes", type: 0, parent_id: null, position: 0 }]);
    discord.deleteMessage = vi.fn(async () => {});
    guildSettings = new GuildSettings(db);
    quotes = new QuoteStore(db);
    app = await buildDashboard({ config, db, discord, guildSettings, store: new CaseStore(db), logger: fakeLogger() });
  });

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
  const base = `/api/guilds/${GUILD_ID}/quotes`;
  const add = (content, extra = {}) =>
    quotes.add({ guildId: GUILD_ID, content, authorId: AUTHOR_ID, authorName: "Sam", authorUsername: "sam", channelId: CHANNEL_ID, messageId: null, saidAt: 1, addedBy: USER_ID, addedAt: 2, via: "app", ...extra });

  it("needs a login", async () => {
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
  });

  it("lists, searches, edits and deletes quotes", async () => {
    const cookies = await login();
    add("pizza forever");
    const second = add("tacos", { messageId: "600000000000000001" });
    quotes.setCard(GUILD_ID, second.number, CHANNEL_ID, "610000000000000001");
    const all = (await send(cookies, "GET", base)).json();
    expect(all).toMatchObject({ total: 2, count: 2, page: 1, pages: 1 });
    expect(all.quotes[0]).toMatchObject({ number: 2, link: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/600000000000000001` });
    expect(all.authors[0]).toMatchObject({ authorId: AUTHOR_ID, total: 2 });
    expect((await send(cookies, "GET", `${base}?q=pizza`)).json().quotes.map((quote) => quote.number)).toEqual([1]);

    expect((await send(cookies, "PUT", `${base}/1`, { content: "" })).statusCode).toBe(400);
    const edited = await send(cookies, "PUT", `${base}/1`, { content: "pizza always" });
    expect(edited.json().quote).toMatchObject({ content: "pizza always" });
    expect(edited.json().quote.editedAt).toBeGreaterThan(0);
    expect((await send(cookies, "PUT", `${base}/99`, { content: "x" })).statusCode).toBe(404);

    const deleted = await send(cookies, "DELETE", `${base}/2`);
    expect(deleted.json()).toEqual({ deleted: 2, count: 1 });
    expect(discord.deleteMessage).toHaveBeenCalledWith(CHANNEL_ID, "610000000000000001");
    expect((await send(cookies, "DELETE", `${base}/2`)).statusCode).toBe(404);
  });

  it("draws cards and the look preview", async () => {
    const cookies = await login();
    add("hello");
    const card = await send(cookies, "GET", `${base}/1/card.png`);
    expect(card.statusCode).toBe(200);
    expect(card.headers["content-type"]).toBe("image/png");
    const preview = await send(cookies, "GET", `${base}/preview.png?theme=ocean&font=serif&light=1`);
    expect(preview.statusCode).toBe(200);
    expect((await send(cookies, "GET", `${base}/7/card.png`)).statusCode).toBe(404);
  });

  it("saves the quote settings and refuses bad ones", async () => {
    const cookies = await login();
    const settings = `/api/guilds/${GUILD_ID}/settings`;
    const saved = await send(cookies, "PUT", settings, { [Setting.QUOTES]: { enabled: false, channelId: CHANNEL_ID, reactionEmoji: "💬", reactionCount: 4 } });
    expect(saved.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.QUOTES)).toMatchObject({ enabled: false, channelId: CHANNEL_ID, reactionCount: 4 });
    expect((await send(cookies, "PUT", settings, { [Setting.QUOTES]: { channelId: "500000000000000099" } })).statusCode).toBe(400);
    expect((await send(cookies, "PUT", settings, { [Setting.QUOTES]: { enabled: true } })).statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.QUOTES)).toBeUndefined();
  });
});
