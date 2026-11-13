import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildBotInfoEmbed, botInfoButtons, botStats, createBotInfoCommands } from "../src/commands/botInfo.js";
import {
  buildAvatarEmbeds,
  buildRoleInfoEmbed,
  buildUserInfoEmbed,
  createInfoCommands,
  imageLinks,
  keyPermissionNames,
  roleList,
} from "../src/commands/infoCommands.js";
import { createMemberLoader } from "../src/guilds/memberCache.js";
import { translate } from "../src/i18n/i18n.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "900000000000000002";
const USER_ID = "900000000000000003";
const text = (key, values) => translate("en", key, values);
const field = (embed, name) => embed.data.fields.find((entry) => entry.name === name)?.value;

const role = (id, position, overrides = {}) => ({ id, position, name: `role-${id}`, color: 0, hoist: false, mentionable: false, tags: null, permissions: new PermissionsBitField(), createdTimestamp: 1_500_000_000_000, ...overrides });

function fakeUser(overrides = {}) {
  return {
    id: USER_ID,
    tag: "player",
    username: "player",
    globalName: "Player One",
    bot: false,
    avatar: "abc",
    banner: null,
    createdTimestamp: 1_600_000_000_000,
    displayAvatarURL: ({ extension = "webp", size } = {}) => `https://cdn/avatars/${USER_ID}/abc.${extension}?size=${size}`,
    bannerURL: ({ extension = "png", size } = {}) => `https://cdn/banners/${USER_ID}/b.${extension}?size=${size}`,
    ...overrides,
  };
}

function fakeMember(user, overrides = {}) {
  const roles = [role(GUILD_ID, 0), role("1", 1), role("2", 5)];
  return {
    id: user.id,
    user,
    nickname: "Captain",
    displayName: "Captain",
    displayColor: 0xff0000,
    joinedTimestamp: 1_700_000_000_000,
    premiumSinceTimestamp: null,
    communicationDisabledUntilTimestamp: null,
    pending: false,
    avatar: null,
    roles: { cache: new Map(roles.map((entry) => [entry.id, entry])) },
    permissions: new PermissionsBitField([PermissionFlagsBits.BanMembers, PermissionFlagsBits.SendMessages]),
    displayAvatarURL: () => "https://cdn/member.png",
    avatarURL: ({ extension = "png", size } = {}) => `https://cdn/guild-avatar.${extension}?size=${size}`,
    ...overrides,
  };
}

describe("info helpers", () => {
  it("lists key permissions, or only Administrator when someone has it", () => {
    expect(keyPermissionNames(new PermissionsBitField([PermissionFlagsBits.KickMembers, PermissionFlagsBits.SendMessages]), text)).toEqual(["Kick Members"]);
    expect(keyPermissionNames(new PermissionsBitField([PermissionFlagsBits.Administrator, PermissionFlagsBits.KickMembers]), text)).toEqual(["Administrator"]);
    expect(keyPermissionNames(null, text)).toEqual([]);
  });

  it("lists roles highest first, without @everyone, and says how many more there are", () => {
    const roles = [role(GUILD_ID, 0), ...Array.from({ length: 25 }, (_, index) => role(`1000000000000000${String(index).padStart(2, "0")}`, index + 1))];
    const list = roleList(roles, text, GUILD_ID);
    expect(list.startsWith("<@&100000000000000024>")).toBe(true);
    expect(list).not.toContain(`<@&${GUILD_ID}>`);
    expect(list.endsWith("and 5 more")).toBe(true);
    expect(roleList([role(GUILD_ID, 0)], text, GUILD_ID)).toBe("None");
  });

  it("links every image format, GIF only when animated", () => {
    const make = ({ extension, size }) => `https://x/${extension}/${size}`;
    expect(imageLinks(make, false)).toBe("[PNG](https://x/png/4096) · [JPG](https://x/jpg/4096) · [WebP](https://x/webp/4096)");
    expect(imageLinks(make, true)).toContain("[GIF](https://x/gif/4096)");
  });
});

describe("/userinfo", () => {
  const guild = { id: GUILD_ID, ownerId: OWNER_ID };

  it("shows a member's account, join date, roles and permissions", () => {
    const user = fakeUser();
    const embed = buildUserInfoEmbed({ user, member: fakeMember(user, { premiumSinceTimestamp: 1_710_000_000_000 }), guild, language: "en", color: 1 });
    expect(embed.data.color).toBe(0xff0000);
    expect(embed.data.description).toBe(`<@${USER_ID}> · Captain\n💎 Boosting since <t:1710000000:D>`);
    expect(field(embed, "Account created")).toBe("<t:1600000000:D>\n<t:1600000000:R>");
    expect(field(embed, "Joined the server")).toBe("<t:1700000000:D>\n<t:1700000000:R>");
    expect(field(embed, "Roles (2)")).toBe("<@&2> <@&1>");
    expect(field(embed, "Key permissions")).toBe("Ban Members");
  });

  it("marks someone who isn't in the server, and the owner", () => {
    const user = fakeUser();
    const gone = buildUserInfoEmbed({ user, member: undefined, guild, language: "en", color: 7 });
    expect(gone.data.color).toBe(7);
    expect(gone.data.description).toContain("Not in this server");
    expect(field(gone, "Joined the server")).toBeUndefined();
    const owner = buildUserInfoEmbed({ user: fakeUser({ id: OWNER_ID }), member: fakeMember(fakeUser({ id: OWNER_ID })), guild, language: "en", color: 7 });
    expect(owner.data.description).toContain("👑 Server owner");
  });

  it("replies without pings, privately when asked", async () => {
    const user = fakeUser();
    const member = fakeMember(user);
    const [command] = createInfoCommands({ guildSettings: { get: () => undefined } });
    const interaction = {
      locale: "en-US",
      guild: { ...guild, id: GUILD_ID },
      user,
      member,
      inCachedGuild: () => true,
      options: { getUser: () => null, getMember: () => null, getBoolean: () => true },
      reply: vi.fn(async () => {}),
    };
    await command.execute(interaction);
    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(reply.allowedMentions).toEqual({ parse: [] });
    expect(reply.embeds[0].data.description).toContain("Captain");
  });
});

