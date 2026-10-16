// Ticket transcripts: the whole conversation in a ticket's thread as plain
// text, saved when the ticket is closed and posted in the mod log.

// Enough for any real ticket; a thread with more keeps the newest ones.
export const MAX_TRANSCRIPT_MESSAGES = 1000;
// Kept well under Discord's 8 MB upload limit and small in the database.
export const MAX_TRANSCRIPT_LENGTH = 1_000_000;

const FETCH_PAGE = 100;

const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// Reads the thread's messages, newest first, up to `max`.
export async function fetchThreadMessages(thread, max = MAX_TRANSCRIPT_MESSAGES) {
  const messages = [];
  let before;
  while (messages.length < max) {
    const page = await thread.messages.fetch({ limit: Math.min(FETCH_PAGE, max - messages.length), before, cache: false });
    const batch = [...page.values()];
    messages.push(...batch);
    if (batch.length < FETCH_PAGE) {
      break;
    }
    before = batch.at(-1).id;
  }
  return messages;
}

function messageLine(message) {
  const who = `${message.author?.tag ?? message.author?.username ?? "unknown"} (${message.author?.id ?? "?"})`;
  const parts = [];
  if (message.content) {
    parts.push(message.content);
  }
  for (const embed of message.embeds ?? []) {
    const text = [embed.title, embed.description].filter(Boolean).join(": ");
    if (text) {
      parts.push(`[embed] ${text}`);
    }
  }
  for (const attachment of message.attachments?.values() ?? []) {
    parts.push(`[file: ${attachment.name ?? "file"} ${attachment.url}]`);
  }
  return `[${stamp(message.createdTimestamp)} UTC] ${who}: ${parts.join("\n    ") || "(no text)"}`;
}

// The transcript: who opened it and why, how it ended, then every message
// oldest first. `names` maps user IDs to names for the header.
export function buildTicketTranscript({ ticket, guildName, messages, names = {} }) {
  const person = (id) => (id ? `${names[id] ?? "unknown"} (${id})` : "nobody");
  const header = [
    `Ticket #${ticket.number} · ${guildName}`,
    `Opened by ${person(ticket.userId)} on ${stamp(ticket.createdAt)} UTC`,
    `Subject: ${ticket.subject}`,
    ticket.closedAt ? `Closed by ${person(ticket.closedBy)} on ${stamp(ticket.closedAt)} UTC${ticket.closeReason ? `. Reason: ${ticket.closeReason}` : ""}` : null,
    `${messages.length} message${messages.length === 1 ? "" : "s"}${messages.length >= MAX_TRANSCRIPT_MESSAGES ? ` (the newest ${MAX_TRANSCRIPT_MESSAGES} only)` : ""}`,
    "",
  ].filter((line) => line !== null);
  const body = [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(messageLine);
  const text = [...header, ...body].join("\n");
  return text.length > MAX_TRANSCRIPT_LENGTH ? `${text.slice(0, MAX_TRANSCRIPT_LENGTH)}\n… (cut off: too long)` : text;
}
