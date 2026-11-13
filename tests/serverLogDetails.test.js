import { AuditLogEvent, Collection, GatewayIntentBits, IntentsBitField, PermissionFlagsBits } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditTrail } from "../src/logs/auditTrail.js";
import { createInviteTracker } from "../src/logs/inviteTracker.js";
import { createLogChannelPoster } from "../src/logs/logChannel.js";
import { buildLogEntry, formatDuration } from "../src/logs/logEntry.js";
import { checkLogOptions, DEFAULT_LOG_OPTIONS, InvalidLogOptions, LOG_EVENT_GROUPS, LOG_EVENTS, normalizeLogOptions } from "../src/logs/logEvents.js";
import { LOG_ROUTES, ROUTE_DEFAULTS, routeChain } from "../src/logs/logRoutes.js";
import { buildServerChangeEmbed, eventOfAuditEntry, permissionNames } from "../src/logs/serverChanges.js";
import { buildMessageEditedEmbed, createServerLog, LogEvent } from "../src/logs/serverLog.js";
import { describeEdit, diffWords } from "../src/logs/textDiff.js";
import { RecentIds } from "../src/logs/recentIds.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const LOG_ID = "800000000000000007";
const CHANNEL_ID = "800000000000000001";
const VOICE_ID = "800000000000000002";
const OTHER_VOICE_ID = "800000000000000003";
const USER_ID = "300000000000000001";
const MOD_ID = "300000000000000002";
const BOT_ID = "300000000000000009";
const ROLE_ID = "700000000000000001";

const client = { options: { intents: new IntentsBitField([GatewayIntentBits.MessageContent]) } };
const author = { id: USER_ID, tag: "member", username: "member", bot: false, displayAvatarURL: () => "https://cdn.example/a.png" };
const roles = (...ids) => ({ cache: new Collection(ids.map((id) => [id, { id }])) });

describe("log events and options", () => {
  it("puts every event in exactly one group, and every event and group is a log route of the server log", () => {
    const grouped = LOG_EVENT_GROUPS.flatMap((group) => group.events);
    expect(grouped.sort()).toEqual([...LOG_EVENTS].sort());
    for (const group of LOG_EVENT_GROUPS) {
      expect(ROUTE_DEFAULTS[group.id]).toBe("serverLog");
      for (const event of group.events) {
        expect(LOG_ROUTES).toContain(event);
        expect(ROUTE_DEFAULTS[event]).toBe("serverLog");
        expect(routeChain(event)).toEqual([event, group.id]);
      }
    }
    expect(new Set(LOG_ROUTES).size).toBe(LOG_ROUTES.length);
  });

  it("fills in default options and saves only the ones that differ", () => {
    expect(normalizeLogOptions(undefined)).toEqual(DEFAULT_LOG_OPTIONS);
    expect(normalizeLogOptions({ compact: true, junk: 1, showIds: "no" })).toEqual({ ...DEFAULT_LOG_OPTIONS, compact: true });
    expect(checkLogOptions({ compact: true, showIds: true })).toEqual({ compact: true });
    expect(checkLogOptions({ ...DEFAULT_LOG_OPTIONS })).toBeNull();
    expect(() => checkLogOptions({ nope: true })).toThrow(InvalidLogOptions);
    expect(() => checkLogOptions({ compact: "yes" })).toThrow(InvalidLogOptions);
    expect(() => checkLogOptions([])).toThrow(InvalidLogOptions);
  });

  it("builds compact entries without the author, avatar, details or IDs when asked", () => {
    const entry = { color: 1, title: "**Title**", lines: ["line"], details: ["detail"], user: author, thumbnail: "https://cdn.example/t.png", ids: ["User ID 1"] };
    const full = buildLogEntry(entry).toJSON();
    expect(full.description).toBe("**Title**\nline\ndetail");
    expect(full.author.name).toBe("member");
    expect(full.thumbnail.url).toBe("https://cdn.example/t.png");
    expect(full.footer.text).toBe("User ID 1");
    const compact = buildLogEntry(entry, { ...DEFAULT_LOG_OPTIONS, compact: true, showIds: false }).toJSON();
    expect(compact.description).toBe("**Title**\nline");
    expect(compact.author).toBeUndefined();
    expect(compact.thumbnail).toBeUndefined();
    expect(compact.footer).toBeUndefined();
  });

  it("says how long something lasted in its two biggest units", () => {
    expect(formatDuration(500)).toBe("0 seconds");
    expect(formatDuration(61_000)).toBe("1 minute 1 second");
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000 + 60_000)).toBe("2 days 3 hours");
    expect(formatDuration(86_400_000 + 5_000)).toBe("1 day");
  });
});

