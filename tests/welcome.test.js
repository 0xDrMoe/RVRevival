import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildWelcomeCommandData, createWelcomeCommand } from "../src/commands/welcome.js";
import { createWelcomer, renderTemplate, welcomePayload, welcomeText } from "../src/community/welcome.js";
import { checkWelcomeEmbed, renderWelcomeEmbed } from "../src/community/welcomeEmbeds.js";
import { checkMilestones, createMilestones, InvalidMilestones, milestoneFor, reachedMilestone } from "../src/community/milestones.js";
import { GrowthStore } from "../src/members/growthStore.js";
import { BRAND_COLOR } from "../src/guilds/guildJoin.js";
import { InvalidMessage } from "../src/messages/embedMessage.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const WELCOME_CHANNEL_ID = "800000000000000001";
const LEAVE_CHANNEL_ID = "800000000000000002";
const MEMBER_ROLE_ID = "700000000000000001";
const HIGH_ROLE_ID = "700000000000000002";
const USER_ID = "300000000000000020";

function fakeChannel(id) {
  return { id, isTextBased: () => true, send: vi.fn(async () => ({})) };
}

function fakeGuild({ canManageRoles = true, features = [] } = {}) {
  const channels = new Map([
    [WELCOME_CHANNEL_ID, fakeChannel(WELCOME_CHANNEL_ID)],
    [LEAVE_CHANNEL_ID, fakeChannel(LEAVE_CHANNEL_ID)],
  ]);
  const roles = new Map([
    [MEMBER_ROLE_ID, { id: MEMBER_ROLE_ID, position: 5, managed: false }],
    [HIGH_ROLE_ID, { id: HIGH_ROLE_ID, position: 60, managed: false }],
  ]);
  return {
    id: GUILD_ID,
    name: "Rumbleverse *Revival*",
    features,
    memberCount: 1234,
    preferredLocale: "en-US",
    channels: { cache: channels },
    roles: { cache: roles },
    members: {
      me: {
        roles: { highest: { position: 50 } },
        permissions: { has: (bit) => canManageRoles || bit !== PermissionFlagsBits.ManageRoles },
      },
    },
  };
}

function fakeMember(guild, { bot = false, pending = false, name = "Big_Rumbler" } = {}) {
  const roleIds = new Set();
  return {
    id: USER_ID,
    guild,
    pending,
    displayName: name,
    user: { id: USER_ID, username: name, bot },
    roles: {
      cache: { has: (id) => roleIds.has(id) },
      add: vi.fn(async (ids) => [ids].flat().forEach((id) => roleIds.add(id))),
    },
    send: vi.fn(async () => ({})),
  };
}

async function settingsWith(values) {
  const guildSettings = new GuildSettings();
  for (const [setting, value] of Object.entries(values)) {
    await guildSettings.set(GUILD_ID, setting, value);
  }
  return guildSettings;
}

describe("renderTemplate", () => {
  it("fills in every placeholder and escapes names", () => {
    const guild = fakeGuild();
    const member = fakeMember(guild);
    expect(renderTemplate("Hi {user} ({username}), welcome to {server}! You're #{count}.", { member, guild })).toBe(
      `Hi <@${USER_ID}> (Big\\_Rumbler), welcome to Rumbleverse \\*Revival\\*! You're #1,234.`,
    );
  });

  it("leaves unknown placeholders alone", () => {
    const guild = fakeGuild();
    expect(renderTemplate("{nope} {user}", { member: fakeMember(guild), guild })).toBe(`{nope} <@${USER_ID}>`);
  });

  it("uses the default message when none is set", async () => {
    const guild = fakeGuild();
    const text = welcomeText(new GuildSettings(), guild, fakeMember(guild), "welcome");
    expect(text).toBe(renderTemplate(translate("en", "welcomeDefaultWelcome"), { member: fakeMember(guild), guild }));
    expect(text).toContain(`<@${USER_ID}>`);
  });
});

