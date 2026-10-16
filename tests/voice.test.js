import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildVoiceCommandData, createVoiceCommand } from "../src/commands/voice.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { channelName, createTempVoice, MAX_TEMP_CHANNELS, OWNER_PERMISSIONS } from "../src/voice/tempVoice.js";
import { TempVoiceStore } from "../src/voice/tempVoiceStore.js";

const GUILD_ID = "900000000000000001";
const HUB_ID = "800000000000000001";
const CATEGORY_ID = "800000000000000002";
const OWNER_ID = "300000000000000001";
const OTHER_ID = "300000000000000002";
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
const allPermissions = new PermissionsBitField(PermissionsBitField.All);

// A fake guild whose channels.create makes channels the test can join and leave.
function fakeGuild({ botCanManage = true } = {}) {
  const channels = new Map();
  const guild = {
    id: GUILD_ID,
    members: { me: { id: "bot" } },
    channels: {
      cache: channels,
      create: vi.fn(async (options) => {
        const channel = fakeVoiceChannel(`70000000000000${String(channels.size).padStart(4, "0")}`, guild, options);
        channels.set(channel.id, channel);
        return channel;
      }),
    },
  };
  const permissionsFor = () => (botCanManage ? allPermissions : new PermissionsBitField());
  const category = {
    id: CATEGORY_ID,
    type: ChannelType.GuildCategory,
    permissionsFor,
    permissionOverwrites: { cache: new Map([[GUILD_ID, { id: GUILD_ID, type: 0, allow: { bitfield: 0n }, deny: { bitfield: 1n } }]]) },
  };
  const hub = { id: HUB_ID, type: ChannelType.GuildVoice, parentId: CATEGORY_ID, permissionsFor, members: new Map() };
  channels.set(CATEGORY_ID, category);
  channels.set(HUB_ID, hub);
  return guild;
}

function fakeVoiceChannel(id, guild, options = {}) {
  const overwrites = new Map();
  return {
    id,
    guild,
    name: options.name,
    parentId: options.parent,
    members: new Map(),
    delete: vi.fn(async () => guild.channels.cache.delete(id)),
    permissionOverwrites: {
      cache: overwrites,
      edit: vi.fn(async (target, changes) => overwrites.set(target, { ...(overwrites.get(target) ?? {}), ...changes })),
      delete: vi.fn(async (target) => overwrites.delete(target)),
    },
  };
}

function fakeMember(guild, id, { failMove = false } = {}) {
  const member = { id, guild, displayName: `Member ${id.slice(-1)}`, user: { id, username: `user${id.slice(-1)}`, bot: false } };
  member.voice = {
    channel: null,
    setChannel: vi.fn(async (channel) => {
      if (failMove) {
        throw Object.assign(new Error("Target user is not connected to voice."), { code: 40032 });
      }
      join(member, channel);
    }),
  };
  return member;
}

function join(member, channel) {
  member.voice.channel?.members.delete(member.id);
  member.voice.channel = channel;
  channel?.members.set(member.id, member);
}

const state = (guild, member, channel) => ({ guild, member, channelId: channel?.id ?? null, channel: channel ?? null });

function setup({ settings = { hubChannelId: HUB_ID, categoryId: null, nameTemplate: "🔊 {name}", userLimit: 0 }, ...guildOptions } = {}) {
  const guild = fakeGuild(guildOptions);
  const guildSettings = new GuildSettings();
  if (settings) {
    guildSettings.set(GUILD_ID, Setting.TEMP_VOICE, settings);
  }
  const store = new TempVoiceStore();
  const tempVoice = createTempVoice({ guildSettings, store, logger, now: () => 1000 });
  // Moves a member and tells tempVoice, like Discord's voice state update.
  const move = async (member, channel) => {
    const old = state(guild, member, member.voice.channel);
    join(member, channel);
    await tempVoice.voiceStateUpdate(old, state(guild, member, channel));
  };
  return { guild, guildSettings, store, tempVoice, move };
}

