import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryHelpCommand } from "../src/commands/countryHelp.js";
import { translate } from "../src/i18n/i18n.js";
import { ChannelSettings } from "../src/settings/channelSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";

// A fake /country-help interaction from someone with Manage Server.
function fakeInteraction({ botCanManageRoles = true, ...overrides } = {}) {
  return {
    commandName: "country-help",
    locale: "en-US",
    guildId: GUILD_ID,
    guild: {
      members: {
        me: { permissions: { has: (permission) => botCanManageRoles && permission === PermissionFlagsBits.ManageRoles } },
      },
    },
    inCachedGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

// The embed sent in the reply, as plain JSON.
const sentEmbed = (interaction) => interaction.reply.mock.calls[0][0].embeds[0].toJSON();
const statusField = (embed) => embed.fields.at(-1).value;

describe("/country-help definition", () => {
  const { data } = createCountryHelpCommand({ channelSettings: new ChannelSettings() });

  it("is hidden from members without Manage Server", () => {
    expect(data.name).toBe("country-help");
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });
});

describe("/country-help", () => {
  let channelSettings;
  let command;

  beforeEach(() => {
    channelSettings = new ChannelSettings();
    command = createCountryHelpCommand({ channelSettings });
  });

  it("privately explains how to use the bot", async () => {
    const interaction = fakeInteraction();
    await command.execute(interaction);

    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    const embed = sentEmbed(interaction);
    expect(embed.title).toBe(translate("en", "helpTitle"));
    expect(embed.fields.map((field) => field.name)).toEqual([
      translate("en", "helpMembersTitle"),
      translate("en", "helpChannelTitle"),
      translate("en", "helpSetupTitle"),
      translate("en", "helpLanguageTitle"),
      translate("en", "helpStatusTitle"),
    ]);
  });

  it("shows the chosen channel and the bot's permissions", async () => {
    const before = fakeInteraction();
    await command.execute(before);
    expect(statusField(sentEmbed(before))).toContain(translate("en", "channelShowNone"));
    expect(statusField(sentEmbed(before))).toContain(translate("en", "helpStatusCanManageRoles"));

    await channelSettings.set(GUILD_ID, CHANNEL_ID);
    const after = fakeInteraction({ botCanManageRoles: false });
    await command.execute(after);
    expect(statusField(sentEmbed(after))).toContain(`<#${CHANNEL_ID}>`);
    expect(statusField(sentEmbed(after))).toContain(translate("en", "helpStatusCannotManageRoles"));
  });

  it("refuses members without Manage Server", async () => {
    const interaction = fakeInteraction({ memberPermissions: { has: () => false } });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "helpNoPermission"),
      flags: MessageFlags.Ephemeral,
    });
  });

  it("replies in the admin's language", async () => {
    const interaction = fakeInteraction({ locale: "fr" });
    await command.execute(interaction);
    expect(sentEmbed(interaction).title).toBe(translate("fr", "helpTitle"));
  });
});
