import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildEmbedForm, createEmbedCommand, findMessage, parseColor, parseFormId } from "../src/commands/embed.js";
import { SentMessageStore } from "../src/messages/sentMessageStore.js";
import { openDatabase } from "../src/storage/database.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "900000000000000010";
const MESSAGE_ID = "900000000000000020";
const BOT_ID = "900000000000000099";
const MOD_ID = "900000000000000030";

const settings = { get: () => undefined };

function fakeChannel({ memberCanPost = true, botCanPost = true, message } = {}) {
  return {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    permissionsFor: (who) => ({ has: () => (who.id === BOT_ID ? botCanPost : memberCanPost) }),
    send: vi.fn(async (body) => ({ id: MESSAGE_ID, url: "https://discord.com/channels/x/y/z", ...body })),
    messages: { fetch: vi.fn(async (id) => (message && id === message.id ? message : Promise.reject(new Error("Unknown Message")))) },
  };
}

function fakeInteraction({ channel = fakeChannel(), subcommand = "post", options = {}, fields = {}, customId, permissions = [PermissionFlagsBits.ManageMessages] } = {}) {
  const member = { id: MOD_ID, roles: { cache: new Map() } };
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    channel,
    customId,
    user: { id: MOD_ID },
    member,
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    client: { user: { id: BOT_ID } },
    guild: { id: GUILD_ID, members: { me: { id: BOT_ID } }, channels: { cache: new Map([[CHANNEL_ID, channel]]) } },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getChannel: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
    },
    fields: { getTextInputValue: (id) => fields[id] ?? "" },
    deferred: false,
    replied: false,
    reply: vi.fn(async function () {
      this.replied = true;
    }),
    deferReply: vi.fn(async function () {
      this.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
  };
}

const formHandler = (command) => command.componentPrefixes["embedform:"].handle;

