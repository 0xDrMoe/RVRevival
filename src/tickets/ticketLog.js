// The ticket log: everything that happens to a ticket (opened, closed,
// reopened, people added or removed, renamed, thread deleted) is saved in the
// ticket's history, which the dashboard's Tickets page shows, and posted in the
// ticket log channel (/tickets log, or the dashboard's Logging page). Without
// one, entries go to the mod-log channel like before. Each kind of entry can
// also have a channel of its own (the Logging page, "Where each log goes"),
// and be switched off (/tickets log-event); switched-off events are still saved.
//
// Log entries are in English, like every other log.

import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import { LogRoute, ticketRoute } from "../logs/logRoutes.js";
import { Setting } from "../settings/guildSettings.js";
import { transcriptPath } from "../transcripts/linkPreview.js";
import { ticketTranscriptPage } from "../transcripts/ticketPage.js";

// The values are saved in the database and the settings, so never rename one.
export const TicketEvent = Object.freeze({
  OPENED: "opened",
  CLOSED: "closed",
  REOPENED: "reopened",
  MEMBER_ADDED: "memberAdded",
  MEMBER_REMOVED: "memberRemoved",
  RENAMED: "renamed",
  DELETED: "deleted",
  CLAIMED: "claimed",
  UNCLAIMED: "unclaimed",
  RATED: "rated",
  // The AI assistant (ai/ticketAssistant.js): its triage of a new ticket, and
  // each time staff used Summarize or Suggest reply.
  AI_TRIAGED: "aiTriaged",
  AI_USED: "aiUsed",
});
export const TICKET_EVENTS = Object.values(TicketEvent);

// The ticket log channel, else the mod-log channel, else the logs channel.
export const TICKET_LOG_SETTINGS = [Setting.TICKET_LOG_CHANNEL, Setting.MOD_LOG_CHANNEL, Setting.LOGS_CHANNEL];

const STYLE = {
  [TicketEvent.OPENED]: { title: "opened", color: 0x57f287 },
  [TicketEvent.CLOSED]: { title: "closed", color: 0x5865f2 },
  [TicketEvent.REOPENED]: { title: "reopened", color: 0xfee75c },
  [TicketEvent.MEMBER_ADDED]: { title: "people added", color: 0x3ba55c },
  [TicketEvent.MEMBER_REMOVED]: { title: "people removed", color: 0xe67e22 },
  [TicketEvent.RENAMED]: { title: "renamed", color: 0x99aab5 },
  [TicketEvent.DELETED]: { title: "thread deleted", color: 0xed4245 },
  [TicketEvent.CLAIMED]: { title: "claimed", color: 0x7c5cff },
  [TicketEvent.UNCLAIMED]: { title: "unclaimed", color: 0x99aab5 },
  [TicketEvent.RATED]: { title: "rated", color: 0xfee75c },
  [TicketEvent.AI_TRIAGED]: { title: "triaged by AI", color: 0xc061cb },
  [TicketEvent.AI_USED]: { title: "AI helper used", color: 0xc061cb },
};

const PRIORITY_LABEL = { low: "🟢 Low", normal: "🔵 Normal", high: "🟠 High", urgent: "🔴 Urgent" };
export const priorityLabel = (priority) => PRIORITY_LABEL[priority] ?? PRIORITY_LABEL.normal;

const UNKNOWN = "Unknown or automatic";
const MAX_PEOPLE_SHOWN = 20;

export const transcriptFileName = (ticket, extension = "html") => `ticket-${String(ticket.number).padStart(4, "0")}.${extension}`;

// Where a ticket's transcript page is on the dashboard. With the dashboard's
// session secret the link carries a key, so its link preview can say what the
// ticket was about (transcripts/linkPreview.js).
export const transcriptUrl = (dashboardUrl, ticket, secret = null) =>
  dashboardUrl ? `${dashboardUrl.replace(/\/+$/, "")}${transcriptPath(ticket.guildId, ticket.number, secret)}` : null;

function peopleList(userIds) {
  const shown = userIds.slice(0, MAX_PEOPLE_SHOWN).map((id) => `<@${id}>`);
  const more = userIds.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

// The "View transcript" link button under a closed ticket's log entry.
export function transcriptButtonRow(transcriptLink) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View transcript").setEmoji("📄").setURL(transcriptLink));
}

