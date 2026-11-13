// Draws a transcript (snapshot.js) as one self-contained web page that looks
// like the Discord conversation: avatars, names in their role colour, grouped
// messages, day dividers, formatting, mentions, embeds and attachments. The
// same page is shown on the dashboard, downloaded, and attached to log
// entries, so it works offline and needs no scripts. Light and dark follow the
// reader's system, and it fits phones.
//
// Everything that came from Discord is escaped. Links must be http(s).

const escapeHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Only web links, so nothing in a message can run as javascript: or data:.
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const pad = (number) => String(number).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "13 Nov 2026"
export const formatDay = (ms) => {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};
// "21:43"
const formatTime = (ms) => {
  const date = new Date(ms);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};
// "13 Nov 2026, 21:43 UTC"
export const formatDateTime = (ms) => `${formatDay(ms)}, ${formatTime(ms)} UTC`;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

// --- Discord formatting -------------------------------------------------------

// Discord's <t:unix:style> timestamps, in UTC.
function timestampText(seconds, style) {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) {
    return null;
  }
  switch (style) {
    case "t":
      return `${formatTime(ms)} UTC`;
    case "d":
    case "D":
      return formatDay(ms);
    default:
      return formatDateTime(ms);
  }
}

// Inline formatting of text that's already escaped: mentions, emoji, links,
// bold, italics, underline, strikethrough and spoilers.
function inline(text, names) {
  // Finished HTML (mentions, emoji, links) is set aside so the emphasis
  // rules below can't reach into its attributes.
  const done = [];
  const hold = (html) => `\u0001${done.push(html) - 1}\u0001`;
  let html = text;
  html = html.replace(/&lt;@!?(\d{17,20})&gt;/g, (_, id) => {
    const user = names.users?.[id];
    return hold(`<span class="mention">@${escapeHtml(user?.name ?? "unknown user")}</span>`);
  });
  html = html.replace(/&lt;@&amp;(\d{17,20})&gt;/g, (_, id) => {
    const role = names.roles?.[id];
    const color = /^#[0-9a-f]{6}$/i.test(role?.color ?? "") ? ` style="--role:${role.color}"` : "";
    return hold(`<span class="mention role"${color}>@${escapeHtml(role?.name ?? "unknown role")}</span>`);
  });
  html = html.replace(/&lt;#(\d{17,20})&gt;/g, (_, id) => hold(`<span class="mention">#${escapeHtml(names.channels?.[id] ?? "unknown channel")}</span>`));
  html = html.replace(/&lt;(a?):(\w{2,32}):(\d{17,20})&gt;/g, (_, animated, name, id) =>
    hold(`<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=48" alt=":${name}:" title=":${name}:" loading="lazy">`),
  );
  html = html.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (match, seconds, style) => {
    const shown = timestampText(seconds, style);
    return shown ? hold(`<span class="stamp">${escapeHtml(shown)}</span>`) : match;
  });
  html = html.replace(/@(everyone|here)\b/g, (_, who) => hold(`<span class="mention">@${who}</span>`));
  const link = (url, label) => {
    const safe = safeUrl(url.replace(/&amp;/g, "&"));
    return safe ? hold(`<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`) : null;
  };
  // Masked links [text](url), then bare links.
  html = html.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => link(url, label) ?? match);
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<\u0001]+[^\s<.,:;"')\]\u0001])/g, (match, before, url) => {
    const linked = link(url, url);
    return linked ? `${before}${linked}` : match;
  });
  html = html
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?![_\w])/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" tabindex="0">$1</span>');
  // Twice: a held link's label can hold a mention.
  for (let pass = 0; pass < 2; pass += 1) {
    html = html.replace(/\u0001(\d+)\u0001/g, (_, index) => done[Number(index)]);
  }
  return html;
}

