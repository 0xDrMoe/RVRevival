import { PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelToolCommands, isLocked, MAX_SLOWMODE_SECONDS } from "../src/commands/channelTools.js";
import { createMemberToolCommands, roleProblem } from "../src/commands/memberTools.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { discordError } from "./helpers/fakes.js";
import { GUILD_ID, MOD_ID, OWNER_ID, STAFF_ROLE_ID, TARGET_ID, fakeGuild, fakeMember } from "./helpers/moderationFakes.js";

const CHANNEL_ID = "800000000000000001";
const ROLE_ID = "700000000000000005";

// A text channel whose @everyone overwrite can be edited.
function fakeChannel() {
  const deny = new Set();
  const channel = {
    id: CHANNEL_ID,
    send: vi.fn(async () => {}),
    setRateLimitPerUser: vi.fn(async () => {}),
    permissionOverwrites: {
      cache: new Map([[GUILD_ID, { deny: { has: (bit) => deny.has(bit) } }]]),
      edit: vi.fn(async (_id, changes) => {
        if (changes.SendMessages === false) {
          deny.add(PermissionFlagsBits.SendMessages);
        } else {
          deny.delete(PermissionFlagsBits.SendMessages);
        }
      }),
    },
  };
  return channel;
}

function fakeInteraction(guild, { subcommand, channel, options = {}, target, role, permissions = [], roleIds = [], moderator } = {}) {
  const member = moderator ?? fakeMember(MOD_ID, { position: 10, roleIds });
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    guild,
    channel,
    user: member.user,
    member,
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => null,
      getString: (name) => options[name] ?? null,
      getMember: () => target ?? null,
      getUser: () => target?.user,
      getRole: () => role,
    },
    reply: vi.fn(async () => {}),
  };
}

const answerOf = (interaction) => interaction.reply.mock.calls.at(-1)[0].content;

describe("/lock, /unlock and /slowmode", () => {
  let guild;
  let channel;
  let modLog;
  let commands;
  const MANAGE_CHANNELS = [PermissionFlagsBits.ManageChannels];

  beforeEach(() => {
    guild = fakeGuild();
    channel = fakeChannel();
    modLog = { post: vi.fn(async () => {}) };
    commands = new Map(
      createChannelToolCommands({ guildSettings: new GuildSettings(), modLog }).map((command) => [command.name, command]),
    );
  });

  it("locks the channel, posting the notice first, and refuses to lock it twice", async () => {
    const lock = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS, options: { reason: "raid" } });
    expect(await commands.get("lock").execute(lock)).toMatchObject({ status: Status.SUCCESS, key: "lockDone" });
    expect(channel.permissionOverwrites.edit).toHaveBeenCalledWith(
      GUILD_ID,
      { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false },
      { reason: "raid (by user-10)" },
    );
    expect(channel.send.mock.invocationCallOrder[0]).toBeLessThan(channel.permissionOverwrites.edit.mock.invocationCallOrder[0]);
    expect(isLocked(channel, GUILD_ID)).toBe(true);
    expect(modLog.post).toHaveBeenCalledTimes(1);

    const again = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS });
    expect(await commands.get("lock").execute(again)).toMatchObject({ status: Status.REFUSED, key: "lockAlready" });
  });

  it("unlocks a locked channel, resetting the permissions", async () => {
    const notLocked = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS });
    expect(await commands.get("unlock").execute(notLocked)).toMatchObject({ key: "unlockNotLocked" });

    await commands.get("lock").execute(fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS }));
    const unlock = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS });
    expect(await commands.get("unlock").execute(unlock)).toMatchObject({ status: Status.SUCCESS, key: "unlockDone" });
    expect(channel.permissionOverwrites.edit).toHaveBeenLastCalledWith(
      GUILD_ID,
      { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null },
      expect.anything(),
    );
    expect(isLocked(channel, GUILD_ID)).toBe(false);
  });

  it("reports a missing bot permission", async () => {
    channel.permissionOverwrites.edit.mockRejectedValue(discordError(50013));
    const lock = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS });
    expect(await commands.get("lock").execute(lock)).toMatchObject({ status: Status.FAILED, key: "lockBotMissingPermission" });
  });

  it("refuses members without Manage Channels or the mod role", async () => {
    const lock = fakeInteraction(guild, { channel });
    expect(await commands.get("lock").execute(lock)).toMatchObject({ status: Status.REFUSED, key: "modNoPermission" });
    expect(answerOf(lock)).toContain("Manage Channels");
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
  });

  it("sets and turns off slowmode, within Discord's limit", async () => {
    const set = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS, options: { duration: "30s" } });
    expect(await commands.get("slowmode").execute(set)).toMatchObject({ status: Status.SUCCESS, key: "slowmodeSet" });
    expect(channel.setRateLimitPerUser).toHaveBeenLastCalledWith(30, expect.any(String));

    const off = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS, options: { duration: "Off" } });
    expect(await commands.get("slowmode").execute(off)).toMatchObject({ key: "slowmodeOff" });
    expect(channel.setRateLimitPerUser).toHaveBeenLastCalledWith(0, expect.any(String));

    for (const duration of ["7h", "soon"]) {
      const bad = fakeInteraction(guild, { channel, permissions: MANAGE_CHANNELS, options: { duration } });
      expect(await commands.get("slowmode").execute(bad)).toMatchObject({ status: Status.REFUSED, key: "modInvalidDuration" });
    }
    expect(channel.setRateLimitPerUser).toHaveBeenCalledTimes(2);
    expect(MAX_SLOWMODE_SECONDS).toBe(21_600);
  });
});

