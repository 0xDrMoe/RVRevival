// What each address on the site is called: its title, description and
// canonical address. The server puts these in the page's <head> (seo.js) so
// link previews (Discord, Slack, X) and search engines see the right page
// without running JavaScript, and app.js updates them as the reader moves
// around. Runs in the browser and in Node, so it only uses plain JavaScript.
//
// pageMeta(pathname, search, pageLabel) returns:
//   title        the browser tab and search result title
//   heading      the link preview's title (og:title)
//   description  one or two sentences, at most 160 characters
//   path         the canonical address (the path, plus the query that picks a
//                guide page), or null for a page that belongs to one server
//   index        false for pages behind a login, which search engines skip
//   crumbs       [{ name, path }] on guide pages, for breadcrumbs
//   landing      true on the home page
//
// pageLabel(pageId) names a dashboard page ("cases" is "Cases"); it returns
// nothing for a page it doesn't know.

import { CHANGELOG } from "./changelog.js";
import { GUIDE } from "./guide.js";

export const SITE_NAME = "Rabble";
export const SITE_DESCRIPTION =
  "The all-in-one Discord bot for your community. Moderation, automod, tickets, leveling and more, all set up from one dashboard.";
// Search results and link previews cut longer text off mid-sentence.
const DESCRIPTION_LENGTH = 160;
// Guide text shorter than this gets a closing line (see describeGuide).
const SHORT_DESCRIPTION = 100;

