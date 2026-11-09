import { ChannelType } from "discord.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkResponders, fillReply } from "../src/community/autoResponders.js";
import { renderTemplate } from "../src/community/welcome.js";
import { variableRefusal } from "../src/commands/commandHelpers.js";
import { RESPONDER_TEMPLATES } from "../src/dashboard/public/customCommandTemplates.js";
import {
  contextsUsing,
  fillVariables,
  findVariableProblems,
  usedVariables,
  variableError,
  VARIABLE_CONTEXT_NAMES,
  VARIABLE_CONTEXTS,
  VARIABLES,
  variablesFor,
} from "../src/dashboard/public/variables.js";
import { checkSettingChanges, InvalidSetting } from "../src/dashboard/settingsRules.js";
import { checkLeveling, DEFAULT_LEVELING } from "../src/leveling/config.js";
import { fillLevelMessage } from "../src/leveling/leveling.js";
import { checkTemplate, counterName, InvalidCounter, normalizeCounters } from "../src/stats/statsCounters.js";
import { checkCategories, InvalidCategories } from "../src/tickets/categories.js";
import { checkLook, formatThreadName } from "../src/tickets/panel.js";
import { channelName, DEFAULT_NAME_TEMPLATE } from "../src/voice/tempVoice.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const LANGUAGES = ["en", "es", "de", "fr", "pt", "it", "ar"];

describe("the variable list", () => {
  it("gives every place only variables that exist, each once", () => {
    for (const name of VARIABLE_CONTEXT_NAMES) {
      const { variables, aliases = {}, notes = {} } = VARIABLE_CONTEXTS[name];
      expect(new Set(variables).size, name).toBe(variables.length);
      for (const variable of [...variables, ...Object.values(aliases), ...Object.keys(notes)]) {
        expect(VARIABLES, `${name}: ${variable}`).toHaveProperty(variable);
        expect(variables, `${name}: ${variable}`).toContain(variable);
      }
      for (const alias of Object.keys(aliases)) {
        expect(VARIABLES, `${name}: alias ${alias} hides a variable`).not.toHaveProperty(alias);
      }
    }
  });

  it("uses every variable somewhere", () => {
    for (const name of Object.keys(VARIABLES)) {
      expect(contextsUsing(name).length, name).toBeGreaterThan(0);
      expect(name).toMatch(/^[a-z]+$/);
    }
  });

  it("describes a variable the way its place uses it", () => {
    expect(variablesFor("birthday").find((variable) => variable.name === "user").about).toMatch(/everyone with a birthday/);
    expect(variablesFor("welcome").find((variable) => variable.name === "user").about).toBe(VARIABLES.user.about);
    expect(variablesFor("feed").map((variable) => variable.token)).toEqual(["{title}", "{link}", "{author}", "{feed}", "{game}"]);
  });

  it("has dashboard words for every variable, note and place, in every language", () => {
    for (const language of LANGUAGES) {
      const strings = readJson(`../src/dashboard/public/locales/${language}.json`);
      for (const name of Object.keys(VARIABLES)) {
        expect(strings, `${language}: ${name}`).toHaveProperty(`variable_${name}`);
      }
      for (const context of VARIABLE_CONTEXT_NAMES) {
        expect(strings, `${language}: ${context}`).toHaveProperty(`variableWhere_${context}`);
        for (const note of Object.keys(VARIABLE_CONTEXTS[context].notes ?? {})) {
          expect(strings, `${language}: ${context} ${note}`).toHaveProperty(`variable_${context}_${note}`);
        }
      }
    }
  });
});

describe("fillVariables", () => {
  it("fills the place's variables and leaves everything else as typed", () => {
    const values = { user: "<@1>", username: "Moe", server: "Lounge", members: "12" };
    expect(fillVariables("Hi {user} ({username}) to {server}, #{members}", "welcome", values)).toBe("Hi <@1> (Moe) to Lounge, #12");
    expect(fillVariables("{level} {usr} {1,2} {User}", "welcome", values)).toBe("{level} {usr} {1,2} {User}");
  });

  it("follows old spellings", () => {
    expect(fillVariables("#{count}", "welcome", { members: "7" })).toBe("#7");
    expect(fillVariables("🔊 {name}", "voice", { username: "Moe" })).toBe("🔊 Moe");
  });

  it("leaves a variable without a value as typed, and never re-reads filled text", () => {
    expect(fillVariables("{game}", "feed", {})).toBe("{game}");
    expect(fillVariables("{username}", "welcome", { username: "{server}", server: "nope" })).toBe("{server}");
  });

  it("lists the variables a text uses, after old spellings", () => {
    expect(usedVariables("{count} {members} {user} {nope}", "welcome").sort()).toEqual(["members", "user"]);
  });
});

