import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createMusicCommands } from "../src/commands/music.js";
import { MusicError } from "../src/music/net.js";
import { MusicButton, SEARCH_PREFIX } from "../src/music/nowPlaying.js";
import { PlaylistStore } from "../src/music/playlistStore.js";
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
    voteSkip: vi.fn(() => ({ votes: 1, needed: 2, skipped: false })),
    setFilter: vi.fn(),
    forward: vi.fn((ms) => 30_000 + ms),
    seek: vi.fn(() => true),
    positionMs: 30_000,
  };
}

function fakeInteraction({ command = "music", sub = null, options = {}, voiceChannelId = "vc", roles = [], permissions = [], customId = null, focused = "" } = {}) {
  const roleCache = new Map([[DJ, { id: DJ }]]);
  return {
    commandName: command,
    customId,
    guildId: GUILD,
    locale: "en-US",
    user: { id: "u0", send: vi.fn(async () => {}) },
    inCachedGuild: () => true,
    member: {
      voice: { channelId: voiceChannelId, channel: voiceChannelId ? { id: voiceChannelId, type: 2, joinable: true, permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak) } : null },
      roles: { cache: new Map(roles.map((id) => [id, { id }])) },
    },
    memberPermissions: new PermissionsBitField(permissions.reduce((bits, bit) => bits | bit, 0n)),
    guild: { id: GUILD, name: "Test server", roles: { cache: roleCache }, members: { me: { id: "bot" } } },
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
    update: vi.fn(async function update() {
      this.replied = true;
    }),
    followUp: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

const lastText = (interaction) => (interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1))[0].content;

