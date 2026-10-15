import { ApplicationCommandOptionType, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryChannelCommand } from "../src/commands/countryChannel.js";
import { translate } from "../src/i18n/i18n.js";
import { ChannelSettings } from "../src/settings/channelSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";

// A fake /country-channel <subcommand> interaction from someone with Manage Server.
function fakeInteraction(subcommand, overrides = {}) {
  return {
    commandName: "country-channel",
    locale: "en-US",
    guildId: GUILD_ID,
    inCachedGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => ({ id: CHANNEL_ID }),
    },
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

const privateReply = (content) => ({ content, flags: MessageFlags.Ephemeral });

describe("/country-channel definition", () => {
  const { data } = createCountryChannelCommand({ channelSettings: new ChannelSettings() });

  it("is hidden from members without Manage Server", () => {
    expect(data.name).toBe("country-channel");
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });

  it("has set, clear and show subcommands, and set takes a text channel", () => {
    expect(data.options.map((option) => option.name)).toEqual(["set", "clear", "show"]);
    const [channelOption] = data.options[0].options;
    expect(channelOption).toMatchObject({ name: "channel", type: ApplicationCommandOptionType.Channel, required: true });
    expect(channelOption.channel_types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  });
});

describe("/country-channel", () => {
  let channelSettings;
  let command;

  beforeEach(() => {
    channelSettings = new ChannelSettings();
    command = createCountryChannelCommand({ channelSettings });
  });

  it("sets the channel", async () => {
    const interaction = fakeInteraction("set");
    await command.execute(interaction);

    expect(channelSettings.get(GUILD_ID)).toBe(CHANNEL_ID);
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(`/country can now only be used in <#${CHANNEL_ID}>.`));
  });

  it("clears the channel", async () => {
    await channelSettings.set(GUILD_ID, CHANNEL_ID);
    const interaction = fakeInteraction("clear");
    await command.execute(interaction);

    expect(channelSettings.get(GUILD_ID)).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("en", "channelCleared")));
  });

  it("shows the current setting", async () => {
    const before = fakeInteraction("show");
    await command.execute(before);
    expect(before.reply).toHaveBeenCalledWith(privateReply(translate("en", "channelShowNone")));

    await channelSettings.set(GUILD_ID, CHANNEL_ID);
    const after = fakeInteraction("show");
    await command.execute(after);
    expect(after.reply).toHaveBeenCalledWith(privateReply(`/country can only be used in <#${CHANNEL_ID}>.`));
  });

  it("refuses members without Manage Server", async () => {
    const interaction = fakeInteraction("set", { memberPermissions: { has: () => false } });
    await command.execute(interaction);

    expect(channelSettings.get(GUILD_ID)).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("en", "channelNoPermission")));
  });

  it("replies in the admin's language", async () => {
    const interaction = fakeInteraction("clear", { locale: "de" });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("de", "channelCleared")));
  });
});