describe("/avatar", () => {
  it("shows the profile picture, then the server picture and banner when there are some", () => {
    const user = fakeUser({ avatar: "a_anim", banner: "bnr" });
    const embeds = buildAvatarEmbeds({ user, member: fakeMember(user, { avatar: "srv" }), language: "en", color: 1 });
    expect(embeds.map((embed) => embed.data.title)).toEqual(["Captain's profile picture", "Captain's server picture", "Captain's banner"]);
    expect(embeds[0].data.image.url).toContain(".gif?size=1024");
    expect(embeds[1].data.image.url).toBe("https://cdn/guild-avatar.png?size=1024");
    expect(buildAvatarEmbeds({ user: fakeUser(), member: undefined, language: "en", color: 1 })).toHaveLength(1);
  });
});

describe("/roleinfo", () => {
  const guild = { id: GUILD_ID, roles: { cache: { size: 11 } } };

  it("describes the role", () => {
    const managed = role("5", 10, { color: 0x00ff00, hoist: true, tags: { botId: "42" }, permissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages]) });
    const embed = buildRoleInfoEmbed({ role: managed, guild, language: "en", memberCount: 3, complete: true });
    expect(embed.data.description).toBe("<@&5>\nManaged by <@42>");
    expect(field(embed, "Colour")).toBe("#00ff00");
    expect(field(embed, "Members")).toBe("3");
    expect(field(embed, "Position")).toBe("1 of 10");
    expect(field(embed, "Shown separately")).toBe("Yes");
    expect(field(embed, "Anyone can mention")).toBe("No");
    expect(field(embed, "Key permissions")).toBe("Manage Messages");
  });

  it("says when the count may be short", () => {
    const embed = buildRoleInfoEmbed({ role: role("5", 1), guild, language: "en", memberCount: 3, complete: false });
    expect(field(embed, "Members")).toBe("At least 3");
    expect(field(embed, "Colour")).toBe("None");
    expect(buildRoleInfoEmbed({ role: role("5", 1), guild, language: "en", memberCount: null, complete: false }).data.fields[1].value).toBe("Unknown");
  });
});

describe("member loader", () => {
  it("fetches once, shares a fetch in progress and skips fetching again for 10 minutes", async () => {
    let time = 0;
    const loader = createMemberLoader({ now: () => time });
    const fetch = vi.fn(async () => {});
    const guild = { id: GUILD_ID, memberCount: 5, members: { cache: { size: 2 }, fetch } };
    const [first, second] = await Promise.all([loader.loadAll(guild), loader.loadAll(guild)]);
    expect([first, second]).toEqual([true, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
    time = 5 * 60_000;
    await loader.loadAll(guild);
    expect(fetch).toHaveBeenCalledTimes(1);
    time = 11 * 60_000;
    await loader.loadAll(guild);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("doesn't fetch when every member is cached, and reports a failed fetch", async () => {
    const loader = createMemberLoader();
    const fetch = vi.fn(async () => {
      throw new Error("GuildMembersTimeout");
    });
    expect(await loader.loadAll({ id: "1", memberCount: 2, members: { cache: { size: 2 }, fetch } })).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(await loader.loadAll({ id: "1", memberCount: 3, members: { cache: { size: 2 }, fetch } })).toBe(false);
  });
});

describe("/botinfo and /ping", () => {
  const client = {
    user: { id: "123456789012345678", username: "Rabble", displayAvatarURL: () => "https://cdn/bot.png" },
    guilds: { cache: new Map([["1", { memberCount: 10 }], ["2", { memberCount: 32 }]]) },
    ws: { ping: 41.6 },
    readyTimestamp: 1_700_000_000_000,
  };

  it("counts servers and members from the cache", () => {
    expect(botStats(client, { memoryBytes: 50 * 1024 * 1024 })).toEqual({ servers: 2, members: 42, pingMs: 42, readyAt: 1_700_000_000_000, memoryMb: 50 });
    expect(botStats({ ...client, ws: { ping: -1 } }).pingMs).toBeNull();
  });

  it("builds the card and its link buttons", () => {
    const embed = buildBotInfoEmbed({ client, language: "en", color: 5, commandCount: 60, stats: botStats(client, { memoryBytes: 0 }) });
    expect(field(embed, "Servers")).toBe("2");
    expect(field(embed, "Commands")).toBe("60");
    expect(field(embed, "Ping")).toBe("42 ms");
    const [row] = botInfoButtons({ clientId: "123456789012345678", dashboardUrl: "https://rabble.example", language: "en" });
    expect(row.components.map((button) => button.data.url)).toEqual([
      "https://rabble.example",
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot+applications.commands&permissions=1495608192214",
      "https://rabble.example/privacy",
    ]);
    expect(botInfoButtons({ clientId: "1", dashboardUrl: undefined, language: "en" })[0].components).toHaveLength(1);
  });

  it("pings privately", async () => {
    let time = 1000;
    const [, ping] = createBotInfoCommands({ guildSettings: { get: () => undefined }, now: () => time });
    const interaction = {
      locale: "en-US",
      client,
      deferReply: vi.fn(async () => {
        time += 120;
      }),
      editReply: vi.fn(async () => {}),
    };
    await ping.execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply.mock.calls[0][0].content).toBe("🏓 Pong! Round trip: **120 ms** · Gateway: **42 ms**");
  });
});
