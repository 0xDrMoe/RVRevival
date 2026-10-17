import { MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryHelpCommand, TranslateId } from "../src/commands/countryHelp.js";
import { PickerId } from "../src/commands/countryPicker.js";
import { CONTINENTS } from "../src/countries/continents.js";
import { SUPPORTED_LANGUAGES, translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
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
const postedButtons = (interaction) =>
  interaction.channel.send.mock.calls[0][0].components.flatMap((row) => row.toJSON().components);
const notes = (language) => `${translate(language, "helpNotes")}\n${translate(language, "helpFallbackNote")}`;

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
    const outcome = await command.execute(interaction);

    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "helpPosted" });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("en", "helpPosted") });

    const embed = postedEmbed(interaction);
    expect(embed.title).toBe(translate("en", "helpTitle"));
    expect(embed.description).toBe(translate("en", "helpIntro"));
    expect(embed.fields).toEqual([
      { name: translate("en", "helpStepsTitle"), value: translate("en", "helpSteps") },
      { name: translate("en", "helpNotesTitle"), value: notes("en") },
    ]);
  });

  it("adds a button per continent, Type my country and Translate this message under the guide", async () => {
    const interaction = fakeInteraction();
    await command.execute(interaction);
    const buttons = postedButtons(interaction);
    expect(buttons.map((button) => button.custom_id)).toEqual([
      ...CONTINENTS.map((continent) => PickerId.CONTINENT + continent),
      PickerId.BUTTON,
      TranslateId.BUTTON,
    ]);
    expect(buttons.map((button) => button.label)).toContain("North America");
    expect(buttons.at(-2).label).toBe(translate("en", "pickButtonLabel"));
    expect(buttons.at(-1).label).toBe(translate("en", "translateButtonLabel"));
  });

  it("labels the buttons in the server's language", async () => {
    const interaction = fakeInteraction({ locale: "de", guildLocale: "es-ES" });
    await command.execute(interaction);
    expect(postedButtons(interaction).at(-2).label).toBe(translate("es", "pickButtonLabel"));
    expect(postedButtons(interaction).at(-1).label).toBe(translate("es", "translateButtonLabel"));
    expect(postedButtons(interaction)[0].label).toBe(translate("es", "continentAfrica"));
  });

  it("says other messages are deleted when posted in the /country channel", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    const interaction = fakeInteraction();
    await createCountryHelpCommand({ guildSettings }).execute(interaction);

    expect(postedEmbed(interaction).fields[1].value).toBe(
      `${notes("en")}\n${translate("en", "helpChannelNote")}`,
    );
  });

  it("leaves the deletion note out in other channels", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, "800000000000000002");
    const elsewhere = fakeInteraction();
    await createCountryHelpCommand({ guildSettings }).execute(elsewhere);
    expect(postedEmbed(elsewhere).fields[1].value).toBe(notes("en"));

    const notSet = fakeInteraction();
    await createCountryHelpCommand({ guildSettings: new GuildSettings() }).execute(notSet);
    expect(postedEmbed(notSet).fields[1].value).toBe(notes("en"));
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

// A click on the guide's Translate button, or a pick from the language menu.
function fakeComponentInteraction({ locale = "de", values, channelId = CHANNEL_ID } = {}) {
  return {
    locale,
    guildId: GUILD_ID,
    channelId,
    values,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  };
}

const sentMessage = (mock) => mock.mock.calls[0][0];
const embedOf = (message) => message.embeds[0].toJSON();
const componentsOf = (message) => message.components.flatMap((row) => row.toJSON().components);
const languageMenuOf = (message) => componentsOf(message).find((component) => component.custom_id === TranslateId.MENU);