describe("welcomer", () => {
  it("posts the welcome message, DMs the member and gives autoroles", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({
      [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID,
      [Setting.WELCOME_MESSAGE]: "Welcome {user}!",
      [Setting.WELCOME_DM]: "Read the rules of {server}",
      [Setting.AUTOROLES]: [MEMBER_ROLE_ID, HIGH_ROLE_ID],
    });
    const member = fakeMember(guild);
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberJoined(member);

    expect(guild.channels.cache.get(WELCOME_CHANNEL_ID).send).toHaveBeenCalledWith({
      content: `Welcome <@${USER_ID}>!`,
      allowedMentions: { users: [USER_ID] },
    });
    expect(member.send).toHaveBeenCalledWith({ content: "Read the rules of Rumbleverse \\*Revival\\*", allowedMentions: { parse: [] } });
    // The role above the bot is skipped.
    expect(member.roles.add).toHaveBeenCalledWith([MEMBER_ROLE_ID], "Autorole");
  });

  it("stops welcome DMs when too many people join at once, but still welcomes them", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({ [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID, [Setting.WELCOME_DM]: "Hi" });
    const welcomer = createWelcomer({ guildSettings, logger: fakeLogger(), now: () => 1000 });
    const members = Array.from({ length: 15 }, () => fakeMember(guild));
    await Promise.all(members.map((member) => welcomer.memberJoined(member)));
    expect(members.filter((member) => member.send.mock.calls.length > 0)).toHaveLength(10);
    // The welcomes that piled up went out together.
    const channel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
    expect(channel.send.mock.calls.length).toBeLessThan(15);
    expect(channel.send.mock.calls.map(([payload]) => payload.content.split("\n").length).reduce((sum, count) => sum + count, 0)).toBe(15);
  });

  it("doesn't try to post where the bot can't", async () => {
    const guild = fakeGuild();
    const channel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
    guild.members.me.id = "bot";
    channel.guild = guild;
    channel.permissionsFor = () => ({ has: () => false });
    const logger = fakeLogger();
    const guildSettings = await settingsWith({ [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID });
    await createWelcomer({ guildSettings, logger }).memberJoined(fakeMember(guild));
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("does nothing for bots", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({ [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID, [Setting.AUTOROLES]: [MEMBER_ROLE_ID] });
    const member = fakeMember(guild, { bot: true });
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberJoined(member);
    expect(guild.channels.cache.get(WELCOME_CHANNEL_ID).send).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("gives bots only the bot autoroles", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({ [Setting.AUTOROLES]: [MEMBER_ROLE_ID], [Setting.BOT_AUTOROLES]: [HIGH_ROLE_ID.replace(/2$/, "3")] });
    guild.roles.cache.set(HIGH_ROLE_ID.replace(/2$/, "3"), { id: HIGH_ROLE_ID.replace(/2$/, "3"), position: 4, managed: false, permissions: { has: () => false } });
    const bot = fakeMember(guild, { bot: true });
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberJoined(bot);
    expect(bot.roles.add).toHaveBeenCalledWith([HIGH_ROLE_ID.replace(/2$/, "3")], "Autorole");
  });

  it("waits until pending members accept the rules before giving autoroles", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({ [Setting.AUTOROLES]: [MEMBER_ROLE_ID] });
    const welcomer = createWelcomer({ guildSettings, logger: fakeLogger() });
    const pending = fakeMember(guild, { pending: true });
    await welcomer.memberJoined(pending);
    expect(pending.roles.add).not.toHaveBeenCalled();

    const accepted = { ...pending, pending: false };
    await welcomer.memberUpdated(pending, accepted);
    expect(accepted.roles.add).toHaveBeenCalledWith([MEMBER_ROLE_ID], "Autorole");
  });

  it("warns once when it can't give roles", async () => {
    const guild = fakeGuild({ canManageRoles: false });
    const guildSettings = await settingsWith({ [Setting.AUTOROLES]: [MEMBER_ROLE_ID] });
    const logger = fakeLogger();
    const welcomer = createWelcomer({ guildSettings, logger });
    await welcomer.memberJoined(fakeMember(guild));
    await welcomer.memberJoined(fakeMember(guild));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("posts the leave message, and nothing without a leave channel", async () => {
    const guild = fakeGuild();
    const welcomer = createWelcomer({ guildSettings: await settingsWith({}), logger: fakeLogger() });
    await welcomer.memberLeft(fakeMember(guild));
    expect(guild.channels.cache.get(LEAVE_CHANNEL_ID).send).not.toHaveBeenCalled();

    const guildSettings = await settingsWith({ [Setting.LEAVE_CHANNEL]: LEAVE_CHANNEL_ID, [Setting.LEAVE_MESSAGE]: "Bye {username}" });
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberLeft(fakeMember(guild));
    expect(guild.channels.cache.get(LEAVE_CHANNEL_ID).send).toHaveBeenCalledWith({
      content: "Bye Big\\_Rumbler",
      allowedMentions: { users: [USER_ID] },
    });
  });

  it("doesn't crash when the DM fails", async () => {
    const guild = fakeGuild();
    const member = fakeMember(guild);
    member.send.mockRejectedValue(new Error("Cannot send messages to this user"));
    const guildSettings = await settingsWith({ [Setting.WELCOME_DM]: "Hi" });
    await expect(createWelcomer({ guildSettings, logger: fakeLogger() }).memberJoined(member)).resolves.toBeUndefined();
  });
});

describe("/welcome", () => {
  function fakeInteraction(subcommand, { text, role, what, bots = null, every = null, canPost = true, manageGuild = true, features } = {}) {
    const guild = fakeGuild({ features });
    const member = fakeMember(guild);
    return {
      locale: "en-US",
      guildId: GUILD_ID,
      guild,
      member,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => manageGuild && bit === PermissionFlagsBits.ManageGuild },
      options: {
        getSubcommand: () => subcommand,
        getChannel: () => ({ id: WELCOME_CHANNEL_ID, permissionsFor: () => ({ has: () => canPost }) }),
        getString: (name) => (name === "what" ? what : text),
        getRole: () => role,
        getBoolean: (name) => (name === "bots" ? bots : null),
        getInteger: (name) => (name === "every" ? every : null),
      },
      reply: vi.fn(async () => {}),
    };
  }
  const run = async (guildSettings, ...args) => {
    const interaction = fakeInteraction(...args);
    const outcome = await createWelcomeCommand({ guildSettings }).execute(interaction);
    return { interaction, outcome, content: interaction.reply.mock.calls[0]?.[0].content };
  };

  it("is hidden from members without Manage Server", () => {
    const data = buildWelcomeCommandData();
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(data.options.map((option) => option.name)).toEqual([
      "channel",
      "message",
      "leave-channel",
      "leave-message",
      "dm",
      "embed",
      "autorole",
      "milestones",
      "persist",
      "off",
      "test",
      "show",
    ]);
  });

  it("/welcome milestones saves it and previews the next one", async () => {
    const guildSettings = new GuildSettings();
    const { outcome, content } = await run(guildSettings, "milestones", { every: 500, text: "We hit {members}!" });
    expect(outcome.status).toBe(Status.SUCCESS);
    expect(guildSettings.get(GUILD_ID, Setting.MILESTONES)).toEqual({ channelId: WELCOME_CHANNEL_ID, every: 500, message: "We hit {members}!" });
    expect(content).toContain("We hit 1,500!");
    await run(guildSettings, "off", { what: "milestones" });
    expect(guildSettings.get(GUILD_ID, Setting.MILESTONES)).toBeUndefined();
  });

  it("/welcome autorole bots:True manages the bot list", async () => {
    const guildSettings = new GuildSettings();
    const role = { id: MEMBER_ROLE_ID, position: 5, managed: false, permissions: { has: () => false } };
    const { outcome } = await run(guildSettings, "autorole", { role, bots: true });
    expect(outcome.key).toBe("welcomeBotAutoroleAdded");
    expect(guildSettings.getList(GUILD_ID, Setting.BOT_AUTOROLES)).toEqual([MEMBER_ROLE_ID]);
    expect(guildSettings.getList(GUILD_ID, Setting.AUTOROLES)).toEqual([]);
  });

  it("refuses members without Manage Server", async () => {
    const { outcome } = await run(new GuildSettings(), "show", { manageGuild: false });
    expect(outcome.status).toBe(Status.REFUSED);
  });

  it("sets the welcome channel, and warns when the bot can't post there", async () => {
    const guildSettings = new GuildSettings();
    const { content, interaction } = await run(guildSettings, "channel", { canPost: false });
    expect(guildSettings.get(GUILD_ID, Setting.WELCOME_CHANNEL)).toBe(WELCOME_CHANNEL_ID);
    expect(content).toContain(translate("en", "welcomeCannotPost", { channel: `<#${WELCOME_CHANNEL_ID}>` }));
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
  });

  it("saves messages with new lines and previews them", async () => {
    const guildSettings = new GuildSettings();
    const { content } = await run(guildSettings, "message", { text: "Hi {user}\\nHave fun" });
    expect(guildSettings.get(GUILD_ID, Setting.WELCOME_MESSAGE)).toBe("Hi {user}\nHave fun");
    expect(content).toContain(`Hi <@${USER_ID}>\nHave fun`);
    expect(content).toContain(translate("en", "welcomeNoChannelYet"));
  });

  it("adds and removes autoroles, refusing dangerous or managed ones", async () => {
    const guildSettings = new GuildSettings();
    const role = { id: MEMBER_ROLE_ID, position: 5, managed: false, permissions: { has: () => false } };
    await run(guildSettings, "autorole", { role });
    expect(guildSettings.getList(GUILD_ID, Setting.AUTOROLES)).toEqual([MEMBER_ROLE_ID]);
    await run(guildSettings, "autorole", { role });
    expect(guildSettings.getList(GUILD_ID, Setting.AUTOROLES)).toEqual([]);

    const admin = { ...role, permissions: { has: (bit) => bit === PermissionFlagsBits.Administrator } };
    expect((await run(guildSettings, "autorole", { role: admin })).outcome.key).toBe("welcomeAutoroleDangerous");
    const banner = { ...role, permissions: { has: (bit) => bit === PermissionFlagsBits.BanMembers } };
    expect((await run(guildSettings, "autorole", { role: banner })).outcome.key).toBe("welcomeAutoroleDangerous");
    expect((await run(guildSettings, "autorole", { role: { ...role, managed: true } })).outcome.key).toBe("welcomeAutoroleInvalid");
    expect((await run(guildSettings, "autorole", { role: { ...role, id: GUILD_ID } })).outcome.key).toBe("welcomeAutoroleInvalid");
  });

  it("recommends Onboarding over autoroles on Community servers", async () => {
    const role = { id: MEMBER_ROLE_ID, position: 5, managed: false, permissions: { has: () => false } };
    const tip = translate("en", "welcomeOnboardingTip");
    expect((await run(new GuildSettings(), "autorole", { role })).content).not.toContain(tip);
    const guildSettings = new GuildSettings();
    expect((await run(guildSettings, "autorole", { role, features: ["COMMUNITY"] })).content).toContain(tip);
    expect((await run(guildSettings, "show", { features: ["COMMUNITY"] })).content).toContain(tip);
  });

  it("switches things off", async () => {
    const guildSettings = await settingsWith({ [Setting.WELCOME_MESSAGE]: "a", [Setting.LEAVE_MESSAGE]: "b", [Setting.WELCOME_DM]: "c" });
    await run(guildSettings, "off", { what: "messages" });
    expect(guildSettings.get(GUILD_ID, Setting.WELCOME_MESSAGE)).toBeUndefined();
    expect(guildSettings.get(GUILD_ID, Setting.LEAVE_MESSAGE)).toBeUndefined();
    expect(guildSettings.get(GUILD_ID, Setting.WELCOME_DM)).toBe("c");
    await run(guildSettings, "off", { what: "dm" });
    expect(guildSettings.get(GUILD_ID, Setting.WELCOME_DM)).toBeUndefined();
  });

  it("previews everything with the admin as the new member", async () => {
    const guildSettings = await settingsWith({ [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID, [Setting.WELCOME_DM]: "DM for {username}" });
    const { content } = await run(guildSettings, "test");
    expect(content).toContain(`<@${USER_ID}>`);
    expect(content).toContain("> DM for Big\\_Rumbler");
    expect(content).toContain(translate("en", "welcomeTestOff"));
  });

  it("shows the setup", async () => {
    const guildSettings = await settingsWith({ [Setting.AUTOROLES]: [MEMBER_ROLE_ID] });
    const { content } = await run(guildSettings, "show");
    expect(content).toContain(translate("en", "welcomeShowNoChannel"));
    expect(content).toContain(`<@&${MEMBER_ROLE_ID}>`);
  });
});

describe("welcome embeds", () => {
  const AVATAR = "https://cdn.discordapp.com/avatars/1/a.png";
  const withAvatar = (member) => ({ ...member, displayAvatarURL: () => AVATAR });

  it("checks embeds: drops empty parts, refuses bad variables and links, keeps the avatar switch", () => {
    expect(checkWelcomeEmbed({ title: " Hi {user} ", description: "", image: { url: "" }, color: null })).toEqual({ title: "Hi {user}" });
    expect(checkWelcomeEmbed({ title: "", color: 0xff0000 })).toBeNull();
    expect(checkWelcomeEmbed({ memberAvatar: true, thumbnail: { url: "https://example.com/a.png" } })).toEqual({ memberAvatar: true });
    expect(() => checkWelcomeEmbed({ title: "Level {level}" })).toThrow(InvalidMessage);
    expect(() => checkWelcomeEmbed({ fields: [{ name: "a", value: "{usr}" }] })).toThrow(/field 1 value/);
    expect(() => checkWelcomeEmbed({ title: "x", image: { url: "javascript:alert(1)" } })).toThrow(InvalidMessage);
    expect(() => checkWelcomeEmbed("nope")).toThrow(InvalidMessage);
  });

  it("fills in the member, uses the Branding colour and the avatar, and stays under Discord's limits", () => {
    const guild = fakeGuild();
    const member = withAvatar(fakeMember(guild));
    const saved = checkWelcomeEmbed({
      title: "Welcome {username}",
      description: "Hi {user}, you're #{members} in {server}",
      footer: { text: "{username} · {server}" },
      fields: [{ name: "Server", value: "{server}", inline: true }],
      memberAvatar: true,
    });
    expect(renderWelcomeEmbed(saved, { member, guild, color: 0x123456 })).toEqual({
      color: 0x123456,
      title: "Welcome Big\\_Rumbler",
      description: `Hi <@${USER_ID}>, you're #1,234 in Rumbleverse \\*Revival\\*`,
      footer: { text: "Big_Rumbler · Rumbleverse *Revival*" },
      fields: [{ name: "Server", value: "Rumbleverse \\*Revival\\*", inline: true }],
      thumbnail: { url: AVATAR },
    });
    expect(renderWelcomeEmbed({ description: "x", color: 0xabcdef }, { member, guild }).color).toBe(0xabcdef);
    expect(renderWelcomeEmbed({ description: "x" }, { member, guild }).color).toBe(BRAND_COLOR);
    const long = renderWelcomeEmbed({ title: "t".repeat(256), description: "{server}".repeat(500), footer: { text: "f".repeat(2048) } }, { member, guild });
    expect(long.title.length + long.description.length + long.footer.text.length).toBeLessThanOrEqual(6000);
  });

  it("sends only the server's own text with an embed, never the default line", async () => {
    const guild = fakeGuild();
    const member = fakeMember(guild);
    const guildSettings = await settingsWith({ [Setting.WELCOME_EMBED]: { title: "Hi {username}" } });
    expect(welcomePayload(guildSettings, guild, member, "welcome")).toEqual({ content: "", embeds: [expect.objectContaining({ title: "Hi Big\\_Rumbler" })] });
    await guildSettings.set(GUILD_ID, Setting.WELCOME_MESSAGE, "Hey {user}");
    expect(welcomePayload(guildSettings, guild, member, "welcome").content).toBe(`Hey <@${USER_ID}>`);
    expect(welcomePayload(guildSettings, guild, member, "leave").content).toBe(welcomeText(guildSettings, guild, member, "leave"));
    expect(welcomePayload(guildSettings, guild, member, "dm")).toBeNull();
  });

  it("posts the welcome embed and DMs an embed-only welcome DM", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({
      [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID,
      [Setting.WELCOME_MESSAGE]: "Welcome {user}!",
      [Setting.WELCOME_EMBED]: { title: "Welcome to {server}" },
      [Setting.WELCOME_DM_EMBED]: { description: "Read the rules" },
      [Setting.BRANDING]: { color: 0x00ff00 },
    });
    const member = fakeMember(guild);
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberJoined(member);
    expect(guild.channels.cache.get(WELCOME_CHANNEL_ID).send).toHaveBeenCalledWith({
      content: `Welcome <@${USER_ID}>!`,
      embeds: [{ color: 0x00ff00, title: "Welcome to Rumbleverse \\*Revival\\*" }],
      allowedMentions: { users: [USER_ID] },
    });
    expect(member.send).toHaveBeenCalledWith({ embeds: [{ color: 0x00ff00, description: "Read the rules" }], allowedMentions: { parse: [] } });
  });

  it("posts a leave embed", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({ [Setting.LEAVE_CHANNEL]: LEAVE_CHANNEL_ID, [Setting.LEAVE_EMBED]: { title: "Bye {username}", color: 1 } });
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberLeft(fakeMember(guild));
    expect(guild.channels.cache.get(LEAVE_CHANNEL_ID).send).toHaveBeenCalledWith({
      embeds: [{ color: 1, title: "Bye Big\\_Rumbler" }],
      allowedMentions: { users: [USER_ID] },
    });
  });

  describe("/welcome embed", () => {
    function embedInteraction(strings = {}, booleans = {}) {
      const guild = fakeGuild();
      return {
        locale: "en-US",
        guildId: GUILD_ID,
        guild,
        member: withAvatar(fakeMember(guild)),
        inCachedGuild: () => true,
        memberPermissions: { has: (bit) => bit === PermissionFlagsBits.ManageGuild },
        options: {
          getSubcommand: () => "embed",
          getString: (name) => strings[name] ?? null,
          getBoolean: (name) => booleans[name] ?? null,
        },
        reply: vi.fn(async () => {}),
      };
    }
    const run = async (guildSettings, strings, booleans) => {
      const interaction = embedInteraction(strings, booleans);
      const outcome = await createWelcomeCommand({ guildSettings }).execute(interaction);
      return { outcome, reply: interaction.reply.mock.calls[0]?.[0] };
    };

    it("saves the parts given, keeps the rest, and previews the embed", async () => {
      const guildSettings = new GuildSettings();
      const first = await run(guildSettings, { message: "welcome", title: "Hi {username}", colour: "#ff0000" }, { avatar: true });
      expect(first.outcome.status).toBe(Status.SUCCESS);
      expect(guildSettings.get(GUILD_ID, Setting.WELCOME_EMBED)).toEqual({ title: "Hi {username}", color: 0xff0000, memberAvatar: true });
      expect(first.reply.embeds).toEqual([{ color: 0xff0000, title: "Hi Big\\_Rumbler", thumbnail: { url: AVATAR } }]);
      expect(first.reply.content).toContain(translate("en", "welcomeEmbedTextNote"));
      expect(first.reply.flags).toBe(MessageFlags.Ephemeral);

      await run(guildSettings, { message: "welcome", description: "Line 1\\nLine 2", colour: "-" });
      expect(guildSettings.get(GUILD_ID, Setting.WELCOME_EMBED)).toEqual({ title: "Hi {username}", description: "Line 1\nLine 2", memberAvatar: true });
    });

    it("removes an embed, refuses an empty command, bad colours and bad variables", async () => {
      const guildSettings = await settingsWith({ [Setting.LEAVE_EMBED]: { title: "Bye" } });
      expect((await run(guildSettings, { message: "leave" })).outcome.key).toBe("welcomeEmbedNothing");
      expect((await run(guildSettings, { message: "leave", colour: "pink" })).outcome.key).toBe("embedBadColor");
      expect((await run(guildSettings, { message: "leave", title: "{level}" })).outcome.key).toBe("welcomeEmbedInvalid");
      expect(guildSettings.get(GUILD_ID, Setting.LEAVE_EMBED)).toEqual({ title: "Bye" });
      await run(guildSettings, { message: "leave", title: "-" });
      expect(guildSettings.get(GUILD_ID, Setting.LEAVE_EMBED)).toBeUndefined();
      await guildSettings.set(GUILD_ID, Setting.WELCOME_DM_EMBED, { title: "DM" });
      expect((await run(guildSettings, { message: "dm" }, { remove: true })).outcome.key).toBe("welcomeEmbedRemoved");
      expect(guildSettings.get(GUILD_ID, Setting.WELCOME_DM_EMBED)).toBeUndefined();
    });
  });
});

describe("member milestones", () => {
  const CELEBRATE = { channelId: WELCOME_CHANNEL_ID, every: 100, message: null };

  async function setup(count, saved = CELEBRATE) {
    const guild = fakeGuild();
    guild.memberCount = count;
    const guildSettings = await settingsWith(saved ? { [Setting.MILESTONES]: saved } : {});
    const store = new GrowthStore();
    const milestones = createMilestones({ guildSettings, store, logger: fakeLogger() });
    const join = async (memberCount, options) => {
      guild.memberCount = memberCount;
      await milestones.memberJoined(fakeMember(guild, options));
    };
    return { guild, store, join, send: guild.channels.cache.get(WELCOME_CHANNEL_ID).send };
  }

  it("works out when a count reaches a milestone", () => {
    expect(milestoneFor(1234, 100)).toBe(1200);
    expect(reachedMilestone(1200, 100, undefined)).toBe(true);
    expect(reachedMilestone(1234, 100, undefined)).toBe(false);
    expect(reachedMilestone(1300, 100, 1200)).toBe(true);
    expect(reachedMilestone(1250, 100, 1200)).toBe(false);
    expect(reachedMilestone(50, 100, undefined)).toBe(false);
  });

  it("posts each milestone once, thanking the member who reached it", async () => {
    const { store, join, send } = await setup(1234);
    await join(1250);
    expect(send).not.toHaveBeenCalled();
    expect(store.milestone(GUILD_ID)).toBe(1200);
    await join(1300);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.content).toContain("1,300");
    expect(message.content).toContain(`<@${USER_ID}>`);
    expect(message.allowedMentions).toEqual({ users: [USER_ID] });
    // Leaving and rejoining around it doesn't post it again; bots don't count.
    await join(1299);
    await join(1300);
    await join(1400, { bot: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does nothing when switched off", async () => {
    const { join, send, store } = await setup(99, null);
    await join(100);
    expect(send).not.toHaveBeenCalled();
    expect(store.milestone(GUILD_ID)).toBeUndefined();
  });

  it("checks what the dashboard sends", () => {
    expect(checkMilestones({ channelId: WELCOME_CHANNEL_ID, every: 500, message: "  Hi {user}  " })).toEqual({ channelId: WELCOME_CHANNEL_ID, every: 500, message: "Hi {user}" });
    expect(checkMilestones(null)).toBeNull();
    expect(() => checkMilestones({ channelId: WELCOME_CHANNEL_ID, every: 5 })).toThrow(InvalidMilestones);
    expect(() => checkMilestones({ channelId: "nope", every: 100 })).toThrow(InvalidMilestones);
    expect(() => checkMilestones({ channelId: WELCOME_CHANNEL_ID, every: 100 }, { channelOk: () => false })).toThrow(InvalidMilestones);
  });

});
