import { ApplicationCommandOptionType, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsCommand } from "../src/commands/settings.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000001";

// A fake /settings <subcommand> interaction from someone with Manage Server.
function fakeInteraction(
  subcommand,
  { setting, roleId = ROLE_ID, canDeleteMessages = true, canPost = true, ...overrides } = {},
) {
  const botMember = {};
  return {
    commandName: "settings",
    locale: "en-US",
    guildId: GUILD_ID,
    guild: { members: { me: botMember } },
    inCachedGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => ({
        id: CHANNEL_ID,
        permissionsFor: (member) => ({
          has: (wanted) =>
            member === botMember &&
            [wanted]
              .flat()
              .every(
                (bit) =>
                  (bit !== PermissionFlagsBits.ManageMessages || canDeleteMessages) &&
                  (bit !== PermissionFlagsBits.SendMessages || canPost),
              ),
        }),
      }),
      getRole: () => ({ id: roleId }),
      getString: () => setting,
    },
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

const privateReply = (content) => ({ content, flags: MessageFlags.Ephemeral });

describe("/settings definition", () => {
  const { data } = createSettingsCommand({ guildSettings: new GuildSettings() });

  it("is hidden from members without Manage Server", () => {
    expect(data.name).toBe("settings");
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });

  it("has staff-role, country-channel, logs-channel, clear and show subcommands", () => {
    expect(data.options.map((option) => option.name)).toEqual([
      "staff-role",
      "country-channel",
      "logs-channel",
      "clear",
      "show",
    ]);

    const [roleOption] = data.options[0].options;
    expect(roleOption).toMatchObject({ name: "role", type: ApplicationCommandOptionType.Role, required: true });

    const [channelOption] = data.options[1].options;
    expect(channelOption).toMatchObject({ name: "channel", type: ApplicationCommandOptionType.Channel, required: true });
    expect(channelOption.channel_types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

    const [logsChannelOption] = data.options[2].options;
    expect(logsChannelOption).toMatchObject({ name: "channel", type: ApplicationCommandOptionType.Channel, required: true });
    expect(logsChannelOption.channel_types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

    const [settingOption] = data.options[3].options;
    expect(settingOption.choices.map((choice) => choice.value)).toEqual([
      Setting.STAFF_ROLE,
      Setting.COUNTRY_CHANNEL,
      Setting.LOGS_CHANNEL,
    ]);
    expect(settingOption.choices[0].name_localizations.de).toBe(translate("de", "settingsStaffRoleName"));
  });
});

describe("/settings", () => {
  let guildSettings;
  let command;

  beforeEach(() => {
    guildSettings = new GuildSettings();
    command = createSettingsCommand({ guildSettings });
  });

  it("sets the staff role", async () => {
    const interaction = fakeInteraction("staff-role");
    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, Setting.STAFF_ROLE)).toBe(ROLE_ID);
    expect(interaction.reply).toHaveBeenCalledWith(
      privateReply(`Members with the <@&${ROLE_ID}> role can now use /country-staff.`),
    );
  });

  it("refuses @everyone as the staff role", async () => {
    const interaction = fakeInteraction("staff-role", { roleId: GUILD_ID });
    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, Setting.STAFF_ROLE)).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("en", "settingsStaffRoleEveryone")));
  });

  it("sets the /country channel", async () => {
    const interaction = fakeInteraction("country-channel");
    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBe(CHANNEL_ID);
    expect(interaction.reply).toHaveBeenCalledWith(
      privateReply(`/country can now only be used in <#${CHANNEL_ID}>. Any other message posted there will be deleted.`),
    );
  });

  it("warns when the bot can't delete messages in the new /country channel", async () => {
    const interaction = fakeInteraction("country-channel", { canDeleteMessages: false });
    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, Setting.COUNTRY_CHANNEL)).toBe(CHANNEL_ID);
    const channel = { channel: `<#${CHANNEL_ID}>` };
    expect(interaction.reply).toHaveBeenCalledWith(
      privateReply(
        `${translate("en", "settingsCountryChannelSet", channel)}\n${translate("en", "settingsCountryChannelNeedsManageMessages", channel)}`,
      ),
    );
  });

  it("sets the logs channel", async () => {
    const interaction = fakeInteraction("logs-channel");
    const outcome = await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, Setting.LOGS_CHANNEL)).toBe(CHANNEL_ID);
    expect(interaction.reply).toHaveBeenCalledWith(
      privateReply(`Everything members do with the bot will now be logged in <#${CHANNEL_ID}>.`),
    );
    expect(outcome.status).toBe(Status.SUCCESS);
  });

  it("warns when the bot can't post in the new logs channel", async () => {
    const interaction = fakeInteraction("logs-channel", { canPost: false });
    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, Setting.LOGS_CHANNEL)).toBe(CHANNEL_ID);
    const channel = { channel: `<#${CHANNEL_ID}>` };
    expect(interaction.reply).toHaveBeenCalledWith(
      privateReply(
        `${translate("en", "settingsLogsChannelSet", channel)}\n${translate("en", "settingsLogsChannelNeedsPermissions", channel)}`,
      ),
    );
  });

  it.each([
    [Setting.STAFF_ROLE, "settingsStaffRoleCleared"],
    [Setting.COUNTRY_CHANNEL, "settingsCountryChannelCleared"],
    [Setting.LOGS_CHANNEL, "settingsLogsChannelCleared"],
  ])("clears %s", async (setting, messageKey) => {
    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, CHANNEL_ID);
    const interaction = fakeInteraction("clear", { setting });

    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, setting)).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("en", messageKey)));
  });

  it("shows the current settings", async () => {
    const before = fakeInteraction("show");
    await command.execute(before);
    expect(before.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Staff role: not set\n/country channel: any channel\nLogs channel: not set" }),
    );

    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, CHANNEL_ID);
    const after = fakeInteraction("show");
    await command.execute(after);
    expect(after.reply).toHaveBeenCalledWith({
      content: `Staff role: <@&${ROLE_ID}>\n/country channel: <#${CHANNEL_ID}>\nLogs channel: <#${CHANNEL_ID}>`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });

  it("refuses members without Manage Server", async () => {
    const interaction = fakeInteraction("staff-role", { memberPermissions: { has: () => false } });
    const outcome = await command.execute(interaction);
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "settingsNoPermission" });

    expect(guildSettings.get(GUILD_ID, Setting.STAFF_ROLE)).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("en", "settingsNoPermission")));
  });

  it("replies in the admin's language", async () => {
    const interaction = fakeInteraction("clear", { setting: Setting.COUNTRY_CHANNEL, locale: "de" });
    await command.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("de", "settingsCountryChannelCleared")));
  });
});
