// A ticket's transcript page: the ticket's details at the top, then the
// conversation (render.js). The same page is attached to the ticket log
// entry, shown on the dashboard and downloaded from it.

import { formatDateTime, renderTranscriptPage } from "./render.js";

// Options:
//   ticket     the ticket (tickets/ticketStore.js)
//   data       its transcript data (snapshot.js), if saved
//   text       its plain-text transcript, for tickets closed before data was saved
//   names      { userId: name } for the people in the details, when known
//   backUrl, embedded   see renderTranscriptPage()
export function ticketTranscriptPage({ ticket, data, text, names = {}, backUrl = null, embedded = false }) {
  const person = (id) => {
    if (!id) {
      return null;
    }
    const name = names[id] ?? data?.users?.[id]?.name;
    return name ? `${name} (${id})` : id;
  };
  const facts = [
    { label: "Opened by", value: person(ticket.userId) },
    { label: "Opened", value: ticket.createdAt ? formatDateTime(ticket.createdAt) : null },
    { label: "Category", value: ticket.categoryLabel },
    { label: "Claimed by", value: person(ticket.claimedBy) },
    { label: "Closed by", value: ticket.closedAt ? (person(ticket.closedBy) ?? "Automatic") : null },
    { label: "Closed", value: ticket.closedAt ? formatDateTime(ticket.closedAt) : null },
    { label: "Reason", value: ticket.closeReason },
    { label: "Messages", value: data ? String(data.messages.length) : ticket.messageCount !== null && ticket.messageCount !== undefined ? String(ticket.messageCount) : null },
    { label: "Rating", value: ticket.rating ? `${ticket.rating}/5` : null },
  ];
  return renderTranscriptPage({
    title: `Ticket #${ticket.number}`,
    subtitle: ticket.subject ?? null,
    facts,
    data,
    text,
    backUrl,
    embedded,
  });
}
