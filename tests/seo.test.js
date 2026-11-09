import { describe, expect, it } from "vitest";
import { PAGE_PATHS } from "../src/dashboard/app.js";
import { CHANGELOG } from "../src/dashboard/public/changelog.js";
import { GUIDE } from "../src/dashboard/public/guide.js";
import { clip, PAGE_ALIASES, pageMeta, plainText, publicPaths } from "../src/dashboard/public/pageMeta.js";
import { headTags, pageRenderer, publicSitemap } from "../src/dashboard/seo.js";

const BASE = "https://dash.example.com";
const GUILD_ID = "900000000000000001";
const render = pageRenderer("<head>\n    <!--%META%-->\n  </head>", BASE);
// The content of one <meta> tag in a page, or undefined when it has none.
const metaContent = (html, attribute, name) => html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)" />`))?.[1];

describe("page titles and descriptions", () => {
  const pages = publicPaths().map((path) => {
    const url = new URL(path, BASE);
    return { path, meta: pageMeta(url.pathname, url.search) };
  });

  it("lists every site page, guide part and guide topic once", () => {
    const topics = GUIDE.flatMap((part) => part.sections);
    expect(pages.length).toBe(6 + GUIDE.length + topics.length);
    expect(new Set(publicPaths()).size).toBe(pages.length);
    for (const { path, meta } of pages) {
      expect(path).toMatch(/^\/\w*(?:\?(?:part|topic)=\w+)?$/);
      expect(meta.path, path).toBe(path);
      expect(meta.index, path).toBe(true);
    }
  });

  it("gives every public page its own title, preview title and description", () => {
    for (const field of ["title", "heading", "description"]) {
      const seen = new Map();
      for (const { path, meta } of pages) {
        expect(seen.get(meta[field]), `${path} has the same ${field} as another page`).toBeUndefined();
        seen.set(meta[field], path);
      }
    }
  });

  it("keeps titles and descriptions a length search results show in full", () => {
    for (const { path, meta } of pages) {
      expect(meta.description.length, path).toBeLessThanOrEqual(160);
      expect(meta.description.length, path).toBeGreaterThanOrEqual(50);
      expect(meta.title.length, path).toBeLessThanOrEqual(70);
      // No `code`, **bold** or *italic* marks left over from the guide's text.
      expect(meta.description, path).not.toMatch(/`|\*\*|\*\w/);
    }
  });

  it("names guide pages after their topic, part or command", () => {
    expect(pageMeta("/guide")).toMatchObject({ title: "Guide · Rabble", heading: "Rabble Guide", path: "/guide" });
    expect(pageMeta("/guide", "?topic=cmdwarn")).toMatchObject({ title: "/warn command · Rabble Guide", path: "/guide?topic=cmdwarn" });
    expect(pageMeta("/guide", "?topic=cmdwarn").description).toMatch(/^\/warn: Gives a member a formal warning\./);
    expect(pageMeta("/guide", "?topic=automod").title).toBe("Automod · Rabble Guide");
    expect(pageMeta("/guide", "?part=protection")).toMatchObject({ title: "Protection · Rabble Guide", path: "/guide?part=protection" });
    expect(pageMeta("/guide", "?part=protection").crumbs.map((crumb) => crumb.name)).toEqual(["Guide", "Protection"]);
  });

  it("gives the same canonical address however the page was asked for", () => {
    expect(pageMeta("/guide/", "?utm_source=discord&topic=automod").path).toBe("/guide?topic=automod");
    expect(pageMeta("/guide", "?part=protection&topic=automod").path).toBe("/guide?topic=automod");
    expect(pageMeta("/status/", "?ref=1").path).toBe("/status");
    expect(pageMeta("/", "?anything").path).toBe("/");
  });

  it("falls back to the guide's first page for an unknown id, like the app", () => {
    expect(pageMeta("/guide", "?topic=nope").path).toBe("/guide");
    expect(pageMeta("/guide", "?part=<script>").path).toBe("/guide");
    expect(pageMeta("/guide", "?topic=constructor").path).toBe("/guide");
  });

  it("mentions the newest update on the What's new page", () => {
    const { description } = pageMeta("/changelog");
    const [day] = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${CHANGELOG[0].date}T00:00:00Z`)).split(" ");
    expect(description).toContain(`Latest, ${day} `);
    expect(description).toContain(CHANGELOG[0].title.slice(0, 20));
  });

  it("names pages behind a login without indexing them or naming a server", () => {
    expect(pageMeta("/servers")).toMatchObject({ index: false, path: "/servers", title: "Your servers · Rabble" });
    expect(pageMeta(`/appeal/${GUILD_ID}`)).toMatchObject({ index: false, path: null, title: "Appeal a ban · Rabble" });
    const label = (pageId) => ({ cases: "Cases", overview: "Overview", welcome: "Welcome & leave" })[pageId];
    expect(pageMeta(`/g/${GUILD_ID}/cases`, "?user=1", label)).toMatchObject({
      index: false,
      path: null,
      title: "Cases · Rabble dashboard",
      description: "The Cases page of the Rabble dashboard. Sign in with Discord to manage your server.",
    });
    expect(pageMeta(`/g/${GUILD_ID}`, "", label).title).toBe("Overview · Rabble dashboard");
    expect(pageMeta(`/g/${GUILD_ID}/community`, "", label).title).toBe("Welcome & leave · Rabble dashboard");
    expect(PAGE_ALIASES.get("community")).toBe("welcome");
    for (const meta of [pageMeta(`/g/${GUILD_ID}/nothing`, "", label), pageMeta(`/g/${GUILD_ID}/cases`)]) {
      expect(meta).toMatchObject({ index: false, path: null, title: "Dashboard · Rabble" });
    }
  });

  it("has a name for every address the server sends the page for", () => {
    const home = pageMeta("/");
    for (const pattern of [...PAGE_PATHS, "/terms", "/privacy"]) {
      const path = pattern.replace(":guildId", GUILD_ID).replace(":page", "cases");
      expect(pageMeta(path, "", () => "Cases").title, pattern).not.toBe(home.title);
    }
  });

  it("points the guide inside a server at the public page", () => {
    expect(pageMeta(`/g/${GUILD_ID}/guide`, "?topic=automod")).toEqual(pageMeta("/guide", "?topic=automod"));
  });

  it("treats an address it doesn't know as the home page", () => {
    expect(pageMeta("/nothing-here")).toEqual(pageMeta("/"));
    expect(pageMeta("/constructor")).toEqual(pageMeta("/"));
  });

  it("strips the guide's formatting and shortens text at a word", () => {
    expect(plainText("Use `/warn` for **bold** and *soft*   things")).toBe("Use /warn for bold and soft things");
    expect(plainText(undefined)).toBe("");
    const long = clip("word ".repeat(60).trim(), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith("word…")).toBe(true);
    expect(clip("Stops here, and the rest goes away", 14)).toBe("Stops here…");
    expect(clip("A whole first sentence fits. The second one is far too long to keep.", 40)).toBe("A whole first sentence fits.");
    expect(clip("Tiny. Then a long run of words with no full stop anywhere near the end", 40)).toBe("Tiny. Then a long run of words with no…");
    expect(clip("short")).toBe("short");
  });
});