// A message's text as HTML: code blocks and inline code are kept as they are,
// quotes, headings and lists get their own lines, the rest is inline().
export function renderMarkdown(text, names = {}) {
  // The placeholder characters below can't come from the message itself.
  const source = String(text ?? "").replace(/[\u0000\u0001]/g, "");
  if (!source) {
    return "";
  }
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let work = source.replace(/```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g, (_, language, code) =>
    keep(`<pre class="code"><code${language ? ` data-lang="${escapeHtml(language)}"` : ""}>${escapeHtml(code.replace(/^\n+|\n+$/g, ""))}</code></pre>`),
  );
  work = work.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  const lines = escapeHtml(work).split("\n");
  const out = [];
  for (const line of lines) {
    const quote = /^&gt; ?(.*)$/.exec(line);
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const small = /^-# (.+)$/.exec(line);
    const bullet = /^\s*[-*] (.+)$/.exec(line);
    if (quote) {
      out.push(`<blockquote>${inline(quote[1], names) || "&nbsp;"}</blockquote>`);
    } else if (heading) {
      out.push(`<h${heading[1].length + 2} class="md-h">${inline(heading[2], names)}</h${heading[1].length + 2}>`);
    } else if (small) {
      out.push(`<small class="subtext">${inline(small[1], names)}</small>`);
    } else if (bullet) {
      out.push(`<span class="bullet">${inline(bullet[1], names)}</span>`);
    } else {
      out.push(`${inline(line, names)}<br>`);
    }
  }
  let html = out.join("").replace(/(<br>)+$/, "");
  html = html.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)]);
  return html.replace(/<\/pre><br>/g, "</pre>");
}

// --- Page parts -------------------------------------------------------------------

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif)$/i;

function avatarHtml(user, size = 40) {
  const url = safeUrl(user?.avatar);
  if (url) {
    return `<img class="avatar" src="${escapeHtml(url)}" alt="" width="${size}" height="${size}" loading="lazy">`;
  }
  const letter = escapeHtml((user?.name ?? "?").trim().charAt(0).toUpperCase() || "?");
  return `<span class="avatar fallback" aria-hidden="true">${letter}</span>`;
}

function attachmentHtml(attachment) {
  const url = safeUrl(attachment.url);
  const name = escapeHtml(attachment.name ?? "file");
  const isImage = (attachment.contentType ?? "").startsWith("image/") || IMAGE_FILE.test(attachment.name ?? "");
  if (url && isImage) {
    return `<a class="image" href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank"><img src="${escapeHtml(url)}" alt="${name}" loading="lazy"></a>`;
  }
  const size = formatBytes(attachment.size);
  const label = url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${name}</a>` : name;
  return `<div class="file"><span class="file-icon" aria-hidden="true">📄</span><span class="file-text">${label}${size ? `<small>${size}</small>` : ""}</span></div>`;
}

function embedHtml(embed, names) {
  const parts = [];
  const color = /^#[0-9a-f]{6}$/i.test(embed.color ?? "") ? ` style="--embed:${embed.color}"` : "";
  if (embed.author?.name) {
    parts.push(`<div class="embed-author">${escapeHtml(embed.author.name)}</div>`);
  }
  if (embed.title) {
    const url = safeUrl(embed.url);
    const title = renderMarkdown(embed.title, names);
    parts.push(`<div class="embed-title">${url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${title}</a>` : title}</div>`);
  }
  if (embed.description) {
    parts.push(`<div class="embed-text">${renderMarkdown(embed.description, names)}</div>`);
  }
  if (embed.fields?.length > 0) {
    parts.push(
      `<div class="embed-fields">${embed.fields
        .map((field) => `<div class="embed-field${field.inline ? " inline" : ""}"><div class="embed-field-name">${renderMarkdown(field.name, names)}</div><div>${renderMarkdown(field.value, names)}</div></div>`)
        .join("")}</div>`,
    );
  }
  const image = safeUrl(embed.image ?? embed.thumbnail);
  if (image) {
    parts.push(`<img class="embed-image" src="${escapeHtml(image)}" alt="" loading="lazy">`);
  }
  if (embed.footer) {
    parts.push(`<div class="embed-footer">${escapeHtml(embed.footer)}</div>`);
  }
  return parts.length > 0 ? `<div class="embed"${color}>${parts.join("")}</div>` : "";
}

