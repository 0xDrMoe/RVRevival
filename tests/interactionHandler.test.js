import { Collection, MessageFlags, PermissionFlagsBits, PermissionsBitField, RESTJSONErrorCodes, SlashCommandBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../src/i18n/i18n.js";
import { createInteractionHandler } from "../src/interactionHandler.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { discordError, fakeLogger } from "./helpers/fakes.js";

function fakeCommandInteraction(commandName, { deferred = false, locale = "en-US" } = {}) {
  return {
    commandName,
    locale,
    guildId: "900000000000000001",
    user: { id: "300000000000000001" },
    deferred,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  };
}

function handlerFor(command, options = {}) {
  const commands = new Map([["country", { name: "country", data: {}, execute: vi.fn(), ...command }]]);
  return createInteractionHandler({ commands, logger: fakeLogger(), ...options });
}

const failing = (error) => vi.fn(async () => Promise.reject(error));
const errorMessage = translate("en", "unexpected");

describe("interaction handler", () => {
  it("runs the matching command", async () => {
    const execute = vi.fn(async () => {});
    const interaction = fakeCommandInteraction("country");
    await handlerFor({ execute })(interaction);
    expect(execute).toHaveBeenCalledWith(interaction);
  });

  it("replies with a generic private error when a command crashes before acknowledging", async () => {
    const interaction = fakeCommandInteraction("country");
    await handlerFor({ execute: failing(new Error("C:\\secret\\path failed")) })(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: errorMessage, flags: MessageFlags.Ephemeral });
  });

  it("edits the reply when a command crashes after acknowledging", async () => {
    const interaction = fakeCommandInteraction("country", { deferred: true });
    await handlerFor({ execute: failing(new Error("boom")) })(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: errorMessage });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("translates the error message", async () => {
    const interaction = fakeCommandInteraction("country", { locale: "fr" });
    await handlerFor({ execute: failing(new Error("boom")) })(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: translate("fr", "unexpected"), flags: MessageFlags.Ephemeral });
  });

  it("doesn't try to answer an expired interaction", async () => {
    const interaction = fakeCommandInteraction("country");
    await handlerFor({ execute: failing(discordError(RESTJSONErrorCodes.UnknownInteraction)) })(interaction);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("never throws, even if the error reply fails", async () => {
    const interaction = fakeCommandInteraction("country");
    interaction.reply.mockRejectedValueOnce(new Error("network down"));
    await expect(handlerFor({ execute: failing(new Error("boom")) })(interaction)).resolves.toBeUndefined();
  });

  it("answers commands the bot doesn't know", async () => {
    const interaction = fakeCommandInteraction("old-command");
    await handlerFor({})(interaction);
    expect(interaction.reply).toHaveBeenCalled();
  });

  it("answers with no suggestions if autocomplete crashes", async () => {
    const respond = vi.fn(async () => {});
    await handlerFor({ autocomplete: failing(new Error("boom")) })({
      commandName: "country",
      responded: false,
      isAutocomplete: () => true,
      respond,
    });
    expect(respond).toHaveBeenCalledWith([]);
  });

  describe("command rules", () => {
    const HELPER_ROLE = "700000000000000002";
    const banData = new SlashCommandBuilder().setName("ban").setDescription("ban").setDefaultMemberPermissions(PermissionFlagsBits.BanMembers);

    async function setup(rule) {
      const guildSettings = new GuildSettings();
      await guildSettings.set("900000000000000001", Setting.COMMAND_RULES, { ban: rule });
      const execute = vi.fn(async (interaction) => interaction.memberPermissions.has(PermissionFlagsBits.BanMembers));
      const commands = new Map([["ban", { name: "ban", data: banData, execute }]]);
      const actionLog = { logCommand: vi.fn(async () => {}) };
      const handler = createInteractionHandler({ commands, logger: fakeLogger(), actionLog, guildSettings });
      const interaction = {
        ...fakeCommandInteraction("ban"),
        member: { roles: { cache: new Collection([[HELPER_ROLE, { id: HELPER_ROLE }]]) } },
        memberPermissions: new PermissionsBitField(0n).freeze(),
      };
      return { handler, execute, actionLog, interaction };
    }

    it("refuses a turned-off command without running it, and logs the refusal", async () => {
      const { handler, execute, actionLog, interaction } = await setup({ disabled: true });
      await handler(interaction);
      expect(execute).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: translate("en", "commandRuleDisabled", { command: "ban" }), flags: MessageFlags.Ephemeral }));
      expect(actionLog.logCommand).toHaveBeenCalledWith(interaction, expect.objectContaining({ status: Status.REFUSED, key: "commandRuleDisabled" }));
    });

    it("runs the command with the permission a role was given", async () => {
      const { handler, execute, interaction } = await setup({ roleIds: [HELPER_ROLE] });
      await handler(interaction);
      await expect(execute.mock.results[0].value).resolves.toBe(true);
    });
  });

  describe("logs channel", () => {
    const fakeActionLog = () => ({ logCommand: vi.fn(async () => {}), logDeletedMessage: vi.fn(async () => {}) });

    it("logs what the command reported", async () => {
      const actionLog = fakeActionLog();
      const outcome = { status: Status.REFUSED, key: "guildOnly" };
      const interaction = fakeCommandInteraction("country");
      await handlerFor({ execute: vi.fn(async () => outcome) }, { actionLog })(interaction);
      expect(actionLog.logCommand).toHaveBeenCalledWith(interaction, outcome);
    });

    it("logs a success when the command reports nothing", async () => {
      const actionLog = fakeActionLog();
      await handlerFor({ execute: vi.fn(async () => {}) }, { actionLog })(fakeCommandInteraction("country"));
      expect(actionLog.logCommand).toHaveBeenCalledWith(expect.anything(), { status: Status.SUCCESS });
    });

    it("logs crashes, expired interactions and unknown commands", async () => {
      const actionLog = fakeActionLog();
      await handlerFor({ execute: failing(new Error("boom")) }, { actionLog })(fakeCommandInteraction("country"));
      await handlerFor({ execute: failing(discordError(RESTJSONErrorCodes.UnknownInteraction)) }, { actionLog })(
        fakeCommandInteraction("country"),
      );
      await handlerFor({}, { actionLog })(fakeCommandInteraction("old-command"));

      const statuses = actionLog.logCommand.mock.calls.map(([, outcome]) => outcome.status);
      expect(statuses).toEqual([Status.ERROR, Status.FAILED, Status.ERROR]);
    });
  });

  describe("buttons, forms and menus", () => {
    const fakeActionLog = () => ({ logCommand: vi.fn(async () => {}) });

    function fakeButtonInteraction(customId) {
      return {
        customId,
        locale: "en-US",
        guildId: "900000000000000001",
        user: { id: "300000000000000001" },
        deferred: false,
        replied: false,
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        isButton: () => true,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        reply: vi.fn(async () => {}),
        editReply: vi.fn(async () => {}),
      };
    }

    const withButton = (handle, options) =>
      handlerFor({ components: { "test:open": { label: "Test button", handle } } }, options);

    it("runs the handler registered for the custom ID and logs its outcome", async () => {
      const actionLog = fakeActionLog();
      const outcome = { status: Status.SUCCESS, key: "assigned", values: { country: "Canada" } };
      const handle = vi.fn(async () => outcome);
      const interaction = fakeButtonInteraction("test:open");

      await withButton(handle, { actionLog })(interaction);

      expect(handle).toHaveBeenCalledWith(interaction);
      expect(actionLog.logCommand).toHaveBeenCalledWith(interaction, { action: { label: "Test button" }, ...outcome });
    });

    it("logs nothing for steps that return nothing", async () => {
      const actionLog = fakeActionLog();
      await withButton(vi.fn(async () => null), { actionLog })(fakeButtonInteraction("test:open"));
      expect(actionLog.logCommand).not.toHaveBeenCalled();
    });

    it("answers privately and logs when a handler crashes", async () => {
      const actionLog = fakeActionLog();
      const interaction = fakeButtonInteraction("test:open");
      await withButton(failing(new Error("boom")), { actionLog })(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({ content: errorMessage, flags: MessageFlags.Ephemeral });
      expect(actionLog.logCommand).toHaveBeenCalledWith(
        interaction,
        expect.objectContaining({ status: Status.ERROR, action: { label: "Test button" } }),
      );
    });

    it("routes buttons whose custom ID starts with a registered prefix", async () => {
      const handle = vi.fn(async () => null);
      const exact = vi.fn(async () => null);
      const handler = handlerFor({
        components: { "rp:help": { label: "Exact", handle: exact } },
        componentPrefixes: { "rp:": { label: "Role panel button", handle } },
      });
      const interaction = fakeButtonInteraction("rp:3:700000000000000001");
      await handler(interaction);
      expect(handle).toHaveBeenCalledWith(interaction);

      await handler(fakeButtonInteraction("rp:help"));
      expect(exact).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledTimes(1);
    });

    it("answers buttons the bot doesn't know", async () => {
      const interaction = fakeButtonInteraction("gone:button");
      await withButton(vi.fn())(interaction);
      expect(interaction.reply).toHaveBeenCalledWith({ content: errorMessage, flags: MessageFlags.Ephemeral });
    });
  });
});
