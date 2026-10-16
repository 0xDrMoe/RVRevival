// Reads RSS 2.0 and Atom feeds (YouTube and Reddit use Atom) without a
// dependency: only the few tags a feed post needs. Never throws on odd XML;
// a document with no items just has none.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

const stripTags = (html) => decodeXml(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// The text inside the first <tag>…</tag> (namespaced names like yt:videoId work).
function tagText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function attribute(tagSource, name) {
  const match = tagSource.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeXml(match[2] ?? match[3] ?? "") : "";
}

// Atom links: the rel="alternate" one (or the first without a rel).
function atomLink(entry) {
  const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map(([source]) => source);
  const alternate = links.find((source) => /rel\s*=\s*["']alternate["']/i.test(source)) ?? links.find((source) => !/\srel\s*=/i.test(source));
  return alternate ? attribute(alternate, "href") : "";
}

function isHttp(link) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export const MAX_ITEMS = 30;

// { title, items: [{ id, title, link, author, publishedAt }] }, items in feed order (newest first, usually).
export function parseFeed(xml) {
  if (typeof xml !== "string") {
    return { title: "", items: [] };
  }
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map(([block]) => block);
  const channelPart = xml.replace(/<(entry|item)[\s>][\s\S]*?<\/\1>/gi, "");
  const items = blocks.slice(0, MAX_ITEMS).map((block) => {
    const link = isAtom ? atomLink(block) || tagText(block, "link") : tagText(block, "link") || attribute(block.match(/<link\b[^>]*>/i)?.[0] ?? "", "href");
    const id = tagText(block, "yt:videoId") || tagText(block, "id") || tagText(block, "guid") || link || tagText(block, "title");
    const published = tagText(block, "published") || tagText(block, "pubDate") || tagText(block, "updated") || tagText(block, "dc:date");
    const time = Date.parse(published);
    return {
      id: id.slice(0, 300),
      title: tagText(block, "title").slice(0, 256) || "(untitled)",
      link: isHttp(link) ? link : "",
      author: (isAtom ? tagText(block.match(/<author[\s>][\s\S]*?<\/author>/i)?.[0] ?? "", "name") : tagText(block, "dc:creator") || tagText(block, "author")).slice(0, 100),
      publishedAt: Number.isFinite(time) ? time : null,
    };
  });
  return { title: tagText(channelPart, "title").slice(0, 200), items: items.filter((item) => item.id) };
}
