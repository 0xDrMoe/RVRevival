import { ApplicationCommandOptionType, GatewayIntentBits, IntentsBitField, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Status,
  buildCommandLogEmbed,
  buildDeletedMessageLogEmbed,
  createActionLog,
  describeCommand,
  result,
  saveAttachments,
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

const BOT_MEMBER = {};

function fakeLogsChannel({ canAttach = true } = {}) {
  return {
    isTextBased: () => true,
    permissionsFor: (member) => ({ has: (bit) => member === BOT_MEMBER && (bit !== PermissionFlagsBits.AttachFiles || canAttach) }),
    send: vi.fn(async () => {}),
  };
}

function fakeGuild(channels = {}) {
  return { id: GUILD_ID, members: { me: BOT_MEMBER }, channels: { cache: new Map(Object.entries(channels)) } };
}

// A fake "/country-staff set member:@target country:Canada" interaction.
function fakeInteraction(guild) {
  return {
    commandName: "country-staff",
    guild,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: USER_ID, tag: "member", displayAvatarURL: () => "https://cdn.example/avatar.png" },
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

// A fake deleted message, shaped like discord.js's Message.
function fakeMessage({ content = "hello", attachments = [], stickers = [], readsContent = true, guild } = {}) {
  const intents = new IntentsBitField(readsContent ? [GatewayIntentBits.MessageContent] : []);
  return {
    id: "500000000000000001",
    guild,
    channelId: CHANNEL_ID,
    content,
    createdTimestamp: 1_700_000_000_000,
    author: { id: USER_ID, tag: "member" },
    client: { options: { intents } },
    attachments: new Map(attachments.map((attachment) => [attachment.id, attachment])),
    stickers: new Map(stickers.map((sticker) => [sticker.id, sticker])),
  };
}

const fakeAttachment = (id, size = 1000) => ({ id, name: `file-${id}.png`, url: `https://cdn.example/${id}.png`, size });

describe("buildCommandLogEmbed", () => {
  it("fits who, what, where and the English reply in a few lines", () => {
    const embed = buildCommandLogEmbed(
      fakeInteraction(),
      result(Status.REFUSED, "staffOnly", { role: "<@&700000000000000001>" }),
    ).toJSON();
    expect(embed.author).toEqual({ name: "member", icon_url: "https://cdn.example/avatar.png" });
    expect(embed.description).toBe(
      [
        `**Refused** · \`/country-staff set\` in <#${CHANNEL_ID}>`,
        `member: <@${TARGET_ID}> · country: \`Canada\``,
        "> Only members with the <@&700000000000000001> role can use this command.",
      ].join("\n"),
    );
    expect(embed.footer.text).toBe(`User ID ${USER_ID}`);
    expect(embed.fields).toBeUndefined();
  });

  it("names buttons and forms by their label and shows what was typed", () => {
    const outcome = {
      ...result(Status.SUCCESS, "assigned", { country: "Germany" }),
      action: { label: "Pick my country button", fields: { typed: "deutsch`land", country: "Germany" } },
    };
    const embed = buildCommandLogEmbed(fakeInteraction(), outcome).toJSON();
    expect(embed.description).toBe(
      [
        `**Success** · \`Pick my country button\` in <#${CHANNEL_ID}>`,
        "typed: `deutsch'land` · country: `Germany`",
        "> Your country role has been set to Germany.",
      ].join("\n"),
    );
  });
});

describe("buildDeletedMessageLogEmbed", () => {
  it("shows the text exactly as typed, in a code block that can't be closed early", () => {
    const embed = buildDeletedMessageLogEmbed(fakeMessage({ content: "hi ```@everyone```" }), result(Status.SUCCESS)).toJSON();
    expect(embed.description).toBe(
      `**Message deleted** in <#${CHANNEL_ID}>\n\`\`\`\nhi \`\u200b\`\`@everyone\`\u200b\`\`\n\`\`\``,
    );
    expect(embed.footer.text).toBe(`User ID ${USER_ID} · Message ID 500000000000000001`);
  });

  it("cuts very long text and says how much was left out", () => {
    const embed = buildDeletedMessageLogEmbed(fakeMessage({ content: "x".repeat(4000) }), result(Status.SUCCESS)).toJSON();
    expect(embed.description).toContain("*…500 more characters not shown*");
    expect(embed.description.length).toBeLessThanOrEqual(4096);
  });

  it("says when the text can't be read", () => {
    const embed = buildDeletedMessageLogEmbed(fakeMessage({ content: "", readsContent: false }), result(Status.SUCCESS));
    expect(embed.toJSON().description).toContain("Message Content intent is off");
  });

  it("lists attachments and stickers, and which attachments were saved", () => {
    const message = fakeMessage({
      content: "",
      attachments: [fakeAttachment("1", 2048), fakeAttachment("2", 20 * 1024 * 1024)],
      stickers: [{ id: "9", name: "wave" }],
    });
    const saved = [{ id: "1", file: {} }, { id: "2", reason: "too large to keep" }];
    const { description } = buildDeletedMessageLogEmbed(message, result(Status.SUCCESS), saved).toJSON();
    expect(description).toContain("**Attachments (2)**");
    expect(description).toContain("- [file-1.png](https://cdn.example/1.png) · 2 KB · saved below");
    expect(description).toContain("- [file-2.png](https://cdn.example/2.png) · 20.0 MB · too large to keep");
    expect(description).toContain("**Stickers:** `wave`");
  });
});

describe("saveAttachments", () => {
  const okFetch = () => vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));

  it("downloads attachments so they can be re-uploaded", async () => {
    const fetchFile = okFetch();
    const saved = await saveAttachments(fakeMessage({ attachments: [fakeAttachment("1")] }), { fetchFile });
    expect(fetchFile).toHaveBeenCalledWith("https://cdn.example/1.png", expect.anything());
    expect(saved[0].file.name).toBe("file-1.png");
  });

  it("skips files over the upload limit and survives failed downloads", async () => {
    const fetchFile = vi.fn(async () => {
      throw new Error("network down");
    });
    const message = fakeMessage({ attachments: [fakeAttachment("1", 9 * 1024 * 1024), fakeAttachment("2")] });
    const saved = await saveAttachments(message, { fetchFile });
    expect(saved).toEqual([
      { id: "1", reason: "too large to keep" },
      { id: "2", reason: "couldn't be downloaded" },
    ]);
    expect(fetchFile).toHaveBeenCalledTimes(1);
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
    expect(channel.send).toHaveBeenCalledWith({ embeds: [expect.anything()], files: [], allowedMentions: { parse: [] } });
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

  it("logs deleted messages with their text and re-uploads their attachments", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_CHANNEL_ID);
    const channel = fakeLogsChannel();
    const fetchFile = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
    actionLog = createActionLog({ guildSettings, logger, fetchFile });
    const message = fakeMessage({ guild: fakeGuild({ [LOGS_CHANNEL_ID]: channel }), attachments: [fakeAttachment("1")] });

    const saved = await actionLog.saveAttachments(message);
    await actionLog.logDeletedMessage(message, result(Status.SUCCESS), saved);

    const [{ embeds, files }] = channel.send.mock.calls[0];
    expect(embeds[0].toJSON().description).toContain("hello");
    expect(files.map((file) => file.name)).toEqual(["file-1.png"]);
  });

  it("still logs the message, without files, when the bot can't attach files there", async () => {
    await guildSettings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOGS_CHANNEL_ID);
    const channel = fakeLogsChannel({ canAttach: false });
    const message = fakeMessage({ guild: fakeGuild({ [LOGS_CHANNEL_ID]: channel }), attachments: [fakeAttachment("1")] });

    await actionLog.logDeletedMessage(message, result(Status.SUCCESS), [{ id: "1", file: {} }]);

    const [{ embeds, files }] = channel.send.mock.calls[0];
    expect(files).toEqual([]);
    expect(embeds[0].toJSON().description).toContain("not saved: the bot needs Attach Files here");
  });

  it("doesn't download anything when no logs channel is set", async () => {
    const fetchFile = vi.fn();
    actionLog = createActionLog({ guildSettings, logger, fetchFile });
    const saved = await actionLog.saveAttachments(fakeMessage({ guild: fakeGuild(), attachments: [fakeAttachment("1")] }));
    expect(saved).toEqual([]);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});
