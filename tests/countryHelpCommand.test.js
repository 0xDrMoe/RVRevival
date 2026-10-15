import { MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryHelpCommand } from "../src/commands/countryHelp.js";
import { translate } from "../src/i18n/i18n.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { discordError } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const POST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
];

// Permissions object shaped like discord.js's PermissionsBitField#has.
const permissions = (granted) => ({ has: (wanted) => [wanted].flat().every((bit) => granted.includes(bit)) });

// A fake /country-help interaction from someone with Manage Server, in a text channel.
function fakeInteraction({ botPermissions = POST_PERMISSIONS, isThread = false, ...overrides } = {}) {
  return {
    commandName: "country-help",
    locale: "en-US",
    guildLocale: "en-US",
    guildId: GUILD_ID,
    inCachedGuild: () => true,
    memberPermissions: permissions([PermissionFlagsBits.ManageGuild]),
    appPermissions: permissions(botPermissions),
    channel: { id: CHANNEL_ID, isThread: () => isThread, send: vi.fn(async () => {}) },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
}

const postedEmbed = (interaction) => interaction.channel.send.mock.calls[0][0].embeds[0].toJSON();

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

  it("posts the guide as its own channel message and confirms privately", async () => {
    const interaction = fakeInteraction();
    await command.execute(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("en", "helpPosted") });

    const embed = postedEmbed(interaction);
    expect(embed.title).toBe(translate("en", "helpTitle"));
    expect(embed.description).toBe(translate("en", "helpIntro"));
    expect(embed.fields).toEqual([
      { name: translate("en", "helpStepsTitle"), value: translate("en", "helpSteps") },
      { name: translate("en", "helpNotesTitle"), value: translate("en", "helpNotes") },
    ]);
  });

  it("says other messages are deleted when posted in the /country channel", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    const interaction = fakeInteraction();
    await createCountryHelpCommand({ guildSettings }).execute(interaction);

    expect(postedEmbed(interaction).fields[1].value).toBe(
      `${translate("en", "helpNotes")}\n${translate("en", "helpChannelNote")}`,
    );
  });

  it("leaves the deletion note out in other channels", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, "800000000000000002");
    const elsewhere = fakeInteraction();
    await createCountryHelpCommand({ guildSettings }).execute(elsewhere);
    expect(postedEmbed(elsewhere).fields[1].value).toBe(translate("en", "helpNotes"));

    const notSet = fakeInteraction();
    await createCountryHelpCommand({ guildSettings: new GuildSettings() }).execute(notSet);
    expect(postedEmbed(notSet).fields[1].value).toBe(translate("en", "helpNotes"));
  });

  it("never mentions a channel", async () => {
    const interaction = fakeInteraction();
    await command.execute(interaction);
    expect(JSON.stringify(postedEmbed(interaction))).not.toMatch(/<#\d+>/);
  });

  it.each([
    ["Send Messages", PermissionFlagsBits.SendMessages],
    ["Embed Links", PermissionFlagsBits.EmbedLinks],
    ["View Channel", PermissionFlagsBits.ViewChannel],
  ])("tells the admin privately when the bot lacks %s", async (_name, missing) => {
    const interaction = fakeInteraction({ botPermissions: POST_PERMISSIONS.filter((bit) => bit !== missing) });
    await command.execute(interaction);
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "helpCannotPost"),
      flags: MessageFlags.Ephemeral,
    });
  });

  it("needs Send Messages in Threads, not Send Messages, inside a thread", async () => {
    const inThread = fakeInteraction({
      isThread: true,
      botPermissions: POST_PERMISSIONS.filter((bit) => bit !== PermissionFlagsBits.SendMessages),
    });
    await command.execute(inThread);
    expect(inThread.channel.send).toHaveBeenCalledTimes(1);

    const blocked = fakeInteraction({
      isThread: true,
      botPermissions: POST_PERMISSIONS.filter((bit) => bit !== PermissionFlagsBits.SendMessagesInThreads),
    });
    await command.execute(blocked);
    expect(blocked.channel.send).not.toHaveBeenCalled();
  });

  it("tells the admin when Discord rejects the post for permissions", async () => {
    const interaction = fakeInteraction();
    interaction.channel.send.mockRejectedValue(discordError(RESTJSONErrorCodes.MissingPermissions));
    await command.execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("en", "helpCannotPost") });
  });

  it("lets other send errors reach the generic error handler", async () => {
    const interaction = fakeInteraction();
    interaction.channel.send.mockRejectedValue(new Error("network down"));
    await expect(command.execute(interaction)).rejects.toThrow("network down");
  });

  it("refuses when the channel isn't available", async () => {
    const interaction = fakeInteraction({ channel: null });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "helpCannotPost"),
      flags: MessageFlags.Ephemeral,
    });
  });

  it("refuses members without Manage Server", async () => {
    const interaction = fakeInteraction({ memberPermissions: permissions([]) });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "helpNoPermission"),
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.channel.send).not.toHaveBeenCalled();
  });

  it("refuses outside a server", async () => {
    const interaction = fakeInteraction({ inCachedGuild: () => false });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: translate("en", "guildOnly"), flags: MessageFlags.Ephemeral });
  });

  it("posts in the server's language and confirms in the admin's", async () => {
    const interaction = fakeInteraction({ locale: "de", guildLocale: "fr" });
    await command.execute(interaction);
    expect(postedEmbed(interaction).title).toBe(translate("fr", "helpTitle"));
    expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("de", "helpPosted") });
  });

  it("uses BOT_LANGUAGE when it is set", async () => {
    const forced = createCountryHelpCommand({ forcedLanguage: "ar" });
    const interaction = fakeInteraction({ guildLocale: "fr" });
    await forced.execute(interaction);
    expect(postedEmbed(interaction).title).toBe(translate("ar", "helpTitle"));
  });
});
