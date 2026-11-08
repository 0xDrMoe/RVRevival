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
    ...(topic.usages ?? []).flatMap((usage) => [usage.usage, usage.what, ...usage.options.flat()]),
    ...[topic.table, topic.legend].flatMap((table) => (table ? [...table.head, ...table.rows.flat()] : [])),
    ...(topic.example ?? []),
    ...(topic.tips ?? []),
  ].filter(Boolean);

// Every way to run each slash command: { command: "/ban", path: "/ban" or
// "/case view" or "/settings automod rule", options: [{ name, required }] }.
function commandUsages() {
  const commands = createCommands({ logger: fakeLogger(), guildSettings: new GuildSettings() });
  const optionsOf = (list) => (list ?? []).map((option) => ({ name: option.name, required: option.required === true }));
  return [...commands.values()].flatMap((command) => {
    const data = typeof command.data.toJSON === "function" ? command.data.toJSON() : command.data;
    const base = `/${data.name}`;
    const subs = (data.options ?? []).flatMap((option) => {
      if (option.type === 1) {
        return [{ command: base, path: `${base} ${option.name}`, options: optionsOf(option.options) }];
      }
      if (option.type === 2) {
        return option.options.map((sub) => ({ command: base, path: `${base} ${option.name} ${sub.name}`, options: optionsOf(sub.options) }));
      }
      return [];
    });
    return subs.length > 0 ? subs : [{ command: base, path: base, options: optionsOf(data.options) }];
  });
}

// "/name" and "/name sub" (and "/name group sub") for every slash command.
const commandNames = () => commandUsages().map((usage) => usage.path);

// A usage line's options after its command path: "[reason]" is optional.
function usageOptions(usage, path) {
  return usage
    .slice(path.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.startsWith("[") && word.endsWith("]") ? { name: word.slice(1, -1), required: false } : { name: word, required: true }));
}

// The real usage a usage line is for: the longest command path it starts with.
function realUsageFor(line, usages) {
  return usages.filter((usage) => line === usage.path || line.startsWith(`${usage.path} `)).sort((a, b) => b.path.length - a.path.length)[0];
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

  it("has parts with unique ids, known icons and something to say", () => {
    const ids = GUIDE.map((part) => part.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const part of GUIDE) {
      expect(part.id, part.part).toMatch(/^[a-z]+$/);
      expect(icons.has(part.icon), `${part.id} icon ${part.icon}`).toBe(true);
      expect(part.about.length, part.id).toBeGreaterThan(0);
      expect(part.sections.length, part.id).toBeGreaterThan(0);
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
    const usages = topics.flatMap((topic) => [...(topic.commands ?? []).map(([usage]) => usage), ...(topic.usages ?? []).map(({ usage }) => usage)]).map((usage) => `${usage} `);
    const missing = commandNames().filter((name) => !usages.some((usage) => usage.startsWith(`${name} `)));
    expect(missing).toEqual([]);
  });

  it("shows every command's real options, in order, wherever it lists a usage", () => {
    const real = commandUsages();
    const lines = topics.flatMap((topic) => [...(topic.commands ?? []).map(([usage]) => usage), ...(topic.usages ?? []).map(({ usage }) => usage)]);
    for (const line of lines) {
      const usage = realUsageFor(line, real);
      expect(usage, `${line}: no such command`).toBeDefined();
      expect(usageOptions(line, usage.path), line).toEqual(usage.options);
    }
  });

  it("has a command page for every command, with every subcommand and option explained", () => {
    const real = commandUsages();
    const pages = topics.filter((topic) => topic.command);
    const commands = [...new Set(real.map((usage) => usage.command))];
    expect(pages.map((page) => page.command).sort()).toEqual(commands.sort());
    const topicIds = new Set(topics.map((topic) => topic.id));
    for (const page of pages) {
      expect(page.title, page.id).toBe(page.command);
      expect(topicIds.has(page.related), `${page.id} related ${page.related}`).toBe(true);
      const paths = real.filter((usage) => usage.command === page.command).map((usage) => usage.path);
      const covered = page.usages.map(({ usage }) => realUsageFor(usage, real)?.path);
      // Every subcommand once, in whatever order reads best.
      expect([...covered].sort(), page.id).toEqual([...paths].sort());
      for (const { usage, what, options } of page.usages) {
        expect(what.length, usage).toBeGreaterThan(0);
        const path = realUsageFor(usage, real).path;
        expect(options.map(([name]) => name), usage).toEqual(usageOptions(usage, path).map((option) => option.name));
        for (const [name, text] of options) {
          expect(text.length, `${usage} ${name}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps every part small enough for Discord's topic menu", () => {
    expect(GUIDE.length).toBeLessThanOrEqual(24);
    for (const part of GUIDE) {
      expect(part.sections.length, part.id).toBeLessThanOrEqual(25);
    }
  });

  it("shows only real icons and commands on the landing page", () => {
    const block = page.slice(page.indexOf("const LANDING_FEATURES = ["), page.indexOf("const LANDING_STEPS"));
    const features = [...block.matchAll(/^ {2}\["(\w+)", "\w+", "(\w+)", \[([^\]]*)\]\],$/gm)];
    expect(features.length).toBeGreaterThan(8);
    const names = commandNames();
    for (const [, iconName, key, list] of features) {
      expect(icons.has(iconName), `${key} icon ${iconName}`).toBe(true);
      for (const [, command] of list.matchAll(/"([^"]+)"/g)) {
        expect(
          names.some((name) => name === command || name.startsWith(`${command} `)),
          `${key} command ${command}`,
        ).toBe(true);
      }
    }
  });
});