describe("TempVoiceStore", () => {
  it("adds, finds, reassigns and removes channels", () => {
    const store = new TempVoiceStore();
    store.add({ channelId: "1", guildId: GUILD_ID, ownerId: OWNER_ID, createdAt: 5 });
    store.add({ channelId: "2", guildId: "other", ownerId: OWNER_ID, createdAt: 6 });
    expect(store.get("1")).toEqual({ channelId: "1", guildId: GUILD_ID, ownerId: OWNER_ID, createdAt: 5 });
    expect(store.byOwner(GUILD_ID, OWNER_ID).map((row) => row.channelId)).toEqual(["1"]);
    expect(store.count(GUILD_ID)).toBe(1);
    store.setOwner("1", OTHER_ID);
    expect(store.get("1").ownerId).toBe(OTHER_ID);
    store.remove("1");
    expect(store.get("1")).toBeUndefined();
    expect(store.all().map((row) => row.channelId)).toEqual(["2"]);
  });
});

describe("channelName", () => {
  it("fills in the member's names and stays within 100 characters", () => {
    const member = { displayName: "Rumbler", user: { username: "rumbler99" } };
    expect(channelName("🔊 {name}", member)).toBe("🔊 Rumbler");
    expect(channelName("{username}'s room", member)).toBe("rumbler99's room");
    expect(channelName("", member)).toBe("🔊 Rumbler");
    expect(channelName("x".repeat(80) + "{name}{name}{name}", member)).toHaveLength(100);
  });
});

describe("join-to-create", () => {
  it("makes a channel for whoever joins the hub, moves them in and deletes it once empty", async () => {
    const { guild, store, move } = setup();
    const owner = fakeMember(guild, OWNER_ID);
    await move(owner, guild.channels.cache.get(HUB_ID));

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "🔊 Member 1", type: ChannelType.GuildVoice, parent: CATEGORY_ID, userLimit: 0 }),
    );
    const channel = owner.voice.channel;
    expect(channel.id).not.toBe(HUB_ID);
    // The category's permissions are copied, plus the owner's.
    expect(guild.channels.create.mock.calls[0][0].permissionOverwrites.map((overwrite) => overwrite.id)).toEqual([GUILD_ID]);
    expect(channel.permissionOverwrites.cache.get(OWNER_ID)).toEqual(OWNER_PERMISSIONS);
    expect(store.get(channel.id)).toMatchObject({ ownerId: OWNER_ID, guildId: GUILD_ID });

    const friend = fakeMember(guild, OTHER_ID);
    await move(friend, channel);
    await move(owner, null);
    expect(channel.delete).not.toHaveBeenCalled();

    await move(friend, null);
    expect(channel.delete).toHaveBeenCalled();
    expect(store.get(channel.id)).toBeUndefined();
  });

  it("moves someone who already has a channel back into it instead of making another", async () => {
    const { guild, move } = setup();
    const owner = fakeMember(guild, OWNER_ID);
    const friend = fakeMember(guild, OTHER_ID);
    await move(owner, guild.channels.cache.get(HUB_ID));
    const channel = owner.voice.channel;
    await move(friend, channel);

    await move(owner, guild.channels.cache.get(HUB_ID));
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(owner.voice.channel).toBe(channel);
  });

  it("deletes the new channel when the member left before they could be moved", async () => {
    const { guild, store, tempVoice } = setup();
    const owner = fakeMember(guild, OWNER_ID, { failMove: true });
    await tempVoice.voiceStateUpdate(state(guild, owner, null), state(guild, owner, guild.channels.cache.get(HUB_ID)));
    const created = await guild.channels.create.mock.results[0].value;
    expect(created.delete).toHaveBeenCalled();
    expect(store.count(GUILD_ID)).toBe(0);
  });

  it("does nothing when it's off, the bot lacks permissions or the server has too many channels", async () => {
    const off = setup({ settings: null });
    await off.move(fakeMember(off.guild, OWNER_ID), off.guild.channels.cache.get(HUB_ID));
    expect(off.guild.channels.create).not.toHaveBeenCalled();

    const weak = setup({ botCanManage: false });
    await weak.move(fakeMember(weak.guild, OWNER_ID), weak.guild.channels.cache.get(HUB_ID));
    expect(weak.guild.channels.create).not.toHaveBeenCalled();

    const full = setup();
    for (let i = 0; i < MAX_TEMP_CHANNELS; i++) {
      full.store.add({ channelId: `c${i}`, guildId: GUILD_ID, ownerId: `o${i}` });
    }
    await full.move(fakeMember(full.guild, OWNER_ID), full.guild.channels.cache.get(HUB_ID));
    expect(full.guild.channels.create).not.toHaveBeenCalled();
  });

  it("ignores bots joining the hub", async () => {
    const { guild, move } = setup();
    const bot = fakeMember(guild, OWNER_ID);
    bot.user.bot = true;
    await move(bot, guild.channels.cache.get(HUB_ID));
    expect(guild.channels.create).not.toHaveBeenCalled();
  });

  it("cleans up after a restart: forgets missing channels and deletes empty ones", async () => {
    const { guild, store, tempVoice } = setup();
    const empty = fakeVoiceChannel("71", guild);
    const busy = fakeVoiceChannel("72", guild);
    busy.members.set(OWNER_ID, {});
    guild.channels.cache.set(empty.id, empty);
    guild.channels.cache.set(busy.id, busy);
    store.add({ channelId: "71", guildId: GUILD_ID, ownerId: OWNER_ID });
    store.add({ channelId: "72", guildId: GUILD_ID, ownerId: OTHER_ID });
    store.add({ channelId: "73", guildId: GUILD_ID, ownerId: "x" });

    await tempVoice.sweep({ guilds: { cache: new Map([[GUILD_ID, guild]]) } });
    expect(empty.delete).toHaveBeenCalled();
    expect(busy.delete).not.toHaveBeenCalled();
    expect(store.all().map((row) => row.channelId)).toEqual(["72"]);
  });
});

