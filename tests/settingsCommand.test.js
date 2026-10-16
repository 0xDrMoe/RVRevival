import { ApplicationCommandOptionType, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsCommand } from "../src/commands/settings.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { LogEvent } from "../src/logs/serverLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000001";

// A fake /settings <subcommand> interaction from someone with Manage Server.
function fakeInteraction(
  subcommand,
  { setting, enabled, roleId = ROLE_ID, canDeleteMessages = true, canPost = true, ...overrides } = {},
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
      getBoolean: () => enabled,
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

  it("has a subcommand per setting, plus clear and show", () => {
    expect(data.options.map((option) => option.name)).toEqual([
      "staff-role",
      "country-channel",
      "logs-channel",
      "mod-log-channel",
      "server-log-channel",
      "mod-role",
      "log-event",
      "log-ignore",
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

    const [eventOption, enabledOption] = data.options[6].options;
    expect(eventOption.choices.map((choice) => choice.value)).toEqual(Object.values(LogEvent));
    expect(enabledOption).toMatchObject({ name: "enabled", type: ApplicationCommandOptionType.Boolean, required: true });

    const [settingOption] = data.options[8].options;
    expect(settingOption.choices.map((choice) => choice.value)).toEqual([
      Setting.STAFF_ROLE,
      Setting.COUNTRY_CHANNEL,
      Setting.LOGS_CHANNEL,
      Setting.MOD_LOG_CHANNEL,
      Setting.SERVER_LOG_CHANNEL,
      Setting.MOD_ROLE,
      Setting.DISABLED_LOG_EVENTS,
      Setting.LOG_IGNORED_CHANNELS,
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
    ["mod-log-channel", Setting.MOD_LOG_CHANNEL, "Moderation cases will now be posted in"],
    ["server-log-channel", Setting.SERVER_LOG_CHANNEL, "Edited and deleted messages, joins, leaves"],
  ])("sets the %s", async (subcommand, setting, start) => {
    const interaction = fakeInteraction(subcommand);
    const outcome = await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, setting)).toBe(CHANNEL_ID);
    expect(interaction.reply.mock.calls[0][0].content.startsWith(start)).toBe(true);
    expect(outcome.status).toBe(Status.SUCCESS);
  });

  it.each([
    [Setting.STAFF_ROLE, "settingsStaffRoleCleared"],
    [Setting.COUNTRY_CHANNEL, "settingsCountryChannelCleared"],
    [Setting.LOGS_CHANNEL, "settingsLogsChannelCleared"],
    [Setting.MOD_LOG_CHANNEL, "settingsModLogChannelCleared"],
    [Setting.SERVER_LOG_CHANNEL, "settingsServerLogChannelCleared"],
    [Setting.MOD_ROLE, "settingsModRoleCleared"],
    [Setting.DISABLED_LOG_EVENTS, "settingsLogEventsCleared"],
    [Setting.LOG_IGNORED_CHANNELS, "settingsLogIgnoreCleared"],
  ])("clears %s", async (setting, messageKey) => {
    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.MOD_LOG_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.SERVER_LOG_CHANNEL, CHANNEL_ID);
    const interaction = fakeInteraction("clear", { setting });

    await command.execute(interaction);

    expect(guildSettings.get(GUILD_ID, setting)).toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledWith(privateReply(translate("en", messageKey)));
  });

  it("shows the current settings", async () => {
    const before = fakeInteraction("show");
    await command.execute(before);
    expect(before.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Staff role: not set\n/country channel: any channel\nLogs channel: not set\n" +
          "Mod-log channel: not set (cases go to the logs channel)\nServer-log channel: not set\n" +
          "Mod role: not set (the staff role is used)\nServer-log events: all on\nIgnored by the server log: none",
      }),
    );

    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, ROLE_ID);
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.MOD_LOG_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.SERVER_LOG_CHANNEL, CHANNEL_ID);
    await guildSettings.set(GUILD_ID, Setting.MOD_ROLE, ROLE_ID);
    await guildSettings.set(GUILD_ID, Setting.DISABLED_LOG_EVENTS, [LogEvent.MEMBER_JOIN, LogEvent.MESSAGE_EDIT]);
    await guildSettings.set(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, [CHANNEL_ID]);
    const after = fakeInteraction("show");
    await command.execute(after);
    expect(after.reply).toHaveBeenCalledWith({
      content:
        `Staff role: <@&${ROLE_ID}>\n/country channel: <#${CHANNEL_ID}>\nLogs channel: <#${CHANNEL_ID}>\n` +
        `Mod-log channel: <#${CHANNEL_ID}>\nServer-log channel: <#${CHANNEL_ID}>\nMod role: <@&${ROLE_ID}>\n` +
        `Server-log events switched off: Edited messages, Members joining\nIgnored by the server log: <#${CHANNEL_ID}>`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  });

  it("sets the mod role and refuses @everyone", async () => {
    const interaction = fakeInteraction("mod-role");
    await command.execute(interaction);
    expect(guildSettings.get(GUILD_ID, Setting.MOD_ROLE)).toBe(ROLE_ID);
    expect(interaction.reply).toHaveBeenCalledWith(
      privateReply(`Members with the <@&${ROLE_ID}> role can now use the moderation commands.`),
    );

    const everyone = fakeInteraction("mod-role", { roleId: GUILD_ID });
    const outcome = await command.execute(everyone);
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "settingsModRoleEveryone" });
    expect(guildSettings.get(GUILD_ID, Setting.MOD_ROLE)).toBe(ROLE_ID);
  });

  it("switches a server-log event off and back on, without duplicates", async () => {
    const off = fakeInteraction("log-event", { setting: LogEvent.MESSAGE_EDIT, enabled: false });
    await command.execute(off);
    await command.execute(fakeInteraction("log-event", { setting: LogEvent.MESSAGE_EDIT, enabled: false }));
    expect(guildSettings.getList(GUILD_ID, Setting.DISABLED_LOG_EVENTS)).toEqual([LogEvent.MESSAGE_EDIT]);
    expect(off.reply).toHaveBeenCalledWith(privateReply("Edited messages will no longer be logged in the server log."));

    const on = fakeInteraction("log-event", { setting: LogEvent.MESSAGE_EDIT, enabled: true });
    const outcome = await command.execute(on);
    expect(guildSettings.getList(GUILD_ID, Setting.DISABLED_LOG_EVENTS)).toEqual([]);
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "settingsLogEventOn" });
  });

  it("rejects an unknown server-log event", async () => {
    const outcome = await command.execute(fakeInteraction("log-event", { setting: "nope", enabled: false }));
    expect(outcome.status).toBe(Status.FAILED);
    expect(guildSettings.getList(GUILD_ID, Setting.DISABLED_LOG_EVENTS)).toEqual([]);
  });

  it("ignores a channel in the server log, then stops ignoring it", async () => {
    const first = await command.execute(fakeInteraction("log-ignore"));
    expect(first).toMatchObject({ key: "settingsLogIgnoreAdded" });
    expect(guildSettings.getList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS)).toEqual([CHANNEL_ID]);

    const second = await command.execute(fakeInteraction("log-ignore"));
    expect(second).toMatchObject({ key: "settingsLogIgnoreRemoved" });
    expect(guildSettings.getList(GUILD_ID, Setting.LOG_IGNORED_CHANNELS)).toEqual([]);
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