describe("Translate this message", () => {
  const { components } = createCountryHelpCommand();
  const clickTranslate = (interaction) => components[TranslateId.BUTTON].handle(interaction);
  const pickLanguage = (interaction) => components[TranslateId.MENU].handle(interaction);

  it("privately shows the guide in the clicker's Discord language", async () => {
    const interaction = fakeComponentInteraction({ locale: "de" });
    const outcome = await clickTranslate(interaction);

    expect(outcome).toBeNull();
    const message = sentMessage(interaction.reply);
    expect(message.flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(message).title).toBe(translate("de", "helpTitle"));
    expect(embedOf(message).fields[0].value).toBe(translate("de", "helpSteps"));
  });

  it("keeps the continent and Type my country buttons, in the translated language", async () => {
    const interaction = fakeComponentInteraction({ locale: "fr" });
    await clickTranslate(interaction);
    const ids = componentsOf(sentMessage(interaction.reply)).map((component) => component.custom_id);

    expect(ids).toEqual([...CONTINENTS.map((continent) => PickerId.CONTINENT + continent), PickerId.BUTTON, TranslateId.MENU]);
    expect(componentsOf(sentMessage(interaction.reply))[0].label).toBe(translate("fr", "continentAfrica"));
  });

  it("offers every language by its own name, with the current one selected", async () => {
    const interaction = fakeComponentInteraction({ locale: "es-ES" });
    await clickTranslate(interaction);
    const menu = languageMenuOf(sentMessage(interaction.reply));

    expect(menu.placeholder).toBe(translate("es", "translatePlaceholder"));
    expect(menu.options.map((option) => option.value)).toEqual(SUPPORTED_LANGUAGES);
    expect(menu.options.map((option) => option.label)).toEqual([
      "English",
      "Español",
      "Deutsch",
      "Français",
      "Português",
      "Italiano",
      "العربية",
    ]);
    expect(menu.options.filter((option) => option.default).map((option) => option.value)).toEqual(["es"]);
  });

  it("falls back to English for Discord languages the bot doesn't have", async () => {
    const interaction = fakeComponentInteraction({ locale: "ja" });
    await clickTranslate(interaction);
    expect(embedOf(sentMessage(interaction.reply)).title).toBe(translate("en", "helpTitle"));
  });

  it("ignores BOT_LANGUAGE, since the member asked for a translation", async () => {
    const forced = createCountryHelpCommand({ forcedLanguage: "ar" });
    const interaction = fakeComponentInteraction({ locale: "it" });
    await forced.components[TranslateId.BUTTON].handle(interaction);
    expect(embedOf(sentMessage(interaction.reply)).title).toBe(translate("it", "helpTitle"));
  });

  it.each(SUPPORTED_LANGUAGES)("switches the private copy to %s from the menu", async (language) => {
    const interaction = fakeComponentInteraction({ locale: "en-US", values: [language] });
    const outcome = await pickLanguage(interaction);

    expect(outcome).toBeNull();
    const message = sentMessage(interaction.update);
    expect(embedOf(message).title).toBe(translate(language, "helpTitle"));
    expect(languageMenuOf(message).options.find((option) => option.default).value).toBe(language);
  });

  it("makes Arabic reachable even though Discord has no Arabic setting", async () => {
    const interaction = fakeComponentInteraction({ locale: "en-US", values: ["ar"] });
    await pickLanguage(interaction);
    expect(embedOf(sentMessage(interaction.update)).description).toBe(translate("ar", "helpIntro"));
  });

  it("ignores a language value the menu never offered", async () => {
    const interaction = fakeComponentInteraction({ locale: "pt-BR", values: ["xx"] });
    await pickLanguage(interaction);
    expect(embedOf(sentMessage(interaction.update)).title).toBe(translate("pt", "helpTitle"));
  });

  it("includes the deletion note only for guides in the /country channel", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    const { components: withChannel } = createCountryHelpCommand({ guildSettings });

    const inChannel = fakeComponentInteraction({ locale: "de" });
    await withChannel[TranslateId.BUTTON].handle(inChannel);
    expect(embedOf(sentMessage(inChannel.reply)).fields[1].value).toContain(translate("de", "helpChannelNote"));

    const elsewhere = fakeComponentInteraction({ locale: "de", channelId: "800000000000000002" });
    await withChannel[TranslateId.BUTTON].handle(elsewhere);
    expect(embedOf(sentMessage(elsewhere.reply)).fields[1].value).not.toContain(translate("de", "helpChannelNote"));
  });
});

describe("the server's own guide wording", () => {
  const guide = { title: "Pick your flag", steps: "Click a continent.", color: 0xeb459e };

  async function settingsWith(values) {
    const settings = new GuildSettings();
    for (const [setting, value] of Object.entries(values)) {
      await settings.set(GUILD_ID, setting, value);
    }
    return settings;
  }

  it("posts the custom wording and colour, with the same fixed buttons", async () => {
    const command = createCountryHelpCommand({ guildSettings: await settingsWith({ [Setting.COUNTRY_GUIDE]: guide }) });
    const interaction = fakeInteraction();
    await command.execute(interaction);

    const embed = postedEmbed(interaction);
    expect(embed).toMatchObject({ title: "Pick your flag", color: 0xeb459e, description: translate("en", "helpIntro") });
    expect(embed.fields[0]).toEqual({ name: translate("en", "helpStepsTitle"), value: "Click a continent." });
    expect(embed.fields[1].value).toBe(notes("en"));
    const ids = postedButtons(interaction).map((button) => button.custom_id);
    expect(ids).toEqual([...CONTINENTS.map((continent) => PickerId.CONTINENT + continent), PickerId.BUTTON, TranslateId.BUTTON]);
  });

  it("remembers the posted guide so the dashboard can update it", async () => {
    const settings = await settingsWith({});
    const command = createCountryHelpCommand({ guildSettings: settings });
    const interaction = fakeInteraction();
    interaction.channel.send = vi.fn(async () => ({ id: "610000000000000001" }));
    await command.execute(interaction);
    expect(settings.get(GUILD_ID, Setting.COUNTRY_GUIDE_POST)).toEqual({ channelId: CHANNEL_ID, messageId: "610000000000000001" });
  });

  it("uses the custom wording for copies in the server's language only", async () => {
    const { components } = createCountryHelpCommand({ guildSettings: await settingsWith({ [Setting.COUNTRY_GUIDE]: guide }) });
    const english = { ...fakeComponentInteraction({ locale: "en-US" }), guildLocale: "en-US" };
    await components[TranslateId.BUTTON].handle(english);
    expect(embedOf(sentMessage(english.reply)).title).toBe("Pick your flag");

    const german = { ...fakeComponentInteraction({ locale: "de" }), guildLocale: "en-US" };
    await components[TranslateId.BUTTON].handle(german);
    const embed = embedOf(sentMessage(german.reply));
    expect(embed.title).toBe(translate("de", "helpTitle"));
    expect(embed.fields[0].value).toBe(translate("de", "helpSteps"));
    expect(embed.color).toBe(0xeb459e);
  });
});
