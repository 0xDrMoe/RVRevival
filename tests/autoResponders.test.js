import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildAutoResponderCommandData, createAutoResponderCommand } from "../src/commands/autoResponder.js";
import {
  checkResponders,
  cleanTrigger,
  createAutoResponder,
  fillReply,
  InvalidResponders,
  Match,
  matchesTrigger,
  MAX_RESPONDERS,
  respondersOf,
  RESPONDER_COOLDOWN_MS,
} from "../src/community/autoResponders.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const CATEGORY_ID = "800000000000000003";
const AUTHOR_ID = "300000000000000001";
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

function fakeMessage(content, { channelId = CHANNEL_ID, parentId = CATEGORY_ID, bot = false, thread = false } = {}) {
  const channel = { id: channelId, parentId, isThread: () => thread, parent: thread ? { id: parentId, parentId: CATEGORY_ID } : null };
  return {
    content,
    guildId: GUILD_ID,
    guild: { name: "Rumbleverse" },
    channelId,
    channel,
    author: { id: AUTHOR_ID, bot },
    inGuild: () => true,
    reply: vi.fn(async () => {}),
  };
}

function withResponders(responders) {
  const guildSettings = new GuildSettings();
  guildSettings.set(GUILD_ID, Setting.AUTO_RESPONDERS, responders);
  return guildSettings;
}

describe("matching", () => {
  const responder = (trigger, match) => ({ trigger, match });

  it("ignores case and extra spaces", () => {
    expect(cleanTrigger("  How   DO I\nDownload ")).toBe("how do i download");
  });

  it("matches anywhere, as whole words, the whole message or the start", () => {
    const text = cleanTrigger("Hi, how do I download the game?");
    expect(matchesTrigger(responder("download", Match.CONTAINS), text)).toBe(true);
    expect(matchesTrigger(responder("down", Match.CONTAINS), text)).toBe(true);
    expect(matchesTrigger(responder("down", Match.WORD), text)).toBe(false);
    expect(matchesTrigger(responder("download", Match.WORD), text)).toBe(true);
    expect(matchesTrigger(responder("hi", Match.STARTS), text)).toBe(true);
    expect(matchesTrigger(responder("hi", Match.EXACT), text)).toBe(false);
    expect(matchesTrigger(responder("hi", Match.EXACT), "hi")).toBe(true);
  });

  it("treats regex characters in triggers literally", () => {
    expect(matchesTrigger(responder("c++?", Match.WORD), "is c++? hard")).toBe(true);
    expect(matchesTrigger(responder("a.b", Match.CONTAINS), "axb")).toBe(false);
  });

  it("finds whole words in any alphabet", () => {
    expect(matchesTrigger(responder("مرحبا", Match.WORD), "مرحبا يا جماعة")).toBe(true);
    expect(matchesTrigger(responder("día", Match.WORD), "buenos días")).toBe(false);
  });
});

describe("checkResponders", () => {
  const anyChannel = () => true;

  it("cleans and sorts the list, and clears it when empty", () => {
    expect(
      checkResponders(
        [
          { trigger: " Server IP ", reply: "play.example.com\r\n", match: "word" },
          { trigger: "download", reply: "#downloads", channelId: CHANNEL_ID },
        ],
        anyChannel,
      ),
    ).toEqual([
      { trigger: "download", match: "contains", reply: "#downloads", channelId: CHANNEL_ID },
      { trigger: "server ip", match: "word", reply: "play.example.com", channelId: null },
    ]);
    expect(checkResponders([], anyChannel)).toBeNull();
  });

  it("refuses bad triggers, replies, match types, channels and duplicates", () => {
    const bad = [
      [{ trigger: "", reply: "x" }],
      [{ trigger: "x".repeat(61), reply: "x" }],
      [{ trigger: "x", reply: " " }],
      [{ trigger: "x", reply: "x".repeat(2001) }],
      [{ trigger: "x", reply: "x", match: "regex" }],
      [{ trigger: "x", reply: "x", channelId: "nope" }],
      [
        { trigger: "Hi", reply: "x" },
        { trigger: "hi", reply: "y" },
      ],
      Array.from({ length: MAX_RESPONDERS + 1 }, (_, i) => ({ trigger: `t${i}`, reply: "x" })),
      "not a list",
    ];
    for (const value of bad) {
      expect(() => checkResponders(value, (id) => id === CHANNEL_ID)).toThrow(InvalidResponders);
    }
  });
});

