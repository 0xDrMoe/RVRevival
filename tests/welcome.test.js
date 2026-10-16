import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildWelcomeCommandData, createWelcomeCommand } from "../src/commands/welcome.js";
import { createWelcomer, renderTemplate, welcomeText } from "../src/community/welcome.js";
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

function fakeGuild({ canManageRoles = true } = {}) {
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

  it("does nothing for bots", async () => {
    const guild = fakeGuild();
    const guildSettings = await settingsWith({ [Setting.WELCOME_CHANNEL]: WELCOME_CHANNEL_ID, [Setting.AUTOROLES]: [MEMBER_ROLE_ID] });
    const member = fakeMember(guild, { bot: true });
    await createWelcomer({ guildSettings, logger: fakeLogger() }).memberJoined(member);
    expect(guild.channels.cache.get(WELCOME_CHANNEL_ID).send).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
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
  function fakeInteraction(subcommand, { text, role, what, canPost = true, manageGuild = true } = {}) {
    const guild = fakeGuild();
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
      "autorole",
      "off",
      "test",
      "show",
    ]);
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
    expect((await run(guildSettings, "autorole", { role: { ...role, managed: true } })).outcome.key).toBe("welcomeAutoroleInvalid");
    expect((await run(guildSettings, "autorole", { role: { ...role, id: GUILD_ID } })).outcome.key).toBe("welcomeAutoroleInvalid");
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
