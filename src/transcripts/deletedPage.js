// Deleted messages (a bulk delete or /purge) as a transcript page, attached
// to the log entry so staff can read them the way they looked.

import { buildTranscriptData } from "./snapshot.js";
import { formatDateTime, renderTranscriptPage } from "./render.js";

// `title` is like "Messages purged"; `by` is who did it (a name), if known.
export function deletedMessagesPage({ guild, channel, messages, title, by = null, at = Date.now() }) {
  const data = buildTranscriptData({ guild, channel, messages });
  const channelName = channel?.name ? `#${channel.name}` : null;
  return renderTranscriptPage({
    title,
    subtitle: channelName,
    facts: [
      { label: "Channel", value: channelName ?? channel?.id ?? null },
      { label: "Messages", value: String(data.messages.length) },
      { label: "By", value: by },
      { label: "Deleted", value: formatDateTime(at) },
    ],
    data,
  });
}
