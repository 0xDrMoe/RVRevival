// The AI assistant inside tickets (ai/ticketAssistant.js does the AI part):
//
//   - when a ticket opens, its triage (priority, a summary, a better category,
//     articles that may answer it) is saved on the ticket and posted in the
//     ticket log, which only staff see;
//   - the ✨ Staff assist button under a ticket's first message shows staff
//     that triage, privately, with Summarize ticket and Suggest reply;
//   - Suggest reply shows a draft only the staff member sees; they edit it
//     (or send it as it is) and it's posted with their name on it;
//   - when a ticket closes, an AI summary goes in the ticket log and its history.
//
// Members can't use any of it, and nothing the AI writes reaches a member
// unless a staff member sends it. Every use is in the ticket's history and
// the ticket log (TicketEvent.AI_USED).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { AiErrorCode } from "../ai/client.js";
import { AiFeature, conversationFromMessages, MAX_REPLY_LENGTH, noTicketAssistant } from "../ai/ticketAssistant.js";
import { accentColor } from "../branding/branding.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { findCategory } from "./categories.js";
import { findPanel } from "./panels.js";
import { priorityLabel, TicketEvent } from "./ticketLog.js";
import { fetchThreadMessages } from "./transcript.js";
import { isTicketStaff, serverLanguage, TICKET_COLOR } from "./tickets.js";

export const ASSIST_BUTTON = "tk:ai";
export const AI_PREFIX = "tk:ai:";
const SUMMARIZE = `${AI_PREFIX}sum`;
const SUGGEST = `${AI_PREFIX}reply`;
const EDIT = `${AI_PREFIX}edit:`;
const SEND = `${AI_PREFIX}send:`;
const MODAL = `${AI_PREFIX}m:`;
const REPLY_INPUT = "reply";

// The newest messages the AI reads for Summarize and Suggest reply.
export const MAX_AI_MESSAGES = 300;
// One AI request per staff member this often, so a busy button can't drain the month.
export const AI_COOLDOWN_MS = 8_000;
// How long a suggested reply can still be sent.
export const DRAFT_TTL_MS = 30 * 60_000;
const MAX_DRAFTS = 500;
const AI_COLOR = 0xc061cb;

const ERROR_KEYS = {
  [AiErrorCode.OFF]: "ticketAiErrorOff",
  [AiErrorCode.LIMIT]: "ticketAiErrorLimit",
  [AiErrorCode.REFUSED]: "ticketAiErrorRefused",
  [AiErrorCode.RATE_LIMITED]: "ticketAiErrorBusy",
  [AiErrorCode.BAD_OUTPUT]: "ticketAiErrorFailed",
  [AiErrorCode.FAILED]: "ticketAiErrorFailed",
};
const errorKey = (error) => ERROR_KEYS[error?.code] ?? "ticketAiErrorFailed";

// The ✨ Staff assist button for a ticket's first message.
export function assistButton(language) {
  return new ButtonBuilder().setCustomId(ASSIST_BUTTON).setStyle(ButtonStyle.Secondary).setEmoji("✨").setLabel(translate(language, "ticketAiAssistButton"));
}

// The AI's triage as embed fields, in the staff member's language.
function triageFields(language, triage, panel) {
  if (!triage) {
    return [];
  }
  const better = triage.categoryId && panel ? findCategory(panel.categories, triage.categoryId) : null;
  return [
    { name: translate(language, "ticketAiPriority"), value: priorityLabel(triage.priority), inline: true },
    { name: translate(language, "ticketAiNeedsStaff"), value: translate(language, triage.needsStaff === false ? "ticketAiNeedsStaffMaybeNot" : "ticketAiNeedsStaffYes"), inline: true },
    { name: translate(language, "ticketAiSummary"), value: triage.summary.slice(0, 1024) },
    better ? { name: translate(language, "ticketAiBetterCategory"), value: better.label.slice(0, 1024) } : null,
    triage.articles?.length
      ? { name: translate(language, "ticketAiArticles"), value: triage.articles.map((article) => `• ${article.title}`).join("\n").slice(0, 1024) }
      : null,
  ].filter(Boolean);
}

