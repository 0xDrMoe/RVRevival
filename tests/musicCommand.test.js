import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createMusicCommands } from "../src/commands/music.js";
import { MusicError } from "../src/music/net.js";
import { MusicButton } from "../src/music/nowPlaying.js";
import { makeTrack, Source } from "../src/music/track.js";
import { Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD = "900000000000000001";
const DJ = "900000000000000050";

function fakeSettings(values = {}) {
  const saved = new Map(Object.entries(values));
  return { get: (guildId, key) => saved.get(key) ?? null, set: vi.fn(async (guildId, key, value) => saved.set(key, value)), saved };
}

// An active player shaped like music/player.js's.
function fakePlayer({ current = makeTrack({ title: "Song", source: Source.SOUNDCLOUD }), queue = [], listeners = 2 } = {}) {
  const members = new Map(Array.from({ length: listeners }, (_, index) => [`u${index}`, { user: { bot: false } }]));
  return {
    channelId: "vc",
    current: current && { ...current, requestedBy: "someone" },
    queue,
    paused: false,
    loop: "off",
    voiceChannel: { members },
    skip: vi.fn(() => true),
    destroy: vi.fn(),
    pause: vi.fn(function pause() {
      this.paused = true;
      return true;
    }),
    resume: vi.fn(() => true),
    setLoop: vi.fn(),
    setVolume: vi.fn(),
    nowPlaying: vi.fn(() => ({ content: "now playing" })),
    nowPlayingUpdated: vi.fn(),
    state() {
      return { guildId: GUILD, current: this.current, queue: this.queue, loop: this.loop, paused: this.paused, volume: 80, positionMs: 0 };
    },
    add: vi.fn((tracks) => tracks.length),
  };
}

function fakeInteraction({ command = "music", sub = null, options = {}, voiceChannelId = "vc", roles = [], permissions = [], customId = null, focused = "" } = {}) {
  const roleCache = new Map([[DJ, { id: DJ }]]);
  return {
    commandName: command,
    customId,
    guildId: GUILD,
    locale: "en-US",
    user: { id: "u0" },
    inCachedGuild: () => true,
    member: {
      voice: { channelId: voiceChannelId, channel: voiceChannelId ? { id: voiceChannelId, type: 2, joinable: true, permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak) } : null },
      roles: { cache: new Map(roles.map((id) => [id, { id }])) },
    },
    memberPermissions: new PermissionsBitField(permissions.reduce((bits, bit) => bits | bit, 0n)),
    guild: { id: GUILD, roles: { cache: roleCache }, members: { me: { id: "bot" } } },
    channel: { id: "tc" },
    message: { id: "m" },
    options: {
      getSubcommand: () => sub,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getAttachment: (name) => options[name] ?? null,
      getFocused: () => focused,
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async function reply() {
      this.replied = true;
    }),
    deferReply: vi.fn(async function deferReply() {
      this.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

const lastText = (interaction) => (interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1))[0].content;

function setup({ active = null, settings = {}, resolve } = {}) {
  const guildSettings = fakeSettings(settings);
  const joined = active ?? fakePlayer({ current: null });
  const music = {
    get: vi.fn(() => active),
    join: vi.fn(async () => joined),
    resolver: { resolve: resolve ?? vi.fn(async () => ({ tracks: [makeTrack({ title: "New song", source: Source.SOUNDCLOUD })], skipped: 0, name: null })), fileTrack: vi.fn() },
    radio: { search: vi.fn(async () => [{ id: "96062a7b-0601-11e8-ae97-52543be04c81", name: "Radio One", country: "UK", bitrate: 128 }]), byId: vi.fn() },
  };
  const commands = new Map(createMusicCommands({ guildSettings, logger: fakeLogger(), music }).map((command) => [command.name, command]));
  return { commands, music, guildSettings, joined };
}

describe("/play", () => {
  it("needs a voice channel and something to play", async () => {
    const { commands } = setup();
    const away = fakeInteraction({ command: "play", options: { query: "song" }, voiceChannelId: null });
    await commands.get("play").execute(away);
    expect(lastText(away)).toBe("Join a voice channel first.");
    const empty = fakeInteraction({ command: "play" });
    await commands.get("play").execute(empty);
    expect(lastText(empty)).toContain("Type a song name or link");
  });

  it("joins and plays", async () => {
    const { commands, music, joined } = setup();
    const interaction = fakeInteraction({ command: "play", options: { query: "new song" } });
    const outcome = await commands.get("play").execute(interaction);
    expect(music.resolver.resolve).toHaveBeenCalledWith("new song", { limit: 100 });
    expect(music.join).toHaveBeenCalledWith(expect.objectContaining({ textChannel: interaction.channel }));
    expect(joined.add).toHaveBeenCalledWith([expect.objectContaining({ title: "New song" })], { next: false, requestedBy: "u0" });
    expect(lastText(interaction)).toBe("▶️ Playing **New song**.");
    expect(outcome.status).toBe("success");
  });

  it("explains links it can't play", async () => {
    const { commands, music } = setup({ resolve: vi.fn(async () => Promise.reject(new MusicError("youtube"))) });
    const interaction = fakeInteraction({ command: "play", options: { query: "https://youtu.be/x" } });
    const outcome = await commands.get("play").execute(interaction);
    expect(lastText(interaction)).toContain("YouTube doesn't allow other apps");
    expect(music.join).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
  });

  it("stays in the channel it's playing in", async () => {
    const { commands } = setup({ active: fakePlayer() });
    const interaction = fakeInteraction({ command: "play", options: { query: "song" }, voiceChannelId: "other" });
    await commands.get("play").execute(interaction);
    expect(lastText(interaction)).toBe("You need to be in <#vc> with me to do that.");
  });
});

describe("/radio", () => {
  it("suggests stations as people type", async () => {
    const { commands } = setup();
    const interaction = fakeInteraction({ command: "radio", focused: "radio one" });
    await commands.get("radio").autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "Radio One · UK · 128 kbps", value: "96062a7b-0601-11e8-ae97-52543be04c81" }]);
  });
});

