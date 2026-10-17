import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildGuideCommandData, buildGuidePages, createGuideCommand, findGuidePage, renderGuidePage } from "../src/commands/guide.js";
import { GUIDE } from "../src/dashboard/public/guide.js";
import { SUPPORTED_LANGUAGES } from "../src/i18n/i18n.js";

const GUILD_ID = "900000000000000001";
const DASHBOARD = "https://rumbleverse.example.com";
const PAGES = buildGuidePages();
const topics = GUIDE.flatMap((part) => part.sections);

const json = (message) => ({
  embeds: message.embeds.map((embed) => embed.toJSON()),
  components: message.components.map((row) => row.toJSON()),
});

// Everything Discord counts towards an embed's 6000 characters.
const embedSize = (embed) =>
  (embed.title ?? "").length +
  (embed.description ?? "").length +
  (embed.author?.name ?? "").length +
  (embed.footer?.text ?? "").length +
  (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);

function fakeInteraction({ topic = null, locale = "en-US", customId, values } = {}) {
  return {
    locale,
    guildId: GUILD_ID,
    customId,
    values,
    options: { getString: () => topic, getFocused: () => topic ?? "" },
    isStringSelectMenu: () => values !== undefined,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

const buttonsOf = (message) => message.components.at(-1).components;
const titleOf = (message) => message.embeds[0].title;

describe("/guide pages", () => {
  it("has the contents, every part and every topic, in reading order", () => {
    expect(PAGES[0].key).toBe("home");
    const keys = PAGES.map((page) => page.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const part of GUIDE) {
      const start = keys.indexOf(`p.${part.id}`);
      expect(start, part.id).toBeGreaterThan(0);
      expect(PAGES[start + 1].topic).toBe(part.sections[0]);
    }
    for (const topic of topics) {
      expect(keys, topic.id).toContain(`t.${topic.id}.0`);
    }
  });

  it.each(SUPPORTED_LANGUAGES)("fits every page in Discord's limits (%s)", (language) => {
    for (let index = 0; index < PAGES.length; index += 1) {
      const message = json(renderGuidePage(index, { language, dashboardUrl: DASHBOARD, guildId: GUILD_ID }));
      const [embed] = message.embeds;
      const where = `${language} ${PAGES[index].key}`;
      expect(embedSize(embed), where).toBeLessThanOrEqual(6000);
      expect((embed.title ?? "").length, where).toBeLessThanOrEqual(256);
      expect((embed.description ?? "").length, where).toBeLessThanOrEqual(4096);
      expect((embed.fields ?? []).length, where).toBeLessThanOrEqual(25);
      for (const field of embed.fields ?? []) {
        expect(field.name.length, where).toBeLessThanOrEqual(256);
        expect(field.value.length, where).toBeGreaterThan(0);
        expect(field.value.length, where).toBeLessThanOrEqual(1024);
      }

      expect(message.components.length, where).toBeLessThanOrEqual(5);
      const ids = message.components.flatMap((row) => row.components).map((component) => component.custom_id).filter(Boolean);
      expect(new Set(ids).size, where).toBe(ids.length);
      for (const id of ids) {
        expect(id.length, where).toBeLessThanOrEqual(100);
      }
      for (const row of message.components) {
        expect(row.components.length, where).toBeLessThanOrEqual(5);
        for (const menu of row.components.filter((component) => component.options)) {
          expect(menu.options.length, where).toBeGreaterThan(0);
          expect(menu.options.length, where).toBeLessThanOrEqual(25);
          expect(menu.options.filter((option) => option.default).length, where).toBeLessThanOrEqual(1);
          for (const option of menu.options) {
            expect(option.label.length, where).toBeLessThanOrEqual(100);
            expect((option.description ?? "").length, where).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it("shows every command a topic explains", () => {
    const shown = PAGES.filter((page) => page.topic)
      .map((page) => json(renderGuidePage(PAGES.indexOf(page))).embeds[0])
      .flatMap((embed) => (embed.fields ?? []).map((field) => field.value))
      .join("\n");
    for (const topic of topics) {
      for (const [usage] of topic.commands ?? []) {
        expect(shown, `${topic.id} ${usage}`).toContain(`\`${usage}\``);
      }
    }
  });

  it("finds pages by key, topic, part and words, and falls back to the contents", () => {
    expect(PAGES[findGuidePage("t.moderation.0")].topic.id).toBe("moderation");
    expect(PAGES[findGuidePage("tickets")].topic.id).toBe("tickets");
    expect(PAGES[findGuidePage("protection")].part.id).toBe("protection");
    expect(PAGES[findGuidePage("protection")].topic).toBeUndefined();
    expect(PAGES[findGuidePage("Troubleshoot")].topic.id).toBe("troubleshooting");
    expect(findGuidePage("nothing like this")).toBe(0);
    expect(findGuidePage(null)).toBe(0);
  });

  it("disables Previous on the first page and Next on the last", () => {
    const first = json(renderGuidePage(0));
    expect(buttonsOf(first)[0].disabled).toBe(true);
    expect(buttonsOf(first)[2].disabled).toBe(false);
    expect(first.components).toHaveLength(2);
    const last = json(renderGuidePage(PAGES.length - 1));
    expect(buttonsOf(last)[0].disabled).toBe(false);
    expect(buttonsOf(last)[2].disabled).toBe(true);
    expect(last.components).toHaveLength(3);
  });

  it("links to the same page on the dashboard only when it has an address", () => {
    const index = findGuidePage("tickets");
    expect(buttonsOf(json(renderGuidePage(index)))).toHaveLength(3);
    const link = buttonsOf(json(renderGuidePage(index, { dashboardUrl: DASHBOARD, guildId: GUILD_ID })))[3];
    expect(link.url).toBe(`${DASHBOARD}/#/g/${GUILD_ID}/guide?topic=tickets`);
  });

  it("notes the guide is in English for other languages", () => {
    expect(json(renderGuidePage(0, { language: "en" })).embeds[0].footer.text).toBe(`Page 1 of ${PAGES.length}`);
    expect(json(renderGuidePage(0, { language: "es" })).embeds[0].footer.text).toContain("inglés");
  });
});

describe("/guide command", () => {
  const command = createGuideCommand({ dashboardUrl: DASHBOARD });

  it("registers with an optional, autocompleted topic", () => {
    expect(buildGuideCommandData()).toMatchObject({
      name: "guide",
      options: [{ name: "topic", required: false, autocomplete: true }],
    });
  });

  it("replies privately with the contents, or the topic asked for", async () => {
    const plain = fakeInteraction();
    await expect(command.execute(plain)).resolves.toMatchObject({ status: "success" });
    const [reply] = plain.reply.mock.calls[0];
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(titleOf(json(reply))).toContain("Guide");

    const topic = fakeInteraction({ topic: "t.tickets.0" });
    await command.execute(topic);
    expect(titleOf(json(topic.reply.mock.calls[0][0]))).toContain("Support tickets");
  });

  it("pages with the buttons and jumps with the menus", async () => {
    const handle = command.componentPrefixes["guide:"].handle;
    const first = json(renderGuidePage(0));

    const next = fakeInteraction({ customId: buttonsOf(first)[2].custom_id });
    await expect(handle(next)).resolves.toBeNull();
    const second = json(next.update.mock.calls[0][0]);
    expect(titleOf(second)).toContain(GUIDE[0].part);

    const back = fakeInteraction({ customId: buttonsOf(second)[0].custom_id });
    await handle(back);
    expect(titleOf(json(back.update.mock.calls[0][0]))).toContain("Guide");

    const part = fakeInteraction({ customId: "guide:part", values: ["p.messages"] });
    await handle(part);
    const messages = json(part.update.mock.calls[0][0]);
    expect(titleOf(messages)).toContain("Messages");
    const topicMenu = messages.components[1].components[0];
    expect(topicMenu.options.map((option) => option.value)).toEqual(GUIDE.find((entry) => entry.id === "messages").sections.map((topic) => `t.${topic.id}.0`));

    const topic = fakeInteraction({ customId: "guide:topic", values: ["t.feeds.0"] });
    await handle(topic);
    expect(titleOf(json(topic.update.mock.calls[0][0]))).toContain("Feeds");

    // A button from a guide that has since changed lands on the contents.
    const stale = fakeInteraction({ customId: "guide:go:t.gone.0:next" });
    await handle(stale);
    expect(titleOf(json(stale.update.mock.calls[0][0]))).toContain("Guide");
  });

  it("suggests parts and topics that match what's typed", async () => {
    const typed = fakeInteraction({ topic: "ban" });
    await command.autocomplete(typed);
    const [choices] = typed.respond.mock.calls[0];
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.length).toBeLessThanOrEqual(25);
    expect(choices.map((choice) => choice.value)).toContain("t.moderation.0");

    const empty = fakeInteraction();
    await command.autocomplete(empty);
    expect(empty.respond.mock.calls[0][0]).toHaveLength(25);
  });
});