describe("head tags", () => {
  it("renders a guide topic's own tags for link previews", () => {
    const html = render("/guide", "?topic=cmdwarn");
    expect(html).toContain("<title>/warn command · Rabble Guide</title>");
    expect(html).toContain(`<link rel="canonical" href="${BASE}/guide?topic=cmdwarn" />`);
    expect(metaContent(html, "property", "og:url")).toBe(`${BASE}/guide?topic=cmdwarn`);
    expect(metaContent(html, "property", "og:title")).toBe("/warn command · Rabble Guide");
    expect(metaContent(html, "property", "og:site_name")).toBe("Rabble");
    expect(metaContent(html, "property", "og:description")).toBe(metaContent(html, "name", "description"));
    expect(metaContent(html, "property", "og:image")).toBe(`${BASE}/og-image.jpg`);
    expect(metaContent(html, "name", "twitter:card")).toBe("summary_large_image");
    expect(metaContent(html, "name", "twitter:title")).toBe("/warn command · Rabble Guide");
    expect(metaContent(html, "name", "twitter:description")).toBe(metaContent(html, "name", "description"));
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain(`"item":"${BASE}/guide?part=cmdmod"`);
    expect(html).not.toContain('name="robots"');
    expect(html).not.toContain("%META%");
  });

  it("gives two pages different tags, and the same page the same ones", () => {
    expect(render("/guide", "?topic=cmdwarn")).not.toBe(render("/guide", "?topic=cmdban"));
    expect(render("/guide", "?topic=cmdwarn&utm=1")).toBe(render("/guide", "?topic=cmdwarn"));
    expect(render("/status")).not.toBe(render("/changelog"));
  });

  it("describes the bot to search engines on the home page only", () => {
    expect(render("/")).toContain('"@type":"SoftwareApplication"');
    expect(render("/status")).not.toContain("application/ld+json");
  });

  it("names a dashboard page in English, noindex and without an address", () => {
    const html = render(`/g/${GUILD_ID}/welcome`);
    expect(html).toContain("<title>Welcome &#38; leave · Rabble dashboard</title>");
    expect(metaContent(html, "name", "robots")).toBe("noindex");
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain("og:url");
    expect(html).not.toContain(GUILD_ID);
    expect(render(`/g/${GUILD_ID}/welcome`)).toBe(render("/g/900000000000000002/welcome"));
    expect(render(`/g/${GUILD_ID}/constructor`)).toContain("<title>Dashboard · Rabble</title>");
  });

  it("escapes text, and keeps structured data from closing its script tag", () => {
    const html = headTags(
      {
        title: 'A "quoted" <b> $& title',
        heading: "x</script><script>alert(1)",
        description: "this & that",
        path: "/guide?part=a&b=c",
        index: true,
        crumbs: [{ name: "</script><script>alert(2)", path: "/guide" }],
      },
      BASE,
    );
    expect(html).toContain("<title>A &#34;quoted&#34; &#60;b&#62; $&#38; title</title>");
    expect(html).toContain('<meta name="description" content="this &#38; that" />');
    expect(html).toContain(`<link rel="canonical" href="${BASE}/guide?part=a&#38;b=c" />`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script>");
  });

  it("keeps a `$` in a title as it is when filling the template", () => {
    const filled = "<head><!--%META%--></head>".replace("<!--%META%-->", () => headTags({ title: "$& and $1", heading: "h", description: "d", path: "/", index: true }, BASE));
    expect(filled).toContain("<title>$&#38; and $1</title>");
  });

  it("refuses a template without the marker", () => {
    expect(() => pageRenderer("<head></head>", BASE)).toThrow(/marker/);
  });

  it("lists guide pages in the sitemap as valid XML", () => {
    const sitemap = publicSitemap(BASE);
    expect(sitemap).toContain(`<loc>${BASE}/guide?topic=cmdwarn</loc>`);
    expect(sitemap).toContain(`<loc>${BASE}/guide?part=protection</loc>`);
    expect(sitemap.match(/<loc>/g)).toHaveLength(publicPaths().length);
    expect(sitemap).not.toMatch(/&(?!#\d+;)/);
    expect(sitemap).not.toContain("/servers");
  });
});