function setup({ active = null, settings = {}, resolve, search, lyrics, dm } = {}) {
  const guildSettings = fakeSettings(settings);
  const joined = active ?? fakePlayer({ current: null });
  const music = {
    get: vi.fn(() => active),
    join: vi.fn(async () => joined),
    resolver: {
      resolve: resolve ?? vi.fn(async () => ({ tracks: [makeTrack({ title: "New song", source: Source.SOUNDCLOUD, stream: { id: 1 } })], skipped: 0, name: null })),
      search: search ?? vi.fn(async () => [1, 2, 3, 4, 5].map((n) => makeTrack({ title: `Result ${n}`, source: Source.SOUNDCLOUD, stream: { id: n } }))),
      fileTrack: vi.fn(),
    },
    radio: { search: vi.fn(async () => [{ id: "96062a7b-0601-11e8-ae97-52543be04c81", name: "Radio One", country: "UK", bitrate: 128 }]), byId: vi.fn() },
  };
  const playlists = new PlaylistStore();
  const commands = new Map(createMusicCommands({ guildSettings, logger: fakeLogger(), music, playlists, lyrics, dm }).map((command) => [command.name, command]));
  return { commands, music, guildSettings, joined, playlists };
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
    const { commands } = setup({ active, settings: { [Setting.MUSIC]: { djRoleId: DJ, voteSkipPercent: 0 } } });
    const member = fakeInteraction({ sub: "skip" });
    await commands.get("music").execute(member);
    expect(lastText(member)).toContain(`Only <@&${DJ}> can do that`);
    expect(active.skip).not.toHaveBeenCalled();
    const pause = fakeInteraction({ sub: "pause" });
    await commands.get("music").execute(pause);
    expect(active.pause).not.toHaveBeenCalled();

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
    const interaction = fakeInteraction({ command: "queue", sub: "view" });
    await commands.get("queue").execute(interaction);
    expect(lastText(interaction)).toContain("Nothing is playing");
  });

  it("saves settings for Manage Server only", async () => {
    const { commands, guildSettings } = setup();
    const member = fakeInteraction({ sub: "settings", options: { volume: 50 } });
    await commands.get("music").execute(member);
    expect(guildSettings.set).not.toHaveBeenCalled();

    const admin = fakeInteraction({ sub: "settings", options: { "dj-role": { id: DJ }, volume: 50 }, permissions: [PermissionFlagsBits.ManageGuild] });
    await commands.get("music").execute(admin);
    expect(guildSettings.set).toHaveBeenCalledWith(GUILD, Setting.MUSIC, {
      djRoleId: DJ,
      djOnly: false,
      voteSkipPercent: 50,
      maxSongMinutes: 0,
      stay247: false,
      defaultVolume: 50,
      maxQueue: 200,
      announce: true,
      leaveAfterMinutes: 3,
    });
    expect(lastText(admin)).toContain(`DJ role: <@&${DJ}>`);

    const reset = fakeInteraction({ sub: "settings", options: { "no-dj-role": true, volume: 80 }, permissions: [PermissionFlagsBits.ManageGuild] });
    await commands.get("music").execute(reset);
    expect(guildSettings.set).toHaveBeenLastCalledWith(GUILD, Setting.MUSIC, null);
  });

  it("refuses DJ-only mode without a DJ role", async () => {
    const { commands, guildSettings } = setup();
    const admin = fakeInteraction({ sub: "settings", options: { "dj-only": true }, permissions: [PermissionFlagsBits.ManageGuild] });
    await commands.get("music").execute(admin);
    expect(guildSettings.set).not.toHaveBeenCalled();
    expect(lastText(admin)).toContain("needs a DJ role");
  });

  it("counts votes to skip from members who aren't DJs", async () => {
    const active = fakePlayer({ listeners: 3 });
    const { commands } = setup({ active, settings: { [Setting.MUSIC]: { djRoleId: DJ, voteSkipPercent: 50 } } });
    const member = fakeInteraction({ sub: "skip" });
    await commands.get("music").execute(member);
    expect(active.voteSkip).toHaveBeenCalledWith("u0", 50);
    expect(active.skip).not.toHaveBeenCalled();
    expect(lastText(member)).toBe("🗳️ <@u0> voted to skip (1/2).");

    active.voteSkip.mockReturnValueOnce({ votes: 2, needed: 2, skipped: true });
    const second = fakeInteraction({ sub: "skip" });
    await commands.get("music").execute(second);
    expect(lastText(second)).toBe("⏭️ The vote passed (2/2): skipped **Song**.");
  });

  it("changes the filter and moves around in the song", async () => {
    const active = fakePlayer();
    const { commands } = setup({ active });
    const filter = fakeInteraction({ sub: "filter", options: { name: "nightcore" } });
    await commands.get("music").execute(filter);
    expect(active.setFilter).toHaveBeenCalledWith("nightcore");
    expect(lastText(filter)).toBe("🎚️ <@u0> turned on Nightcore.");

    const forward = fakeInteraction({ sub: "forward", options: { seconds: 15 } });
    await commands.get("music").execute(forward);
    expect(active.forward).toHaveBeenCalledWith(15_000);
    expect(lastText(forward)).toBe("⏩ <@u0> jumped to 0:45.");

    const rewind = fakeInteraction({ sub: "rewind" });
    await commands.get("music").execute(rewind);
    expect(active.forward).toHaveBeenLastCalledWith(-10_000);

    const badSeek = fakeInteraction({ sub: "seek", options: { time: "soon" } });
    await commands.get("music").execute(badSeek);
    expect(lastText(badSeek)).toContain("1:30");
  });

  it("finds lyrics for the song playing", async () => {
    const find = vi.fn(async () => ({ title: "Song", artist: "Band", lyrics: "la la la", instrumental: false }));
    const { commands } = setup({ active: fakePlayer(), lyrics: { find } });
    const interaction = fakeInteraction({ sub: "lyrics" });
    await commands.get("music").execute(interaction);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ title: "Song" }));
    expect(interaction.editReply.mock.calls[0][0].embeds[0].data.description).toBe("la la la");

    const missing = setup({ active: fakePlayer(), lyrics: { find: vi.fn(async () => null) } });
    const none = fakeInteraction({ sub: "lyrics", options: { query: "nothing - here" } });
    await missing.commands.get("music").execute(none);
    expect(lastText(none)).toContain("No lyrics found for **nothing - here**");
  });

  it("DMs the song playing", async () => {
    const dm = vi.fn(async () => {});
    const { commands } = setup({ active: fakePlayer(), dm });
    const interaction = fakeInteraction({ sub: "grab" });
    await commands.get("music").execute(interaction);
    expect(dm.mock.calls[0][1].embeds[0].data.title).toBe("Song");
    expect(lastText(interaction)).toBe("📩 Sent **Song** to your DMs.");

    const closed = setup({ active: fakePlayer(), dm: vi.fn(async () => Promise.reject(new Error("closed"))) });
    const refused = fakeInteraction({ sub: "grab" });
    await closed.commands.get("music").execute(refused);
    expect(lastText(refused)).toContain("couldn't DM you");
  });
});

