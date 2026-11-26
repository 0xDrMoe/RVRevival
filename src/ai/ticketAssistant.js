// The AI ticket assistant (it helps staff; it never answers members on its own):
//
//   triage        a new ticket's priority, a short summary, the category that
//                 fits best and the knowledge base articles that answer it.
//   summarize     what a ticket is about so far, for staff joining it.
//   suggestReply  a reply staff can edit before it's sent.
//   closeSummary  a short account of how a ticket went, for the log.
//
// Each server shapes all four on the dashboard (ai/options.js): the
// assistant's name, tone and emoji, reply length, language and format, a
// greeting and sign-off, its own instructions, topics to stay out of, how
// triage ranks tickets, how summaries read, what's taken out of ticket text,
// and changes per ticket panel.
//
// What no setting changes (ai/guardrails.js): the locked rules come first in
// every request; the model has no tools, so it can't act on Discord; member,
// staff and admin text goes in as escaped data; card numbers and tokens are
// taken out before anything is sent; nothing it writes can ping; and each
// server has a monthly limit (counted in ai_usage). Requests stay small: only
// the articles that match the ticket go with it (ai/retrieval.js).

import { tagsOf } from "../community/tags.js";
import { Setting } from "../settings/guildSettings.js";
import { AiError, AiErrorCode, noAiClient } from "./client.js";
import { avoidBlock, escapeData, frameReply, languageName, raisePriority, redact, replyRules, systemPrompt } from "./guardrails.js";
import { assistantName, normalizeTicketAi, optionsForPanel, panelUsesAi } from "./options.js";
import { pickContext } from "./retrieval.js";

export { languageName } from "./guardrails.js";

export const TriagePriority = Object.freeze({ LOW: "low", NORMAL: "normal", HIGH: "high", URGENT: "urgent" });
export const TRIAGE_PRIORITIES = Object.values(TriagePriority);
// The most the bot lets any server use a month, unless AI_MONTHLY_LIMIT says otherwise.
export const DEFAULT_BOT_MONTHLY_LIMIT = 500;
export const MAX_SUMMARY_LENGTH = 600;
export const MAX_REPLY_LENGTH = 1800;
// The newest part of a conversation the AI reads.
export const MAX_CONVERSATION_CHARACTERS = 40_000;
const MAX_MESSAGE_CHARACTERS = 2_000;
export const DEFAULT_ASSISTANT_NAME = "Rabble AI";

export const AiFeature = Object.freeze({ TRIAGE: "triage", HELPERS: "helpers", CLOSE_SUMMARY: "closeSummary" });

function knowledgeBlock(documents) {
  if (documents.length === 0) {
    return "<knowledge>\n(The knowledge base has nothing on this.)\n</knowledge>";
  }
  const articles = documents.map((document) => `<article id="${escapeData(document.id)}" title="${escapeData(document.title)}">\n${escapeData(document.body)}\n</article>`);
  return `<knowledge>\n${articles.join("\n")}\n</knowledge>`;
}

// The ticket's own words (the form, or its subject), with private details taken out.
function ticketText(ticket, answers) {
  const lines = [`Ticket #${ticket.number}`, ticket.categoryLabel ? `Category the member picked: ${ticket.categoryLabel}` : null];
  for (const entry of answers ?? []) {
    lines.push(entry.question ? `${entry.question}: ${entry.answer}` : entry.answer);
  }
  if (!answers?.length) {
    lines.push(ticket.subject);
  }
  return lines.filter(Boolean).join("\n");
}

const ticketBlock = (ticket, answers, privacy) => `<ticket>\n${escapeData(redact(ticketText(ticket, answers), privacy))}\n</ticket>`;

