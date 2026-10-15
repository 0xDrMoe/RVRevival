import { RESTJSONErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryChannelGuard } from "../src/channels/countryChannelGuard.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { discordError, fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const BOT_ID = "600000000000000001";
const MEMBER_ID = "300000000000000001";

// A fake message, shaped like discord.js's Message.
function fakeMessage({ channelId = CHANNEL_ID, authorId = MEMBER_ID, inGuild = true } = {}) {
  return {
    guildId: inGuild ? GUILD_ID : null,
    channelId,
    author: { id: authorId },
    client: { user: { id: BOT_ID } },
    inGuild: () => inGuild,
    delete: vi.fn(async () => {}),
  };
}

describe("/country channel guard", () => {
  let guildSettings;
  let logger;
  let guard;

  beforeEach(async () => {
    guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    logger = fakeLogger();
    guard = createCountryChannelGuard({ guildSettings, logger });
  });

  it("deletes other people's messages in the /country channel", async () => {
    const message = fakeMessage();
    await guard(message);
    expect(message.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps the bot's own messages", async () => {
    const message = fakeMessage({ authorId: BOT_ID });
    await guard(message);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it("leaves other channels, threads and DMs alone", async () => {
    for (const message of [fakeMessage({ channelId: OTHER_CHANNEL_ID }), fakeMessage({ inGuild: false })]) {
      await guard(message);
      expect(message.delete).not.toHaveBeenCalled();
    }
  });

  it("does nothing when no /country channel is set", async () => {
    await guildSettings.clear(GUILD_ID, Setting.COUNTRY_CHANNEL);
    const message = fakeMessage();
    await guard(message);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it.each([RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.CannotExecuteActionOnSystemMessage])(
    "ignores error %s",
    async (code) => {
      const message = fakeMessage();
      message.delete.mockRejectedValue(discordError(code));
      await expect(guard(message)).resolves.toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("warns once per server when it lacks permission, and again after a delete works", async () => {
    const denied = () => {
      const message = fakeMessage();
      message.delete.mockRejectedValue(discordError(RESTJSONErrorCodes.MissingPermissions));
      return message;
    };

    await guard(denied());
    await guard(denied());
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await guard(fakeMessage());
    await guard(denied());
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("passes other errors on", async () => {
    const message = fakeMessage();
    message.delete.mockRejectedValue(new Error("network down"));
    await expect(guard(message)).rejects.toThrow("network down");
  });
});
