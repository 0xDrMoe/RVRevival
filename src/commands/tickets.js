// The /tickets command and the ticket buttons.
//
//   /tickets panel channel:#support [staff-role:@Support] [title:…] [message:…]   (title and message are saved with the panel's look)
//   /tickets off                          remove the button (open tickets stay)
//   /tickets close [reason:…]             close the ticket you're in
//   /tickets add member:@x                bring someone into this ticket
//   /tickets remove member:@x             take them out again
//   /tickets list                         the open tickets
//   /tickets log [channel:#…]             where the ticket log goes (empty: the mod log)
//   /tickets log-event event:<…> enabled:<…>  switch one kind of ticket log entry off or on
//
// The panel's look (embed, buttons or dropdown, intro message, thread names)
// and its categories (each with its own questions, staff role, intro and
// thread name) are set on the dashboard's Tickets page; see tickets/panel.js
// and tickets/categories.js.
//
// Members open a ticket with the panel's button, which asks what they need
// help with. The ticket is a private thread in the panel's channel with the
// member and the staff role in it, and a Close button that the member or staff
// can press. Panel and off need Manage Server; the rest needs ticket staff
// (see tickets/tickets.js). Tickets are saved in data/bot.db (tickets/ticketStore.js).
// Closing a ticket saves its transcript. Everything that happens to a ticket,
// here or in Discord itself (renaming, archiving, adding people by hand,
// deleting the thread), goes in its history and the ticket log
// (tickets/ticketLog.js).

import {
  AuditLogEvent,
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
} from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import {
  addStaff,
  buildPanelComponents,
  buildPanelMessage,
  buildRatingRequest,
  buildTicketWelcome,
  CLAIM_BUTTON,
  CLOSE_BUTTON,
  RATE_PREFIX,
  FORM_ID,
  FORM_INPUT,
  isTicketStaff,
  MAX_MESSAGE_LENGTH,
  MAX_OPEN_TICKETS,
  MAX_REASON_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TITLE_LENGTH,
  FORM_PREFIX,
  MENU_ID,
  OPEN_BUTTON,
  OPEN_PREFIX,
  panelLook,
  questionInput,
  serverLanguage,
  TICKET_PERMISSIONS,
  ticketCategories,
  ticketSettings,
  ticketStaffRoleId,
  ticketThreadName,
} from "../tickets/tickets.js";
import { isDefaultLook } from "../tickets/panel.js";
import { idleStep, MAX_AUTO_CLOSE_HOURS, normalizeTicketSupport, warningHours } from "../tickets/support.js";
import { findCategory, subjectFromAnswers } from "../tickets/categories.js";
import { buildTicketTranscript, fetchThreadMessages } from "../tickets/transcript.js";
import { buildTranscriptData } from "../transcripts/snapshot.js";
import { noTicketLog, TICKET_EVENTS, TicketEvent } from "../tickets/ticketLog.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { accentColor } from "../branding/branding.js";
import { sendDm } from "../utils/dms.js";

const COMMAND_NAME = "tickets";

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const memberOption = (option) => withDescription(option.setName("member"), "ticketsMemberOptionDescription").setRequired(true);

// The /tickets log-event choices, named like "Opened" in each language.
const eventNameKey = (event) => `ticketLogEvent${event[0].toUpperCase()}${event.slice(1)}`;
export const TICKET_LOG_EVENT_CHOICES = TICKET_EVENTS.map((value) => ({
  name: translate("en", eventNameKey(value)),
  name_localizations: discordLocalizations(eventNameKey(value)),
  value,
}));

// What the bot needs in the ticket log channel.
const POST_LOGS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];

// Discord writes the audit log entry a moment after sending the event.
const AUDIT_LOG_DELAY_MS = 1500;
// Entries older than this belong to an earlier change.
const AUDIT_LOG_MAX_AGE_MS = 30_000;
// People who join a ticket this soon after it opens came with it (the member,
// and the staff role brought in by the welcome message), so they aren't logged.
export const OPEN_GRACE_MS = 60_000;
// How long a change made with /tickets add or remove waits for Discord's event,
// which is then skipped (the command already logged it, with who did it).
const EXPECTED_CHANGE_MS = 30_000;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildTicketsCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "ticketsCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("panel"), "ticketsPanelDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "ticketsPanelChannelOptionDescription")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((option) => withDescription(option.setName("staff-role"), "ticketsPanelStaffRoleOptionDescription"))
        .addStringOption((option) =>
          withDescription(option.setName("title"), "ticketsPanelTitleOptionDescription").setMaxLength(MAX_TITLE_LENGTH),
        )
        .addStringOption((option) =>
          withDescription(option.setName("message"), "ticketsPanelMessageOptionDescription").setMaxLength(MAX_MESSAGE_LENGTH),
        ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("off"), "ticketsOffDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("close"), "ticketsCloseDescription").addStringOption((option) =>
        withDescription(option.setName("reason"), "ticketsReasonOptionDescription").setMaxLength(MAX_REASON_LENGTH),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("add"), "ticketsAddDescription").addUserOption(memberOption))
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "ticketsRemoveDescription").addUserOption(memberOption))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "ticketsListDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("claim"), "ticketsClaimDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("auto-close"), "ticketsAutoCloseDescription").addIntegerOption((option) =>
        withDescription(option.setName("hours"), "ticketsAutoCloseHoursOptionDescription")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(MAX_AUTO_CLOSE_HOURS),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("ratings"), "ticketsRatingsDescription").addBooleanOption((option) =>
        withDescription(option.setName("enabled"), "ticketsRatingsEnabledOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("log"), "ticketsLogDescription").addChannelOption((option) =>
        withDescription(option.setName("channel"), "ticketsLogChannelOptionDescription").addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("log-event"), "ticketsLogEventDescription")
        .addStringOption((option) =>
          withDescription(option.setName("event"), "ticketsLogEventOptionDescription")
            .setRequired(true)
            .addChoices(...TICKET_LOG_EVENT_CHOICES),
        )
        .addBooleanOption((option) => withDescription(option.setName("enabled"), "ticketsLogEnabledOptionDescription").setRequired(true)),
    )
    .toJSON();
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