function messageBody(message, data) {
  const parts = [];
  if (message.content) {
    parts.push(`<div class="text">${renderMarkdown(message.content, data)}</div>`);
  }
  for (const embed of message.embeds ?? []) {
    parts.push(embedHtml(embed, data));
  }
  if (message.attachments?.length > 0) {
    parts.push(`<div class="attachments">${message.attachments.map(attachmentHtml).join("")}</div>`);
  }
  if (message.stickers?.length > 0) {
    parts.push(`<div class="stickers">${message.stickers.map((name) => `<span class="sticker">${escapeHtml(name)}</span>`).join("")}</div>`);
  }
  if (parts.length === 0) {
    parts.push('<div class="text muted">No text</div>');
  }
  return parts.join("");
}

// Messages by the same person within 7 minutes are shown as one group.
const GROUP_MS = 7 * 60 * 1000;

function messagesHtml(data) {
  const byId = new Map(data.messages.map((message) => [message.id, message]));
  const out = [];
  let previous;
  let day;
  for (const message of data.messages) {
    const at = message.createdAt ?? 0;
    const thisDay = formatDay(at);
    if (thisDay !== day) {
      out.push(`<div class="day" role="separator"><span>${escapeHtml(thisDay)}</span></div>`);
      day = thisDay;
      previous = undefined;
    }
    const user = data.users?.[message.authorId] ?? { name: "Unknown" };
    const edited = message.editedAt ? ' <span class="edited">(edited)</span>' : "";
    if (message.system) {
      out.push(`<div class="message system" id="m${escapeHtml(message.id)}"><span class="system-text">${renderMarkdown(message.content, data) || "System message"}</span> <time>${formatTime(at)}</time></div>`);
      previous = undefined;
      continue;
    }
    const reply = message.replyTo ? byId.get(message.replyTo) : undefined;
    const grouped = !reply && previous && previous.authorId === message.authorId && at - (previous.createdAt ?? 0) < GROUP_MS;
    const replyHtml = message.replyTo
      ? `<a class="reply" href="#m${escapeHtml(message.replyTo)}">↪ ${
          reply
            ? `<strong>${escapeHtml(data.users?.[reply.authorId]?.name ?? "Unknown")}</strong> ${escapeHtml((reply.content || "Attachment").replace(/\s+/g, " ").slice(0, 100))}`
            : "a message not in this transcript"
        }</a>`
      : "";
    if (grouped) {
      out.push(
        `<div class="message follow" id="m${escapeHtml(message.id)}"><time class="side">${formatTime(at)}</time><div class="body">${messageBody(message, data)}${edited ? `<div class="meta">${edited}</div>` : ""}</div></div>`,
      );
    } else {
      const color = /^#[0-9a-f]{6}$/i.test(user.color ?? "") ? ` style="--name:${user.color}"` : "";
      out.push(
        `<div class="message" id="m${escapeHtml(message.id)}">${replyHtml}<div class="row">${avatarHtml(user)}<div class="body"><div class="head"><span class="name"${color} title="${escapeHtml(user.username ?? "")}">${escapeHtml(user.name)}</span>${user.bot ? '<span class="tag">APP</span>' : ""}<time datetime="${new Date(at).toISOString()}">${escapeHtml(formatDateTime(at))}</time>${edited}</div>${messageBody(message, data)}</div></div></div>`,
      );
    }
    previous = message;
  }
  return out.join("\n");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--panel:#f2f3f5;--text:#2e3338;--muted:#5c5e66;--line:#e3e5e8;--link:#006ce7;--mention:rgba(88,101,242,.15);--mention-text:#4752c4;--code:#ebedef;--embed-bg:#f2f3f5;--accent:#7c5cff}
@media (prefers-color-scheme:dark){:root{--bg:#313338;--panel:#2b2d31;--text:#dbdee1;--muted:#949ba4;--line:#3f4147;--link:#00a8fc;--mention:rgba(88,101,242,.3);--mention-text:#c9cdfb;--code:#2b2d31;--embed-bg:#2b2d31}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
a{color:var(--link)}
.page{max-width:980px;margin:0 auto;padding:16px}
.top{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px}
.top a{text-decoration:none}
.card{background:var(--panel);border-radius:12px;padding:16px;margin-bottom:16px;border-top:4px solid var(--accent)}
.card-head{display:flex;gap:12px;align-items:center}
.card-head img{width:48px;height:48px;border-radius:50%;flex:none}
h1{font-size:20px;margin:0;line-height:1.25}
.sub{color:var(--muted);margin:2px 0 0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:10px 16px;margin:14px 0 0;padding:0}
.facts div{min-width:0}
.facts dt{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--muted)}
.facts dd{margin:2px 0 0}
.notice{background:var(--panel);border-left:4px solid #f0b232;padding:8px 12px;border-radius:8px;margin-bottom:12px;font-size:14px}
.day{display:flex;align-items:center;gap:8px;margin:20px 0 8px;color:var(--muted);font-size:12px;font-weight:600}
.day:before,.day:after{content:"";flex:1;border-top:1px solid var(--line)}
.message{padding:2px 8px;border-radius:6px}
.message:hover{background:var(--panel)}
.message:target{background:var(--mention)}
.message+.message:not(.follow){margin-top:12px}
.row{display:flex;gap:12px;align-items:flex-start}
.avatar{width:40px;height:40px;border-radius:50%;flex:none;object-fit:cover;background:var(--line)}
.avatar.fallback{display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;background:var(--accent)}
.body{min-width:0;flex:1}
.follow{display:flex;gap:12px}
.follow .side{width:40px;flex:none;text-align:right;font-size:11px;color:transparent;padding-top:3px}
.follow:hover .side{color:var(--muted)}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
.name{font-weight:600;color:var(--name,var(--text))}
.tag{background:#5865f2;color:#fff;font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;align-self:center}
time{color:var(--muted);font-size:12px}
.edited,.meta{color:var(--muted);font-size:11px}
.text{white-space:normal}
.muted{color:var(--muted)}
.mention{background:var(--mention);color:var(--mention-text);border-radius:4px;padding:0 2px;font-weight:500}
.mention.role{color:var(--role,var(--mention-text));background:color-mix(in srgb,var(--role,#5865f2) 18%,transparent)}
.stamp{background:var(--code);border-radius:4px;padding:0 3px}
code{font:13px/1.4 Consolas,"Courier New",monospace;background:var(--code);border-radius:4px;padding:1px 4px}
pre.code{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:8px;margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
pre.code code{padding:0;background:none}
blockquote{margin:2px 0;padding-left:10px;border-left:4px solid var(--line)}
.md-h{margin:6px 0 2px}
h3.md-h{font-size:20px}h4.md-h{font-size:17px}h5.md-h{font-size:15px}
.subtext{display:block;color:var(--muted);font-size:12px}
.bullet{display:block;padding-left:14px;position:relative}
.bullet:before{content:"•";position:absolute;left:2px}
.spoiler{background:var(--muted);color:transparent;border-radius:4px;padding:0 2px;cursor:pointer}
.spoiler:hover,.spoiler:focus{background:var(--code);color:inherit}
.emoji{width:22px;height:22px;vertical-align:-5px;object-fit:contain}
.reply{display:block;font-size:13px;color:var(--muted);margin:0 0 2px 52px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:clip}
.reply strong{color:var(--text)}
.embed{border-left:4px solid var(--embed,var(--line));background:var(--embed-bg);border-radius:4px;padding:8px 12px;margin:4px 0;max-width:520px}
.embed-author{font-size:13px;font-weight:600}
.embed-title{font-weight:700;margin:2px 0}
.embed-text{font-size:14px}
.embed-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,150px),1fr));gap:6px 12px;margin-top:6px;font-size:14px}
.embed-field{grid-column:1/-1}
.embed-field.inline{grid-column:auto}
.embed-field-name{font-weight:700}
.embed-image{display:block;max-width:100%;max-height:300px;border-radius:4px;margin-top:8px}
.embed-footer{font-size:12px;color:var(--muted);margin-top:6px}
.attachments{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.image img{display:block;max-width:min(400px,100%);max-height:300px;border-radius:6px}
.file{display:flex;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;max-width:100%}
.file-text{display:flex;flex-direction:column;min-width:0}
.file small{color:var(--muted)}
.sticker{display:inline-block;background:var(--panel);border-radius:8px;padding:4px 8px;font-size:13px;margin-top:4px}
.system{color:var(--muted);font-size:14px;padding-left:60px}
.empty{text-align:center;color:var(--muted);padding:32px 0}
.foot{color:var(--muted);font-size:12px;text-align:center;margin:24px 0 8px}
pre.plain{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 Consolas,"Courier New",monospace;background:var(--panel);border-radius:8px;padding:12px}
.embedded .page{padding:8px}
@media (max-width:520px){.page{padding:12px}.avatar{width:32px;height:32px}.follow .side{width:32px}.reply{margin-left:44px}.system{padding-left:44px}.card{padding:12px}}
`;

// The whole page. Options:
//   title      "Ticket #12"
//   subtitle   the ticket's subject, say
//   facts      [{ label, value }] shown under the title (plain text)
//   data       transcript data (snapshot.js), or
//   text       an old plain-text transcript, shown as it is
//   backUrl    a "Back" link at the top, if any
//   embedded   true when shown inside the dashboard, which shows the details itself:
//              no header card, no back link, less padding
export function renderTranscriptPage({ title, subtitle = null, facts = [], data, text, backUrl = null, embedded = false, brand = "Rabble" }) {
  const icon = safeUrl(data?.guild?.icon);
  const back = backUrl && !embedded ? `<nav class="top"><a href="${escapeHtml(backUrl)}">← Back to the dashboard</a></nav>` : "";
  const factsHtml = facts
    .filter((fact) => fact && fact.value !== null && fact.value !== undefined && fact.value !== "")
    .map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`)
    .join("");
  const notices = [];
  if (data?.truncated) {
    notices.push("This transcript was too long to keep whole, so the oldest messages were left out.");
  }
  let content;
  if (data) {
    content = data.messages.length > 0 ? messagesHtml(data) : '<p class="empty">No messages.</p>';
  } else if (typeof text === "string") {
    notices.push("This transcript was saved before transcripts kept formatting, so it's shown as plain text.");
    content = `<pre class="plain">${escapeHtml(text)}</pre>`;
  } else {
    content = '<p class="empty">No transcript was saved.</p>';
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}${data?.guild?.name ? ` · ${escapeHtml(data.guild.name)}` : ""}</title>
<style>${STYLE}</style>
</head>
<body${embedded ? ' class="embedded"' : ""}>
<main class="page">
${back}
${embedded ? "" : `<header class="card">
<div class="card-head">${icon ? `<img src="${escapeHtml(icon)}" alt="">` : ""}<div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ""}${data?.guild?.name ? `<p class="sub">${escapeHtml(data.guild.name)}</p>` : ""}</div></div>
${factsHtml ? `<dl class="facts">${factsHtml}</dl>` : ""}
</header>`}
${notices.map((notice) => `<p class="notice">${escapeHtml(notice)}</p>`).join("\n")}
<section aria-label="Messages">
${content}
</section>
<p class="foot">Saved by ${escapeHtml(brand)} · times in UTC · images and files are Discord links and can stop working after a while</p>
</main>
</body>
</html>
`;
}

// A short page in the transcript look, for "not found" and "no access".
export function renderNotice({ title, message, linkUrl = null, linkText = null }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="page">
<header class="card"><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(message)}</p>${
    linkUrl ? `<p><a href="${escapeHtml(linkUrl)}">${escapeHtml(linkText ?? linkUrl)}</a></p>` : ""
  }</header>
</main>
</body>
</html>
`;
}
