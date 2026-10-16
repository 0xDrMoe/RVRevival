import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildGiveawayCommandData, createGiveawayCommand } from "../src/commands/giveaway.js";
import { createGiveawayScheduler } from "../src/giveaways/giveawayScheduler.js";
import { GiveawayStore } from "../src/giveaways/giveawayStore.js";
import { KEEP_ENDED_MS, pickWinners, shuffle } from "../src/giveaways/giveaways.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_ID = "800000000000000001";
const HOST_ID = "300000000000000001";
const ROLE_ID = "700000000000000005";
const MOD_ROLE_ID = "700000000000000001";
const HOUR = 60 * 60 * 1000;
const user = (n) => `30000000000000010${n}`;

// Always picks the last remaining item, so shuffles are predictable.
const random = (max) => max - 1;

function fakeMember(id, roleIds = []) {
  return { id, user: { id, bot: false }, roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } };
}

function fakeGuild({ members = [], canPost = true } = {}) {
  const sent = [];
  const edits = [];
  const message = { id: "600000000000000001", edit: vi.fn(async (payload) => edits.push(payload)) };
  const channel = {
    id: CHANNEL_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => canPost }),
    send: vi.fn(async (payload) => {
      sent.push(payload);
      return message;
    }),
    messages: { fetch: vi.fn(async () => message) },
  };
  const memberMap = new Map(members.map((member) => [member.id, member]));
  return {
    sent,
    edits,
    channel,
    guild: {
      id: GUILD_ID,
      name: "RV",
      preferredLocale: "en-US",
      channels: { cache: new Map([[CHANNEL_ID, channel]]) },
      members: {
        me: {},
        cache: memberMap,
        fetch: vi.fn(async (id) => {
          throw new Error(`Unknown member ${id}`);
        }),
      },
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

function fakeInteraction(guild, { subcommand, options = {}, manageGuild = true, roleIds = [], userId = HOST_ID, customId, focused = "" } = {}) {
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    guild,
    channel: guild.channels.cache.get(CHANNEL_ID),
    channelId: CHANNEL_ID,
    customId,
    user: { id: userId },
    member: fakeMember(userId, roleIds),
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    memberPermissions: { has: (bit) => manageGuild && bit === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getFocused: () => focused,
    },
    reply: vi.fn(async function () {
      this.replied = true;
    }),
    deferReply: vi.fn(async function () {
      this.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

const replyText = (interaction) =>
  (interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1))[0].content;

function setup({ members = [], canPost } = {}) {
  const store = new GiveawayStore();
  const guildSettings = new GuildSettings();
  let time = 1_000_000;
  const fake = fakeGuild({ members, canPost });
  const command = createGiveawayCommand({ giveaways: store, guildSettings, logger, now: () => time, random });
  const run = (options) => command.execute(fakeInteraction(fake.guild, options));
  const click = (giveawayId, userId, roleIds = []) => {
    const interaction = fakeInteraction(fake.guild, { customId: `gw:${giveawayId}`, userId, roleIds });
    return command.componentPrefixes["gw:"].handle(interaction).then(() => interaction);
  };
  return { store, guildSettings, command, run, click, ...fake, later: (ms) => (time += ms), now: () => time };
}

describe("GiveawayStore", () => {
  it("toggles entries and ends a giveaway only once", () => {
    const store = new GiveawayStore();
    const giveaway = store.create({ guildId: GUILD_ID, channelId: CHANNEL_ID, hostId: HOST_ID, prize: "Nitro", winnerCount: 1, createdAt: 0, endsAt: HOUR });
    expect(store.toggleEntry(giveaway.id, user(1))).toBe(true);
    expect(store.toggleEntry(giveaway.id, user(2))).toBe(true);
    expect(store.toggleEntry(giveaway.id, user(1))).toBe(false);
    expect(store.entries(giveaway.id)).toEqual([user(2)]);

    expect(store.due(HOUR - 1)).toEqual([]);
    expect(store.due(HOUR).map((entry) => entry.id)).toEqual([giveaway.id]);
    expect(store.markEnded(giveaway.id, HOUR, [user(2)])).toBe(true);
    expect(store.markEnded(giveaway.id, HOUR, [user(1)])).toBe(false);
    expect(store.get(giveaway.id)).toMatchObject({ endedAt: HOUR, winnerIds: [user(2)] });
    expect(store.running(GUILD_ID)).toEqual([]);
    expect(store.ended(GUILD_ID).map((entry) => entry.id)).toEqual([giveaway.id]);

    expect(store.deleteEndedBefore(HOUR + 1)).toBe(1);
    expect(store.get(giveaway.id)).toBeUndefined();
    expect(store.entries(giveaway.id)).toEqual([]);
  });
});

describe("picking winners", () => {
  it("shuffles every item exactly once", () => {
    expect(shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    expect(shuffle([1, 2, 3], random)).toEqual([1, 2, 3]);
  });

  it("skips members who left, lost the role, or already won", async () => {
    const { guild } = fakeGuild({ members: [fakeMember(user(1), [ROLE_ID]), fakeMember(user(2)), fakeMember(user(3), [ROLE_ID])] });
    const giveaway = { requiredRoleId: ROLE_ID };
    const entrants = [user(1), user(2), user(3), user(4)];
    expect(await pickWinners(guild, giveaway, entrants, { count: 5, random })).toEqual([user(1), user(3)]);
    expect(await pickWinners(guild, giveaway, entrants, { count: 5, exclude: [user(1)], random })).toEqual([user(3)]);
    expect(await pickWinners(guild, {}, entrants, { count: 1, random })).toEqual([user(1)]);
  });
});

describe("/giveaway", () => {
  it("needs Manage Server or the mod role", async () => {
    expect(buildGiveawayCommandData().default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    const { run, guildSettings } = setup();
    expect((await run({ subcommand: "list", manageGuild: false })).key).toBe("modNoPermission");
    await guildSettings.set(GUILD_ID, Setting.MOD_ROLE, MOD_ROLE_ID);
    expect((await run({ subcommand: "list", manageGuild: false, roleIds: [MOD_ROLE_ID] })).key).toBe("giveawayListEmpty");
  });

  it("starts a giveaway with an Enter button", async () => {
    const { run, store, sent } = setup();
    const outcome = await run({ subcommand: "start", options: { prize: "Nitro", duration: "1d", winners: 2 } });
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "giveawayStarted" });
    const [giveaway] = store.running(GUILD_ID);
    expect(giveaway).toMatchObject({ prize: "Nitro", winnerCount: 2, hostId: HOST_ID, messageId: "600000000000000001" });
    const payload = JSON.parse(JSON.stringify(sent[0]));
    expect(payload.embeds[0].title).toBe("🎉 Nitro");
    expect(payload.components[0].components[0]).toMatchObject({ custom_id: `gw:${giveaway.id}`, label: "Enter" });
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("refuses bad durations, a missing channel permission and too many giveaways", async () => {
    const { run } = setup();
    expect((await run({ subcommand: "start", options: { prize: "x", duration: "soon" } })).key).toBe("giveawayBadDuration");
    expect((await run({ subcommand: "start", options: { prize: "x", duration: "30s" } })).key).toBe("giveawayOutOfRange");
    expect((await run({ subcommand: "start", options: { prize: "x", duration: "31d" } })).key).toBe("giveawayOutOfRange");
    expect((await run({ subcommand: "start", options: { prize: "  ", duration: "1h" } })).key).toBe("giveawayNoPrize");
    for (let index = 0; index < 10; index++) {
      await run({ subcommand: "start", options: { prize: `p${index}`, duration: "1h" } });
    }
    expect((await run({ subcommand: "start", options: { prize: "one more", duration: "1h" } })).key).toBe("giveawayTooMany");

    const blocked = setup({ canPost: false });
    expect((await blocked.run({ subcommand: "start", options: { prize: "x", duration: "1h" } })).key).toBe("giveawayCannotPost");
  });

  it("lets members enter and leave, and checks the required role", async () => {
    const { run, store, click } = setup();
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h", role: { id: ROLE_ID } } });
    const [giveaway] = store.running(GUILD_ID);

    const refused = await click(giveaway.id, user(1));
    expect(replyText(refused)).toContain(`<@&${ROLE_ID}>`);
    const joined = await click(giveaway.id, user(1), [ROLE_ID]);
    expect(joined.reply.mock.calls[0][0]).toMatchObject({ flags: MessageFlags.Ephemeral });
    expect(replyText(joined)).toContain("You're in");
    expect(store.entries(giveaway.id)).toEqual([user(1)]);
    expect(replyText(await click(giveaway.id, user(1), [ROLE_ID]))).toContain("You left");
    expect(store.entries(giveaway.id)).toEqual([]);
  });

  it("ends on time, announces the winners pinging only them, and closes the button", async () => {
    const members = [1, 2, 3].map((n) => fakeMember(user(n)));
    const { run, store, click, guild, sent, edits, later, now } = setup({ members });
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h", winners: 2 } });
    const [giveaway] = store.running(GUILD_ID);
    for (const n of [1, 2, 3]) {
      await click(giveaway.id, user(n));
    }

    const scheduler = createGiveawayScheduler({ client: { guilds: { cache: new Map([[GUILD_ID, guild]]) } }, store, logger, now, random });
    await scheduler.sweep();
    expect(sent).toHaveLength(1);

    later(HOUR);
    await scheduler.sweep();
    const ended = store.get(giveaway.id);
    expect(ended.endedAt).not.toBeNull();
    expect(ended.winnerIds).toHaveLength(2);
    const announcement = sent.at(-1);
    expect(announcement.allowedMentions).toEqual({ users: ended.winnerIds });
    expect(announcement.content).toContain("Nitro");
    const finalMessage = JSON.parse(JSON.stringify(edits.at(-1)));
    expect(finalMessage.components[0].components[0].disabled).toBe(true);

    expect(replyText(await click(giveaway.id, user(1)))).toContain("has ended");
    await scheduler.sweep();
    expect(sent).toHaveLength(2);
  });

  it("says so when no one entered", async () => {
    const { run, store, sent } = setup();
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h" } });
    const [giveaway] = store.running(GUILD_ID);
    const outcome = await run({ subcommand: "end", options: { giveaway: giveaway.id } });
    expect(outcome).toMatchObject({ key: "giveawayEndedNow", values: { count: 0 } });
    expect(sent.at(-1).content).toContain("no one could be picked");
    expect((await run({ subcommand: "end", options: { giveaway: giveaway.id } })).key).toBe("giveawayAlreadyEnded");
  });

  it("rerolls without picking a previous winner", async () => {
    const members = [1, 2].map((n) => fakeMember(user(n)));
    const { run, store, click } = setup({ members });
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h" } });
    const [giveaway] = store.running(GUILD_ID);
    expect((await run({ subcommand: "reroll", options: { giveaway: giveaway.id } })).key).toBe("giveawayNotEnded");
    await click(giveaway.id, user(1));
    await click(giveaway.id, user(2));
    await run({ subcommand: "end", options: { giveaway: giveaway.id } });
    const [first] = store.get(giveaway.id).winnerIds;

    const outcome = await run({ subcommand: "reroll", options: { giveaway: giveaway.id } });
    expect(outcome.key).toBe("giveawayRerolled");
    const winners = store.get(giveaway.id).winnerIds;
    expect(winners).toHaveLength(2);
    expect(winners[1]).not.toBe(first);
    expect((await run({ subcommand: "reroll", options: { giveaway: giveaway.id } })).key).toBe("giveawayRerollNoOne");
  });

  it("cancels a giveaway and forgets it", async () => {
    const { run, store, edits } = setup();
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h" } });
    const [giveaway] = store.running(GUILD_ID);
    expect((await run({ subcommand: "cancel", options: { giveaway: giveaway.id } })).key).toBe("giveawayCancelled");
    expect(store.get(giveaway.id)).toBeUndefined();
    expect(JSON.stringify(edits.at(-1))).toContain("Cancelled");
  });

  it("doesn't touch another server's giveaway", async () => {
    const { run, store } = setup();
    const other = store.create({ guildId: "900000000000000002", channelId: CHANNEL_ID, hostId: HOST_ID, prize: "x", winnerCount: 1, createdAt: 0, endsAt: HOUR });
    expect((await run({ subcommand: "end", options: { giveaway: other.id } })).key).toBe("giveawayNotFound");
  });

  it("suggests running giveaways, and ended ones for reroll", async () => {
    const { run, store, command, guild } = setup();
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h" } });
    await run({ subcommand: "start", options: { prize: "Steam key", duration: "1h" } });
    const [nitro] = store.running(GUILD_ID);
    await run({ subcommand: "end", options: { giveaway: nitro.id } });

    const running = fakeInteraction(guild, { subcommand: "end", focused: "" });
    await command.autocomplete(running);
    expect(running.respond.mock.calls[0][0].map((choice) => choice.name)).toEqual(["#2 Steam key"]);
    const ended = fakeInteraction(guild, { subcommand: "reroll", focused: "nit" });
    await command.autocomplete(ended);
    expect(ended.respond.mock.calls[0][0]).toEqual([{ name: "#1 Nitro", value: nitro.id }]);
  });

  it("forgets ended giveaways after a while", async () => {
    const { run, store, guild, later, now } = setup();
    await run({ subcommand: "start", options: { prize: "Nitro", duration: "1h" } });
    const [giveaway] = store.running(GUILD_ID);
    await run({ subcommand: "end", options: { giveaway: giveaway.id } });
    const scheduler = createGiveawayScheduler({ client: { guilds: { cache: new Map([[GUILD_ID, guild]]) } }, store, logger, now });
    later(KEEP_ENDED_MS + 1);
    await scheduler.sweep();
    expect(store.get(giveaway.id)).toBeUndefined();
  });
});