// The form a ticket opens with: the category's questions, or "What do you
// need help with?".
function buildTicketForm(language, category) {
  const answerInput = (customId, question = {}) => {
    const input = new TextInputBuilder()
      .setCustomId(customId)
      .setStyle(question.style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setRequired(question.required ?? true)
      .setMaxLength(Math.min(question.maxLength ?? MAX_SUBJECT_LENGTH, MAX_SUBJECT_LENGTH))
      .setPlaceholder(question.placeholder ?? translate(language, "ticketFormPlaceholder"));
    return question.minLength ? input.setMinLength(question.minLength) : input;
  };
  const form = new ModalBuilder()
    .setCustomId(category ? `${FORM_PREFIX}${category.id}` : FORM_ID)
    .setTitle((category?.label ?? translate(language, "ticketFormTitle")).slice(0, 45));
  if (category?.questions.length > 0) {
    return form.addLabelComponents(
      category.questions.map((question, index) => new LabelBuilder().setLabel(question.label).setTextInputComponent(answerInput(questionInput(index), question))),
    );
  }
  return form.addLabelComponents(new LabelBuilder().setLabel(translate(language, "ticketFormLabel")).setTextInputComponent(answerInput(FORM_INPUT)));
}

// A text box's answer, or undefined if the form didn't have it.
function formValue(interaction, customId) {
  try {
    return interaction.fields.getTextInputValue(customId);
  } catch {
    return undefined;
  }
}

const cleanAnswer = (text) => (text ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_SUBJECT_LENGTH);

// The category a category button or form belongs to: undefined for the
// single default button, null when the category was removed since.
function categoryFor(interaction, guildSettings, prefix) {
  if (!interaction.customId.startsWith(prefix)) {
    return undefined;
  }
  return findCategory(ticketCategories(guildSettings, interaction.guildId), interaction.customId.slice(prefix.length)) ?? null;
}

// Options:
//   tickets      the TicketStore (only needed to run the command, not to register it)
//   ticketLog    saves and posts what happens to tickets (tickets/ticketLog.js)
//   guildSettings, logger, forcedLanguage, now, sleep
export function createTicketsCommand({
  tickets,
  guildSettings,
  logger,
  forcedLanguage,
  ticketLog = noTicketLog,
  now = Date.now,
  sleep = sleepFor,
}) {
  // "<thread id>:<user id>" -> when a change made by a command stops being expected.
  const expectedChanges = new Map();

  function expectChange(threadId, userId) {
    const at = now();
    for (const [key, until] of expectedChanges) {
      if (until < at) {
        expectedChanges.delete(key);
      }
    }
    expectedChanges.set(`${threadId}:${userId}`, at + EXPECTED_CHANGE_MS);
  }

  function wasExpected(threadId, userId) {
    const key = `${threadId}:${userId}`;
    const until = expectedChanges.get(key);
    expectedChanges.delete(key);
    return until !== undefined && until >= now();
  }

  // Who made a change in Discord itself, from the audit log (needs View Audit
  // Log). null when it's unknown or nobody did (Discord archiving a quiet thread).
  async function auditActor(guild, type, targetId, matches = () => true) {
    if (!guild?.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
      return null;
    }
    await sleep(AUDIT_LOG_DELAY_MS);
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 10 });
      const entry = logs.entries.find(
        (candidate) => candidate.targetId === targetId && now() - candidate.createdTimestamp < AUDIT_LOG_MAX_AGE_MS && matches(candidate),
      );
      return entry?.executorId ?? null;
    } catch (error) {
      logger.debug("Couldn't read the audit log for a ticket", { guildId: guild.id, error });
      return null;
    }
  }
  const changed = (key) => (entry) => entry.changes?.some((change) => change.key === key) ?? false;

  // Replies privately (or edits the deferred reply) and returns the log outcome.
  function answerer(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };
    return { language, text, answer };
  }

  // The panel's channel, if the bot can open tickets there.
  function usableChannel(guild, channelId) {
    const channel = guild.channels.cache.get(channelId);
    const me = guild.members.me;
    return channel?.type === ChannelType.GuildText && me && channel.permissionsFor(me)?.has(TICKET_PERMISSIONS) ? channel : undefined;
  }

  // The member's open ticket, unless its thread is gone or archived (then it's
  // closed on the spot, so they can open a new one). Normally the thread's own
  // events have closed it already; this catches what happened while the bot was offline.
  function liveTicket(guild, userId) {
    const ticket = tickets.openForUser(guild.id, userId);
    if (!ticket) {
      return undefined;
    }
    const thread = ticket.threadId && guild.channels.cache.get(ticket.threadId);
    if (thread && !thread.archived) {
      return ticket;
    }
    // Closed right away; the transcript and log entry follow without holding up the member.
    void closeQuietly(guild, ticket, { thread: thread || null, reason: thread ? "Thread archived" : "Thread deleted" });
    return undefined;
  }

  // Closes a ticket without a command (its thread was archived or is gone),
  // saves what it can of the transcript and logs it. Closing happens before
  // the first await, so callers needn't wait. Never throws.
  async function closeQuietly(guild, ticket, { thread, closedBy = null, reason }) {
    const closed = tickets.close(ticket.id, { closedBy, reason, closedAt: now() });
    if (!closed) {
      return undefined;
    }
    logger.info("Ticket closed", { guildId: ticket.guildId, ticket: ticket.number, reason });
    const saved = thread ? await saveTranscript(thread, closed, guild) : undefined;
    await ticketLog.record(guild, closed, {
      event: TicketEvent.CLOSED,
      actorId: closedBy,
      detail: reason,
      transcript: saved?.transcript,
      transcriptData: saved?.data,
      messageCount: saved?.messageCount,
    });
    return closed;
  }

  // Saves the conversation, as text and as data for the dashboard's
  // transcript page. Returns { transcript, data, messageCount }, or undefined
  // if it couldn't be read. Never throws: a ticket whose history can't be read still closes.
  async function saveTranscript(thread, ticket, guild) {
    try {
      const messages = await fetchThreadMessages(thread);
      const names = {};
      for (const message of messages) {
        names[message.author.id] ??= message.author.tag ?? message.author.username;
      }
      for (const id of [ticket.userId, ticket.closedBy]) {
        const member = id && guild.members.cache.get(id);
        names[id] ??= member?.user?.tag ?? member?.user?.username;
      }
      const transcript = buildTicketTranscript({ ticket, guildName: guild.name, messages, names });
      const data = buildTranscriptData({ guild, channel: thread, messages });
      tickets.setTranscript(ticket.id, transcript, messages.length, data);
      return { transcript, data, messageCount: messages.length };
    } catch (error) {
      logger.warn("Couldn't save a ticket's transcript", { guildId: guild.id, ticket: ticket.number, error });
      return undefined;
    }
  }

  // Marks the ticket closed, says so in the thread, saves the transcript, then
  // locks and archives it so only staff can read it afterwards.
  async function closeTicket(interaction, ticket, reason) {
    const { answer } = answerer(interaction);
    const closed = tickets.close(ticket.id, { closedBy: interaction.user.id, reason, closedAt: now() });
    if (!closed) {
      return answer(Status.REFUSED, "ticketAlreadyClosed");
    }
    const language = serverLanguage(interaction.guild, forcedLanguage);
    const values = { user: `<@${interaction.user.id}>`, number: ticket.number, reason };
    await interaction.reply({
      content: translate(language, reason ? "ticketClosedReason" : "ticketClosedMessage", values),
      allowedMentions: { parse: [] },
    });
    const saved = await saveTranscript(interaction.channel, closed, interaction.guild);
    await ticketLog.record(interaction.guild, closed, {
      event: TicketEvent.CLOSED,
      actorId: interaction.user.id,
      detail: reason,
      transcript: saved?.transcript,
      transcriptData: saved?.data,
      messageCount: saved?.messageCount,
    });
    await interaction.channel
      .edit({ locked: true, archived: true, reason: `Ticket #${ticket.number} closed by ${interaction.user.id}` })
      .catch((error) => logger.warn("Couldn't lock and archive a closed ticket", { guildId: ticket.guildId, ticket: ticket.number, error }));
    logger.info("Ticket closed", { guildId: ticket.guildId, ticket: ticket.number });
    await askForRating(interaction.guild, closed);
    return result(Status.SUCCESS, "ticketClosedLog", { number: ticket.number });
  }

  // Claims the ticket for whoever asked, or lets go of it if they had it.
  // Someone else's claim can only be taken over with Manage Server.
  async function claimTicket(interaction, ticket) {
    const { answer } = answerer(interaction);
    const userId = interaction.user.id;
    const language = serverLanguage(interaction.guild, forcedLanguage);
    if (ticket.claimedBy && ticket.claimedBy !== userId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return answer(Status.REFUSED, "ticketClaimedByOther", { user: `<@${ticket.claimedBy}>` });
    }
    const releasing = ticket.claimedBy === userId;
    const updated = tickets.claim(ticket.id, releasing ? null : userId, now());
    if (!updated) {
      return answer(Status.REFUSED, "ticketAlreadyClosed");
    }
    await interaction.reply({
      content: translate(language, releasing ? "ticketUnclaimedMessage" : "ticketClaimedMessage", { user: `<@${userId}>`, number: ticket.number }),
      allowedMentions: { parse: [] },
    });
    await ticketLog.record(interaction.guild, updated, {
      event: releasing ? TicketEvent.UNCLAIMED : TicketEvent.CLAIMED,
      actorId: userId,
      detail: !releasing && ticket.claimedBy ? `Taken over from <@${ticket.claimedBy}>` : null,
    });
    return result(Status.SUCCESS, releasing ? "ticketUnclaimedLog" : "ticketClaimedLog", { number: ticket.number });
  }

  // "Claim" in a ticket's first message.
  async function handleClaimButton(interaction) {
    const { answer } = answerer(interaction);
    const ticket = tickets.byThread(interaction.channelId);
    if (!interaction.inCachedGuild() || !ticket || ticket.guildId !== interaction.guildId) {
      return answer(Status.REFUSED, "ticketNotATicket");
    }
    if (!isTicketStaff(interaction, guildSettings, ticket)) {
      return answer(Status.REFUSED, "ticketStaffOnly");
    }
    if (ticket.closedAt !== null) {
      return answer(Status.REFUSED, "ticketAlreadyClosed");
    }
    return claimTicket(interaction, ticket);
  }

  // Sends the member a 1-5 star rating request by DM, when the server has
  // ratings on. Never throws: closed DMs only mean no rating.
  async function askForRating(guild, ticket) {
    if (!guild || !normalizeTicketSupport(guildSettings.get(guild.id, Setting.TICKET_SUPPORT)).ratings) {
      return;
    }
    try {
      const user = await guild.client.users.fetch(ticket.userId);
      await sendDm(user, buildRatingRequest(serverLanguage(guild, forcedLanguage), { ticket, serverName: guild.name }));
    } catch (error) {
      logger.debug("Couldn't ask for a ticket rating", { guildId: guild.id, ticket: ticket.number, error });
    }
  }

  // A star button in the rating DM.
  async function handleRating(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const [ticketId, stars] = interaction.customId.slice(RATE_PREFIX.length).split(":").map(Number);
    if (!Number.isInteger(ticketId) || !Number.isInteger(stars) || stars < 1 || stars > 5) {
      return undefined;
    }
    const rated = tickets.rate(ticketId, interaction.user.id, stars);
    if (!rated) {
      await interaction.reply({ content: translate(language, "ticketRatingAlready"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "ticketRatingAlready");
    }
    await interaction.update({ content: translate(language, "ticketRatingThanks", { stars: "⭐".repeat(stars) }), components: [] });
    const guild = interaction.client.guilds.cache.get(rated.guildId);
    if (guild) {
      await ticketLog.record(guild, rated, { event: TicketEvent.RATED, actorId: interaction.user.id, detail: `${"⭐".repeat(stars)} (${stars}/5)` });
    }
    return result(Status.SUCCESS, "ticketRatedLog", { number: rated.number, stars });
  }

  // A message in a ticket keeps it from closing for inactivity and, from
  // anyone but the member, counts as the first response.
  function messageCreated(message) {
    if (message.author?.bot || !message.inGuild?.() || !message.channel?.isThread?.()) {
      return;
    }
    const ticket = tickets.byThread(message.channelId);
    if (ticket && ticket.closedAt === null && ticket.guildId === message.guildId) {
      tickets.noteActivity(ticket.id, message.author.id, message.createdTimestamp ?? now());
    }
  }

  // Warns, then closes, tickets that went quiet, on servers with auto-close
  // on. Run every few minutes. Never throws.
  async function sweepIdle(client) {
    for (const ticket of tickets.allOpen()) {
      try {
        const support = normalizeTicketSupport(guildSettings.get(ticket.guildId, Setting.TICKET_SUPPORT));
        const step = idleStep(ticket, support.autoCloseHours, now());
        const guild = step && client.guilds.cache.get(ticket.guildId);
        const thread = guild?.channels.cache.get(ticket.threadId);
        if (!thread || thread.archived) {
          continue;
        }
        const language = serverLanguage(guild, forcedLanguage);
        if (step === "warn") {
          tickets.markIdleWarned(ticket.id, now());
          await thread.send({
            content: translate(language, "ticketIdleWarning", { user: `<@${ticket.userId}>`, hours: warningHours(support.autoCloseHours) }),
            allowedMentions: { users: [ticket.userId] },
          });
          continue;
        }
        const reason = `No messages for ${support.autoCloseHours} hours`;
        const closed = tickets.close(ticket.id, { closedBy: null, reason, closedAt: now() });
        if (!closed) {
          continue;
        }
        await thread
          .send({ content: translate(language, "ticketIdleClosed", { hours: support.autoCloseHours }), allowedMentions: { parse: [] } })
          .catch(() => {});
        const saved = await saveTranscript(thread, closed, guild);
        await ticketLog.record(guild, closed, {
          event: TicketEvent.CLOSED,
          detail: reason,
          transcript: saved?.transcript,
          transcriptData: saved?.data,
          messageCount: saved?.messageCount,
        });
        await thread
          .edit({ locked: true, archived: true, reason: `Ticket #${ticket.number} closed for inactivity` })
          .catch((error) => logger.warn("Couldn't lock and archive an idle ticket", { guildId: ticket.guildId, ticket: ticket.number, error }));
        logger.info("Ticket closed for inactivity", { guildId: ticket.guildId, ticket: ticket.number });
        await askForRating(guild, closed);
      } catch (error) {
        logger.warn("Couldn't check a ticket for inactivity", { guildId: ticket.guildId, ticket: ticket.number, error });
      }
    }
  }

  async function execute(interaction) {
    const { text, answer } = answerer(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();

    if (["log", "log-event", "auto-close", "ratings"].includes(subcommand)) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
      }
      if (subcommand === "auto-close" || subcommand === "ratings") {
        const support = normalizeTicketSupport(guildSettings.get(guildId, Setting.TICKET_SUPPORT));
        if (subcommand === "auto-close") {
          support.autoCloseHours = interaction.options.getInteger("hours", true);
        } else {
          support.ratings = interaction.options.getBoolean("enabled", true);
        }
        if (support.autoCloseHours === 0 && !support.ratings) {
          await guildSettings.clear(guildId, Setting.TICKET_SUPPORT);
        } else {
          await guildSettings.set(guildId, Setting.TICKET_SUPPORT, support);
        }
        if (subcommand === "ratings") {
          return answer(Status.SUCCESS, support.ratings ? "ticketRatingsOn" : "ticketRatingsOff");
        }
        return support.autoCloseHours
          ? answer(Status.SUCCESS, "ticketAutoCloseOn", { hours: support.autoCloseHours, warning: warningHours(support.autoCloseHours) })
          : answer(Status.SUCCESS, "ticketAutoCloseOff");
      }
      if (subcommand === "log") {
        const picked = interaction.options.getChannel("channel");
        if (!picked) {
          await guildSettings.clear(guildId, Setting.TICKET_LOG_CHANNEL);
          return answer(Status.SUCCESS, "ticketLogCleared");
        }
        const channel = guild.channels.cache.get(picked.id);
        const me = guild.members.me;
        if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type) || !me || !channel.permissionsFor(me)?.has(POST_LOGS)) {
          return answer(Status.FAILED, "ticketLogNeedsPermissions", { channel: `<#${picked.id}>` });
        }
        await guildSettings.set(guildId, Setting.TICKET_LOG_CHANNEL, channel.id);
        return answer(Status.SUCCESS, "ticketLogSet", { channel: `<#${channel.id}>` });
      }
      const event = interaction.options.getString("event", true);
      if (!TICKET_EVENTS.includes(event)) {
        return answer(Status.FAILED, "unexpected");
      }
      const enabled = interaction.options.getBoolean("enabled", true);
      const disabled = guildSettings.getList(guildId, Setting.DISABLED_TICKET_LOG_EVENTS);
      if (disabled.includes(event) === enabled) {
        await guildSettings.toggleInList(guildId, Setting.DISABLED_TICKET_LOG_EVENTS, event);
      }
      return answer(Status.SUCCESS, enabled ? "ticketLogEventOn" : "ticketLogEventOff", { event: text(eventNameKey(event)) });
    }

    if (subcommand === "panel" || subcommand === "off") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
      }
      const saved = ticketSettings(guildSettings, guildId);
      // Removes the old panel's message, if it's still there.
      const removeOldPanel = async () => {
        const oldChannel = saved && guild.channels.cache.get(saved.channelId);
        await oldChannel?.messages
          ?.delete(saved.messageId)
          .catch((error) => logger.debug("Couldn't delete the old ticket panel", { guildId, error }));
      };

      if (subcommand === "off") {
        if (!saved) {
          return answer(Status.REFUSED, "ticketPanelNone");
        }
        await removeOldPanel();
        await guildSettings.clear(guildId, Setting.TICKETS);
        return answer(Status.SUCCESS, "ticketPanelRemoved");
      }

      const picked = interaction.options.getChannel("channel", true);
      const channel = usableChannel(guild, picked.id);
      if (!channel) {
        return answer(Status.FAILED, "ticketCannotCreate", { channel: `<#${picked.id}>` });
      }
      const role = interaction.options.getRole("staff-role");
      if (role?.id === guildId) {
        return answer(Status.REFUSED, "ticketStaffEveryone");
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // A title or message given here is kept in the look; left out, the saved one stays.
      const title = interaction.options.getString("title")?.trim() || null;
      const message = interaction.options.getString("message")?.trim() || null;
      const look = { ...panelLook(guildSettings, guildId), ...(title ? { title } : {}), ...(message ? { description: message } : {}) };
      const panel = buildPanelMessage(serverLanguage(guild, forcedLanguage), {
        look,
        categories: ticketCategories(guildSettings, guildId),
        color: accentColor(guildSettings, guildId),
      });
      let posted;
      try {
        posted = await channel.send(panel);
      } catch (error) {
        if (isPermissionError(error)) {
          return answer(Status.FAILED, "ticketCannotCreate", { channel: `<#${channel.id}>` });
        }
        throw error;
      }
      await removeOldPanel();
      if (!isDefaultLook(look)) {
        await guildSettings.set(guildId, Setting.TICKET_PANEL, look);
      }
      // The title and message are kept with the panel too, which tells the
      // dashboard this panel's whole message may be redrawn.
      await guildSettings.set(guildId, Setting.TICKETS, {
        channelId: channel.id,
        messageId: posted.id,
        staffRoleId: role?.id ?? null,
        title: look.title,
        message: look.description,
      });
      const staffRoleId = ticketStaffRoleId(guildSettings, guildId);
      return answer(Status.SUCCESS, staffRoleId ? "ticketPanelPosted" : "ticketPanelPostedNoStaff", {
        channel: `<#${channel.id}>`,
        staff: `<@&${staffRoleId}>`,
      });
    }

    if (subcommand === "list") {
      if (!isTicketStaff(interaction, guildSettings)) {
        return answer(Status.REFUSED, "ticketStaffOnly");
      }
      const open = tickets.listOpen(guildId);
      if (open.length === 0) {
        return answer(Status.SUCCESS, "ticketsListEmpty");
      }
      const lines = open.map((ticket) =>
        text("ticketsListLine", {
          number: ticket.number,
          thread: ticket.threadId ? `<#${ticket.threadId}>` : "—",
          user: `<@${ticket.userId}>`,
          when: timestamp(ticket.createdAt, "R"),
        }),
      );
      await interaction.reply({
        content: [text("ticketsListTitle", { count: open.length }), ...lines].join("\n").slice(0, 2000),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return result(Status.SUCCESS);
    }

    // close, add and remove work inside a ticket.
    const ticket = tickets.byThread(interaction.channelId);
    if (!ticket || ticket.guildId !== guildId) {
      return answer(Status.REFUSED, "ticketNotATicket");
    }
    if (subcommand === "close") {
      if (ticket.userId !== interaction.user.id && !isTicketStaff(interaction, guildSettings, ticket)) {
        return answer(Status.REFUSED, "ticketCloseNoPermission");
      }
      return closeTicket(interaction, ticket, interaction.options.getString("reason")?.trim() || null);
    }
    if (!isTicketStaff(interaction, guildSettings, ticket)) {
      return answer(Status.REFUSED, "ticketStaffOnly");
    }
    if (ticket.closedAt !== null) {
      return answer(Status.REFUSED, "ticketAlreadyClosed");
    }
    if (subcommand === "claim") {
      return claimTicket(interaction, ticket);
    }
    const user = interaction.options.getUser("member", true);
    const values = { member: `<@${user.id}>`, number: ticket.number };
    if (subcommand === "add") {
      expectChange(ticket.threadId, user.id);
      try {
        await interaction.channel.members.add(user.id);
      } catch (error) {
        // Discord refuses people who can't see the panel's channel.
        logger.debug("Couldn't add someone to a ticket", { guildId, ticket: ticket.number, error });
        return answer(Status.FAILED, "ticketCannotAdd", values);
      }
      const outcome = await answer(Status.SUCCESS, "ticketAdded", values);
      await ticketLog.record(guild, ticket, { event: TicketEvent.MEMBER_ADDED, actorId: interaction.user.id, userIds: [user.id] });
      return outcome;
    }
    if (user.id === ticket.userId) {
      return answer(Status.REFUSED, "ticketCannotRemoveOwner");
    }
    expectChange(ticket.threadId, user.id);
    await interaction.channel.members.remove(user.id);
    const outcome = await answer(Status.SUCCESS, "ticketRemoved", values);
    await ticketLog.record(guild, ticket, { event: TicketEvent.MEMBER_REMOVED, actorId: interaction.user.id, userIds: [user.id] });
    return outcome;
  }

  // "Open a ticket" (or a category's button) on the panel: asks what they need help with.
  async function handleOpenButton(interaction) {
    return showForm(interaction, () => categoryFor(interaction, guildSettings, OPEN_PREFIX));
  }

  // The panel's dropdown: the same, for the category picked. The menu is
  // redrawn afterwards so it doesn't stay on that choice (Discord would
  // otherwise not let the same member pick it again).
  async function handleMenu(interaction) {
    try {
      return await showForm(interaction, () => findCategory(ticketCategories(guildSettings, interaction.guildId), interaction.values?.[0]) ?? null);
    } finally {
      await resetMenu(interaction);
    }
  }

  async function resetMenu(interaction) {
    if (!interaction.inCachedGuild() || typeof interaction.message?.edit !== "function") {
      return;
    }
    const guildId = interaction.guildId;
    await interaction.message
      .edit({ components: buildPanelComponents(serverLanguage(interaction.guild, forcedLanguage), { look: panelLook(guildSettings, guildId), categories: ticketCategories(guildSettings, guildId) }) })
      .catch((error) => logger.debug("Couldn't reset the ticket panel's dropdown", { guildId, error }));
  }

  async function showForm(interaction, pickCategory) {
    const { language, answer } = answerer(interaction);
    if (!interaction.inCachedGuild() || !ticketSettings(guildSettings, interaction.guildId)) {
      return answer(Status.REFUSED, "ticketsOff");
    }
    const category = pickCategory();
    if (category === null) {
      return answer(Status.REFUSED, "ticketCategoryGone");
    }
    const open = liveTicket(interaction.guild, interaction.user.id);
    if (open) {
      return answer(Status.REFUSED, "ticketAlreadyOpen", { thread: `<#${open.threadId}>` });
    }
    await interaction.showModal(buildTicketForm(language, category));
    return undefined;
  }

  // The form: opens the ticket's private thread.
  async function handleForm(interaction) {
    const { answer } = answerer(interaction);
    const settings = interaction.inCachedGuild() && ticketSettings(guildSettings, interaction.guildId);
    if (!settings) {
      return answer(Status.REFUSED, "ticketsOff");
    }
    const guild = interaction.guild;
    const category = categoryFor(interaction, guildSettings, FORM_PREFIX);
    if (category === null) {
      return answer(Status.REFUSED, "ticketCategoryGone");
    }
    const channel = usableChannel(guild, settings.channelId);
    if (!channel) {
      logger.warn("Can't open tickets in the panel's channel; check the bot's permissions there", { guildId: guild.id });
      return answer(Status.FAILED, "ticketsBroken");
    }
    const open = liveTicket(guild, interaction.user.id);
    if (open) {
      return answer(Status.REFUSED, "ticketAlreadyOpen", { thread: `<#${open.threadId}>` });
    }
    if (tickets.countOpen(guild.id) >= MAX_OPEN_TICKETS) {
      return answer(Status.REFUSED, "ticketTooMany");
    }
    // The form was built from the questions when the button was pressed; read
    // what came back rather than trusting the questions haven't changed since.
    const answers =
      category?.questions.length > 0
        ? category.questions
            .map((question, index) => {
              const value = formValue(interaction, questionInput(index));
              return value === undefined ? null : { question: question.label, answer: cleanAnswer(value) || "—" };
            })
            .filter(Boolean)
        : [{ question: null, answer: cleanAnswer(formValue(interaction, FORM_INPUT)) || "—" }];
    const ticket = tickets.open({
      guildId: guild.id,
      userId: interaction.user.id,
      subject: answers.length > 0 ? subjectFromAnswers(answers) : "—",
      category: category ? { id: category.id, label: category.label } : null,
      createdAt: now(),
    });
    if (!ticket) {
      const existing = tickets.openForUser(guild.id, interaction.user.id);
      return answer(Status.REFUSED, "ticketAlreadyOpen", { thread: existing?.threadId ? `<#${existing.threadId}>` : "—" });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const look = panelLook(guildSettings, guild.id);
    const name = interaction.member.displayName ?? interaction.user.username;
    let thread;
    try {
      thread = await channel.threads.create({
        name: ticketThreadName(category?.nameFormat ?? look.nameFormat, {
          number: ticket.number,
          displayName: name,
          username: interaction.user.username,
          category: category?.label,
          server: guild.name,
        }),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: `Ticket #${ticket.number} opened by ${interaction.user.id}`,
      });
    } catch (error) {
      tickets.delete(ticket.id);
      if (isPermissionError(error)) {
        return answer(Status.FAILED, "ticketsBroken");
      }
      throw error;
    }
    tickets.setThread(ticket.id, thread.id);

    const staffRoleId = category?.staffRoleId ?? settings.staffRoleId ?? ticketStaffRoleId(guildSettings, guild.id);
    const ping = category?.pingStaff ?? look.pingStaff;
    await thread.members.add(interaction.user.id);
    const welcome = buildTicketWelcome(serverLanguage(guild, forcedLanguage), {
      ticket: { ...ticket, userName: interaction.user.username },
      staffRoleId,
      color: accentColor(guildSettings, guild.id),
      intro: category?.intro ?? look.intro,
      ping,
      server: guild.name,
    });
    await thread.send(welcome);
    logger.info("Ticket opened", { guildId: guild.id, ticket: ticket.number });
    const outcome = await answer(Status.SUCCESS, "ticketOpened", { thread: `<#${thread.id}>`, number: ticket.number });
    // After answering, since it can take a while on a big staff team.
    await addStaff({ thread, guild, staffRoleId, logger, pinged: welcome.allowedMentions.roles.length > 0 });
    await ticketLog.record(guild, { ...ticket, threadId: thread.id }, {
      event: TicketEvent.OPENED,
      actorId: interaction.user.id,
      detail: ticket.categoryLabel,
    });
    return outcome;
  }

  // "Close ticket" inside a ticket.
  async function handleCloseButton(interaction) {
    const { answer } = answerer(interaction);
    const ticket = tickets.byThread(interaction.channelId);
    if (!interaction.inCachedGuild() || !ticket || ticket.guildId !== interaction.guildId) {
      return answer(Status.REFUSED, "ticketNotATicket");
    }
    if (ticket.userId !== interaction.user.id && !isTicketStaff(interaction, guildSettings, ticket)) {
      return answer(Status.REFUSED, "ticketCloseNoPermission");
    }
    return closeTicket(interaction, ticket, null);
  }

  // A deleted ticket thread closes its ticket. The transcript can't be read
  // any more, so only what was saved before is kept.
  async function threadDeleted(thread) {
    const ticket = tickets.byThread(thread.id);
    if (!ticket) {
      return;
    }
    const closed = tickets.close(ticket.id, { reason: "Thread deleted", closedAt: now() });
    if (closed) {
      logger.info("Ticket closed because its thread was deleted", { guildId: ticket.guildId, ticket: ticket.number });
    }
    const guild = thread.guild;
    if (!guild) {
      return;
    }
    const actorId = await auditActor(guild, AuditLogEvent.ThreadDelete, thread.id);
    await ticketLog.record(guild, closed ?? ticket, {
      event: TicketEvent.DELETED,
      actorId,
      detail: closed ? "The ticket was still open, so it was closed." : null,
    });
  }

  // A ticket's thread changed in Discord: renamed, archived (by staff, or by
  // Discord after a quiet week), or unarchived (which reopens the ticket).
  async function threadUpdated(oldThread, newThread) {
    const ticket = tickets.byThread(newThread.id);
    const guild = newThread.guild;
    if (!ticket || !oldThread || !guild || ticket.guildId !== guild.id) {
      return;
    }
    if (oldThread.name && newThread.name && oldThread.name !== newThread.name) {
      const actorId = await auditActor(guild, AuditLogEvent.ThreadUpdate, newThread.id, changed("name"));
      await ticketLog.record(guild, ticket, { event: TicketEvent.RENAMED, actorId, detail: `${oldThread.name} → ${newThread.name}` });
    }
    if (!oldThread.archived && newThread.archived && ticket.closedAt === null) {
      // Closed with /tickets close or the button already has closedAt set, so this is someone else.
      const actorId = await auditActor(guild, AuditLogEvent.ThreadUpdate, newThread.id, changed("archived"));
      await closeQuietly(guild, ticket, { thread: newThread, closedBy: actorId, reason: "Thread archived" });
    } else if (oldThread.archived && !newThread.archived && ticket.closedAt !== null) {
      const reopened = tickets.reopen(ticket.id);
      if (!reopened) {
        // The member has opened another ticket since; this one stays closed.
        return;
      }
      logger.info("Ticket reopened", { guildId: guild.id, ticket: ticket.number });
      const actorId = await auditActor(guild, AuditLogEvent.ThreadUpdate, newThread.id, changed("archived"));
      await ticketLog.record(guild, reopened, { event: TicketEvent.REOPENED, actorId, detail: "Thread unarchived" });
    }
  }

  // People joined or left a ticket's thread in Discord itself (mentioned,
  // added by hand, left). Changes made with /tickets add and remove were
  // logged already, with who made them.
  async function threadMembersUpdated(added, removed, thread) {
    const ticket = tickets.byThread(thread.id);
    const guild = thread.guild;
    if (!ticket || !guild || ticket.guildId !== guild.id) {
      return;
    }
    const botId = guild.members?.me?.id ?? thread.client?.user?.id;
    const people = (members) => [...(members?.keys() ?? [])].filter((id) => id !== botId && !wasExpected(thread.id, id));
    // Check every ID either way, so expected changes are used up.
    const addedIds = people(added);
    const removedIds = people(removed);
    if (addedIds.length > 0 && now() - ticket.createdAt >= OPEN_GRACE_MS) {
      await ticketLog.record(guild, ticket, { event: TicketEvent.MEMBER_ADDED, userIds: addedIds, detail: "Added in Discord (mentioned or added by hand)" });
    }
    if (removedIds.length > 0) {
      await ticketLog.record(guild, ticket, { event: TicketEvent.MEMBER_REMOVED, userIds: removedIds, detail: "Left, or removed in Discord" });
    }
  }

  return {
    name: COMMAND_NAME,
    data: buildTicketsCommandData(),
    execute,
    threadDeleted,
    threadUpdated,
    threadMembersUpdated,
    messageCreated,
    sweepIdle,
    components: {
      [CLAIM_BUTTON]: { label: "Claim ticket button", handle: handleClaimButton },
      [OPEN_BUTTON]: { label: "Open ticket button", handle: handleOpenButton },
      [FORM_ID]: { label: "Ticket form", handle: handleForm },
      [CLOSE_BUTTON]: { label: "Close ticket button", handle: handleCloseButton },
      [MENU_ID]: { label: "Ticket panel dropdown", handle: handleMenu },
    },
    componentPrefixes: {
      [OPEN_PREFIX]: { label: "Open ticket category button", handle: handleOpenButton },
      [FORM_PREFIX]: { label: "Ticket category form", handle: handleForm },
      [RATE_PREFIX]: { label: "Ticket rating", handle: handleRating },
    },
  };
}
