import { ChannelType, MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildServerInfoCommandData, buildServerInfoEmbed, createServerInfoCommand, serverInfoCounts } from "../src/commands/serverInfo.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "900000000000000002";

const collection = (items) => ({ size: items.length, values: () => items.values() });

function fakeGuild({ members = [], ...overrides } = {}) {
  return {
    id: GUILD_ID,
    name: "Butterfly Club",
    description: "A place for butterflies",
    vanityURLCode: null,
    ownerId: OWNER_ID,
    createdTimestamp: 1_600_000_000_000,
    memberCount: 4,
    premiumSubscriptionCount: 7,
    premiumTier: 2,
    verificationLevel: 2,
    features: ["COMMUNITY", "SOME_INTERNAL_FLAG", "VERIFIED"],
    members: { cache: collection(members) },
    channels: {
      cache: collection([
        { type: ChannelType.GuildText },
        { type: ChannelType.GuildAnnouncement },
        { type: ChannelType.GuildForum },
        { type: ChannelType.GuildVoice },
        { type: ChannelType.GuildStageVoice },
        { type: ChannelType.GuildCategory },
        { type: ChannelType.PublicThread },
      ]),
    },
    roles: { cache: collection([{}, {}, {}]) },
    emojis: { cache: collection([{}, {}]) },
    stickers: { cache: collection([{}]) },
    iconURL: () => "https://cdn.discordapp.com/icons/1/a.png",
    bannerURL: () => null,
    ...overrides,
  };
}

const fieldValue = (embed, name) => embed.data.fields.find((field) => field.name === name)?.value;

describe("/serverinfo", () => {
  it("builds the command", () => {
    expect(buildServerInfoCommandData()).toMatchObject({ name: "serverinfo", options: [{ name: "private" }] });
  });

  it("counts channels by kind and leaves out @everyone and threads", () => {
    const counts = serverInfoCounts(fakeGuild());
    expect(counts.channels).toEqual({ text: 3, voice: 2, categories: 1 });
    expect(counts.roles).toBe(2);
    expect(counts.emojis).toBe(2);
    expect(counts.stickers).toBe(1);
  });

  it("splits people and bots only when every member is cached", () => {
    expect(serverInfoCounts(fakeGuild()).bots).toBeNull();
    const partial = fakeGuild({ members: [{ user: { bot: true } }] });
    expect(serverInfoCounts(partial).bots).toBeNull();
    const full = fakeGuild({ members: [{ user: { bot: true } }, { user: {} }, { user: {} }, { user: {} }] });
    expect(serverInfoCounts(full)).toMatchObject({ members: 4, humans: 3, bots: 1 });
  });

  it("shows the server's details in the chosen language", () => {
    const guild = fakeGuild({ vanityURLCode: "butterflies", members: [{ user: { bot: true } }, { user: {} }, { user: {} }, { user: {} }] });
    const embed = buildServerInfoEmbed(guild, { language: "en", color: 0x123456 });
    expect(embed.data.title).toBe("Butterfly Club");
    expect(embed.data.color).toBe(0x123456);
    expect(embed.data.description).toBe("A place for butterflies\nhttps://discord.gg/butterflies");
    expect(embed.data.thumbnail.url).toBe("https://cdn.discordapp.com/icons/1/a.png");
    expect(embed.data.image).toBeUndefined();
    expect(fieldValue(embed, "Owner")).toBe(`<@${OWNER_ID}>`);
    expect(fieldValue(embed, "Created")).toBe("<t:1600000000:D>\n<t:1600000000:R>");
    expect(fieldValue(embed, "Members")).toBe("4\nPeople: 3 · Bots: 1");
    expect(fieldValue(embed, "Channels")).toBe("Text: 3 · Voice: 2 · Categories: 1");
    expect(fieldValue(embed, "Boosts")).toBe("7 (level 2)");
    expect(fieldValue(embed, "Verification level")).toBe("Medium");
    expect(fieldValue(embed, "Features")).toBe("Verified, Community");
    expect(embed.data.footer.text).toBe(`Server ID: ${GUILD_ID}`);

    const spanish = buildServerInfoEmbed(fakeGuild({ features: [] }), { language: "es", color: 0 });
    expect(fieldValue(spanish, "Funciones")).toBe("Ninguna");
    expect(fieldValue(spanish, "Miembros")).toBe("4");
  });

  it("replies with the branding colour, privately when asked", async () => {
    const guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.BRANDING, { color: 0xff8800 });
    const command = createServerInfoCommand({ guildSettings });
    const reply = vi.fn(async () => {});
    const interaction = (isPrivate) => ({
      locale: "en-US",
      guild: fakeGuild(),
      inCachedGuild: () => true,
      options: { getBoolean: () => isPrivate },
      reply,
    });
    expect(await command.execute(interaction(false))).toMatchObject({ status: "success" });
    expect(reply.mock.calls[0][0].embeds[0].data.color).toBe(0xff8800);
    expect(reply.mock.calls[0][0].flags).toBeUndefined();
    expect(reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
    await command.execute(interaction(true));
    expect(reply.mock.calls[1][0].flags).toBe(MessageFlags.Ephemeral);
  });

  it("uses Rabble's colour when the server has none, and refuses outside servers", async () => {
    const command = createServerInfoCommand({ guildSettings: new GuildSettings() });
    const reply = vi.fn(async () => {});
    await command.execute({ locale: "en-US", guild: fakeGuild(), inCachedGuild: () => true, options: { getBoolean: () => null }, reply });
    expect(reply.mock.calls[0][0].embeds[0].data.color).toBe(0x7c5cff);
    expect(await command.execute({ locale: "en-US", inCachedGuild: () => false, reply })).toMatchObject({ key: "guildOnly" });
  });
});
