import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCommands } from "../src/commands/index.js";
import { GUIDE } from "../src/dashboard/public/guide.js";
import { GuildSettings } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const page = readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8");
const icons = new Set([...page.slice(page.indexOf("const ICONS = {")).split("\n};")[0].matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]));
const pages = new Set([...page.slice(page.indexOf("const NAV = ["), page.indexOf("const PAGES =")).matchAll(/\{ id: "(\w+)"/g)].map((match) => match[1]));
const topics = GUIDE.flatMap((part) => part.sections);

// Every piece of text a topic shows.
const texts = (topic) =>
  [
    topic.title,
    topic.summary,
    topic.who,
    topic.native,
    ...(topic.steps ?? []),
    ...(topic.commands ?? []).flat(),
    ...[topic.table, topic.legend].flatMap((table) => (table ? [...table.head, ...table.rows.flat()] : [])),
    ...(topic.example ?? []),
    ...(topic.tips ?? []),
  ].filter(Boolean);

// "/name" and "/name sub" (and "/name group sub") for every slash command.
function commandNames() {
  const commands = createCommands({ logger: fakeLogger(), guildSettings: new GuildSettings() });
  return [...commands.values()].flatMap((command) => {
    const data = typeof command.data.toJSON === "function" ? command.data.toJSON() : command.data;
    const subs = (data.options ?? []).flatMap((option) => {
      if (option.type === 1) {
        return [`/${data.name} ${option.name}`];
      }
      if (option.type === 2) {
        return option.options.map((sub) => `/${data.name} ${option.name} ${sub.name}`);
      }
      return [];
    });
    return subs.length > 0 ? subs : [`/${data.name}`];
  });
}

describe("dashboard guide", () => {
  it("has topics with unique ids, known icons and real pages", () => {
    const ids = topics.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages.has("guide")).toBe(true);
    for (const topic of topics) {
      expect(topic.id, topic.id).toMatch(/^[a-z]+$/);
      expect(topic.title.length, topic.id).toBeGreaterThan(0);
      expect(topic.summary.length, topic.id).toBeGreaterThan(0);
      expect(icons.has(topic.icon), `${topic.id} icon ${topic.icon}`).toBe(true);
      if (topic.page) {
        expect(pages.has(topic.page), `${topic.id} page ${topic.page}`).toBe(true);
      }
    }
  });

  it("closes every `code` and **bold** mark", () => {
    for (const topic of topics) {
      for (const text of texts(topic)) {
        expect((text.match(/`/g) ?? []).length % 2, `${topic.id}: ${text}`).toBe(0);
        expect((text.match(/\*\*/g) ?? []).length % 2, `${topic.id}: ${text}`).toBe(0);
      }
    }
  });

  it("explains every command and subcommand", () => {
    const usages = topics.flatMap((topic) => (topic.commands ?? []).map(([usage]) => `${usage} `));
    const missing = commandNames().filter((name) => !usages.some((usage) => usage.startsWith(`${name} `)));
    expect(missing).toEqual([]);
  });
});
