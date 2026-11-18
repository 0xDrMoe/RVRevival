import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AiError, AiErrorCode, createAiClient, DEFAULT_AI_MODEL } from "../src/ai/client.js";
import { cleanArticle, KnowledgeStore, MAX_ARTICLE_BODY } from "../src/ai/knowledgeStore.js";
import { checkTicketAi, describeTicketAi, normalizeTicketAi, panelUsesAi } from "../src/ai/options.js";
import { pickContext, search, words } from "../src/ai/retrieval.js";
import { conversationBlock, conversationFromMessages, createTicketAssistant, defuseMentions } from "../src/ai/ticketAssistant.js";
import { AiUsageStore, monthOf } from "../src/ai/usageStore.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { loadBotConfig, loadDashboardConfig } from "../src/config.js";

const GUILD_ID = "900000000000000001";
const TOKEN = ["a".repeat(24), "b".repeat(6), "c".repeat(27)].join(".");
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

describe("AI assistant options", () => {
  it("is off by default, with every helper ready", () => {
    expect(normalizeTicketAi(undefined)).toEqual({ enabled: false, triage: true, helpers: true, closeSummary: true, useTags: true, monthlyLimit: 200, panelIds: [] });
    expect(normalizeTicketAi({ enabled: "yes", monthlyLimit: 99999, panelIds: ["main", "BAD!", "main"] })).toMatchObject({ enabled: false, monthlyLimit: 5000, panelIds: ["main"] });
  });

  it("checks what the dashboard sends, saving nothing for the defaults", () => {
    expect(checkTicketAi({ enabled: false })).toBeNull();
    expect(checkTicketAi({ enabled: true, panelIds: ["main", "abc"] })).toMatchObject({ enabled: true, panelIds: ["main", "abc"] });
    expect(() => checkTicketAi({ monthlyLimit: 0 })).toThrow(/monthly limit/);
    expect(() => checkTicketAi({ helpers: "on" })).toThrow(/helpers/);
    expect(() => checkTicketAi({ apiKey: "x" })).toThrow(/Unknown/);
    expect(() => checkTicketAi({ panelIds: ["nope"] }, { isPanel: () => false })).toThrow(/panels/);
    expect(describeTicketAi({ enabled: true, closeSummary: false })).toBe("on (triage, staff helpers, tags as knowledge; every panel; 200 requests a month)");
    expect(describeTicketAi(undefined)).toBe("off");
  });

  it("runs on every panel unless some are picked", () => {
    expect(panelUsesAi(normalizeTicketAi({}), null)).toBe(true);
    expect(panelUsesAi(normalizeTicketAi({ panelIds: ["abc"] }), null)).toBe(false);
    expect(panelUsesAi(normalizeTicketAi({ panelIds: ["main"] }), null)).toBe(true);
    expect(panelUsesAi(normalizeTicketAi({ panelIds: ["abc"] }), "abc")).toBe(true);
  });

  it("reads the key, model and limit from the environment, and stays off without a key", () => {
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN }).ai).toBeUndefined();
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-1" }).ai).toEqual({ apiKey: "sk-1", model: undefined, monthlyLimit: 500 });
    expect(loadBotConfig({ DISCORD_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-1", AI_MODEL: "claude-sonnet-5-5", AI_MONTHLY_LIMIT: "50" }).ai).toEqual({ apiKey: "sk-1", model: "claude-sonnet-5-5", monthlyLimit: 50 });
    expect(() => loadBotConfig({ DISCORD_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-1", AI_MONTHLY_LIMIT: "lots" })).toThrow(/AI_MONTHLY_LIMIT/);
    expect(() => loadBotConfig({ DISCORD_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-1", AI_MODEL: "a b" })).toThrow(/AI_MODEL/);
    const dashboard = loadDashboardConfig({
      DISCORD_TOKEN: TOKEN,
      DISCORD_CLIENT_ID: "100000000000000001",
      DISCORD_CLIENT_SECRET: "s",
      DASHBOARD_URL: "https://dash.example.com",
      DASHBOARD_SESSION_SECRET: "x".repeat(40),
      ANTHROPIC_API_KEY: "sk-1",
    });
    expect(dashboard.ai.monthlyLimit).toBe(500);
  });
});

describe("knowledge search", () => {
  const documents = [
    { id: "a1", title: "Refunds", body: "Refunds take five days. Ask in billing with your order number." },
    { id: "a2", title: "Reset your password", body: "Use the Forgot password link on the login page." },
    { id: "a3", title: "Game crashes", body: "Verify the game files, then update your graphics driver." },
  ];

  it("splits words in any language and drops filler", () => {
    expect(words("How do I reset MY Password?")).toEqual(["reset", "password"]);
    expect(words("refunds refunded refunding crashes replies")).toEqual(["refund", "refund", "refund", "crash", "reply"]);
    expect(words("¿Cómo cambio la contraseña?")).toEqual(["cómo", "cambio", "contraseña"]);
    expect(words("كلمة المرور")).toEqual(["كلمة", "المرور"]);
  });

  it("finds the best match first, titles counting most", () => {
    expect(search(documents, "I forgot my password").map((document) => document.id)).toEqual(["a2"]);
    expect(search(documents, "my game keeps crashing after the update, refund?").map((document) => document.id)[0]).toBe("a3");
    expect(search(documents, "hello there")).toEqual([]);
    expect(search([], "password")).toEqual([]);
  });

  it("keeps what it picks within a size", () => {
    const big = [{ id: "a9", title: "Password", body: "x".repeat(20_000) }, ...documents];
    expect(pickContext(big, "password", { maxCharacters: 1000 }).map((document) => document.id)).toEqual(["a2"]);
  });
});

describe("knowledge and usage stores", () => {
  it("saves articles per server, cleaned, up to the limit", () => {
    const store = new KnowledgeStore();
    const article = store.add(GUILD_ID, { title: "  Refund   rules ", body: "Five days.\r\nNo more." }, { by: "1", at: 5 });
    expect(article).toMatchObject({ title: "Refund rules", body: "Five days.\nNo more.", updatedBy: "1", updatedAt: 5 });
    expect(store.list("other")).toEqual([]);
    expect(store.update(GUILD_ID, article.id, { title: "Refunds", body: "Seven days." }, { by: "2", at: 6 })).toMatchObject({ title: "Refunds", updatedBy: "2" });
    expect(store.update("other", article.id, { title: "x", body: "y" }, { by: "2" })).toBeUndefined();
    expect(() => cleanArticle({ title: "t", body: "x".repeat(MAX_ARTICLE_BODY + 1) })).toThrow(/characters/);
    expect(store.delete(GUILD_ID, article.id).title).toBe("Refunds");
    expect(store.count(GUILD_ID)).toBe(0);
  });

  it("counts requests and tokens per server per month", () => {
    const usage = new AiUsageStore();
    const november = Date.UTC(2026, 10, 18);
    usage.record(GUILD_ID, { inputTokens: 10, outputTokens: 2 }, november);
    usage.record(GUILD_ID, { inputTokens: 5, outputTokens: 1 }, november);
    expect(usage.get(GUILD_ID, november)).toEqual({ month: "2026-11", requests: 2, inputTokens: 15, outputTokens: 3 });
    expect(usage.get(GUILD_ID, Date.UTC(2026, 11, 1)).requests).toBe(0);
    expect(monthOf(Date.UTC(2026, 0, 31, 23, 59))).toBe("2026-01");
  });
});

describe("AI client", () => {
  const reply = (overrides = {}) => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hello" }], usage: { input_tokens: 7, output_tokens: 3 }, ...overrides });

  it("is off without a key, and uses a small model by default", async () => {
    const client = createAiClient();
    expect(client.available).toBe(false);
    expect(client.model).toBe(DEFAULT_AI_MODEL);
    await expect(client.ask({ system: "s", prompt: "p" })).rejects.toMatchObject({ code: AiErrorCode.OFF });
  });

  it("sends one request with no tools, and reads the text and usage", async () => {
    const create = vi.fn(async () => reply());
    const client = createAiClient({ sdk: { messages: { create } }, model: "test-model" });
    expect(await client.ask({ system: "rules", prompt: "hi", maxTokens: 300 })).toEqual({ text: "Hello", usage: { inputTokens: 7, outputTokens: 3 } });
    const request = create.mock.calls[0][0];
    expect(request).toMatchObject({ model: "test-model", max_tokens: 300, system: "rules", messages: [{ role: "user", content: "hi" }], output_config: { effort: "low" } });
    expect(request.tools).toBeUndefined();
    expect(request.temperature).toBeUndefined();
  });

  it("asks for JSON in a shape and parses it", async () => {
    const create = vi.fn(async () => reply({ content: [{ type: "text", text: '{"a":1}' }] }));
    const schema = { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false };
    const client = createAiClient({ sdk: { messages: { create } } });
    expect((await client.ask({ system: "s", prompt: "p", schema })).json).toEqual({ a: 1 });
    expect(create.mock.calls[0][0].output_config.format).toEqual({ type: "json_schema", schema });
    create.mockResolvedValueOnce(reply({ content: [{ type: "text", text: "not json" }] }));
    await expect(client.ask({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ code: AiErrorCode.BAD_OUTPUT, usage: { inputTokens: 7 } });
  });

  it("turns refusals, cut-off answers and provider errors into AiError codes", async () => {
    const create = vi.fn();
    const client = createAiClient({ sdk: { messages: { create } } });
    create.mockResolvedValueOnce(reply({ stop_reason: "refusal", content: [] }));
    await expect(client.ask({ system: "s", prompt: "p" })).rejects.toMatchObject({ code: AiErrorCode.REFUSED });
    create.mockResolvedValueOnce(reply({ stop_reason: "max_tokens" }));
    await expect(client.ask({ system: "s", prompt: "p" })).rejects.toMatchObject({ code: AiErrorCode.BAD_OUTPUT });
    create.mockRejectedValueOnce(new Anthropic.RateLimitError(429, { type: "error" }, "slow down", new Headers()));
    await expect(client.ask({ system: "s", prompt: "p" })).rejects.toMatchObject({ code: AiErrorCode.RATE_LIMITED });
    create.mockRejectedValueOnce(new Error("socket hang up"));
    const error = await client.ask({ system: "s", prompt: "p" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AiError);
    expect(error.code).toBe(AiErrorCode.FAILED);
  });
});

describe("ticket assistant", () => {
  function setup({ ask = vi.fn(async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } })), available = true, botMonthlyLimit } = {}) {
    const guildSettings = new GuildSettings();
    const usage = new AiUsageStore();
    const knowledge = new KnowledgeStore();
    const assistant = createTicketAssistant({ ai: { available, model: "m", ask }, knowledge, usage, guildSettings, logger, botMonthlyLimit, now: () => 0 });
    return { guildSettings, usage, knowledge, assistant, ask };
  }
  const ticket = { id: 1, number: 7, userId: "1", subject: "Help", categoryLabel: null, categoryId: null, panelId: null };

  it("says why it can't run", async () => {
    expect(setup({ available: false }).assistant.blocked(GUILD_ID, null, "triage")).toBe("noKey");
    expect(setup({ botMonthlyLimit: 0 }).assistant.blocked(GUILD_ID, null, "triage")).toBe("noKey");
    const t = setup();
    expect(t.assistant.blocked(GUILD_ID, null, "triage")).toBe("off");
    await t.guildSettings.set(GUILD_ID, Setting.TICKET_AI, { enabled: true, triage: false, panelIds: ["abc"], monthlyLimit: 1 });
    expect(t.assistant.blocked(GUILD_ID, null, "triage")).toBe("feature");
    expect(t.assistant.blocked(GUILD_ID, null, "helpers")).toBe("panel");
    expect(t.assistant.blocked(GUILD_ID, "abc", "helpers")).toBeNull();
    t.usage.record(GUILD_ID, {}, 0);
    expect(t.assistant.blocked(GUILD_ID, "abc", "helpers")).toBe("limit");
    await expect(t.assistant.summarize({ guildId: GUILD_ID, guildName: "G", ticket: { ...ticket, panelId: "abc" }, conversation: [] })).rejects.toMatchObject({ code: AiErrorCode.LIMIT });
    expect(t.ask).not.toHaveBeenCalled();
  });

  it("keeps triage to the categories and articles it was given", async () => {
    const ask = vi.fn(async () => ({ json: { priority: "extreme", summary: "Needs a refund <@123>", categoryId: "nope", articleIds: ["a1", "a99", "a1"], needsStaff: false }, usage: {} }));
    const t = setup({ ask });
    await t.guildSettings.set(GUILD_ID, Setting.TICKET_AI, { enabled: true });
    t.knowledge.add(GUILD_ID, { title: "Refunds", body: "Refunds take five days." }, { by: "1" });
    const triage = await t.assistant.triage({ guildId: GUILD_ID, guildName: "G", ticket, answers: [{ question: "What happened?", answer: "I want a refund" }], categories: [{ id: "c1", label: "Billing" }] });
    expect(triage).toEqual({ priority: "normal", summary: "Needs a refund @user", categoryId: null, articles: [{ id: "a1", title: "Refunds" }], needsStaff: false });
    expect(t.usage.get(GUILD_ID, 0).requests).toBe(1);
  });

  it("counts a failed request that still used tokens", async () => {
    const ask = vi.fn(async () => {
      throw Object.assign(new AiError(AiErrorCode.REFUSED, "no"), { usage: { inputTokens: 4, outputTokens: 0 } });
    });
    const t = setup({ ask });
    await t.guildSettings.set(GUILD_ID, Setting.TICKET_AI, { enabled: true });
    await expect(t.assistant.closeSummary({ guildId: GUILD_ID, guildName: "G", ticket, conversation: [{ role: "member", name: "a", text: "b" }] })).rejects.toMatchObject({
      code: AiErrorCode.REFUSED,
    });
    expect(t.usage.get(GUILD_ID, 0)).toMatchObject({ requests: 1, inputTokens: 4 });
  });

  it("reads tags as knowledge only when allowed", async () => {
    const t = setup();
    await t.guildSettings.set(GUILD_ID, Setting.TAGS, [{ name: "rules", content: "Be nice." }]);
    expect(t.assistant.documents(GUILD_ID).map((document) => document.title)).toEqual(["/tag rules"]);
    await t.guildSettings.set(GUILD_ID, Setting.TICKET_AI, { enabled: true, useTags: false });
    expect(t.assistant.documents(GUILD_ID)).toEqual([]);
  });

  it("turns Discord messages into a conversation, oldest first, keeping the newest when long", () => {
    const messages = [
      { createdTimestamp: 3, author: { id: "2", username: "kaz" }, content: "Did you verify files?", embeds: [], attachments: new Map() },
      { createdTimestamp: 1, author: { id: "1", username: "sam" }, member: { displayName: "Sam" }, content: "It crashes", embeds: [], attachments: new Map([["f", { name: "log.txt" }]]) },
      { createdTimestamp: 2, author: { id: "9", bot: true, username: "Rabble" }, content: "", embeds: [{ title: "Ticket", description: "Help" }], attachments: new Map() },
    ];
    expect(conversationFromMessages(messages, { userId: "1" })).toEqual([
      { role: "member", name: "Sam", text: "It crashes\n[file: log.txt]" },
      { role: "bot", name: "Rabble", text: "Ticket: Help" },
      { role: "staff", name: "kaz", text: "Did you verify files?" },
    ]);
    const long = Array.from({ length: 100 }, (_, index) => ({ role: "member", name: "a", text: `${index} ${"x".repeat(1000)}` }));
    const block = conversationBlock(long);
    expect(block).toContain("(older messages left out)");
    expect(block).toContain("99 x");
    expect(block).not.toContain("[member] a: 0 x");
  });

  it("never lets the AI ping anyone", () => {
    expect(defuseMentions("Hi <@123> <@!45> <@&67> <#89> @everyone @here")).toBe("Hi @user @user @user #channel @​everyone @​here");
  });
});