describe("respondersOf and fillReply", () => {
  it("drops malformed entries and fills in defaults", () => {
    const guildSettings = withResponders([{ trigger: "a", reply: "b", match: "weird" }, { trigger: 5 }, null]);
    expect(respondersOf(guildSettings, GUILD_ID)).toEqual([{ trigger: "a", match: "contains", reply: "b", channelId: null }]);
  });

  it("fills in the author, server and channel", () => {
    expect(fillReply("Hi {user}, welcome to {server} in {channel}!", fakeMessage("x"))).toBe(
      `Hi <@${AUTHOR_ID}>, welcome to Rumbleverse in <#${CHANNEL_ID}>!`,
    );
  });
});

describe("createAutoResponder", () => {
  it("replies once per channel within the cooldown, without pinging", async () => {
    let time = 0;
    const responder = createAutoResponder({
      guildSettings: withResponders([{ trigger: "download", match: "word", reply: "Hi {user}! See #downloads." }]),
      logger,
      now: () => time,
    });
    const first = fakeMessage("Where's the Download?");
    expect(await responder.handleMessage(first)).toBe(true);
    expect(first.reply).toHaveBeenCalledWith({
      content: `Hi <@${AUTHOR_ID}>! See #downloads.`,
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: false,
    });

    const again = fakeMessage("download pls");
    expect(await responder.handleMessage(again)).toBe(false);
    const elsewhere = fakeMessage("download pls", { channelId: OTHER_CHANNEL_ID });
    expect(await responder.handleMessage(elsewhere)).toBe(true);

    time += RESPONDER_COOLDOWN_MS;
    expect(await responder.handleMessage(fakeMessage("download pls"))).toBe(true);
  });

  it("ignores bots, other text and channels outside its channel or category", async () => {
    const responder = createAutoResponder({
      guildSettings: withResponders([
        { trigger: "ip", match: "word", reply: "here", channelId: CATEGORY_ID },
        { trigger: "rules", reply: "read them", channelId: OTHER_CHANNEL_ID },
      ]),
      logger,
    });
    expect(await responder.handleMessage(fakeMessage("what's the ip", { bot: true }))).toBe(false);
    expect(await responder.handleMessage(fakeMessage("nothing here"))).toBe(false);
    expect(await responder.handleMessage(fakeMessage("rules?"))).toBe(false);
    expect(await responder.handleMessage(fakeMessage("rules?", { channelId: "thread", parentId: OTHER_CHANNEL_ID, thread: true }))).toBe(true);
    // In the category.
    expect(await responder.handleMessage(fakeMessage("what's the ip"))).toBe(true);
    expect(await responder.handleMessage(fakeMessage("what's the ip", { channelId: "x", parentId: "elsewhere" }))).toBe(false);
  });

  it("swallows errors when it can't post", async () => {
    const responder = createAutoResponder({ guildSettings: withResponders([{ trigger: "hi", reply: "hello" }]), logger });
    const message = fakeMessage("hi");
    message.reply.mockRejectedValueOnce(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    expect(await responder.handleMessage(message)).toBe(false);
  });
});

describe("/autoresponder", () => {
  function interactionFor({ subcommand, options = {}, manage = true, customId, reply }) {
    const granted = new PermissionsBitField(manage ? [PermissionFlagsBits.ManageGuild] : []);
    return {
      guildId: GUILD_ID,
      locale: "en-US",
      customId,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => granted.has(bit) },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => options[name] ?? null,
        getChannel: (name) => options[name] ?? null,
        getFocused: () => options.focused ?? "",
      },
      fields: { getTextInputValue: () => reply },
      reply: vi.fn(async () => {}),
      showModal: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
    };
  }

  it("builds set, remove and list", () => {
    const data = buildAutoResponderCommandData();
    expect(data.name).toBe("autoresponder");
    expect(data.options.map((option) => option.name)).toEqual(["set", "remove", "list"]);
  });

  it("adds through the form, then changes the reply while keeping the match and channel", async () => {
    const guildSettings = new GuildSettings();
    const command = createAutoResponderCommand({ guildSettings });
    const channel = { id: CHANNEL_ID, type: ChannelType.GuildText };

    const open = interactionFor({ subcommand: "set", options: { trigger: "  Server IP ", match: "word", channel } });
    expect(await command.execute(open)).toBeNull();
    const form = open.showModal.mock.calls[0][0].toJSON();
    expect(form.custom_id).toBe(`arform:w:${CHANNEL_ID}:server ip`);

    const handle = command.componentPrefixes["arform:"].handle;
    const added = await handle(interactionFor({ customId: form.custom_id, reply: "play.example.com" }));
    expect(added).toMatchObject({ status: Status.SUCCESS, key: "autoresponderAdded" });
    expect(respondersOf(guildSettings, GUILD_ID)).toEqual([
      { trigger: "server ip", match: "word", reply: "play.example.com", channelId: CHANNEL_ID },
    ]);

    // Editing: the form is filled with the current reply; no match or channel picked keeps them.
    const reopen = interactionFor({ subcommand: "set", options: { trigger: "server ip" } });
    await command.execute(reopen);
    const second = reopen.showModal.mock.calls[0][0].toJSON();
    expect(second.custom_id).toBe("arform:-:-:server ip");
    expect(JSON.stringify(second)).toContain("play.example.com");
    const edited = await handle(interactionFor({ customId: second.custom_id, reply: "new.example.com" }));
    expect(edited.key).toBe("autoresponderEdited");
    expect(respondersOf(guildSettings, GUILD_ID)).toEqual([
      { trigger: "server ip", match: "word", reply: "new.example.com", channelId: CHANNEL_ID },
    ]);
  });

  it("removes and lists, and refuses people without Manage Server", async () => {
    const guildSettings = withResponders([{ trigger: "hi", match: "exact", reply: "hello", channelId: null }]);
    const command = createAutoResponderCommand({ guildSettings });

    const refused = await command.execute(interactionFor({ subcommand: "list", manage: false }));
    expect(refused).toMatchObject({ status: Status.REFUSED, key: "autoresponderNeedsManageGuild" });

    const list = interactionFor({ subcommand: "list" });
    await command.execute(list);
    expect(list.reply.mock.calls[0][0].content).toContain("`hi` · The whole message");

    expect(await command.execute(interactionFor({ subcommand: "remove", options: { trigger: "bye" } }))).toMatchObject({
      key: "autoresponderNotFound",
    });
    expect(await command.execute(interactionFor({ subcommand: "remove", options: { trigger: "HI" } }))).toMatchObject({
      status: Status.SUCCESS,
    });
    expect(guildSettings.get(GUILD_ID, Setting.AUTO_RESPONDERS)).toBeUndefined();
  });

  it("refuses a new one when the server is full, and an empty reply", async () => {
    const full = withResponders(Array.from({ length: MAX_RESPONDERS }, (_, i) => ({ trigger: `t${i}`, reply: "x" })));
    const command = createAutoResponderCommand({ guildSettings: full });
    expect(await command.execute(interactionFor({ subcommand: "set", options: { trigger: "new" } }))).toMatchObject({
      key: "autoresponderFull",
    });
    const handle = command.componentPrefixes["arform:"].handle;
    expect(await handle(interactionFor({ customId: "arform:-:-:t1", reply: "  " }))).toMatchObject({ key: "autoresponderEmpty" });
  });

  it("suggests saved triggers", async () => {
    const command = createAutoResponderCommand({ guildSettings: withResponders([{ trigger: "server ip", reply: "x" }, { trigger: "rules", reply: "y" }]) });
    const interaction = interactionFor({ options: { focused: "IP" } });
    await command.autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "server ip", value: "server ip" }]);
  });
});