// The conversation, oldest first, keeping the newest part when it's long.
// `privacy` (ai/options.js) says what to take out; card numbers and tokens always go.
export function conversationBlock(conversation, privacy = { redactEmails: true, redactPhones: true, redactIps: true, fileNames: true }) {
  const lines = [];
  let used = 0;
  for (const entry of [...conversation].reverse()) {
    const line = `[${entry.role}] ${entry.name}: ${redact(String(entry.text).slice(0, MAX_MESSAGE_CHARACTERS), privacy)}`;
    if (used + line.length > MAX_CONVERSATION_CHARACTERS) {
      lines.push("(older messages left out)");
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return `<conversation>\n${escapeData(lines.reverse().join("\n")) || "(no messages yet)"}\n</conversation>`;
}

// A ticket's Discord messages (newest first, as fetchThreadMessages reads
// them) as { role, name, text }: the member, staff (anyone else) or the bot.
export function conversationFromMessages(messages, ticket) {
  return [...messages]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => {
      const embedText = (message.embeds ?? []).map((embed) => [embed.title, embed.description].filter(Boolean).join(": ")).filter(Boolean);
      const files = [...(message.attachments?.values() ?? [])].map((file) => `[file: ${file.name ?? "file"}]`);
      const text = [message.content, ...embedText, ...files].filter(Boolean).join("\n").trim();
      const role = message.author?.bot ? "bot" : message.author?.id === ticket.userId ? "member" : "staff";
      return { role, name: message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? "someone", text };
    })
    .filter((entry) => entry.text);
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
// No pings, whatever the model writes.
export const defuseMentions = (text) => String(text).replace(/@(everyone|here)/g, "@​$1").replace(/<@[!&]?(\d+)>/g, "@user").replace(/<#(\d+)>/g, "#channel");

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    priority: { type: "string", enum: TRIAGE_PRIORITIES },
    summary: { type: "string", description: "One or two sentences for staff." },
    categoryId: { type: "string", description: "The id of the category that fits best, or an empty string." },
    articleIds: { type: "array", items: { type: "string" }, description: "Ids of knowledge base articles that answer the ticket." },
    needsStaff: { type: "boolean", description: "False only when the knowledge base fully answers the ticket." },
  },
  required: ["priority", "summary", "categoryId", "articleIds", "needsStaff"],
  additionalProperties: false,
};

const PRIORITY_RULES = {
  urgent: "safety, someone in danger, security, account takeover, payment, or anything time-critical",
  high: "a member is blocked and can't use the server or product",
  normal: "everything else",
  low: "questions, suggestions and feedback",
};

// The words of each task, from the options for that ticket's panel.
const tasks = {
  triage(options, { categories, serverLanguage }) {
    const rules = options.triageRules;
    const language = rules.summaryLanguage === "server" ? languageName(serverLanguage) : "English";
    const priorities = ["urgent", "high", "low", "normal"].map((level) => `  ${level}: ${rules.priorities[level] ? escapeData(rules.priorities[level]) : PRIORITY_RULES[level]}`);
    return [
      "Triage this new ticket for staff.",
      `- priority:\n${priorities.join("\n")}`,
      `- summary: what the member needs, in one or two short ${language} sentences, without names.`,
      rules.suggestCategory && categories.length > 0
        ? "- categoryId: the category that fits best when it's different from the one the member picked, else an empty string."
        : "- categoryId: an empty string.",
      rules.maxArticles > 0 ? `- articleIds: up to ${rules.maxArticles} knowledge base articles that answer the ticket (none when nothing fits).` : "- articleIds: an empty list.",
      "- needsStaff: false only when the knowledge base fully answers the ticket.",
      options.avoidTopics.length > 0 ? "A ticket about a subject in <avoid> always needs staff." : null,
    ]
      .filter(Boolean)
      .join("\n");
  },
  summarize(options, { language }) {
    const summaries = options.summaries;
    const shape =
      summaries.style === "paragraph"
        ? `one short paragraph of at most ${summaries.maxPoints} sentences`
        : `at most ${summaries.maxPoints} short bullet points starting with "- "`;
    return `Summarize this ticket for a staff member who is joining it, in ${languageName(language)}: what the member needs, what has been tried or said, where it stands, and the next step. Write ${shape}.`;
  },
  suggestReply(options, { staffName, serverLanguage }) {
    return [
      `Write the next reply to the member, for the staff member ${escapeData(staffName)} to check, edit and send as their own.`,
      ...replyRules(options, { serverLanguage }).map((rule) => `- ${rule}`),
      "Reply with the message text only.",
    ].join("\n");
  },
  closeSummary(options, { ticket, serverLanguage }) {
    const summaries = options.summaries;
    const language = summaries.closeLanguage === "server" ? languageName(serverLanguage) : "English";
    const detail =
      summaries.closeDetail === "detailed"
        ? `In up to six short ${language} sentences for the staff log: what the member needed, the main steps taken, how it was resolved (or that it wasn't), who handled it, and any follow-up staff promised.`
        : `In two or three short ${language} sentences for the staff log: what the member needed, how it was resolved (or that it wasn't), and any follow-up staff promised.`;
    return `This ticket is closed${ticket.closeReason ? ` (reason given: ${escapeData(redact(ticket.closeReason, options.privacy))})` : ""}. ${detail}`;
  },
};

// Options:
//   ai               the AI client (ai/client.js)
//   knowledge        the KnowledgeStore
//   usage            the AiUsageStore
//   botMonthlyLimit  the most any server may use a month (AI_MONTHLY_LIMIT)
//   guildSettings, logger, now
//
// Every task takes `options` too: settings to use instead of the saved ones
// (the dashboard's Try it), which then work while the assistant is off.
export function createTicketAssistant({ ai = noAiClient, knowledge, usage, guildSettings, logger, botMonthlyLimit = DEFAULT_BOT_MONTHLY_LIMIT, now = Date.now }) {
  const optionsOf = (guildId) => normalizeTicketAi(guildSettings.get(guildId, Setting.TICKET_AI));
  const limitOf = (options) => Math.min(options.monthlyLimit, botMonthlyLimit);
  // The options for a panel's tickets: `override` (Try it) or what's saved.
  const optionsFor = (guildId, panelId, override) => optionsForPanel(override ? normalizeTicketAi(override) : optionsOf(guildId), panelId);
  const nameOf = (options) => assistantName(options, DEFAULT_ASSISTANT_NAME);

  // Why `feature` can't run for this server's ticket from `panelId`, or null
  // when it can: "noKey", "off", "feature", "panel" or "limit".
  function blocked(guildId, panelId, feature) {
    if (!ai.available || botMonthlyLimit <= 0) {
      return "noKey";
    }
    const saved = optionsOf(guildId);
    if (!saved.enabled) {
      return "off";
    }
    if (!panelUsesAi(saved, panelId)) {
      return "panel";
    }
    if (feature && !optionsForPanel(saved, panelId)[feature]) {
      return "feature";
    }
    return usage.get(guildId, now()).requests >= limitOf(saved) ? "limit" : null;
  }

  // This month's use and the limit, for the dashboard and the Staff assist panel.
  function status(guildId) {
    const options = optionsOf(guildId);
    return { available: ai.available, model: ai.model, enabled: options.enabled, limit: limitOf(options), botLimit: botMonthlyLimit, name: nameOf(options), ...usage.get(guildId, now()) };
  }

  // Articles and (when allowed) tags, as { id, title, body }.
  function documents(guildId, options = optionsOf(guildId)) {
    const articles = knowledge.list(guildId).map((article) => ({ id: `a${article.id}`, title: article.title, body: article.body }));
    const tags = options.useTags ? tagsOf(guildSettings, guildId).map((tag) => ({ id: `t-${tag.name}`, title: `/tag ${tag.name}`, body: tag.content })) : [];
    return [...articles, ...tags];
  }

  // One counted request. A preview (Try it) only needs the key and the month's
  // limit; everything else needs the assistant on for that panel and feature.
  async function request(guildId, feature, panelId, preview, call) {
    let reason;
    if (preview) {
      reason = !ai.available || botMonthlyLimit <= 0 ? "noKey" : usage.get(guildId, now()).requests >= limitOf(optionsOf(guildId)) ? "limit" : null;
    } else {
      reason = blocked(guildId, panelId, feature);
    }
    if (reason === "limit") {
      throw new AiError(AiErrorCode.LIMIT, "This server used its AI requests for the month.");
    }
    if (reason) {
      throw new AiError(AiErrorCode.OFF, `The AI assistant is off here (${reason}).`);
    }
    try {
      const answer = await ai.ask(call);
      usage.record(guildId, answer.usage, now());
      return answer;
    } catch (error) {
      if (error?.usage) {
        usage.record(guildId, error.usage, now());
      }
      logger?.warn?.("An AI request failed", { guildId, feature, code: error?.code, error });
      throw error instanceof AiError ? error : new AiError(AiErrorCode.FAILED, error?.message ?? "The AI request failed.", { cause: error });
    }
  }

  // The words sent for each task, built from the options. `prompt` is what
  // goes after the system prompt; the dashboard shows both.
  function triagePrompt({ guildId, guildName, ticket, answers = [], categories = [], serverLanguage = "en" }, options) {
    const query = [ticket.categoryLabel, ...answers.map((entry) => `${entry.question ?? ""} ${entry.answer}`), ticket.subject].join(" ");
    const context = options.triageRules.maxArticles > 0 ? pickContext(documents(guildId, options), query) : [];
    const offered = options.triageRules.suggestCategory ? categories : [];
    const categoryList = offered.length
      ? `<categories>\n${offered.map((category) => `<category id="${escapeData(category.id)}">${escapeData(category.label)}${category.description ? `: ${escapeData(category.description)}` : ""}</category>`).join("\n")}\n</categories>`
      : null;
    const prompt = [
      `<server>${escapeData(guildName)}</server>`,
      knowledgeBlock(context),
      categoryList,
      avoidBlock(options),
      ticketBlock(ticket, answers, options.privacy),
      tasks.triage(options, { categories: offered, serverLanguage }),
    ]
      .filter(Boolean)
      .join("\n\n");
    return { system: systemPrompt(options, { name: nameOf(options) }), prompt, context, query };
  }

  function summarizePrompt({ guildName, ticket, conversation, language = "en" }, options) {
    const prompt = [`<server>${escapeData(guildName)}</server>`, ticketBlock(ticket, undefined, options.privacy), conversationBlock(conversation, options.privacy), tasks.summarize(options, { language })].join("\n\n");
    return { system: systemPrompt(options, { name: nameOf(options) }), prompt };
  }

  function replyPrompt({ guildId, guildName, ticket, conversation, staffName, serverLanguage = "en" }, options) {
    const recent = conversation.slice(-10).map((entry) => entry.text).join(" ");
    const context = pickContext(documents(guildId, options), `${ticket.subject} ${recent}`);
    const prompt = [
      `<server>${escapeData(guildName)}</server>`,
      knowledgeBlock(context),
      avoidBlock(options),
      ticketBlock(ticket, undefined, options.privacy),
      conversationBlock(conversation, options.privacy),
      tasks.suggestReply(options, { staffName, serverLanguage }),
    ]
      .filter(Boolean)
      .join("\n\n");
    return { system: systemPrompt(options, { name: nameOf(options) }), prompt };
  }

  function closePrompt({ guildName, ticket, conversation, serverLanguage = "en" }, options) {
    const prompt = [`<server>${escapeData(guildName)}</server>`, ticketBlock(ticket, undefined, options.privacy), conversationBlock(conversation, options.privacy), tasks.closeSummary(options, { ticket, serverLanguage })].join("\n\n");
    return { system: systemPrompt(options, { name: nameOf(options) }), prompt };
  }

  // A new ticket. `answers` is the form ([{ question, answer }]); `categories`
  // the panel's ([{ id, label, description }]). Returns
  // { priority, summary, categoryId, articles: [{ id, title }], needsStaff, raisedBy }.
  async function triage(input) {
    const { guildId, ticket, answers = [], categories = [] } = input;
    const options = optionsFor(guildId, ticket.panelId, input.options);
    const { system, prompt, context } = triagePrompt(input, options);
    const { json } = await request(guildId, AiFeature.TRIAGE, ticket.panelId, Boolean(input.options), { system, prompt, maxTokens: 2048, schema: TRIAGE_SCHEMA });
    const byId = new Map(context.map((document) => [document.id, document]));
    const articleIds = Array.isArray(json?.articleIds) ? json.articleIds : [];
    const aiPriority = TRIAGE_PRIORITIES.includes(json?.priority) ? json.priority : TriagePriority.NORMAL;
    const raised = raisePriority(aiPriority, ticketText(ticket, answers), options.triageRules);
    return {
      priority: raised.priority,
      summary: clip(defuseMentions(String(json?.summary ?? "").trim()), MAX_SUMMARY_LENGTH) || "—",
      categoryId:
        options.triageRules.suggestCategory && categories.some((category) => category.id === json?.categoryId && category.id !== ticket.categoryId) ? json.categoryId : null,
      articles: [...new Set(articleIds)]
        .filter((id) => byId.has(id))
        .slice(0, options.triageRules.maxArticles)
        .map((id) => ({ id, title: byId.get(id).title })),
      needsStaff: json?.needsStaff !== false,
      raisedBy: raised.word,
    };
  }

  // What the ticket is about so far, in `language` (the staff member's).
  async function summarize(input) {
    const options = optionsFor(input.guildId, input.ticket.panelId, input.options);
    const { system, prompt } = summarizePrompt(input, options);
    const { text } = await request(input.guildId, AiFeature.HELPERS, input.ticket.panelId, Boolean(input.options), { system, prompt, maxTokens: 2048 });
    return clip(defuseMentions(text), MAX_SUMMARY_LENGTH * 2);
  }

  // A reply staff can edit and send, with the server's greeting and sign-off.
  // `memberName` and `staffName` fill those in.
  async function suggestReply(input) {
    const options = optionsFor(input.guildId, input.ticket.panelId, input.options);
    const { system, prompt } = replyPrompt(input, options);
    const { text } = await request(input.guildId, AiFeature.HELPERS, input.ticket.panelId, Boolean(input.options), { system, prompt, maxTokens: 2048 });
    const framed = frameReply(text.trim(), options, { member: input.memberName ?? "", staff: input.staffName ?? "", server: input.guildName ?? "", assistant: nameOf(options) });
    return clip(defuseMentions(framed), MAX_REPLY_LENGTH);
  }

  // How a closed ticket went, for the log and its history.
  async function closeSummary(input) {
    const options = optionsFor(input.guildId, input.ticket.panelId, input.options);
    const { system, prompt } = closePrompt(input, options);
    const { text } = await request(input.guildId, AiFeature.CLOSE_SUMMARY, input.ticket.panelId, Boolean(input.options), { system, prompt, maxTokens: 2048 });
    return clip(defuseMentions(text), options.summaries.closeDetail === "detailed" ? MAX_SUMMARY_LENGTH * 2 : MAX_SUMMARY_LENGTH);
  }

  // What the AI would be told for each task with these options (saved ones
  // when `override` is missing), for the dashboard. No AI request.
  function preview({ guildId, guildName, panelId = null, override, serverLanguage = "en", sample = "" }) {
    const options = optionsFor(guildId, panelId, override);
    const ticket = { number: 1, panelId, subject: sample || "(the member's words)", categoryLabel: null, userId: "member" };
    const conversation = [{ role: "member", name: "Member", text: sample || "(the conversation)" }];
    const triageInput = { guildId, guildName, ticket, answers: [], categories: [], serverLanguage };
    return {
      name: nameOf(options),
      system: systemPrompt(options, { name: nameOf(options) }),
      triage: triagePrompt(triageInput, options).prompt,
      summarize: summarizePrompt({ guildName, ticket, conversation, language: "en" }, options).prompt,
      suggestReply: replyPrompt({ guildId, guildName, ticket, conversation, staffName: "Staff member", serverLanguage }, options).prompt,
      closeSummary: closePrompt({ guildName, ticket, conversation, serverLanguage }, options).prompt,
    };
  }

  return { available: ai.available, blocked, status, documents, optionsFor, triage, summarize, suggestReply, closeSummary, preview };
}

// For tests and bots without the assistant: always off.
const off = async () => {
  throw new AiError(AiErrorCode.OFF, "AI is off on this bot.");
};
export const noTicketAssistant = Object.freeze({
  available: false,
  blocked: () => "noKey",
  status: () => ({ available: false, enabled: false, requests: 0, limit: 0, name: DEFAULT_ASSISTANT_NAME }),
  documents: () => [],
  optionsFor: () => optionsForPanel(normalizeTicketAi(undefined), null),
  triage: off,
  summarize: off,
  suggestReply: off,
  closeSummary: off,
  preview: () => null,
});
