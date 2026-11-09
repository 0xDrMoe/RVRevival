import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanTrigger, MAX_REPLY_LENGTH, MAX_TRIGGER_LENGTH, Match } from "../src/community/autoResponders.js";
import { cleanTagName, MAX_TAG_LENGTH } from "../src/community/tags.js";
import {
  RESPONDER_TEMPLATES,
  responderFromTemplate,
  TAG_TEMPLATES,
  tagFromTemplate,
} from "../src/dashboard/public/customCommandTemplates.js";

const folder = new URL("../src/dashboard/public/locales/", import.meta.url);
const languages = readdirSync(folder).map((file) => file.replace(".json", ""));
const translator = (language) => {
  const strings = JSON.parse(readFileSync(new URL(`${language}.json`, folder), "utf8"));
  return (key) => {
    expect(strings, `${language}.${key}`).toHaveProperty(key);
    return strings[key];
  };
};

describe("custom command templates", () => {
  it("have unique ids", () => {
    expect(new Set(TAG_TEMPLATES.map((template) => template.id)).size).toBe(TAG_TEMPLATES.length);
    expect(new Set(RESPONDER_TEMPLATES.map((template) => template.id)).size).toBe(RESPONDER_TEMPLATES.length);
  });

  it.each(languages)("%s tag templates save as they are", (language) => {
    const t = translator(language);
    const tags = TAG_TEMPLATES.map((template) => {
      expect(t(`tagTpl_${template.id}_title`).trim()).not.toBe("");
      return tagFromTemplate(template, t);
    });
    for (const tag of tags) {
      expect(cleanTagName(tag.name), `${language} ${tag.name}`).toBe(tag.name);
      expect(tag.content.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
      expect(tag.content.trim()).toBe(tag.content);
    }
    expect(new Set(tags.map((tag) => tag.name)).size).toBe(tags.length);
  });

  it.each(languages)("%s auto-responder templates save as they are", (language) => {
    const t = translator(language);
    const responders = RESPONDER_TEMPLATES.map((template) => {
      expect(t(`respTpl_${template.id}_title`).trim()).not.toBe("");
      return responderFromTemplate(template, t);
    });
    for (const responder of responders) {
      expect(cleanTrigger(responder.trigger), `${language} ${responder.trigger}`).toBe(responder.trigger);
      expect(responder.trigger.length).toBeLessThanOrEqual(MAX_TRIGGER_LENGTH);
      expect(Object.values(Match)).toContain(responder.match);
      expect(responder.reply.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
      expect(responder.channelId).toBeNull();
      // Only the placeholders the bot fills in.
      for (const [, name] of responder.reply.matchAll(/\{(\w+)\}/g)) {
        expect(["user", "server", "channel"]).toContain(name);
      }
    }
    expect(new Set(responders.map((responder) => responder.trigger)).size).toBe(responders.length);
  });
});