// One log entry. `messageCount` is for a closed ticket's transcript; its
// dashboard page is a button under the entry (transcriptButtonRow).
// `aiSummary` is a closed ticket's AI summary; `triage` a new ticket's AI triage.
export function buildTicketEventEmbed({ ticket, event, actorId = null, userIds = [], detail = null, messageCount, aiSummary = null, triage = null, at = Date.now() }) {
  const style = STYLE[event] ?? STYLE[TicketEvent.CLOSED];
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`🎫 Ticket #${ticket.number} ${style.title}`)
    .addFields(
      { name: "Member", value: `<@${ticket.userId}>`, inline: true },
      { name: "By", value: actorId ? `<@${actorId}>` : UNKNOWN, inline: true },
    )
    .setFooter({ text: `Member ID ${ticket.userId}${actorId ? ` · By ID ${actorId}` : ""}` })
    .setTimestamp(at);
  if (ticket.threadId && event !== TicketEvent.DELETED) {
    embed.setDescription(`<#${ticket.threadId}>`);
  }
  const field = (name, value, inline = false) => value && embed.addFields({ name, value: String(value).slice(0, 1024), inline });

  switch (event) {
    case TicketEvent.OPENED:
      field("Category", ticket.categoryLabel, true);
      field("Subject", ticket.subject);
      break;
    case TicketEvent.CLOSED:
      if (messageCount !== undefined) {
        field("Messages", messageCount ?? "—", true);
      }
      field("Category", ticket.categoryLabel, true);
      field("Subject", ticket.subject);
      field("Reason", detail);
      field("AI summary", aiSummary);
      break;
    case TicketEvent.AI_TRIAGED:
      if (triage) {
        field("Priority", priorityLabel(triage.priority), true);
        field("Needs staff", triage.needsStaff === false ? "Maybe not: the knowledge base may answer it" : "Yes", true);
        field("Summary", triage.summary);
        field("Better category", triage.categoryLabel);
        field("Articles that may answer it", triage.articles?.length ? triage.articles.map((article) => `• ${article.title}`).join("\n") : null);
      } else {
        field("Note", detail);
      }
      break;
    case TicketEvent.MEMBER_ADDED:
    case TicketEvent.MEMBER_REMOVED:
      field("People", userIds.length > 0 ? peopleList(userIds) : null);
      field("Note", detail);
      break;
    case TicketEvent.RENAMED:
      field("Name", detail ? escapeMarkdown(detail) : null);
      break;
    default:
      field("Note", detail);
  }
  return embed;
}

// Options:
//   tickets        the TicketStore (where the history is saved)
//   poster         posts in log channels (logs/logChannel.js)
//   dashboardUrl   links closed tickets to their transcript page, when set
//   transcriptSecret  DASHBOARD_SESSION_SECRET, to key those links (optional)
//   guildSettings, logger, now
export function createTicketLog({ tickets, poster, guildSettings, logger, dashboardUrl = null, transcriptSecret = null, now = Date.now }) {
  const isPosted = (guildId, event) => !guildSettings.getList(guildId, Setting.DISABLED_TICKET_LOG_EVENTS).includes(event);

  return {
    // Saves the event in the ticket's history and posts it, unless that kind
    // is switched off. A closed ticket's entry gets a View transcript button
    // (the dashboard page) and the transcript as a web page file (from
    // `transcriptData`, else the `transcript` text) when the channel allows
    // files and the server hasn't switched the file off
    // (Setting.TICKET_TRANSCRIPT_FILE). Never throws: the ticket carries on
    // whatever the log does.
    async record(guild, ticket, { event, actorId = null, userIds = [], detail = null, transcript, transcriptData, messageCount, aiSummary = null, triage = null }) {
      const at = now();
      try {
        tickets.addEvent(ticket, { event, actorId, userIds, detail, createdAt: at });
      } catch (error) {
        logger.warn("Couldn't save a ticket event", { guildId: ticket.guildId, ticket: ticket.number, event, error });
      }
      if (!poster || !isPosted(guild.id, event)) {
        return undefined;
      }
      // A channel picked for this kind of event (the Logging page) wins; then
      // the ticket log channel, which wins over one picked for all "mod actions".
      const route = guildSettings.get(guild.id, Setting.TICKET_LOG_CHANNEL)
        ? ticketRoute(event)
        : [ticketRoute(event), LogRoute.MOD_ACTIONS];
      const hasTranscript = Boolean(transcript || transcriptData);
      const link = hasTranscript ? transcriptUrl(dashboardUrl, ticket, transcriptSecret) : null;
      // Without a dashboard link the file is the only way to read it, so it's always attached then.
      const attachFile = hasTranscript && (!link || guildSettings.get(guild.id, Setting.TICKET_TRANSCRIPT_FILE) !== false);
      try {
        return await poster.post(
          guild,
          TICKET_LOG_SETTINGS,
          ({ canAttach }) => ({
            embed: buildTicketEventEmbed({ ticket, event, actorId, userIds, detail, messageCount, aiSummary, triage, at }),
            components: link ? [transcriptButtonRow(link)] : [],
            files:
              attachFile && canAttach
                ? [
                    new AttachmentBuilder(Buffer.from(ticketTranscriptPage({ ticket, data: transcriptData, text: transcript }), "utf8"), {
                      name: transcriptFileName(ticket),
                    }),
                  ]
                : [],
          }),
          { route },
        );
      } catch (error) {
        logger.warn("Couldn't post a ticket event", { guildId: guild.id, ticket: ticket.number, event, error });
        return undefined;
      }
    },
  };
}

export const noTicketLog = Object.freeze({ record: async () => undefined });
