// Turns deleted messages into a plain-text file for the logs.

// A plain-text record of the deleted messages, oldest first.
export function buildTranscript(messages) {
  return [...messages]
    .sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0))
    .map((message) => {
      const when = new Date(message.createdTimestamp).toISOString().replace("T", " ").slice(0, 19);
      const who = `${message.author?.tag ?? message.author?.username ?? "unknown"} (${message.author?.id ?? "?"})`;
      const attachments = [...(message.attachments?.values() ?? [])].map((attachment) => ` [file: ${attachment.url}]`);
      return `[${when} UTC] ${who}: ${message.content ?? ""}${attachments.join("")}`;
    })
    .join("\n");
}