describe("DJ settings when adding songs", () => {
  it("lets only DJs add songs in DJ-only mode", async () => {
    const { commands, music } = setup({ settings: { [Setting.MUSIC]: { djRoleId: DJ, djOnly: true } } });
    const member = fakeInteraction({ command: "play", options: { query: "song" } });
    await commands.get("play").execute(member);
    expect(lastText(member)).toBe(`Only <@&${DJ}> can add songs on this server.`);
    expect(music.resolver.resolve).not.toHaveBeenCalled();

    const dj = fakeInteraction({ command: "play", options: { query: "song" }, roles: [DJ] });
    await commands.get("play").execute(dj);
    expect(music.resolver.resolve).toHaveBeenCalled();
  });

  it("leaves out songs longer than the server allows", async () => {
    const long = makeTrack({ title: "Long", source: Source.SOUNDCLOUD, durationMs: 20 * 60_000, stream: { id: 1 } });
    const short = makeTrack({ title: "Short", source: Source.SOUNDCLOUD, durationMs: 3 * 60_000, stream: { id: 2 } });
    const { commands, joined } = setup({ settings: { [Setting.MUSIC]: { maxSongMinutes: 10 } }, resolve: vi.fn(async () => ({ tracks: [long, short], skipped: 0, name: "Mix" })) });
    const interaction = fakeInteraction({ command: "play", options: { query: "mix" } });
    await commands.get("play").execute(interaction);
    expect(joined.add.mock.calls[0][0].map((track) => track.title)).toEqual(["Short"]);
    expect(lastText(interaction)).toContain("1 longer than 10 minutes were left out.");

    const only = setup({ settings: { [Setting.MUSIC]: { maxSongMinutes: 10 } }, resolve: vi.fn(async () => ({ tracks: [long], skipped: 0, name: null })) });
    const refused = fakeInteraction({ command: "play", options: { query: "long" } });
    await only.commands.get("play").execute(refused);
    expect(lastText(refused)).toBe("That's longer than this server allows (10 minutes).");
  });
});

describe("/search", () => {
  it("shows 5 results privately and plays the one picked", async () => {
    const { commands, joined } = setup();
    const search = fakeInteraction({ command: "search", options: { query: "song" } });
    await commands.get("search").execute(search);
    const shown = search.editReply.mock.calls[0][0];
    expect(search.deferReply.mock.calls[0][0].flags).toBeDefined();
    expect(shown.embeds[0].data.description.split("\n")).toHaveLength(5);
    const pickId = shown.components[1].components[2].data.custom_id;
    expect(pickId.startsWith(SEARCH_PREFIX)).toBe(true);

    const handle = commands.get("search").componentPrefixes[SEARCH_PREFIX].handle;
    const stranger = fakeInteraction({ customId: pickId });
    stranger.user = { id: "u9" };
    await handle(stranger);
    expect(lastText(stranger)).toContain("aren't your search results");

    const pick = fakeInteraction({ customId: pickId });
    await handle(pick);
    expect(joined.add.mock.calls[0][0][0].title).toBe("Result 3");
    expect(pick.followUp.mock.calls[0][0].content).toBe("🎵 <@u0> picked **Result 3**.");

    const again = fakeInteraction({ customId: pickId });
    await handle(again);
    expect(again.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("expired") }));
  });

  it("can be cancelled", async () => {
    const { commands } = setup();
    const search = fakeInteraction({ command: "search", options: { query: "song" } });
    await commands.get("search").execute(search);
    const cancelId = search.editReply.mock.calls[0][0].components[2].components[0].data.custom_id;
    const cancel = fakeInteraction({ customId: cancelId });
    await commands.get("search").componentPrefixes[SEARCH_PREFIX].handle(cancel);
    expect(cancel.update).toHaveBeenCalledWith({ content: "Search cancelled.", embeds: [], components: [] });
  });
});