describe("edit highlights", () => {
  it("strikes removed words and bolds added ones, keeping a little context", () => {
    expect(describeEdit("see you at 5 today", "see you at 6 today")).toBe("see you at ~~5~~ **6** today");
    const long = `${"word ".repeat(30)}old ending`;
    const changed = describeEdit(long, `${"word ".repeat(30)}new ending`);
    expect(changed).toMatch(/^… word.*~~old~~ \*\*new\*\* ending$/);
  });

  it("escapes markdown in the words and skips texts with nothing in common", () => {
    expect(describeEdit("a *b* c", "a *d* c")).toBe("a ~~\\*b\\*~~ **\\*d\\*** c");
    expect(describeEdit("hello", "goodbye")).toBeUndefined();
    expect(describeEdit("same", "same")).toBeUndefined();
    expect(diffWords("x ".repeat(700), "y")).toBeNull();
  });

  it("adds the changes line to an edited message unless switched off", () => {
    const old = { id: "1", channelId: CHANNEL_ID, content: "meet at noon", author, client, partial: false, attachments: new Map() };
    const edited = { ...old, content: "meet at one", url: "https://discord.com/channels/1/2/3", createdTimestamp: 1 };
    expect(buildMessageEditedEmbed(old, edited).toJSON().description).toContain("**Changes:** meet at ~~noon~~ **one**");
    expect(buildMessageEditedEmbed(old, edited, { ...DEFAULT_LOG_OPTIONS, editDiff: false }).toJSON().description).not.toContain("Changes");
  });
});

describe("server changes from the audit log", () => {
  const guild = {
    id: GUILD_ID,
    channels: { cache: new Map([[CHANNEL_ID, { id: CHANNEL_ID }]]) },
    roles: { cache: new Map([[ROLE_ID, { id: ROLE_ID }]]) },
    emojis: { cache: new Map() },
  };

  it("names permissions the way Discord shows them", () => {
    expect(permissionNames(String(PermissionFlagsBits.ManageMessages | PermissionFlagsBits.BanMembers))).toEqual(["Ban Members", "Manage Messages"]);
    expect(permissionNames("nonsense")).toEqual([]);
  });

  it("logs role permission changes, with who made them and why", () => {
    const entry = {
      action: AuditLogEvent.RoleUpdate,
      targetType: "Role",
      targetId: ROLE_ID,
      executorId: MOD_ID,
      reason: "cleanup",
      changes: [
        { key: "permissions", old: String(PermissionFlagsBits.SendMessages), new: String(PermissionFlagsBits.ManageMessages) },
        { key: "color", old: 0, new: 0xff0000 },
        { key: "hoist", old: false, new: true },
      ],
    };
    expect(eventOfAuditEntry(entry)).toBe(LogEvent.ROLE_UPDATE);
    const embed = buildServerChangeEmbed(entry, guild).toJSON();
    expect(embed.description).toContain(`**Role changed** · <@&${ROLE_ID}>`);
    expect(embed.description).toContain("**Permissions added:** Manage Messages");
    expect(embed.description).toContain("**Permissions removed:** Send Messages");
    expect(embed.description).toContain("**Colour:** Default → #ff0000");
    expect(embed.description).toContain("**Shown separately:** No → Yes");
    expect(embed.description).toContain(`**By:** <@${MOD_ID}> · Reason: cleanup`);
    // Changes are the point of an update, so compact entries keep them.
    expect(buildServerChangeEmbed(entry, guild, { ...DEFAULT_LOG_OPTIONS, compact: true }).toJSON().description).toContain("Permissions added");
  });

  it("logs deleted channels by name, and overwrites with whose permissions they are", () => {
    const deleted = buildServerChangeEmbed(
      {
        action: AuditLogEvent.ChannelDelete,
        targetType: "Channel",
        targetId: "800000000000000099",
        executorId: MOD_ID,
        changes: [
          { key: "name", old: "secret" },
          { key: "type", old: 0 },
          { key: "rate_limit_per_user", old: 30 },
        ],
      },
      guild,
    ).toJSON();
    expect(deleted.description).toContain("**Channel deleted** · `#secret`");
    expect(deleted.description).toContain("**Type:** Text → *none*");

    const overwrite = buildServerChangeEmbed(
      {
        action: AuditLogEvent.ChannelOverwriteUpdate,
        targetType: "Channel",
        targetId: CHANNEL_ID,
        executorId: MOD_ID,
        extra: { id: GUILD_ID, name: "@everyone", type: "0" },
        changes: [{ key: "deny", old: "0", new: String(PermissionFlagsBits.SendMessages) }],
      },
      guild,
    ).toJSON();
    expect(overwrite.description).toContain(`**Channel permissions changed** · <#${CHANNEL_ID}>`);
    expect(overwrite.description).toContain("**For:** @everyone");
    expect(overwrite.description).toContain("**Denied added:** Send Messages");
  });

  it("logs pins with a link, and skips actions the server log doesn't post", () => {
    const pin = buildServerChangeEmbed(
      { action: AuditLogEvent.MessagePin, targetType: "Message", targetId: USER_ID, executorId: MOD_ID, extra: { channel: { id: CHANNEL_ID }, messageId: "5" }, changes: [] },
      guild,
    ).toJSON();
    expect(pin.description).toContain(`**Message pinned** · from <@${USER_ID}> in <#${CHANNEL_ID}> · [Jump to message](https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/5)`);
    expect(eventOfAuditEntry({ action: AuditLogEvent.MemberBanAdd })).toBeUndefined();
    expect(buildServerChangeEmbed({ action: AuditLogEvent.MemberKick }, guild)).toBeUndefined();
  });
});

