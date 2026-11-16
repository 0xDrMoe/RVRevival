import { describe, expect, it } from "vitest";
import { buildTicketEventEmbed, TicketEvent, transcriptUrl } from "../src/tickets/ticketLog.js";
import {
  checkTranscriptKey,
  isLinkPreviewAgent,
  transcriptKey,
  transcriptPath,
  transcriptPreview,
  transcriptPreviewPage,
} from "../src/transcripts/linkPreview.js";

const SECRET = "x".repeat(40);
const GUILD = "154014014698344450";

describe("transcript link keys", () => {
  it("signs one server and ticket, and checks it", () => {
    const key = transcriptKey(SECRET, GUILD, 22);
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(checkTranscriptKey(SECRET, GUILD, 22, key)).toBe(true);
    expect(checkTranscriptKey(SECRET, GUILD, 23, key)).toBe(false);
    expect(checkTranscriptKey(SECRET, "154014014698344451", 22, key)).toBe(false);
    expect(checkTranscriptKey("y".repeat(40), GUILD, 22, key)).toBe(false);
    expect(checkTranscriptKey(SECRET, GUILD, 22, undefined)).toBe(false);
    expect(checkTranscriptKey(SECRET, GUILD, 22, "short")).toBe(false);
    expect(checkTranscriptKey(null, GUILD, 22, key)).toBe(false);
  });

  it("puts the key on links when there is a secret", () => {
    expect(transcriptPath(GUILD, 22)).toBe(`/transcripts/${GUILD}/22`);
    expect(transcriptPath(GUILD, 22, SECRET)).toBe(`/transcripts/${GUILD}/22?k=${transcriptKey(SECRET, GUILD, 22)}`);
    const ticket = { guildId: GUILD, number: 22 };
    expect(transcriptUrl("https://rabble.example.com/", ticket)).toBe(`https://rabble.example.com/transcripts/${GUILD}/22`);
    expect(transcriptUrl("https://rabble.example.com", ticket, SECRET)).toBe(`https://rabble.example.com${transcriptPath(GUILD, 22, SECRET)}`);
    expect(transcriptUrl(null, ticket, SECRET)).toBeNull();
    const embed = buildTicketEventEmbed({ ticket: { ...ticket, userId: "1" }, event: TicketEvent.CLOSED, transcriptLink: transcriptUrl("https://r.example", ticket, SECRET) });
    expect(JSON.stringify(embed.toJSON())).toContain("?k=");
  });
});

describe("link readers", () => {
  it("knows chat apps' link readers, not browsers", () => {
    expect(isLinkPreviewAgent("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)")).toBe(true);
    expect(isLinkPreviewAgent("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)")).toBe(true);
    expect(isLinkPreviewAgent("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isLinkPreviewAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")).toBe(false);
    expect(isLinkPreviewAgent(undefined)).toBe(false);
  });
});

describe("transcript previews", () => {
  const ticket = {
    number: 22,
    userId: "1",
    subject: "My   rank\nrole is missing",
    categoryLabel: "Support",
    createdAt: Date.UTC(2026, 10, 14, 12),
    closedAt: Date.UTC(2026, 10, 16, 9),
    closedBy: "2",
    closeReason: "Fixed the role",
    messageCount: 14,
    claimedBy: "2",
    rating: 5,
  };

  it("gives a short rundown of a keyed ticket, without message text", () => {
    const preview = transcriptPreview({ number: 22, guildName: "Rumbleverse", ticket, names: { 1: "Moe", 2: "Staffy" } });
    expect(preview.title).toBe("Ticket #22 transcript · Rumbleverse");
    expect(preview.description).toBe(
      [
        "📝 My rank role is missing",
        "Opened by Moe · 14 Nov 2026 · Support",
        "Closed by Staffy · 16 Nov 2026 · Reason: Fixed the role",
        "14 messages · Claimed by Staffy · Rated 5/5",
      ].join("\n"),
    );
  });

  it("covers open, automatic and unnamed tickets", () => {
    const open = transcriptPreview({ number: 3, ticket: { number: 3, userId: "1", createdAt: null, closedAt: null, messageCount: null } });
    expect(open.title).toBe("Ticket #3 transcript");
    expect(open.description).toBe("Opened by a member\nStill open");
    const auto = transcriptPreview({ number: 4, ticket: { ...ticket, closedBy: null, closeReason: null, claimedBy: null, rating: null, messageCount: 1 } });
    expect(auto.description).toContain("Closed automatically · 16 Nov 2026");
    expect(auto.description).toContain("1 message");
    expect(auto.description).not.toContain("1 messages");
  });

  it("stays short when the subject and reason are long", () => {
    const long = transcriptPreview({ number: 5, ticket: { ...ticket, subject: "word ".repeat(200), closeReason: "why ".repeat(200) }, names: { 1: "n".repeat(100) } });
    expect(long.description.length).toBeLessThanOrEqual(340);
    expect(long.description.split("\n").length).toBeGreaterThanOrEqual(3);
  });

  it("only says what it is without a key", () => {
    const plain = transcriptPreview({ number: 22 });
    expect(plain.title).toBe("Ticket #22 transcript");
    expect(plain.description).toContain("log in with Discord");
  });

  it("escapes everything in the page", () => {
    const page = transcriptPreviewPage({
      baseUrl: "https://rabble.example.com",
      path: `/transcripts/${GUILD}/22`,
      loginPath: "/auth/login?next=x",
      preview: transcriptPreview({ number: 22, guildName: '<b>"Evil"</b>', ticket: { ...ticket, subject: "<script>alert(1)</script>" } }),
    });
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<b>");
    expect(page).toContain('<meta property="og:title" content="Ticket #22 transcript · &#60;b&#62;&#34;Evil&#34;&#60;/b&#62;" />');
    expect(page).toContain('<meta name="twitter:card" content="summary" />');
    expect(page).toContain(`<meta property="og:url" content="https://rabble.example.com/transcripts/${GUILD}/22" />`);
    expect(page).toContain('<meta property="og:image" content="https://rabble.example.com/og-image.jpg" />');
    expect(page).toContain('href="/auth/login?next=x"');
  });
});