describe("/voice", () => {
  function interactionFor({ member, subcommand, options = {}, permissions = [], guild }) {
    const granted = new PermissionsBitField(permissions);
    return {
      guild,
      guildId: GUILD_ID,
      user: { id: member.id },
      member,
      locale: "en-US",
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => granted.has(bit) },
      options: {
        getSubcommand: () => subcommand,
        getChannel: (name) => options[name] ?? null,
        getString: (name) => options[name] ?? null,
        getInteger: (name) => options[name] ?? null,
      },
      reply: vi.fn(async () => {}),
    };
  }

  it("builds a command with setup, off, lock, unlock and claim", () => {
    const data = buildVoiceCommandData();
    expect(data.name).toBe("voice");
    expect(data.options.map((option) => option.name)).toEqual(["setup", "off", "lock", "unlock", "claim"]);
  });

  it("needs Manage Server to set it up or turn it off", async () => {
    const { guild, guildSettings, store } = setup({ settings: null });
    const command = createVoiceCommand({ guildSettings, store });
    const member = fakeMember(guild, OWNER_ID);
    const hub = guild.channels.cache.get(HUB_ID);

    const refused = await command.execute(interactionFor({ guild, member, subcommand: "setup", options: { hub } }));
    expect(refused.status).toBe(Status.REFUSED);
    expect(guildSettings.get(GUILD_ID, Setting.TEMP_VOICE)).toBeUndefined();

    const done = await command.execute(
      interactionFor({ guild, member, subcommand: "setup", options: { hub, limit: 4 }, permissions: [PermissionFlagsBits.ManageGuild] }),
    );
    expect(done.status).toBe(Status.SUCCESS);
    expect(guildSettings.get(GUILD_ID, Setting.TEMP_VOICE)).toEqual({ hubChannelId: HUB_ID, categoryId: null, nameTemplate: "🔊 {name}", userLimit: 4 });

    const off = await command.execute(interactionFor({ guild, member, subcommand: "off", permissions: [PermissionFlagsBits.ManageGuild] }));
    expect(off.status).toBe(Status.SUCCESS);
    expect(guildSettings.get(GUILD_ID, Setting.TEMP_VOICE)).toBeUndefined();
  });

  it("refuses setup when the bot can't manage channels there", async () => {
    const { guild, guildSettings, store } = setup({ settings: null, botCanManage: false });
    const command = createVoiceCommand({ guildSettings, store });
    const outcome = await command.execute(
      interactionFor({
        guild,
        member: fakeMember(guild, OWNER_ID),
        subcommand: "setup",
        options: { hub: guild.channels.cache.get(HUB_ID) },
        permissions: [PermissionFlagsBits.ManageGuild],
      }),
    );
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "voiceBotMissingPermission" });
  });

  it("lets only the owner lock and unlock, keeping the people already inside", async () => {
    const { guild, guildSettings, store, move } = setup();
    const command = createVoiceCommand({ guildSettings, store });
    const owner = fakeMember(guild, OWNER_ID);
    const friend = fakeMember(guild, OTHER_ID);
    await move(owner, guild.channels.cache.get(HUB_ID));
    const channel = owner.voice.channel;
    await move(friend, channel);

    const notOwner = await command.execute(interactionFor({ guild, member: friend, subcommand: "lock" }));
    expect(notOwner).toMatchObject({ status: Status.REFUSED, key: "voiceNotOwner" });

    const locked = await command.execute(interactionFor({ guild, member: owner, subcommand: "lock" }));
    expect(locked.status).toBe(Status.SUCCESS);
    expect(channel.permissionOverwrites.cache.get(GUILD_ID)).toEqual({ Connect: false });
    expect(channel.permissionOverwrites.cache.get(OTHER_ID)).toEqual({ Connect: true });

    await command.execute(interactionFor({ guild, member: owner, subcommand: "unlock" }));
    expect(channel.permissionOverwrites.cache.get(GUILD_ID)).toEqual({ Connect: null });
  });

  it("refuses lock outside a join-to-create channel", async () => {
    const { guild, guildSettings, store } = setup();
    const command = createVoiceCommand({ guildSettings, store });
    const outcome = await command.execute(interactionFor({ guild, member: fakeMember(guild, OWNER_ID), subcommand: "lock" }));
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "voiceNotInTempChannel" });
  });

  it("lets someone claim a channel only once its owner has left", async () => {
    const { guild, guildSettings, store, move } = setup();
    const command = createVoiceCommand({ guildSettings, store });
    const owner = fakeMember(guild, OWNER_ID);
    const friend = fakeMember(guild, OTHER_ID);
    await move(owner, guild.channels.cache.get(HUB_ID));
    const channel = owner.voice.channel;
    await move(friend, channel);

    const early = await command.execute(interactionFor({ guild, member: friend, subcommand: "claim" }));
    expect(early).toMatchObject({ status: Status.REFUSED, key: "voiceOwnerStillHere" });

    await move(owner, null);
    const claimed = await command.execute(interactionFor({ guild, member: friend, subcommand: "claim" }));
    expect(claimed.status).toBe(Status.SUCCESS);
    expect(store.get(channel.id).ownerId).toBe(OTHER_ID);
    expect(channel.permissionOverwrites.cache.has(OWNER_ID)).toBe(false);
    expect(channel.permissionOverwrites.cache.get(OTHER_ID)).toEqual(OWNER_PERMISSIONS);

    const again = await command.execute(interactionFor({ guild, member: friend, subcommand: "claim" }));
    expect(again).toMatchObject({ status: Status.REFUSED, key: "voiceAlreadyOwner" });
  });
});