describe("findVariableProblems and variableError", () => {
  it("finds nothing wrong with good text, old spellings or other brackets", () => {
    expect(findVariableProblems("Hi {user}, #{count}. {1,2} {\"a\": 1}", "welcome")).toEqual([]);
    expect(variableError("Hi {user}", "welcome")).toBeNull();
    expect(variableError("", "welcome")).toBeNull();
  });

  it("explains unknown variables, wrong capitals and variables from elsewhere", () => {
    expect(findVariableProblems("{usr} {usr} {User} { user } {level}", "welcome")).toEqual([
      { token: "{usr}", kind: "unknown" },
      { token: "{User}", kind: "case", suggestion: "{user}" },
      { token: "{ user }", kind: "case", suggestion: "{user}" },
      { token: "{level}", kind: "elsewhere", name: "level", where: ["level-up messages"] },
    ]);
    expect(variableError("{usr}", "welcome")).toBe(
      "{usr} isn't a variable. Welcome and leave messages and the welcome DM can use {user}, {username}, {server} and {members}.",
    );
    expect(variableError("{User}", "levelUp")).toMatch(/^\{User\} isn't a variable: did you mean \{user\}\?/);
    expect(variableError("{level}", "feed")).toMatch(/^\{level\} only works in level-up messages\. Feed messages can use/);
  });

  it("gives slash commands the bad variables and the good ones", () => {
    expect(variableRefusal("Hi {user}", "levelUp")).toBeNull();
    expect(variableRefusal("{usr} {Level}", "levelUp")).toEqual({ bad: "{usr}, {Level} (→ {level})", allowed: "{user} {username} {level} {server}" });
  });
});

describe("every feature uses the shared variables", () => {
  const guild = { id: "1", name: "Lounge*", memberCount: 1234 };
  const member = { id: "2", displayName: "Moe_", user: { username: "moe" } };

  it("welcome: {members}, the old {count}, and escaped names", () => {
    expect(renderTemplate("{user} {username} {server} #{members} #{count}", { member, guild })).toBe("<@2> Moe\\_ Lounge\\* #1,234 #1,234");
  });

  it("level-up messages escape names too", () => {
    expect(fillLevelMessage("{user} {username} {level} {server}", { member, level: 3, guild })).toBe("<@2> Moe\\_ 3 Lounge\\*");
  });

  it("auto-responders fill {username} as well", () => {
    const message = { author: { id: "2", username: "moe" }, member, guild, channelId: "3" };
    expect(fillReply("{user} {username} {server} {channel}", message)).toBe("<@2> Moe\\_ Lounge\\* <#3>");
  });

  it("voice channel names: {username} is the display name, {name} still works", () => {
    expect(DEFAULT_NAME_TEMPLATE).toBe("🔊 {username}");
    expect(channelName("{name} / {username}", member)).toBe("Moe_ / Moe_");
  });

  it("tickets fill the same way", () => {
    expect(formatThreadName("{category}-{number} {nope}", { category: "bug", number: "7" })).toBe("bug-7 {nope}");
  });

  it("counters fill and refuse the same way, but keep old saved names", () => {
    expect(counterName("{members} / {tier}", { members: 1200, tier: 2 })).toBe("1,200 / 2");
    expect(() => checkTemplate("Members: {member}")).toThrow(InvalidCounter);
    expect(() => checkTemplate("Members: {member}")).toThrow(/\{member\} isn't a variable/);
    expect(normalizeCounters([{ id: "abcdef12", template: "{members} {old}", channelId: null }])).toHaveLength(1);
  });
});

describe("saving refuses unknown variables", () => {
  const TEXT_ID = "800000000000000001";
  const server = { guildId: "900000000000000001", roles: [], channels: [{ id: TEXT_ID, type: ChannelType.GuildText }] };

  it("on the welcome, leave, DM and birthday messages", () => {
    expect(checkSettingChanges({ welcomeMessage: "Hi {user}, #{count}" }, server)).toEqual({ welcomeMessage: "Hi {user}, #{count}" });
    for (const setting of ["welcomeMessage", "leaveMessage", "welcomeDm"]) {
      expect(() => checkSettingChanges({ [setting]: "Hi {usr}" }, server)).toThrow(InvalidSetting);
    }
    expect(() => checkSettingChanges({ birthdays: { channelId: TEXT_ID, roleId: null, timezone: "UTC", message: "{username}!" } }, server)).toThrow(
      /\{username\} only works in/,
    );
  });

  it("on level-up messages", () => {
    const ok = { isRole: () => true, isRewardRole: () => true, isChannel: () => true };
    expect(() => checkLeveling({ ...DEFAULT_LEVELING, message: "{user} hit {lvl}" }, ok)).toThrow(/\{lvl\} isn't a variable/);
    expect(() => checkLeveling({ ...DEFAULT_LEVELING, message: "{user} hit {level}" }, ok)).not.toThrow();
  });

  it("on auto-responder replies", () => {
    expect(() => checkResponders([{ trigger: "hi", match: "contains", reply: "Hi {member}" }], () => true)).toThrow(/"hi": \{member\} isn't a variable/);
  });

  it("on ticket intros and thread names, for the panel and for each type", () => {
    expect(() => checkLook({ intro: "Hi {user}, staff: {staf}" })).toThrow(/intro message: \{staf\} isn't a variable/);
    expect(() => checkLook({ nameFormat: "{category}-{number}" })).not.toThrow();
    expect(() => checkCategories([{ id: "bug", label: "Bug", nameFormat: "{ticket}" }], { isRole: () => true })).toThrow(InvalidCategories);
  });
});

describe("the bot's own default messages", () => {
  it.each(LANGUAGES)("only use their place's variables (%s)", (language) => {
    const strings = readJson(`../src/i18n/locales/${language}.json`);
    const check = (key, context) => expect(findVariableProblems(strings[key], context), `${language}.${key}`).toEqual([]);
    check("welcomeDefaultWelcome", "welcome");
    check("welcomeDefaultLeave", "welcome");
    check("levelUpDefault", "levelUp");
    check("birthdayDefaultMessage", "birthday");
    for (const key of Object.keys(strings).filter((name) => name.startsWith("feedDefault"))) {
      check(key, "feed");
    }
  });

  it.each(LANGUAGES)("and the dashboard's auto-responder templates do too (%s)", (language) => {
    const strings = readJson(`../src/dashboard/public/locales/${language}.json`);
    for (const { id } of RESPONDER_TEMPLATES) {
      expect(findVariableProblems(strings[`respTpl_${id}_reply`], "responder"), `${language} ${id}`).toEqual([]);
    }
  });
});