describe("/queue", () => {
  it("skips to a song and cleans up", async () => {
    const active = fakePlayer({ queue: [makeTrack({ title: "A" }), makeTrack({ title: "B" })] });
    active.skipTo = vi.fn(() => active.queue[1]);
    active.removeDuplicates = vi.fn(() => 2);
    const { commands } = setup({ active });
    const skipto = fakeInteraction({ command: "queue", sub: "skipto", options: { position: 2 } });
    await commands.get("queue").execute(skipto);
    expect(active.skipTo).toHaveBeenCalledWith(2);
    expect(lastText(skipto)).toBe("⏭️ <@u0> skipped to **B**.");
    const dupes = fakeInteraction({ command: "queue", sub: "removedupes" });
    await commands.get("queue").execute(dupes);
    expect(lastText(dupes)).toBe("🧹 <@u0> removed 2 songs that were in the queue twice.");
  });
});

describe("/playlist", () => {
  it("saves songs and plays them back", async () => {
    const active = fakePlayer({ queue: [makeTrack({ title: "Next", source: Source.SOUNDCLOUD, stream: { id: 7 } })] });
    active.current.stream = { id: 6 };
    const { commands, playlists, joined } = setup({ active });
    const run = async (sub, options = {}) => {
      const interaction = fakeInteraction({ command: "playlist", sub, options });
      await commands.get("playlist").execute(interaction);
      return lastText(interaction);
    };
    expect(await run("list")).toContain("no playlists yet");
    expect(await run("create", { name: "Road  trip" })).toBe("📁 Made **Road trip**. Add songs with /playlist add.");
    expect(await run("create", { name: "road trip" })).toBe("You already have a playlist called **road trip**.");
    expect(await run("add", { name: "ROAD TRIP" })).toBe("➕ Saved **Song** to **Road trip**.");
    expect(await run("add", { name: "road trip", queue: true })).toBe("➕ Saved 2 songs to **Road trip**.");
    expect(await run("add", { name: "road trip", query: "new song" })).toBe("➕ Saved **New song** to **Road trip**.");
    expect(playlists.get("u0", "road trip").tracks.map((track) => track.title)).toEqual(["Song", "Song", "Next", "New song"]);
    expect(await run("remove", { name: "road trip", position: 2 })).toBe("🗑️ Removed **Song** from **Road trip**.");
    expect(await run("list")).toBe("**Your playlists** (1/25)\n• **Road trip** · 3 songs");

    const play = fakeInteraction({ command: "playlist", sub: "play", options: { name: "road trip" } });
    await commands.get("playlist").execute(play);
    expect(joined.add.mock.calls[0][0].map((track) => track.title)).toEqual(["Song", "Next", "New song"]);
    expect(lastText(play)).toContain("Added 3 songs from **Road trip**");

    expect(await run("rename", { name: "road trip", "new-name": "Drive" })).toBe("Renamed **Road trip** to **Drive**.");
    expect(await run("delete", { name: "drive" })).toBe("🗑️ Deleted **Drive**.");
    expect(await run("show", { name: "drive" })).toContain("You have no playlist called **drive**");
  });

  it("suggests the member's playlists as they type", async () => {
    const { commands, playlists } = setup();
    playlists.create("u0", "Chill");
    playlists.create("u0", "Gym");
    playlists.create("u1", "Chill beats");
    const interaction = fakeInteraction({ command: "playlist", focused: "ch" });
    await commands.get("playlist").autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "Chill (0)", value: "Chill" }]);
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
