// The <head> tags that make each page its own search result and link preview.
// Discord, Slack and X read these from the HTML the server sends (they don't
// run JavaScript), so every address gets its own title, description,
// canonical address, Open Graph and Twitter card tags. What each page is
// called comes from public/pageMeta.js, which the app shares to keep the tab
// title in step as the reader moves around.

import { readFileSync } from "node:fs";
import { SITE_NAME, pageMeta, publicPaths } from "./public/pageMeta.js";

// The link preview image. The size must match the file, or Discord crops it.
const IMAGE = { path: "/og-image.jpg", width: 1200, height: 630, alt: "Rabble: the all-in-one Discord bot" };
const MARKER = "<!--%META%-->";

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Dashboard pages are named in English, like the rest of the tags: the page's
// own words for them ("page_cases": "Cases") in the English strings.
const ENGLISH = JSON.parse(readFileSync(new URL("./public/locales/en.json", import.meta.url), "utf8"));
const pageLabel = (pageId) => (Object.hasOwn(ENGLISH, `page_${pageId}`) ? ENGLISH[`page_${pageId}`] : undefined);

// JSON for a <script type="application/ld+json"> block (data, not code, so
// the page's CSP allows it). `<` is escaped so text can never close the tag.
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

// What search engines are told about the page: the bot itself on the home
// page, and where a guide page sits in the guide.
function structuredData(meta, baseUrl) {
  if (meta.landing) {
    return jsonLd({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      applicationCategory: "CommunicationApplication",
      operatingSystem: "Discord",
      url: `${baseUrl}/`,
      image: `${baseUrl}${IMAGE.path}`,
      description: meta.description,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@type": "Organization", name: "Cedar Tech Solutions" },
    });
  }
  if (meta.crumbs) {
    return jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: meta.crumbs.map((crumb, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: crumb.name,
        item: `${baseUrl}${crumb.path}`,
      })),
    });
  }
  return null;
}

// The tags for one page, indented to sit in a page's <head>. A page without a
// canonical address (one server's dashboard page) gets no address tags, so a
// preview never points somewhere else.
export function headTags(meta, baseUrl) {
  const url = meta.path === null ? null : `${baseUrl}${meta.path}`;
  const image = `${baseUrl}${IMAGE.path}`;
  const named = (name, content) => `<meta name="${name}" content="${escapeHtml(content)}" />`;
  const property = (name, content) => `<meta property="${name}" content="${escapeHtml(content)}" />`;
  return [
    `<title>${escapeHtml(meta.title)}</title>`,
    named("description", meta.description),
    meta.index ? null : named("robots", "noindex"),
    url && `<link rel="canonical" href="${escapeHtml(url)}" />`,
    property("og:type", "website"),
    property("og:site_name", SITE_NAME),
    property("og:locale", "en_US"),
    property("og:title", meta.heading),
    property("og:description", meta.description),
    url && property("og:url", url),
    property("og:image", image),
    property("og:image:width", String(IMAGE.width)),
    property("og:image:height", String(IMAGE.height)),
    property("og:image:alt", IMAGE.alt),
    named("twitter:card", "summary_large_image"),
    named("twitter:title", meta.heading),
    named("twitter:description", meta.description),
    named("twitter:image", image),
    named("twitter:image:alt", IMAGE.alt),
    structuredData(meta, baseUrl),
  ]
    .filter(Boolean)
    .join("\n    ");
}

// Returns render(pathname, search): the page template with its marker
// replaced by the tags of the page asked for. Each page is built once and
// kept. There are only so many: an unknown guide id is the guide's first
// page, and dashboard pages don't differ by server.
export function pageRenderer(template, baseUrl) {
  if (!template.includes(MARKER)) {
    throw new Error(`The page template has no ${MARKER} marker for its head tags`);
  }
  const pages = new Map();
  return (pathname, search = "") => {
    const meta = pageMeta(pathname, search, pageLabel);
    const key = `${meta.path ?? ""}\n${meta.title}`;
    let html = pages.get(key);
    if (html === undefined) {
      // A function, so a `$` in a title is never read as a replacement pattern.
      html = template.replace(MARKER, () => headTags(meta, baseUrl));
      pages.set(key, html);
    }
    return html;
  };
}

export function publicRobots(baseUrl) {
  return [
    "User-agent: *",
    "Disallow: /api/",
    "Disallow: /auth/",
    "Disallow: /g/",
    "Disallow: /servers",
    "Disallow: /appeal/",
    "Allow: /",
    "",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

// Every public page, guide parts and topics included. `&` and the like are
// written as character references, which XML reads the same way HTML does.
export function publicSitemap(baseUrl) {
  const urls = publicPaths()
    .map((path) => `  <url><loc>${escapeHtml(baseUrl + path)}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
