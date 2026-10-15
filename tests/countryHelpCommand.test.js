import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryHelpCommand } from "../src/commands/countryHelp.js";
import { translate } from "../src/i18n/i18n.js";

const GUILD_ID = "900000000000000001";

// A fake /country-help interaction from someone with Manage Server.
function fakeInteraction(overrides = {}) {
  return {
    commandName: "country-help",
    locale: "en-US",
    guildLocale: "en-US",
    guildId: GUILD_ID,
    inCachedGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

const sentReply = (interaction) => interaction.reply.mock.calls[0][0];
const sentEmbed = (interaction) => sentReply(interaction).embeds[0].toJSON();

describe("/country-help definition", () => {
  const { data } = createCountryHelpCommand();

  it("is hidden from members without Manage Server", () => {
    expect(data.name).toBe("country-help");
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });
});

describe("/country-help", () => {
  let command;

  beforeEach(() => {
    command = createCountryHelpCommand();
  });

  it("posts a public message explaining /country to members", async () => {
    const interaction = fakeInteraction();
    await command.execute(interaction);

    expect(sentReply(interaction).flags).toBeUndefined();
    const embed = sentEmbed(interaction);
    expect(embed.title).toBe(translate("en", "helpTitle"));
    expect(embed.description).toBe(translate("en", "helpIntro"));
    expect(embed.fields).toEqual([
      { name: translate("en", "helpStepsTitle"), value: translate("en", "helpSteps") },
      { name: translate("en", "helpNotesTitle"), value: translate("en", "helpNotes") },
    ]);
  });

  it("never mentions a channel", async () => {
    const interaction = fakeInteraction();
    await command.execute(interaction);
    expect(JSON.stringify(sentEmbed(interaction))).not.toMatch(/<#\d+>/);
  });

  it("refuses members without Manage Server", async () => {
    const interaction = fakeInteraction({ memberPermissions: { has: () => false } });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "helpNoPermission"),
      flags: MessageFlags.Ephemeral,
    });
  });

  it("refuses outside a server", async () => {
    const interaction = fakeInteraction({ inCachedGuild: () => false });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: translate("en", "guildOnly"), flags: MessageFlags.Ephemeral });
  });

  it("posts in the server's language, not the admin's", async () => {
    const interaction = fakeInteraction({ locale: "de", guildLocale: "fr" });
    await command.execute(interaction);
    expect(sentEmbed(interaction).title).toBe(translate("fr", "helpTitle"));
  });

  it("uses BOT_LANGUAGE when it is set", async () => {
    const forced = createCountryHelpCommand({ forcedLanguage: "ar" });
    const interaction = fakeInteraction({ guildLocale: "fr" });
    await forced.execute(interaction);
    expect(sentEmbed(interaction).title).toBe(translate("ar", "helpTitle"));
  });
});
