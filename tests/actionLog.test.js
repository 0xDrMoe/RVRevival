import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Status,
  buildCommandLogEmbed,
  createActionLog,
  describeCommand,
  result,
  statusForOutcome,
} from "../src/logs/actionLog.js";
import { Outcome } from "../src/roles/countryRoles.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const LOGS_CHANNEL_ID = "800000000000000009";
const CHANNEL_ID = "800000000000000001";
const USER_ID = "300000000000000001";
const TARGET_ID = "300000000000000002";

function fakeLogsChannel() {
  return { isTextBased: () => true, send: vi.fn(async () => {}) };
}

function fakeGuild(channels = {}) {
  return { id: GUILD_ID, channels: { cache: new Map(Object.entries(channels)) } };
}

// A fake "/country-staff set member:@target country:Canada" interaction.
function fakeInteraction(guild) {
  return {
    commandName: "country-staff",
    guild,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: USER_ID },
    options: {
      data: [
        {
          name: "set",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            { name: "member", type: ApplicationCommandOptionType.User, value: TARGET_ID },
            { name: "country", type: ApplicationCommandOptionType.String, value: "Canada" },
          ],
        },
      ],
    },
  };
}

describe("describeCommand", () => {
  it("names the subcommand and shows each option", () => {
    expect(describeCommand(fakeInteraction())).toEqual({
      command: "/country-staff set",
      options: [`member: <@${TARGET_ID}>`, "country: `Canada`"],
    });
  });

  it("keeps typed text from adding formatting and cuts long text", () => {
    const interaction = {
      commandName: "country",
      options: { data: [{ name: "country", type: ApplicationCommandOptionType.String, value: "`@everyone`" + "x".repeat(200) }] },
    };
    const [line] = describeCommand(interaction).options;
    expect(line.startsWith("country: `'@everyone'")).toBe(true);
    expect(line.length).toBeLessThan(115);
    expect(line.endsWith("…`")).toBe(true);
  });
});

describe("statusForOutcome", () => {
  it.each([
    [Outcome.ASSIGNED, Status.SUCCESS],
    [Outcome.REMOVED, Status.SUCCESS],
    [Outcome.LOCKED, Status.REFUSED],
    [Outcome.ALREADY_ASSIGNED, Status.REFUSED],
    [Outcome.NOTHING_TO_REMOVE, Status.REFUSED],
    [Outcome.HIERARCHY, Status.FAILED],
    [Outcome.UNEXPECTED, Status.FAILED],
  ])("%s is %s", (outcome, status) => {
    expect(statusForOutcome(outcome)).toBe(status);
  });
});

describe("buildCommandLogEmbed", () => {
  it("shows the user, channel, options and the English reply", () => {
    const embed = buildCommandLogEmbed(
      fakeInteraction(),
      result(Status.REFUSED, "staffOnly", { role: "<@&700000000000000001>" }),
    ).toJSON();
    expect(embed.title).toBe("/country-staff set");
    expect(embed.description).toBe("**Refused:** Only members with the <@&700000000000000001> role can use this command.");
    expect(embed.fields).toEqual([
      { name: "User", value: `<@${USER_ID}> (${USER_ID})`, inline: true },
      { name: "Channel", value: `<#${CHANNEL_ID}>`, inline: true },
      { name: "Options", value: `member: <@${TARGET_ID}>\ncountry: \`Canada\`` },
    ]);
  });
});

describe("action log", () => {
  let guildSettings;
  let logger;
  let actionLog;

  beforeEach(() => {
    guildSettings = new GuildSettings();
    logger = fakeLogger();
    actionLog = createActionLog({ guildSettings, logger });
  });

  it("posts nothing when no logs channel is set", async () => {
    const channel = fakeLogsChannel();
    await actionLog.logCommand(fakeInteraction(fakeGuild({ [LOGS_CHANNEL_ID]: channel })), result(Status.SUCCESS));
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("posts an embed in the logs channel without pinging anyone", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_CHANNEL_ID);
    const channel = fakeLogsChannel();
    await actionLog.logCommand(fakeInteraction(fakeGuild({ [LOGS_CHANNEL_ID]: channel })), result(Status.SUCCESS));
    expect(channel.send).toHaveBeenCalledWith({ embeds: [expect.anything()], allowedMentions: { parse: [] } });
  });

  it("never throws, and warns once until posting works again", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_CHANNEL_ID);
    const channel = fakeLogsChannel();
    channel.send.mockRejectedValue(new Error("Missing Permissions"));
    const interaction = fakeInteraction(fakeGuild({ [LOGS_CHANNEL_ID]: channel }));

    await expect(actionLog.logCommand(interaction, result(Status.SUCCESS))).resolves.toBeUndefined();
    await actionLog.logCommand(interaction, result(Status.SUCCESS));
    expect(logger.warn).toHaveBeenCalledTimes(1);

    channel.send.mockResolvedValue(undefined);
    await actionLog.logCommand(interaction, result(Status.SUCCESS));
    channel.send.mockRejectedValue(new Error("Missing Permissions"));
    await actionLog.logCommand(interaction, result(Status.SUCCESS));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("warns when the logs channel no longer exists", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_CHANNEL_ID);
    await actionLog.logCommand(fakeInteraction(fakeGuild()), result(Status.SUCCESS));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("ignores interactions outside a server", async () => {
    await expect(actionLog.logCommand(fakeInteraction(null), result(Status.REFUSED, "guildOnly"))).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs deleted messages with the author and channel", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_CHANNEL_ID);
    const channel = fakeLogsChannel();
    const message = { guild: fakeGuild({ [LOGS_CHANNEL_ID]: channel }), channelId: CHANNEL_ID, author: { id: USER_ID } };

    await actionLog.logDeletedMessage(message, { status: Status.SUCCESS, note: "Only /country can be used here." });

    const [embed] = channel.send.mock.calls[0][0].embeds;
    expect(embed.toJSON()).toMatchObject({
      title: "Message deleted in the /country channel",
      fields: [{ value: `<@${USER_ID}> (${USER_ID})` }, { value: `<#${CHANNEL_ID}>` }],
    });
  });
});