// Options:
//   tickets        the TicketStore
//   assistant      the AI assistant (ai/ticketAssistant.js)
//   ticketLog      saves and posts what happens to tickets
//   guildSettings, logger, forcedLanguage, now
export function createTicketAi({ tickets, assistant = noTicketAssistant, ticketLog, guildSettings, logger, forcedLanguage, now = Date.now }) {
  // draft id -> { guildId, ticketId, channelId, userId, text, expires }
  const drafts = new Map();
  // staff member -> when they last asked the AI something
  const lastAsked = new Map();

  // Whether a ticket from this panel gets the Staff assist button. It shows
  // while the month's limit is used up too, and says so when pressed.
  const assistShown = (guildId, panelId) => {
    const reason = assistant.blocked(guildId, panelId, AiFeature.HELPERS);
    return reason === null || reason === "limit";
  };

  function saveDraft(entry) {
    const at = now();
    for (const [id, draft] of drafts) {
      if (draft.expires < at || drafts.size >= MAX_DRAFTS) {
        drafts.delete(id);
      }
    }
    const id = `${at.toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`.slice(-12);
    drafts.set(id, { ...entry, expires: at + DRAFT_TTL_MS });
    return id;
  }

  function takeDraft(id) {
    const draft = drafts.get(id);
    return draft && draft.expires >= now() ? draft : undefined;
  }

  // Waits AI_COOLDOWN_MS between one person's requests; true when they must wait.
  function coolingDown(userId) {
    const at = now();
    const last = lastAsked.get(userId);
    if (last !== undefined && at - last < AI_COOLDOWN_MS) {
      return true;
    }
    if (lastAsked.size > 1000) {
      lastAsked.clear();
    }
    lastAsked.set(userId, at);
    return false;
  }

  const panelOfTicket = (guildId, ticket) => findPanel(guildSettings, guildId, ticket.panelId);

  // A new ticket's triage: saved on the ticket and posted in the ticket log.
  // `answers` is the form ([{ question, answer }]). Never throws.
  async function triageOpened(guild, ticket, { panel, answers }) {
    if (assistant.blocked(guild.id, ticket.panelId, AiFeature.TRIAGE) !== null) {
      return undefined;
    }
    try {
      const categories = (panel?.categories ?? []).map((category) => ({ id: category.id, label: category.label, description: category.description ?? null }));
      const triage = await assistant.triage({ guildId: guild.id, guildName: guild.name, ticket, answers, categories });
      const saved = tickets.setTriage(ticket.id, triage) ?? ticket;
      const better = triage.categoryId ? findCategory(panel?.categories ?? [], triage.categoryId) : null;
      await ticketLog.record(guild, saved, { event: TicketEvent.AI_TRIAGED, triage: { ...triage, categoryLabel: better?.label ?? null }, detail: `${triage.priority}: ${triage.summary}` });
      return triage;
    } catch (error) {
      logger.debug("Couldn't triage a ticket with AI", { guildId: guild.id, ticket: ticket.number, code: error?.code });
      return undefined;
    }
  }

  // A closed ticket's AI summary, from the messages its transcript was saved
  // from (newest first). Saved on the ticket. null when it's off or fails. Never throws.
  async function summarizeClosed(guild, ticket, messages) {
    if (!guild || !messages?.length || assistant.blocked(guild.id, ticket.panelId, AiFeature.CLOSE_SUMMARY) !== null) {
      return null;
    }
    const conversation = conversationFromMessages(messages, ticket);
    if (!conversation.some((entry) => entry.role !== "bot")) {
      return null;
    }
    try {
      const summary = await assistant.closeSummary({ guildId: guild.id, guildName: guild.name, ticket, conversation });
      tickets.setAiSummary(ticket.id, summary);
      return summary;
    } catch (error) {
      logger.debug("Couldn't summarize a closed ticket with AI", { guildId: guild.id, ticket: ticket.number, code: error?.code });
      return null;
    }
  }

  // The ticket a button was pressed in, if the person is its staff.
  async function staffTicket(interaction, language) {
    const ticket = tickets.byThread(interaction.channelId);
    const reply = (key, values) => interaction.reply({ content: translate(language, key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!interaction.inCachedGuild() || !ticket || ticket.guildId !== interaction.guildId) {
      await reply("ticketNotATicket");
      return { refused: result(Status.REFUSED, "ticketNotATicket") };
    }
    if (!isTicketStaff(interaction, guildSettings, ticket)) {
      await reply("ticketAiStaffOnly");
      return { refused: result(Status.REFUSED, "ticketAiStaffOnly") };
    }
    if (ticket.closedAt !== null) {
      await reply("ticketAlreadyClosed");
      return { refused: result(Status.REFUSED, "ticketAlreadyClosed") };
    }
    return { ticket };
  }

  // ✨ Staff assist: the triage, this month's use, and the two helpers.
  async function handleAssist(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const { ticket, refused } = await staffTicket(interaction, language);
    if (refused) {
      return refused;
    }
    const reason = assistant.blocked(interaction.guildId, ticket.panelId, AiFeature.HELPERS);
    if (reason !== null && reason !== "limit") {
      await interaction.reply({ content: translate(language, "ticketAiErrorOff"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "ticketAiErrorOff");
    }
    const status = assistant.status(interaction.guildId);
    const embed = new EmbedBuilder()
      .setColor(AI_COLOR)
      .setTitle(translate(language, "ticketAiAssistTitle", { number: ticket.number }))
      .setDescription(translate(language, ticket.aiTriage ? "ticketAiAssistIntro" : "ticketAiAssistIntroNoTriage"))
      .addFields(triageFields(language, ticket.aiTriage, panelOfTicket(interaction.guildId, ticket)))
      .setFooter({ text: translate(language, "ticketAiUsage", { used: status.requests, limit: status.limit }) });
    const limited = reason === "limit";
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SUMMARIZE).setStyle(ButtonStyle.Primary).setEmoji("📝").setLabel(translate(language, "ticketAiSummarizeButton")).setDisabled(limited),
      new ButtonBuilder().setCustomId(SUGGEST).setStyle(ButtonStyle.Secondary).setEmoji("💬").setLabel(translate(language, "ticketAiSuggestButton")).setDisabled(limited),
    );
    await interaction.reply({
      ...(limited ? { content: translate(language, "ticketAiErrorLimit") } : {}),
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return result(Status.SUCCESS, "ticketAiAssistLog", { number: ticket.number });
  }

  // Reads the ticket's conversation for Summarize and Suggest reply.
  async function conversationOf(interaction, ticket) {
    const channel = interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));
    const messages = channel ? await fetchThreadMessages(channel, MAX_AI_MESSAGES) : [];
    return conversationFromMessages(messages, ticket);
  }

  // Runs one helper after the checks every helper shares. `work` returns what to show.
  async function runHelper(interaction, name, work) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const { ticket, refused } = await staffTicket(interaction, language);
    if (refused) {
      return refused;
    }
    if (coolingDown(interaction.user.id)) {
      await interaction.reply({ content: translate(language, "ticketAiCooldown", { seconds: AI_COOLDOWN_MS / 1000 }), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "ticketAiCooldown", { seconds: AI_COOLDOWN_MS / 1000 });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const conversation = await conversationOf(interaction, ticket);
      const shown = await work({ ticket, conversation, language });
      await interaction.editReply(shown);
      await ticketLog.record(interaction.guild, ticket, { event: TicketEvent.AI_USED, actorId: interaction.user.id, detail: name });
      return result(Status.SUCCESS, "ticketAiUsedLog", { number: ticket.number, helper: name });
    } catch (error) {
      await interaction.editReply({ content: translate(language, errorKey(error)), embeds: [], components: [] });
      return result(Status.FAILED, errorKey(error));
    }
  }

  async function handleSummarize(interaction) {
    return runHelper(interaction, "Summarize ticket", async ({ ticket, conversation, language }) => {
      const summary = await assistant.summarize({ guildId: interaction.guildId, guildName: interaction.guild.name, ticket, conversation, language });
      const embed = new EmbedBuilder()
        .setColor(AI_COLOR)
        .setTitle(translate(language, "ticketAiSummaryTitle", { number: ticket.number }))
        .setDescription(summary)
        .setFooter({ text: translate(language, "ticketAiCheckIt") });
      return { content: "", embeds: [embed], components: [] };
    });
  }

  async function handleSuggest(interaction) {
    return runHelper(interaction, "Suggest reply", async ({ ticket, conversation, language }) => {
      const staffName = interaction.member?.displayName ?? interaction.user.username;
      const text = await assistant.suggestReply({ guildId: interaction.guildId, guildName: interaction.guild.name, ticket, conversation, staffName });
      const id = saveDraft({ guildId: interaction.guildId, ticketId: ticket.id, channelId: interaction.channelId, userId: interaction.user.id, text });
      const embed = new EmbedBuilder()
        .setColor(AI_COLOR)
        .setTitle(translate(language, "ticketAiDraftTitle"))
        .setDescription(text)
        .setFooter({ text: translate(language, "ticketAiDraftHelp") });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${EDIT}${id}`).setStyle(ButtonStyle.Primary).setEmoji("✏️").setLabel(translate(language, "ticketAiEditButton")),
        new ButtonBuilder().setCustomId(`${SEND}${id}`).setStyle(ButtonStyle.Secondary).setLabel(translate(language, "ticketAiSendButton")),
      );
      return { content: "", embeds: [embed], components: [row] };
    });
  }

  // The draft a button or form is for, if it's still there and theirs.
  async function draftFor(interaction, id, language) {
    const draft = takeDraft(id);
    if (!draft || draft.userId !== interaction.user.id || draft.channelId !== interaction.channelId) {
      await interaction.reply({ content: translate(language, "ticketAiDraftGone"), flags: MessageFlags.Ephemeral });
      return undefined;
    }
    return draft;
  }

  // Edit and send: the draft in a form, to change before it's posted.
  async function handleEdit(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const id = interaction.customId.slice(EDIT.length);
    const draft = await draftFor(interaction, id, language);
    if (!draft) {
      return result(Status.REFUSED, "ticketAiDraftGone");
    }
    const input = new TextInputBuilder()
      .setCustomId(REPLY_INPUT)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(MAX_REPLY_LENGTH)
      .setValue(draft.text.slice(0, MAX_REPLY_LENGTH));
    const form = new ModalBuilder()
      .setCustomId(`${MODAL}${id}`)
      .setTitle(translate(language, "ticketAiEditTitle").slice(0, 45))
      .addLabelComponents(new LabelBuilder().setLabel(translate(language, "ticketAiEditLabel").slice(0, 45)).setTextInputComponent(input));
    await interaction.showModal(form);
    return undefined;
  }

  // Posts the reply in the ticket with the staff member's name on it, and
  // counts it as staff answering (first response, inactivity).
  async function postReply(interaction, draft, text, edited) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const ticket = tickets.get(draft.ticketId);
    if (!ticket || ticket.closedAt !== null) {
      await interaction.reply({ content: translate(language, "ticketAlreadyClosed"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "ticketAlreadyClosed");
    }
    drafts.delete(interaction.customId.slice(interaction.customId.lastIndexOf(":") + 1));
    const serverLang = serverLanguage(interaction.guild, forcedLanguage);
    const name = interaction.member?.displayName ?? interaction.user.username;
    const embed = new EmbedBuilder()
      .setColor(accentColor(guildSettings, interaction.guildId, TICKET_COLOR))
      .setAuthor({ name, iconURL: interaction.member?.displayAvatarURL?.() ?? interaction.user.displayAvatarURL?.() })
      .setDescription(text)
      .setFooter({ text: translate(serverLang, "ticketAiReplyFooter") });
    const channel = interaction.channel ?? (await interaction.guild.channels.fetch(interaction.channelId).catch(() => null));
    try {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      logger.warn("Couldn't post an AI-suggested ticket reply", { guildId: interaction.guildId, ticket: ticket.number, error });
      await interaction.reply({ content: translate(language, "ticketAiSendFailed"), flags: MessageFlags.Ephemeral });
      return result(Status.FAILED, "ticketAiSendFailed");
    }
    tickets.noteActivity(ticket.id, interaction.user.id, now());
    const done = { content: translate(language, "ticketAiSent"), embeds: [], components: [] };
    if (interaction.isFromMessage?.() || interaction.isButton?.()) {
      await interaction.update(done);
    } else {
      await interaction.reply({ ...done, flags: MessageFlags.Ephemeral });
    }
    await ticketLog.record(interaction.guild, ticket, {
      event: TicketEvent.AI_USED,
      actorId: interaction.user.id,
      detail: edited ? "Suggested reply sent after editing" : "Suggested reply sent as written",
    });
    return result(Status.SUCCESS, "ticketAiSentLog", { number: ticket.number });
  }

  async function handleSend(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const draft = await draftFor(interaction, interaction.customId.slice(SEND.length), language);
    return draft ? postReply(interaction, draft, draft.text, false) : result(Status.REFUSED, "ticketAiDraftGone");
  }

  async function handleForm(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const draft = await draftFor(interaction, interaction.customId.slice(MODAL.length), language);
    if (!draft) {
      return result(Status.REFUSED, "ticketAiDraftGone");
    }
    const text = interaction.fields.getTextInputValue(REPLY_INPUT).replace(/\r\n?/g, "\n").trim().slice(0, MAX_REPLY_LENGTH);
    if (!text) {
      await interaction.reply({ content: translate(language, "ticketAiDraftEmpty"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "ticketAiDraftEmpty");
    }
    return postReply(interaction, draft, text, text !== draft.text);
  }

  // Every "tk:ai:…" button and form.
  function handleComponent(interaction) {
    const id = interaction.customId;
    if (id === SUMMARIZE) {
      return handleSummarize(interaction);
    }
    if (id === SUGGEST) {
      return handleSuggest(interaction);
    }
    if (id.startsWith(EDIT)) {
      return handleEdit(interaction);
    }
    if (id.startsWith(SEND)) {
      return handleSend(interaction);
    }
    if (id.startsWith(MODAL)) {
      return handleForm(interaction);
    }
    return undefined;
  }

  return {
    assistShown,
    triageOpened,
    summarizeClosed,
    components: { [ASSIST_BUTTON]: { label: "Ticket staff assist button", handle: handleAssist } },
    componentPrefixes: { [AI_PREFIX]: { label: "Ticket AI helper", handle: handleComponent } },
  };
}
