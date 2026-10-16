import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAutomod } from "../src/automod/config.js";
import { createSettingsCommand } from "../src/commands/settings.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const ROLE_ID = "700000000000000001";
const CHANNEL_ID = "800000000000000001";

// A fake /settings automod <subcommand> interaction from an admin.
function fakeInteraction(subcommand, options = {}, locale = "en-US") {
  return {
    commandName: "settings",
    locale,
    guildId: GUILD_ID,
    guild: { members: { me: {} } },
    inCachedGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommandGroup: () => "automod",
      getSubcommand: () => subcommand,
      getBoolean: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getRole: () => ({ id: options.role ?? ROLE_ID }),
      getChannel: () => ({ id: CHANNEL_ID }),
    },
    reply: vi.fn(async () => {}),
  };
}

const replyText = (interaction) => interaction.reply.mock.calls[0][0].content;

describe("/settings automod", () => {
  let guildSettings;
  let command;
  const config = () => normalizeAutomod(guildSettings.get(GUILD_ID, Setting.AUTOMOD));
  const run = async (...args) => {
    const interaction = fakeInteraction(...args);
    const outcome = await command.execute(interaction);
    return { interaction, outcome };
  };

  beforeEach(() => {
    guildSettings = new GuildSettings();
    command = createSettingsCommand({ guildSettings });
  });

  it("is a subcommand group of /settings", () => {
    const group = command.data.options.find((option) => option.name === "automod");
    expect(group.options.map((option) => option.name)).toEqual([
      "toggle",
      "rule",
      "limit",
      "word",
      "allow-site",
      "exempt-role",
      "exempt-channel",
      "escalate",
      "show",
    ]);
  });

  it("switches automod on and off, saying which rules are on", async () => {
    const empty = await run("toggle", { enabled: true });
    expect(config().enabled).toBe(true);
    expect(empty.outcome).toMatchObject({ status: Status.SUCCESS, key: "automodOnNoRules" });

    await run("rule", { rule: "spam", enabled: true });
    const on = await run("toggle", { enabled: true });
    expect(replyText(on.interaction)).toBe("Automod is now on. Rules switched on: Spam (messages too fast).");

    await run("toggle", { enabled: false });
    expect(config().enabled).toBe(false);
  });

  it("switches a rule on with an action, and reminds that automod is off", async () => {
    const { interaction, outcome } = await run("rule", { rule: "invites", enabled: true, action: "warn" });
    expect(config().rules.invites).toEqual({ enabled: true, action: "warn" });
    expect(replyText(interaction)).toBe(
      `Invite links is now on: Delete and warn.\n${translate("en", "automodStillOff")}`,
    );
    expect(outcome.status).toBe(Status.SUCCESS);
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);

    // Leaving out the action keeps the one chosen before.
    await run("rule", { rule: "invites", enabled: false });
    expect(config().rules.invites).toEqual({ enabled: false, action: "warn" });
  });

  it("changes limits within their range", async () => {
    await run("limit", { setting: "spamSeconds", value: 10 });
    expect(config().rules.spam.seconds).toBe(10);

    const tooBig = await run("limit", { setting: "mentions", value: 500 });
    expect(tooBig.outcome).toMatchObject({ status: Status.REFUSED, key: "automodLimitOutOfRange" });
    expect(config().rules.mentions.limit).toBe(5);
  });

  it("adds and removes banned words, shown as spoilers", async () => {
    const added = await run("word", { word: "  Bad   Word " });
    expect(config().rules.bannedWords.words).toEqual(["bad word"]);
    expect(replyText(added.interaction)).toContain("||bad word||");
    expect(replyText(added.interaction)).toContain(translate("en", "automodWordRuleOff"));

    const removed = await run("word", { word: "BAD WORD" });
    expect(removed.outcome).toMatchObject({ key: "automodWordRemoved" });
    expect(config().rules.bannedWords.words).toEqual([]);

    const star = await run("word", { word: "**" });
    expect(star.outcome).toMatchObject({ status: Status.REFUSED, key: "automodWordInvalid" });
  });

  it("allows and disallows websites", async () => {
    await run("allow-site", { site: "https://www.YouTube.com/watch?v=1" });
    expect(config().rules.links.allowedDomains).toEqual(["youtube.com"]);
    await run("allow-site", { site: "youtube.com" });
    expect(config().rules.links.allowedDomains).toEqual([]);
    const bad = await run("allow-site", { site: "not a website" });
    expect(bad.outcome).toMatchObject({ status: Status.REFUSED, key: "automodSiteInvalid" });
  });

  it("exempts roles and channels, but never @everyone", async () => {
    await run("exempt-role", {});
    await run("exempt-channel", {});
    expect(config().exemptRoleIds).toEqual([ROLE_ID]);
    expect(config().exemptChannelIds).toEqual([CHANNEL_ID]);

    const everyone = await run("exempt-role", { role: GUILD_ID });
    expect(everyone.outcome).toMatchObject({ status: Status.REFUSED, key: "automodExemptEveryone" });

    await run("exempt-role", {});
    expect(config().exemptRoleIds).toEqual([]);
  });

  it("sets up escalation, and says when no rule warns", async () => {
    const { interaction } = await run("escalate", { warnings: 3, action: "timeout" });
    expect(config().escalation).toEqual({ warnings: 3, action: "timeout", timeoutMinutes: 60 });
    expect(replyText(interaction)).toBe(
      `After 3 warnings within 24 hours, members now get: Time out for 60 minutes.\n${translate("en", "automodEscalateNoWarnRule")}`,
    );
    const off = await run("escalate", { warnings: 0 });
    expect(off.outcome).toMatchObject({ key: "automodEscalateOff" });
  });

  it("shows the settings, in the admin's language", async () => {
    await run("rule", { rule: "caps", enabled: true });
    await run("word", { word: "noob" });
    const { interaction } = await run("show", {}, "de");
    const text = replyText(interaction);
    expect(text).toContain(translate("de", "automodShowRule", {
      rule: translate("de", "automodRule_caps"),
      action: translate("de", "automodAction_delete"),
    }));
    expect(text).toContain("||noob||");
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("keeps a long word list under Discord's limit", async () => {
    await guildSettings.set(GUILD_ID, Setting.AUTOMOD, {
      rules: { bannedWords: { words: Array.from({ length: 200 }, (_, index) => `${"w".repeat(50)}${index}`) } },
    });
    const { interaction } = await run("show", {});
    expect(replyText(interaction).length).toBeLessThanOrEqual(2000);
    expect(replyText(interaction)).toMatch(/\(\+\d+\)/);
  });
});