// Guide text without its `code`, **bold** and *italic* marks.
export function plainText(text) {
  return String(text ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Shortens text to at most `max` characters: whole sentences when they fill a
// fair part of the space, otherwise cut at a word break with an ellipsis.
export function clip(text, max = DESCRIPTION_LENGTH) {
  if (text.length <= max) {
    return text;
  }
  const sentenceEnd = Math.max(...[". ", "? ", "! "].map((mark) => text.lastIndexOf(mark, max - 1)));
  if (sentenceEnd >= max * 0.4) {
    return text.slice(0, sentenceEnd + 1);
  }
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const describe = (text) => clip(plainText(text));

// A short summary gets a closing line, so the preview says where it's from
// and a search result has enough to show.
function describeGuide(text, closing) {
  const summary = describe(text);
  return summary.length < SHORT_DESCRIPTION && !summary.endsWith("…") ? `${summary} ${closing}` : summary;
}

// "2026-11-09" as "9 November 2026", like the legal pages write dates.
function longDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(parsed);
}

// --- The guide: /guide, /guide?part=<id>, /guide?topic=<id> -------------------

const GUIDE_NAME = `${SITE_NAME} Guide`;
const GUIDE_HOME = {
  title: `Guide · ${SITE_NAME}`,
  heading: GUIDE_NAME,
  description: "How to set up and use Rabble: every feature explained step by step, and a page for every slash command with all its options.",
  path: "/guide",
  index: true,
  crumbs: [{ name: "Guide", path: "/guide" }],
};

const PARTS = new Map(GUIDE.map((part) => [part.id, part]));
const TOPICS = new Map(GUIDE.flatMap((part) => part.sections.map((section) => [section.id, { section, part }])));

const partPath = (part) => `/guide?part=${encodeURIComponent(part.id)}`;
const topicPath = (section) => `/guide?topic=${encodeURIComponent(section.id)}`;

function guidePartMeta(part) {
  const title = `${part.part} · ${GUIDE_NAME}`;
  return {
    title,
    heading: title,
    description: describeGuide(part.about, "Explained in the Rabble Guide."),
    path: partPath(part),
    index: true,
    crumbs: [...GUIDE_HOME.crumbs, { name: part.part, path: partPath(part) }],
  };
}

function guideTopicMeta({ section, part }) {
  const name = section.command ? `${section.command} command` : section.title;
  const title = `${name} · ${GUIDE_NAME}`;
  const summary = section.summary || part.about;
  return {
    title,
    heading: title,
    // A command's page starts with the command, so it never reads the same as
    // the feature topic it belongs to.
    description: section.command
      ? describeGuide(`${section.command}: ${summary}`, "Every option, with examples, in the Rabble Guide.")
      : describeGuide(summary, "Step by step in the Rabble Guide."),
    path: topicPath(section),
    index: true,
    crumbs: [...GUIDE_HOME.crumbs, { name: part.part, path: partPath(part) }, { name, path: topicPath(section) }],
  };
}

// An unknown id is the guide's first page, which is also what the app shows.
function guideMeta(search) {
  const query = new URLSearchParams(search);
  const topic = TOPICS.get(query.get("topic"));
  if (topic) {
    return guideTopicMeta(topic);
  }
  const part = PARTS.get(query.get("part"));
  return part ? guidePartMeta(part) : GUIDE_HOME;
}

// --- The other public pages ---------------------------------------------------

const [latest] = CHANGELOG;
const PUBLIC_PAGES = {
  "/": {
    title: `${SITE_NAME}: Discord bot and dashboard`,
    heading: `${SITE_NAME}: the all-in-one Discord bot`,
    description: SITE_DESCRIPTION,
    landing: true,
  },
  "/status": {
    title: `Status · ${SITE_NAME}`,
    heading: `${SITE_NAME} status`,
    description: "Is Rabble online right now? Live bot status, ping and uptime for each of the last 30 days.",
  },
  "/changelog": {
    title: `What's new · ${SITE_NAME}`,
    heading: `What's new in ${SITE_NAME}`,
    description: describe(
      latest
        ? `Every update to the Rabble bot and dashboard, newest first. Latest, ${longDate(latest.date)}: ${latest.title}.`
        : "Every update to the Rabble bot and dashboard, newest first.",
    ),
  },
  "/terms": {
    title: `Terms of Service · ${SITE_NAME}`,
    heading: `${SITE_NAME} Terms of Service`,
    description: "The rules for using the Rabble Discord bot and dashboard: acceptable use, running a server with it, your content, and the limits of the service.",
  },
  "/privacy": {
    title: `Privacy Policy · ${SITE_NAME}`,
    heading: `${SITE_NAME} Privacy Policy`,
    description: "What the Rabble Discord bot and dashboard store, why, who can see it, how long it's kept, and how to have it deleted.",
  },
};

// --- Pages behind a login -----------------------------------------------------
// Named, so a link pasted in Discord says which page it opens, but kept out of
// search results. Nothing here names a server: anyone can ask for these pages.

const SERVERS = {
  title: `Your servers · ${SITE_NAME}`,
  heading: `Your servers · ${SITE_NAME}`,
  description: "Pick a server to manage with the Rabble dashboard. Sign in with Discord to see the ones you can manage.",
  path: "/servers",
  index: false,
};
const APPEAL = {
  title: `Appeal a ban · ${SITE_NAME}`,
  heading: `Appeal a ban · ${SITE_NAME}`,
  description: "Banned from a server that uses Rabble? Sign in with Discord and ask its staff to take another look.",
  path: null,
  index: false,
};
const DASHBOARD_NAME = `${SITE_NAME} dashboard`;
// Addresses from older versions of the dashboard, and the page each one is now.
export const PAGE_ALIASES = new Map([
  ["settings", "moderation"],
  ["community", "welcome"],
]);

function dashboardMeta(pageId, pageLabel) {
  const label = pageLabel?.(pageId);
  const named = typeof label === "string" && label.length > 0;
  const title = named ? `${label} · ${DASHBOARD_NAME}` : `Dashboard · ${SITE_NAME}`;
  return {
    title,
    heading: title,
    description: named
      ? `The ${label} page of the Rabble dashboard. Sign in with Discord to manage your server.`
      : "Manage your server with the Rabble dashboard. Sign in with Discord to open it.",
    path: null,
    index: false,
  };
}

export function pageMeta(pathname, search = "", pageLabel) {
  // Without any trailing slashes ("/guide/" is "/guide"); "/" stays as it is.
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === "/") {
    end -= 1;
  }
  const path = pathname.slice(0, end);
  if (path === "/guide") {
    return guideMeta(search);
  }
  if (Object.hasOwn(PUBLIC_PAGES, path)) {
    return { ...PUBLIC_PAGES[path], path, index: true };
  }
  if (path === "/servers") {
    return SERVERS;
  }
  if (/^\/appeal\/\d+$/.test(path)) {
    return APPEAL;
  }
  const dashboard = path.match(/^\/g\/\d+(?:\/(\w+))?$/);
  if (dashboard) {
    const pageId = PAGE_ALIASES.get(dashboard[1]) ?? dashboard[1] ?? "overview";
    // The guide inside a server is a copy of the public one, so its canonical
    // address is the public page.
    return pageId === "guide" ? guideMeta(search) : dashboardMeta(pageId, pageLabel);
  }
  return { ...PUBLIC_PAGES["/"], path: "/", index: true };
}

// Every address worth listing in the sitemap: the site's pages, then each
// guide part and topic.
export function publicPaths() {
  return [
    ...Object.keys(PUBLIC_PAGES),
    GUIDE_HOME.path,
    ...[...PARTS.values()].map(partPath),
    ...[...TOPICS.values()].map(({ section }) => topicPath(section)),
  ];
}