describe("who did it", () => {
  const guild = { id: GUILD_ID, members: { me: { permissions: { has: (bit) => bit === PermissionFlagsBits.ViewAuditLog } } } };

  it("finds an entry that arrived just before, once only", async () => {
    let clock = 1_000;
    const trail = createAuditTrail({ now: () => clock });
    const entry = { action: AuditLogEvent.MessageDelete, targetId: USER_ID };
    trail.record(entry, guild);
    const match = (candidate) => candidate.targetId === USER_ID;
    expect(await trail.find(guild, match, { waitMs: 0 })).toBe(entry);
    expect(await trail.find(guild, match, { waitMs: 0 })).toBeUndefined();
    trail.record(entry, guild);
    clock += 10_000;
    expect(await trail.find(guild, match, { waitMs: 0 })).toBeUndefined();
  });

  it("waits a moment for an entry that arrives after the change, and gives up quietly", async () => {
    vi.useFakeTimers();
    try {
      const trail = createAuditTrail();
      const entry = { action: AuditLogEvent.MemberRoleUpdate, targetId: USER_ID };
      const found = trail.find(guild, (candidate) => candidate.targetId === USER_ID);
      trail.record({ action: AuditLogEvent.MemberRoleUpdate, targetId: "someone else" }, guild);
      trail.record(entry, guild);
      expect(await found).toBe(entry);
      const missing = trail.find(guild, (candidate) => candidate.targetId === "nobody");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await missing).toBeUndefined();
      // Without View Audit Log there's nothing to wait for.
      const blind = { id: GUILD_ID, members: { me: { permissions: { has: () => false } } } };
      expect(await trail.find(blind, (candidate) => candidate.targetId === "nobody")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("invite tracking", () => {
  const invites = (list) => new Collection(list.map((invite) => [invite.code, invite]));
  function setup(first, { canManage = true } = {}) {
    const guild = {
      id: GUILD_ID,
      members: { me: { permissions: { has: (bit) => canManage && bit === PermissionFlagsBits.ManageGuild } } },
      invites: { fetch: vi.fn(async () => invites(first)) },
    };
    return { guild, tracker: createInviteTracker({ logger: fakeLogger(), sleep: async () => {} }) };
  }

  it("finds the invite whose use count went up", async () => {
    const { guild, tracker } = setup([
      { code: "aaa", uses: 1, maxUses: 0, inviterId: MOD_ID },
      { code: "bbb", uses: 5, maxUses: 0, inviterId: USER_ID },
    ]);
    await tracker.primeAll([guild]);
    guild.invites.fetch.mockResolvedValueOnce(
      invites([
        { code: "aaa", uses: 2, maxUses: 0, inviterId: MOD_ID },
        { code: "bbb", uses: 5, maxUses: 0, inviterId: USER_ID },
      ]),
    );
    expect(await tracker.inviteUsed({ guild })).toEqual({ code: "aaa", inviterId: MOD_ID, uses: 2, maxUses: 0 });
  });

  it("spots a one-time invite that disappeared, and says nothing when unsure", async () => {
    const { guild, tracker } = setup([{ code: "once", uses: 0, maxUses: 1, inviterId: MOD_ID }]);
    await tracker.prime(guild);
    guild.invites.fetch.mockResolvedValueOnce(invites([]));
    expect(await tracker.inviteUsed({ guild })).toMatchObject({ code: "once", inviterId: MOD_ID, uses: 1 });
    // Nothing changed (a vanity link, say): no guess.
    guild.invites.fetch.mockResolvedValueOnce(invites([]));
    expect(await tracker.inviteUsed({ guild })).toBeUndefined();
  });

  it("needs Manage Server, and never throws", async () => {
    const { guild, tracker } = setup([], { canManage: false });
    expect(await tracker.inviteUsed({ guild })).toBeUndefined();
    expect(guild.invites.fetch).not.toHaveBeenCalled();
    const broken = setup([]);
    broken.guild.invites.fetch.mockRejectedValue(new Error("Missing Permissions"));
    expect(await broken.tracker.inviteUsed({ guild: broken.guild })).toBeUndefined();
  });
});

describe("server log details", () => {
  let logChannel;
  let guild;
  let settings;
  let serverLog;
  let auditTrail;
  let inviteTracker;
  let clock;

  beforeEach(async () => {
    logChannel = { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({})) };
    guild = {
      id: GUILD_ID,
      members: { me: { id: BOT_ID }, cache: new Map() },
      channels: { cache: new Map([[LOG_ID, logChannel]]) },
      roles: { cache: new Map() },
      memberCount: 42,
    };
    settings = new GuildSettings();
    await settings.set(GUILD_ID, Setting.SERVER_LOG_CHANNEL, LOG_ID);
    clock = 1_700_000_000_000;
    auditTrail = { find: vi.fn(async () => undefined) };
    inviteTracker = { inviteUsed: vi.fn(async () => ({ code: "abc", inviterId: MOD_ID, uses: 3, maxUses: 0 })) };
    serverLog = createServerLog({
      poster: createLogChannelPoster({ guildSettings: settings, logger: fakeLogger() }),
      botDeletions: new RecentIds(),
      guildSettings: settings,
      auditTrail,
      inviteTracker,
      now: () => clock,
    });
  });

  const posted = () => logChannel.send.mock.calls.flatMap((call) => call[0].embeds.map((embed) => embed.toJSON()));
  const member = (overrides = {}) => ({ id: USER_ID, guild, user: author, roles: roles(), ...overrides });
  const voice = (channelId, overrides = {}) => ({ id: USER_ID, guild, channelId, member: member(), ...overrides });

  it("says who deleted a message when the audit log knows", async () => {
    auditTrail.find.mockImplementation(async (_guild, match) => {
      const entry = { action: AuditLogEvent.MessageDelete, targetId: USER_ID, executorId: MOD_ID, extra: { channel: { id: CHANNEL_ID } } };
      return match(entry) ? entry : undefined;
    });
    await serverLog.messageDeleted({ id: "6", channelId: CHANNEL_ID, guild, content: "oops", author, client, partial: false, attachments: new Map(), createdTimestamp: clock - 60_000 });
    const [embed] = posted();
    expect(embed.description).toContain(`**By:** <@${MOD_ID}>`);
    expect(embed.description).toContain("**Sent:**");
  });

  it("doesn't wait for the audit log when 'Say who did it' is off", async () => {
    await settings.set(GUILD_ID, Setting.LOG_OPTIONS, { whoDidIt: false });
    await serverLog.messageDeleted({ id: "6", channelId: CHANNEL_ID, guild, content: "oops", author, client, partial: false, attachments: new Map() });
    expect(auditTrail.find).not.toHaveBeenCalled();
    expect(posted()).toHaveLength(1);
  });

  it("logs the invite a new member used, unless switched off", async () => {
    await serverLog.memberJoined(member({ user: { ...author, createdTimestamp: 0 } }));
    expect(posted()[0].description).toContain(`**Invite:** discord.gg/abc, made by <@${MOD_ID}> · used 3 times`);
    await settings.set(GUILD_ID, Setting.LOG_OPTIONS, { invites: false });
    await serverLog.memberJoined(member({ user: { ...author, createdTimestamp: 0 } }));
    expect(inviteTracker.inviteUsed).toHaveBeenCalledTimes(1);
  });

  it("logs voice joins, moves and leaves with the time spent", async () => {
    await serverLog.voiceStateUpdated(voice(null), voice(VOICE_ID));
    clock += 90 * 60 * 1000;
    await serverLog.voiceStateUpdated(voice(VOICE_ID), voice(OTHER_VOICE_ID));
    clock += 5 * 60 * 1000;
    await serverLog.voiceStateUpdated(voice(OTHER_VOICE_ID), voice(null));
    const [joined, moved, left] = posted();
    expect(joined.description).toBe(`**Joined voice** · <@${USER_ID}> → <#${VOICE_ID}>`);
    expect(moved.description).toContain(`<#${VOICE_ID}> → <#${OTHER_VOICE_ID}>`);
    expect(moved.description).toContain(`Spent 1 hour 30 minutes in <#${VOICE_ID}>`);
    expect(left.description).toContain(`Spent 5 minutes in <#${OTHER_VOICE_ID}>`);
  });

  it("logs server mutes, and skips bots in voice unless asked", async () => {
    await serverLog.voiceStateUpdated(voice(VOICE_ID, { serverMute: false }), voice(VOICE_ID, { serverMute: true }));
    expect(posted()[0].description).toContain("🔇 Server muted");
    const bot = { ...author, bot: true };
    await serverLog.voiceStateUpdated(voice(null, { member: member({ user: bot }) }), voice(VOICE_ID, { member: member({ user: bot }) }));
    expect(posted()).toHaveLength(1);
    await settings.set(GUILD_ID, Setting.LOG_OPTIONS, { logBots: true });
    await serverLog.voiceStateUpdated(voice(null, { member: member({ user: bot }) }), voice(VOICE_ID, { member: member({ user: bot }) }));
    expect(posted()).toHaveLength(2);
  });

  it("skips voice in ignored channels and members with ignored roles", async () => {
    await settings.set(GUILD_ID, Setting.LOG_IGNORED_CHANNELS, [VOICE_ID]);
    await serverLog.voiceStateUpdated(voice(null), voice(VOICE_ID));
    await settings.clear(GUILD_ID, Setting.LOG_IGNORED_CHANNELS);
    await settings.set(GUILD_ID, Setting.LOG_IGNORED_ROLES, [ROLE_ID]);
    const ignored = member({ roles: roles(ROLE_ID) });
    await serverLog.voiceStateUpdated(voice(null, { member: ignored }), voice(VOICE_ID, { member: ignored }));
    expect(logChannel.send).not.toHaveBeenCalled();
  });

  it("logs timeouts, server avatars and boosts from member updates", async () => {
    const before = member({ partial: false, nickname: null, avatar: null, premiumSinceTimestamp: null, communicationDisabledUntilTimestamp: null, displayAvatarURL: () => undefined });
    const after = {
      ...before,
      avatar: "newhash",
      premiumSinceTimestamp: clock,
      communicationDisabledUntilTimestamp: Date.now() + 3_600_000,
      displayAvatarURL: () => "https://cdn.example/server.png",
    };
    await serverLog.memberUpdated(before, after);
    const descriptions = posted().map((embed) => embed.description);
    expect(descriptions.some((text) => text.includes("**Timed out** until"))).toBe(true);
    expect(descriptions.some((text) => text.includes("**Server avatar changed**"))).toBe(true);
    expect(descriptions.some((text) => text.includes("💎 **Started boosting**"))).toBe(true);
  });

  it("logs username changes in every server that shares the member", async () => {
    guild.members.cache.set(USER_ID, member());
    await serverLog.userUpdated({ ...author, username: "old", globalName: null, avatar: null }, { ...author, username: "new", globalName: "New", avatar: null }, [guild]);
    const [embed] = posted();
    expect(embed.description).toContain("**Username:** `old` → `new`");
    expect(embed.description).toContain("**Display name:** *none* → `New`");
  });

  it("posts server changes, but not the bot's own or ones by members with ignored roles", async () => {
    const entry = (executorId) => ({ action: AuditLogEvent.RoleCreate, targetType: "Role", targetId: ROLE_ID, executorId, changes: [{ key: "name", new: "Helpers" }] });
    await serverLog.auditLogEntry(entry(BOT_ID), guild);
    expect(logChannel.send).not.toHaveBeenCalled();
    await serverLog.auditLogEntry(entry(MOD_ID), guild);
    expect(posted()[0].description).toContain("**Role created** · `Helpers`");
    await settings.set(GUILD_ID, Setting.LOG_IGNORED_ROLES, [ROLE_ID]);
    guild.members.cache.set(MOD_ID, { id: MOD_ID, roles: roles(ROLE_ID) });
    await serverLog.auditLogEntry(entry(MOD_ID), guild);
    expect(posted()).toHaveLength(1);
  });

  it("can switch off a single new event", async () => {
    await settings.set(GUILD_ID, Setting.DISABLED_LOG_EVENTS, [LogEvent.VOICE_JOIN]);
    await serverLog.voiceStateUpdated(voice(null), voice(VOICE_ID));
    expect(logChannel.send).not.toHaveBeenCalled();
  });
});