describe("embed helpers", () => {
  it("reads colours", () => {
    expect(parseColor("#7c5cff")).toBe(0x7c5cff);
    expect(parseColor("ABC")).toBe(0xaabbcc);
    expect(parseColor("")).toBeNull();
    expect(parseColor("red")).toBeUndefined();
  });

  it("reads form IDs and message links", () => {
    expect(parseFormId(`embedform:post:${CHANNEL_ID}`)).toEqual({ mode: "post", channelId: CHANNEL_ID, messageId: null });
    expect(parseFormId(`embedform:edit:${CHANNEL_ID}:${MESSAGE_ID}`)).toEqual({ mode: "edit", channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    expect(parseFormId(`embedform:edit:${CHANNEL_ID}`)).toBeNull();
    expect(parseFormId(`embedform:post:${CHANNEL_ID}:${MESSAGE_ID}`)).toBeNull();
    expect(findMessage(MESSAGE_ID, { guildId: GUILD_ID, channelId: CHANNEL_ID })).toEqual({ channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    expect(findMessage(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`, { guildId: GUILD_ID })).toEqual({ channelId: CHANNEL_ID, messageId: MESSAGE_ID });
    expect(findMessage(`https://discord.com/channels/111111111111111111/${CHANNEL_ID}/${MESSAGE_ID}`, { guildId: GUILD_ID })).toBeNull();
  });

  it("builds a form with five fields, filled in when editing", () => {
    const form = buildEmbedForm("en", `embedform:edit:${CHANNEL_ID}:${MESSAGE_ID}`, { title: "Rules", color: "#ffffff" }).toJSON();
    expect(form.title).toBe("Edit embed");
    expect(form.components).toHaveLength(5);
    expect(form.components[0].component.value).toBe("Rules");
  });
});

describe("/embed", () => {
  it("opens the form with the server's colour", async () => {
    const command = createEmbedCommand({ guildSettings: settings });
    const interaction = fakeInteraction();
    expect(await command.execute(interaction)).toBeNull();
    const form = interaction.showModal.mock.calls[0][0].toJSON();
    expect(form.custom_id).toBe(`embedform:post:${CHANNEL_ID}`);
    expect(form.components[2].component.value).toBe("#7c5cff");
  });

  it("refuses members without Manage Messages, and channels they can't post in", async () => {
    const command = createEmbedCommand({ guildSettings: settings });
    const noPermission = fakeInteraction({ permissions: [] });
    expect((await command.execute(noPermission)).key).toBe("modNoPermission");
    const blocked = fakeInteraction({ channel: fakeChannel({ memberCanPost: false }) });
    expect((await command.execute(blocked)).key).toBe("embedYouCantPost");
    const botBlocked = fakeInteraction({ channel: fakeChannel({ botCanPost: false }) });
    expect((await command.execute(botBlocked)).key).toBe("embedBotCantPost");
  });

  it("posts the embed and lists it for the dashboard", async () => {
    const sentMessages = new SentMessageStore(openDatabase(":memory:"));
    const command = createEmbedCommand({ guildSettings: settings, sentMessages });
    const channel = fakeChannel();
    const interaction = fakeInteraction({
      channel,
      customId: `embedform:post:${CHANNEL_ID}`,
      fields: { title: "Rules", description: "Be nice", color: "#ff0000", image: "", footer: "Thanks" },
    });
    const outcome = await formHandler(command)(interaction);
    expect(outcome.key).toBe("embedPosted");
    expect(channel.send).toHaveBeenCalledWith({
      content: undefined,
      embeds: [{ title: "Rules", description: "Be nice", color: 0xff0000, footer: { text: "Thanks" } }],
      allowedMentions: { parse: [] },
    });
    expect(sentMessages.get(GUILD_ID, MESSAGE_ID)).toMatchObject({ summary: "Rules", sentBy: MOD_ID });
  });

  it("refuses an empty form, a bad colour and a bad image link", async () => {
    const command = createEmbedCommand({ guildSettings: settings });
    const run = (fields) => formHandler(command)(fakeInteraction({ customId: `embedform:post:${CHANNEL_ID}`, fields }));
    expect((await run({ footer: "only a footer" })).key).toBe("embedEmpty");
    expect((await run({ title: "T", color: "blue" })).key).toBe("embedBadColor");
    expect((await run({ title: "T", image: "javascript:alert(1)" })).key).toBe("embedInvalid");
  });

  it("edits a bot embed and keeps what the form doesn't show", async () => {
    const message = {
      id: MESSAGE_ID,
      url: "https://discord.com/channels/x/y/z",
      author: { id: BOT_ID },
      content: "Read this:",
      embeds: [
        { toJSON: () => ({ title: "Old", description: "Old text", fields: [{ name: "A", value: "1" }], thumbnail: { url: "https://x/t.png" } }) },
        { toJSON: () => ({ title: "Second" }) },
      ],
    };
    message.edit = vi.fn(async () => message);
    const channel = fakeChannel({ message });
    const command = createEmbedCommand({ guildSettings: settings });

    const open = fakeInteraction({ channel, subcommand: "edit", options: { message: MESSAGE_ID } });
    message.embeds[0].title = "Old";
    message.embeds[0].description = "Old text";
    await command.execute(open);
    expect(open.showModal.mock.calls[0][0].toJSON().components[0].component.value).toBe("Old");

    const save = fakeInteraction({ channel, customId: `embedform:edit:${CHANNEL_ID}:${MESSAGE_ID}`, fields: { title: "New", description: "New text" } });
    const outcome = await formHandler(command)(save);
    expect(outcome.key).toBe("embedEdited");
    expect(message.edit).toHaveBeenCalledWith({
      content: "Read this:",
      embeds: [{ title: "New", description: "New text", fields: [{ name: "A", value: "1", inline: false }], thumbnail: { url: "https://x/t.png" } }, { title: "Second" }],
      allowedMentions: { parse: [] },
    });
  });

  it("only edits the bot's own messages", async () => {
    const message = { id: MESSAGE_ID, author: { id: "1" }, embeds: [{}] };
    const command = createEmbedCommand({ guildSettings: settings });
    const interaction = fakeInteraction({ channel: fakeChannel({ message }), subcommand: "edit", options: { message: MESSAGE_ID } });
    expect((await command.execute(interaction)).key).toBe("embedNotMine");
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
  });
});
