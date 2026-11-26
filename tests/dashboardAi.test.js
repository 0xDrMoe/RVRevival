import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDashboard } from "../src/dashboard/app.js";
import { CaseStore } from "../src/moderation/caseStore.js";
import { KnowledgeStore, MAX_ARTICLES } from "../src/ai/knowledgeStore.js";
import { AiUsageStore } from "../src/ai/usageStore.js";
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
    setRolePositions: vi.fn(async () => {}),
  };
}

describe("dashboard AI assistant", () => {
  let db;
  let guildSettings;
  let app;

  async function build(ai, aiClient) {
    db = openDatabase();
    guildSettings = new GuildSettings(db);
    app = await buildDashboard({ config: { ...config, ai }, db, discord: fakeDiscord(), guildSettings, store: new CaseStore(db), logger: fakeLogger(), aiClient });
  }

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
  const base = `/api/guilds/${GUILD_ID}/ai`;

  it("needs a login", async () => {
    await build(undefined);
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
  });

  it("says whether this bot has an AI key, and this month's use", async () => {
    await build(undefined);
    const cookies = await login();
    expect((await send(cookies, "GET", base)).json()).toMatchObject({ available: false, articles: [], limit: 200, botLimit: 500 });
    await app.close();
    closeDatabase(db);

    await build({ apiKey: "sk-test", model: "claude-haiku-5-5", monthlyLimit: 100 });
    new AiUsageStore(db).record(GUILD_ID, { inputTokens: 10, outputTokens: 5 });
    const info = (await send(await login(), "GET", base)).json();
    expect(info).toMatchObject({ available: true, model: "claude-haiku-5-5", limit: 100, botLimit: 100, usage: { requests: 1, inputTokens: 10, outputTokens: 5 } });
    expect(JSON.stringify(info)).not.toContain("sk-test");
  });

  it("adds, changes, searches and deletes knowledge base articles", async () => {
    await build(undefined);
    const cookies = await login();
    expect((await send(cookies, "POST", `${base}/articles`, { title: "", body: "x" })).statusCode).toBe(400);
    const added = (await send(cookies, "POST", `${base}/articles`, { title: " Refunds ", body: "Refunds take 5 days.\r\nAsk in #billing." })).json().article;
    expect(added).toMatchObject({ title: "Refunds", body: "Refunds take 5 days.\nAsk in #billing.", updatedBy: USER_ID });
    await send(cookies, "POST", `${base}/articles`, { title: "Reset password", body: "Use the Forgot password link on the login page." });
    await guildSettings.set(GUILD_ID, Setting.TAGS, [{ name: "password", content: "Passwords are reset from the website." }]);

    const changed = await send(cookies, "PUT", `${base}/articles/${added.id}`, { title: "Refunds", body: "Refunds take 7 days." });
    expect(changed.json().article.body).toBe("Refunds take 7 days.");
    expect((await send(cookies, "PUT", `${base}/articles/999`, { title: "a", body: "b" })).statusCode).toBe(404);

    const found = (await send(cookies, "POST", `${base}/search`, { text: "I forgot my password" })).json().matches;
    expect(found.map((match) => match.title)).toEqual(expect.arrayContaining(["Reset password", "/tag password"]));
    expect(found.find((match) => match.title === "/tag password").kind).toBe("tag");
    await send(cookies, "PUT", `/api/guilds/${GUILD_ID}/settings`, { [Setting.TICKET_AI]: { enabled: true, useTags: false } });
    expect((await send(cookies, "POST", `${base}/search`, { text: "I forgot my password" })).json().matches.map((match) => match.kind)).toEqual(["article"]);

    expect((await send(cookies, "DELETE", `${base}/articles/${added.id}`)).json()).toEqual({ deleted: added.id });
    expect((await send(cookies, "DELETE", `${base}/articles/${added.id}`)).statusCode).toBe(404);
    expect((await send(cookies, "GET", base)).json().articles.map((article) => article.title)).toEqual(["Reset password"]);
  });

  it("stops at the article limit", async () => {
    await build(undefined);
    const cookies = await login();
    const knowledge = new KnowledgeStore(db);
    for (let index = 0; index < MAX_ARTICLES; index += 1) {
      knowledge.add(GUILD_ID, { title: `Article ${index}`, body: "text" }, { by: USER_ID });
    }
    expect((await send(cookies, "POST", `${base}/articles`, { title: "One more", body: "text" })).statusCode).toBe(409);
  });

  it("saves the assistant's settings and refuses bad ones", async () => {
    await build(undefined);
    const cookies = await login();
    const settings = `/api/guilds/${GUILD_ID}/settings`;
    const saved = await send(cookies, "PUT", settings, { [Setting.TICKET_AI]: { enabled: true, closeSummary: false, monthlyLimit: 50, panelIds: ["main"] } });
    expect(saved.statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.TICKET_AI)).toMatchObject({ enabled: true, closeSummary: false, monthlyLimit: 50, panelIds: ["main"] });
    expect(saved.json().settings[Setting.TICKET_AI]).toMatchObject({ enabled: true, triage: true });
    expect((await send(cookies, "PUT", settings, { [Setting.TICKET_AI]: { monthlyLimit: 0 } })).statusCode).toBe(400);
    expect((await send(cookies, "PUT", settings, { [Setting.TICKET_AI]: { model: "gpt" } })).statusCode).toBe(400);
    expect((await send(cookies, "PUT", settings, { [Setting.TICKET_AI]: { enabled: false } })).statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.TICKET_AI)).toBeUndefined();
  });

  it("saves every customization and refuses ones that would break the rules", async () => {
    await build(undefined);
    const cookies = await login();
    const settings = `/api/guilds/${GUILD_ID}/settings`;
    const full = {
      enabled: true,
      persona: { name: "Pip", tone: "playful", toneNotes: "Call members adventurers.", emoji: "few" },
      replies: { length: "long", language: "member", greeting: "Hi {member}!", signOff: "{staff}", format: "plain", knowledge: "general", placeholders: false, disclosure: "assisted" },
      triageRules: { priorities: { urgent: "Payments", low: "", normal: "", high: "" }, urgentWords: ["Hacked", "hacked"], highWords: [], suggestCategory: false, maxArticles: 0, summaryLanguage: "server" },
      summaries: { style: "paragraph", maxPoints: 3, closeDetail: "detailed", closeLanguage: "server" },
      instructions: "Refunds within 14 days.",
      avoidTopics: ["Ban appeals"],
      privacy: { redactEmails: false, redactPhones: true, redactIps: true, fileNames: false },
      access: { roleIds: [BOT_ROLE], cooldownSeconds: 20, messageLimit: 50 },
      panels: { main: { tone: "formal", triage: false, instructions: "Main panel only." } },
    };
    expect((await send(cookies, "PUT", settings, { [Setting.TICKET_AI]: full })).statusCode).toBe(200);
    expect(guildSettings.get(GUILD_ID, Setting.TICKET_AI)).toMatchObject({
      persona: full.persona,
      replies: full.replies,
      triageRules: { urgentWords: ["hacked"], maxArticles: 0 },
      avoidTopics: ["ban appeals"],
      access: { roleIds: [BOT_ROLE], cooldownSeconds: 20 },
      panels: { main: { tone: "formal", triage: false, instructions: "Main panel only." } },
    });
    const refused = async (value) => (await send(cookies, "PUT", settings, { [Setting.TICKET_AI]: value })).json().message;
    expect(await refused({ persona: { name: "Discord Support" } })).toMatch(/pass it off/);
    expect(await refused({ persona: { name: "Head Moderator" } })).toMatch(/pass it off/);
    expect(await refused({ replies: { greeting: "Hi {password}" } })).toMatch(/\{member\}/);
    expect(await refused({ replies: { signOff: "ping @everyone" } })).toMatch(/can't mention/);
    expect(await refused({ replies: { disclosure: "none" } })).toMatch(/AI label/);
    expect(await refused({ instructions: "x".repeat(2001) })).toMatch(/2000/);
    expect(await refused({ access: { roleIds: ["700000000000000999"] } })).toMatch(/roles from this server/);
    expect(await refused({ access: { cooldownSeconds: 1 } })).toMatch(/cooldown/);
    expect(await refused({ panels: { main: { apiKey: "x" } } })).toMatch(/Unknown panel option/);
  });

  it("shows what the AI is told, with unsaved settings, without asking the AI", async () => {
    const ask = vi.fn();
    await build({ apiKey: "sk-test", monthlyLimit: 100 }, { available: true, model: "m", ask });
    const cookies = await login();
    await send(cookies, "POST", `${base}/articles`, { title: "Refunds", body: "Refunds take 5 days." });
    const shown = (await send(cookies, "POST", `${base}/preview`, { settings: { persona: { name: "Pip" }, instructions: "Be <b>brief</b>.", avoidTopics: ["ban appeals"] }, text: "I want a refund" })).json();
    expect(shown.name).toBe("Pip");
    expect(shown.system).toContain("Rules you always follow");
    expect(shown.system).toContain("Your name is Pip.");
    // The admins' words come after the rules, escaped, and marked as theirs.
    expect(shown.system.indexOf("<admin_guidance>")).toBeGreaterThan(shown.system.indexOf("Rules you always follow"));
    expect(shown.system).toContain("Be &lt;b&gt;brief&lt;/b&gt;.");
    expect(shown.suggestReply).toContain("Refunds take 5 days.");
    expect(shown.suggestReply).toContain("<avoid>\nban appeals\n</avoid>");
    expect(shown.triage).toContain("Triage this new ticket");
    expect(ask).not.toHaveBeenCalled();
    expect((await send(cookies, "POST", `${base}/preview`, { settings: { persona: { name: "Anthropic" } } })).statusCode).toBe(400);
  });

  it("tries the assistant on a sample ticket with unsaved settings, counting it", async () => {
    const ask = vi.fn(async ({ schema }) =>
      schema
        ? { text: "{}", json: { priority: "normal", summary: "Wants a refund.", categoryId: "", articleIds: [], needsStaff: true }, usage: { inputTokens: 5, outputTokens: 5 } }
        : { text: "Refunds take 5 days.", usage: { inputTokens: 5, outputTokens: 5 } },
    );
    await build({ apiKey: "sk-test", monthlyLimit: 100 }, { available: true, model: "m", ask });
    const cookies = await login();
    // Works while the assistant is still off, so admins can try before turning it on.
    const reply = (await send(cookies, "POST", `${base}/try`, { kind: "reply", text: "refund please", settings: { replies: { greeting: "Hey {member},", signOff: "" } } })).json();
    expect(reply.text).toBe("Hey Member,\n\nRefunds take 5 days.");
    expect(reply.status.requests).toBe(1);
    const triage = (await send(cookies, "POST", `${base}/try`, { kind: "triage", text: "my account was hacked", settings: { triageRules: { urgentWords: ["hacked"] } } })).json();
    expect(triage.triage).toMatchObject({ priority: "urgent", raisedBy: "hacked" });
    expect((await send(cookies, "POST", `${base}/try`, { kind: "nope", text: "x" })).statusCode).toBe(400);
    expect((await send(cookies, "POST", `${base}/try`, { kind: "reply", text: "  " })).statusCode).toBe(400);
    expect(new AiUsageStore(db).get(GUILD_ID).requests).toBe(2);
  });

  it("says when Try it can't run", async () => {
    await build(undefined);
    const cookies = await login();
    const response = await send(cookies, "POST", `${base}/try`, { kind: "reply", text: "hello" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "ai-failed", code: "off" });
  });
});