describe("/music", () => {
  it("keeps control with the DJ role while others listen", async () => {
    const active = fakePlayer();
    const { commands } = setup({ active, settings: { [Setting.MUSIC]: { djRoleId: DJ } } });
    const member = fakeInteraction({ sub: "skip" });
    await commands.get("music").execute(member);
    expect(lastText(member)).toContain(`Only <@&${DJ}> can do that`);
    expect(active.skip).not.toHaveBeenCalled();

    const dj = fakeInteraction({ sub: "skip", roles: [DJ] });
    await commands.get("music").execute(dj);
    expect(active.skip).toHaveBeenCalled();
    expect(lastText(dj)).toBe("⏭️ <@u0> skipped **Song**.");
    expect(dj.reply.mock.calls[0][0].flags).toBeUndefined();
  });

  it("lets people skip their own song and do anything when alone", async () => {
    const own = fakePlayer();
    own.current.requestedBy = "u0";
    const { commands } = setup({ active: own, settings: { [Setting.MUSIC]: { djRoleId: DJ } } });
    await commands.get("music").execute(fakeInteraction({ sub: "skip" }));
    expect(own.skip).toHaveBeenCalled();

    const alone = fakePlayer({ listeners: 1 });
    const second = setup({ active: alone, settings: { [Setting.MUSIC]: { djRoleId: DJ } } });
    await second.commands.get("music").execute(fakeInteraction({ sub: "stop" }));
    expect(alone.destroy).toHaveBeenCalled();
  });

  it("needs the member in the bot's channel", async () => {
    const { commands } = setup({ active: fakePlayer() });
    const interaction = fakeInteraction({ sub: "pause", voiceChannelId: null });
    await commands.get("music").execute(interaction);
    expect(lastText(interaction)).toBe("You need to be in <#vc> with me to do that.");
  });

  it("says when nothing is playing", async () => {
    const { commands } = setup();
    const interaction = fakeInteraction({ sub: "queue" });
    await commands.get("music").execute(interaction);
    expect(lastText(interaction)).toContain("Nothing is playing");
  });

  it("saves settings for Manage Server only", async () => {
    const { commands, guildSettings } = setup();
    const member = fakeInteraction({ sub: "settings", options: { volume: 50 } });
    await commands.get("music").execute(member);
    expect(guildSettings.set).not.toHaveBeenCalled();

    const admin = fakeInteraction({ sub: "settings", options: { "dj-role": { id: DJ }, volume: 50 }, permissions: [PermissionFlagsBits.ManageGuild] });
    await commands.get("music").execute(admin);
    expect(guildSettings.set).toHaveBeenCalledWith(GUILD, Setting.MUSIC, { djRoleId: DJ, defaultVolume: 50, maxQueue: 200, announce: true, leaveAfterMinutes: 3 });
    expect(lastText(admin)).toContain(`DJ role: <@&${DJ}>`);

    const reset = fakeInteraction({ sub: "settings", options: { "no-dj-role": true, volume: 80 }, permissions: [PermissionFlagsBits.ManageGuild] });
    await commands.get("music").execute(reset);
    expect(guildSettings.set).toHaveBeenLastCalledWith(GUILD, Setting.MUSIC, null);
  });
});

describe("Now playing buttons", () => {
  it("pauses in place and shows the queue privately", async () => {
    const active = fakePlayer();
    const { commands } = setup({ active });
    const handle = commands.get("play").components[MusicButton.TOGGLE].handle;
    const toggle = fakeInteraction({ customId: MusicButton.TOGGLE });
    await handle(toggle);
    expect(active.pause).toHaveBeenCalled();
    expect(toggle.update).toHaveBeenCalledWith({ content: "now playing" });
    expect(active.nowPlayingUpdated).toHaveBeenCalledWith(toggle.message);

    const queue = fakeInteraction({ customId: MusicButton.QUEUE, voiceChannelId: null });
    await handle(queue);
    expect(queue.reply.mock.calls[0][0].flags).toBeDefined();
  });

  it("clears the buttons when nothing is playing any more", async () => {
    const { commands } = setup();
    const interaction = fakeInteraction({ customId: MusicButton.SKIP });
    await commands.get("play").components[MusicButton.SKIP].handle(interaction);
    expect(interaction.update).toHaveBeenCalledWith({ components: [] });
  });
});
