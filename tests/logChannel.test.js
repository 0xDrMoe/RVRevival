import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordApi } from "../src/dashboard/discordApi.js";
import { createLogChannelPoster } from "../src/logs/logChannel.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { discordError, fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const LOG_ID = "800000000000000007";
const BOT_ID = "200000000000000001";

const entry = (text) => () => ({ embed: new EmbedBuilder().setDescription(text) });
const descriptions = (call) => call[0].embeds.map((embed) => embed.toJSON().description);

// Resolves once a promise that's waiting on `release()` is let go.
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("log channel poster", () => {
  let permissions;
  let webhook;
  let channel;
  let guild;
  let settings;
  let logger;
  let poster;

  beforeEach(async () => {
    permissions = new Set([PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageWebhooks]);
    webhook = {
      id: "700000000000000001",
      channelId: LOG_ID,
      token: "webhook-token",
      owner: { id: BOT_ID },
      send: vi.fn(async () => ({ id: "600000000000000001", channelId: LOG_ID })),
      editMessage: vi.fn(async () => ({})),
    };
    channel = {
      id: LOG_ID,
      isTextBased: () => true,
      permissionsFor: () => ({ has: (flag) => permissions.has(flag) }),
      send: vi.fn(async () => ({ id: "600000000000000002", channelId: LOG_ID })),
      fetchWebhooks: vi.fn(async () => [webhook]),
      createWebhook: vi.fn(async () => webhook),
      messages: { fetch: vi.fn() },
    };
    const user = { id: BOT_ID, username: "Rumbleverse Revival", displayAvatarURL: () => "https://cdn.example/avatar.png" };
    guild = { id: GUILD_ID, members: { me: { id: BOT_ID, user } }, channels: { cache: new Map([[LOG_ID, channel]]) } };
    settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.LOGS_CHANNEL, LOG_ID);
    logger = fakeLogger();
    poster = createLogChannelPoster({ guildSettings: settings, logger });
  });

  const post = (build, options) => poster.post(guild, [Setting.LOGS_CHANNEL], build, options);

  // Posts "first" and keeps it on its way until `release()`.
  async function holdFirstPost() {
    const held = gate();
    webhook.send.mockImplementationOnce(async () => {
      await held.promise;
      return { id: "1", channelId: LOG_ID };
    });
    const posted = post(entry("first"));
    await vi.waitFor(() => expect(webhook.send).toHaveBeenCalledTimes(1));
    return { release: held.release, posted };
  }

  it("posts through the bot's own webhook, with the bot's name and avatar", async () => {
    const message = await post(entry("hello"));
    expect(message.id).toBe("600000000000000001");
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.createWebhook).not.toHaveBeenCalled();
    const [payload] = webhook.send.mock.calls[0];
    expect(descriptions(webhook.send.mock.calls[0])).toEqual(["hello"]);
    expect(payload).toMatchObject({
      username: "Rumbleverse Revival",
      avatarURL: "https://cdn.example/avatar.png",
      allowedMentions: { parse: [] },
    });
  });

  it("looks the webhook up once and reuses it", async () => {
    await post(entry("one"));
    await post(entry("two"));
    expect(channel.fetchWebhooks).toHaveBeenCalledTimes(1);
    expect(webhook.send).toHaveBeenCalledTimes(2);
  });

  it("creates a webhook when the channel has none of the bot's", async () => {
    channel.fetchWebhooks.mockResolvedValue([{ ...webhook, owner: { id: "someone else" } }]);
    await post(entry("hello"));
    expect(channel.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ name: "Rumbleverse Revival" }));
    expect(webhook.send).toHaveBeenCalledTimes(1);
  });

  it("posts as the bot without Manage Webhooks", async () => {
    permissions.delete(PermissionFlagsBits.ManageWebhooks);
    const message = await post(entry("hello"));
    expect(message.id).toBe("600000000000000002");
    expect(channel.fetchWebhooks).not.toHaveBeenCalled();
    expect(descriptions(channel.send.mock.calls[0])).toEqual(["hello"]);
  });

  it("posts as the bot when the webhook can't be made, and doesn't retry right away", async () => {
    channel.fetchWebhooks.mockResolvedValue([]);
    channel.createWebhook.mockRejectedValue(discordError(30007));
    await post(entry("one"));
    await post(entry("two"));
    expect(channel.createWebhook).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("falls back to the bot when the webhook was deleted, then makes a new one", async () => {
    webhook.send.mockRejectedValueOnce(discordError(10015));
    const message = await post(entry("one"));
    expect(message.id).toBe("600000000000000002");
    expect(descriptions(channel.send.mock.calls[0])).toEqual(["one"]);

    channel.fetchWebhooks.mockResolvedValue([]);
    await post(entry("two"));
    expect(channel.createWebhook).toHaveBeenCalledTimes(1);
    expect(webhook.send).toHaveBeenCalledTimes(2);
  });

  it("drops files on the fallback when the bot can't attach them", async () => {
    webhook.send.mockRejectedValueOnce(discordError(10015));
    permissions.delete(PermissionFlagsBits.AttachFiles);
    const build = vi.fn(({ canAttach }) => ({ embed: new EmbedBuilder().setDescription(`attach ${canAttach}`), files: ["file"] }));
    await post(build);
    expect(webhook.send.mock.calls[0][0].files).toEqual(["file"]);
    expect(descriptions(channel.send.mock.calls[0])).toEqual(["attach false"]);
    expect(channel.send.mock.calls[0][0].files).toEqual([]);
  });

  it("sends entries that arrive during a post together, in order", async () => {
    const first = await holdFirstPost();
    const posts = [first.posted, ...["b", "c", "d"].map((text) => post(entry(text)))];
    first.release();
    await Promise.all(posts);
    expect(webhook.send.mock.calls.map(descriptions)).toEqual([["first"], ["b", "c", "d"]]);
  });

  it("puts at most 10 embeds and 6000 characters in a message", async () => {
    const first = await holdFirstPost();
    const posts = [first.posted];
    for (let index = 0; index < 12; index += 1) {
      posts.push(post(entry(`${index}`)));
    }
    posts.push(post(entry("x".repeat(4000))), post(entry("y".repeat(4000))));
    first.release();
    await Promise.all(posts);
    expect(webhook.send.mock.calls.map((call) => call[0].embeds.length)).toEqual([1, 10, 3, 1]);
  });

  it("gives entries with files, and entries posted alone, their own message", async () => {
    const first = await holdFirstPost();
    const posts = [
      first.posted,
      post(entry("a")),
      post(() => ({ embed: new EmbedBuilder().setDescription("with file"), files: ["file"] })),
      post(entry("case"), { alone: true }),
      post(entry("b")),
      post(entry("c")),
    ];
    first.release();
    await Promise.all(posts);
    expect(webhook.send.mock.calls.map(descriptions)).toEqual([["first"], ["a"], ["with file"], ["case"], ["b", "c"]]);
  });

  it("warns once when the log channel can't be posted in", async () => {
    permissions.delete(PermissionFlagsBits.ManageWebhooks);
    channel.send.mockRejectedValue(discordError(50013));
    expect(await post(entry("one"))).toBeUndefined();
    expect(await post(entry("two"))).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("edits a webhook's entry through the webhook", async () => {
    await post(entry("hello"));
    channel.messages.fetch.mockResolvedValue({ id: "600000000000000001", webhookId: webhook.id });
    const embed = new EmbedBuilder().setDescription("updated");
    expect(await poster.edit(guild, LOG_ID, "600000000000000001", embed)).toBe(true);
    expect(webhook.editMessage).toHaveBeenCalledWith("600000000000000001", expect.objectContaining({ embeds: [embed] }));
  });

  it("edits the bot's own entries directly", async () => {
    const message = { id: "600000000000000002", edit: vi.fn(async () => ({})) };
    channel.messages.fetch.mockResolvedValue(message);
    expect(await poster.edit(guild, LOG_ID, message.id, new EmbedBuilder())).toBe(true);
    expect(message.edit).toHaveBeenCalled();
  });

  it("looks again after the channel's webhooks change", async () => {
    await post(entry("one"));
    poster.webhooksChanged(LOG_ID);
    await post(entry("two"));
    expect(channel.fetchWebhooks).toHaveBeenCalledTimes(2);
  });

  it("uses the parent channel's webhook for a thread", async () => {
    const thread = { ...channel, id: "800000000000000008", isThread: () => true, parent: channel, send: vi.fn() };
    guild.channels.cache.set(thread.id, thread);
    await settings.set(GUILD_ID, Setting.LOGS_CHANNEL, thread.id);
    await post(entry("hello"));
    expect(webhook.send.mock.calls[0][0].threadId).toBe(thread.id);
  });
});

describe("dashboard message edits", () => {
  it("edits a webhook's log entry through that webhook", async () => {
    const rest = {
      patch: vi.fn(async (route) => {
        if (route.startsWith("/channels/")) {
          throw discordError(50005);
        }
        return { id: "6" };
      }),
      get: vi.fn(async (route) =>
        route.startsWith("/channels/")
          ? { id: "6", channel_id: "8", webhook_id: "7" }
          : { id: "7", token: "secret", channel_id: "8" },
      ),
    };
    const discord = createDiscordApi({ config: { url: "https://example.test" }, rest });
    await discord.editMessage("8", "6", { embeds: [] });
    expect(rest.patch).toHaveBeenLastCalledWith(
      "/webhooks/7/secret/messages/6",
      expect.objectContaining({ auth: false, query: undefined }),
    );
  });

  it("still fails for other errors", async () => {
    const rest = { patch: vi.fn(async () => Promise.reject(discordError(50013))), get: vi.fn() };
    const discord = createDiscordApi({ config: { url: "https://example.test" }, rest });
    await expect(discord.editMessage("8", "6", { embeds: [] })).rejects.toMatchObject({ code: 50013 });
    expect(rest.get).not.toHaveBeenCalled();
  });
});