describe("/role and /nick", () => {
  let guild;
  let guildSettings;
  let modLog;
  let commands;
  const MANAGE_ROLES = [PermissionFlagsBits.ManageRoles];
  const role = (overrides = {}) => ({ id: ROLE_ID, position: 5, managed: false, ...overrides });

  // A member whose roles and nickname can be changed.
  const target = (options = {}) => {
    const member = fakeMember(TARGET_ID, { position: 2, ...options });
    member.roles.add = vi.fn(async () => {});
    member.roles.remove = vi.fn(async () => {});
    member.nickname = null;
    member.setNickname = vi.fn(async () => {});
    return member;
  };

  beforeEach(() => {
    guild = fakeGuild();
    guildSettings = new GuildSettings();
    modLog = { post: vi.fn(async () => {}) };
    commands = new Map(createMemberToolCommands({ guildSettings, modLog }).map((command) => [command.name, command]));
  });

  it("gives and takes a role", async () => {
    const member = target();
    const add = fakeInteraction(guild, { subcommand: "add", target: member, role: role(), permissions: MANAGE_ROLES });
    expect(await commands.get("role").execute(add)).toMatchObject({ status: Status.SUCCESS, key: "roleAdded" });
    expect(member.roles.add).toHaveBeenCalledWith(ROLE_ID, "No reason given (by user-10)");
    expect(modLog.post).toHaveBeenCalledTimes(1);

    const holder = target({ roleIds: [ROLE_ID] });
    const remove = fakeInteraction(guild, { subcommand: "remove", target: holder, role: role(), permissions: MANAGE_ROLES });
    expect(await commands.get("role").execute(remove)).toMatchObject({ status: Status.SUCCESS, key: "roleRemoved" });
    expect(holder.roles.remove).toHaveBeenCalled();
  });

  it("refuses roles the member already has, or doesn't have", async () => {
    const holder = target({ roleIds: [ROLE_ID] });
    const add = fakeInteraction(guild, { subcommand: "add", target: holder, role: role(), permissions: MANAGE_ROLES });
    expect(await commands.get("role").execute(add)).toMatchObject({ key: "roleAlreadyHas" });
    const remove = fakeInteraction(guild, { subcommand: "remove", target: target(), role: role(), permissions: MANAGE_ROLES });
    expect(await commands.get("role").execute(remove)).toMatchObject({ key: "roleNotHas" });
  });

  it("lets moderators give themselves a role below their own", async () => {
    const moderator = target();
    moderator.id = MOD_ID;
    const interaction = fakeInteraction(guild, {
      subcommand: "add",
      target: moderator,
      moderator: fakeMember(MOD_ID, { position: 10 }),
      role: role(),
      permissions: MANAGE_ROLES,
    });
    expect(await commands.get("role").execute(interaction)).toMatchObject({ status: Status.SUCCESS });
  });

  it("refuses roles at or above the moderator or the bot, managed roles and @everyone", () => {
    const moderator = fakeMember(MOD_ID, { position: 10 });
    const bot = fakeMember("1", { position: 20 });
    const check = (overrides, by = moderator) => roleProblem({ role: role(overrides), moderator: by, bot, guild });
    expect(check({})).toBeUndefined();
    expect(check({ id: GUILD_ID })).toBe("roleEveryone");
    expect(check({ managed: true })).toBe("roleManaged");
    expect(check({ position: 10 })).toBe("roleAboveYou");
    expect(check({ position: 25 }, fakeMember(OWNER_ID, { position: 1 }))).toBe("roleAboveBot");
  });

  it("lets the mod role use /role without Manage Roles", async () => {
    await guildSettings.set(GUILD_ID, Setting.MOD_ROLE, STAFF_ROLE_ID);
    const member = target();
    const interaction = fakeInteraction(guild, { subcommand: "add", target: member, role: role(), roleIds: [STAFF_ROLE_ID] });
    expect(await commands.get("role").execute(interaction)).toMatchObject({ status: Status.SUCCESS });
  });

  it("sets and resets a nickname", async () => {
    const member = target();
    const set = fakeInteraction(guild, {
      target: member,
      options: { nickname: " Rumbler " },
      permissions: [PermissionFlagsBits.ManageNicknames],
    });
    expect(await commands.get("nick").execute(set)).toMatchObject({ status: Status.SUCCESS, key: "nickSet" });
    expect(member.setNickname).toHaveBeenCalledWith("Rumbler", expect.any(String));

    const reset = fakeInteraction(guild, { target: member, permissions: [PermissionFlagsBits.ManageNicknames] });
    expect(await commands.get("nick").execute(reset)).toMatchObject({ key: "nickReset" });
    expect(member.setNickname).toHaveBeenLastCalledWith(null, expect.any(String));
  });

  it("refuses renaming someone at or above the moderator", async () => {
    const member = target({ position: 10 });
    const interaction = fakeInteraction(guild, { target: member, permissions: [PermissionFlagsBits.ManageNicknames] });
    expect(await commands.get("nick").execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "modTargetHigher" });
    expect(member.setNickname).not.toHaveBeenCalled();
  });
});
