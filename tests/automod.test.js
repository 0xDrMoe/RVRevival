import { PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomod, PUNISH_COOLDOWN_MS } from "../src/automod/automod.js";
import { defaultAutomod, withPath } from "../src/automod/config.js";
import { RecentIds } from "../src/logs/recentIds.js";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";
import { createModerationService } from "../src/moderation/moderationService.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";
import { BOT_ID, fakeMember, GUILD_ID, STAFF_ROLE_ID, TARGET_ID } from "./helpers/moderationFakes.js";

const CHANNEL_ID = "800000000000000001";
const OTHER_GUILD_ID = "900000000000000099";

// Automod with these rules switched on: { rule: { action?, ...settings } }.
function automodWith(rules, extra = {}) {
  let config = { ...defaultAutomod(), enabled: true, ...extra };
  for (const [rule, settings] of Object.entries(rules)) {
    config = withPath(config, ["rules", rule], { ...config.rules[rule], enabled: true, ...settings });
  }
  return config;
}

describe("automod", () => {
  let guildSettings;
  let store;
  let moderation;
  let modLog;
  let botDeletions;
  let automod;
  let clock;
  let member;
  let channel;
  let guild;
  let nextId;

  beforeEach(() => {
    guildSettings = new GuildSettings();
    store = new CaseStore();
    modLog = { postCase: vi.fn(async () => undefined), refreshCase: vi.fn(), post: vi.fn(async () => undefined) };
    clock = 1_700_000_000_000;
    const now = () => clock;
    moderation = createModerationService({ store, modLog, logger: fakeLogger(), now });
    botDeletions = new RecentIds();
    automod = createAutomod({ guildSettings, moderation, modLog, logger: fakeLogger(), botDeletions, now });
    member = Object.assign(fakeMember(TARGET_ID), { moderatable: true, kickable: true, bannable: true });
    channel = {
      id: CHANNEL_ID,
      parentId: null,
      permissionsFor: () => ({ has: () => false }),
      send: vi.fn(async () => ({ delete: vi.fn(async () => {}) })),
      bulkDelete: vi.fn(async () => {}),
      messages: { delete: vi.fn(async () => {}) },
    };
    guild = {
      id: GUILD_ID,
      name: "Rumbleverse",
      preferredLocale: "en-US",
      channels: { cache: new Map([[CHANNEL_ID, channel]]) },
      members: { fetch: vi.fn(async () => member), ban: vi.fn(async () => {}) },
    };
    nextId = 1000;
  });

  afterEach(() => automod.stop());

  function message(content, overrides = {}) {
    nextId += 1;
    return {
      id: String(nextId),
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      content,
      createdTimestamp: clock,
      author: { id: TARGET_ID, bot: false },
      webhookId: null,
      system: false,
      inGuild: () => true,
      member,
      guild,
      channel,
      client: { user: { id: BOT_ID, tag: "RV Bot#0001" }, fetchInvite: vi.fn(async () => ({ guild: { id: OTHER_GUILD_ID } })) },
      delete: vi.fn(async () => {}),
      ...overrides,
    };
  }

  const use = (config) => guildSettings.set(GUILD_ID, Setting.AUTOMOD, config);

  it("does nothing while automod is off", async () => {
    await use({ ...automodWith({ bannedWords: { words: ["noob"] } }), enabled: false });
    const sent = message("noob");
    await automod.handleMessage(sent);
    expect(sent.delete).not.toHaveBeenCalled();
  });

  it("deletes a banned word, tells the member and notes it in the mod log", async () => {
    await use(automodWith({ bannedWords: { words: ["noob"] } }));
    const sent = message("what a NOOB");
    await automod.handleMessage(sent);

    expect(sent.delete).toHaveBeenCalled();
    expect(botDeletions.has(sent.id)).toBe(true);
    expect(channel.send).toHaveBeenCalledWith({
      content: `<@${TARGET_ID}>, that word isn't allowed here.`,
      allowedMentions: { users: [TARGET_ID] },
    });
    expect(modLog.post).toHaveBeenCalledTimes(1);
    const { embed } = modLog.post.mock.calls[0][1]();
    expect(embed.data.description).toContain("**Automod: Banned word**");
    expect(store.countGuildCases(GUILD_ID)).toEqual({});
  });

  it("warns with a case when the rule says so", async () => {
    await use(automodWith({ invites: { action: "warn" } }));
    await automod.handleMessage(message("join discord.gg/other"));

    const [warning] = store.listCases(GUILD_ID, TARGET_ID);
    expect(warning).toMatchObject({ action: CaseAction.WARN, moderatorId: BOT_ID });
    expect(warning.reason).toBe('Automod · Invite link: "join discord.gg/other"');
    expect(member.user.send).toHaveBeenCalled();
  });

  it("allows invites to the same server", async () => {
    await use(automodWith({ invites: {} }));
    const sent = message("discord.gg/home");
    sent.client.fetchInvite.mockResolvedValue({ guild: { id: GUILD_ID } });
    await automod.handleMessage(sent);
    expect(sent.delete).not.toHaveBeenCalled();
  });

  it("times out for mass mentions, for the configured length", async () => {
    await use(automodWith({ mentions: { limit: 3 } }, { timeoutMinutes: 15 }));
    await automod.handleMessage(message("<@1> <@2> <@3> hi"));

    expect(member.timeout).toHaveBeenCalledWith(15 * 60_000, expect.stringContaining("Automod · Mass mention"));
    expect(store.listCases(GUILD_ID, TARGET_ID)[0]).toMatchObject({ action: CaseAction.TIMEOUT });
  });

  it("warns instead of timing out a member the bot can't time out", async () => {
    member.moderatable = false;
    await use(automodWith({ mentions: { limit: 2 } }));
    await automod.handleMessage(message("<@1> <@2>"));
    expect(member.timeout).not.toHaveBeenCalled();
    expect(store.listCases(GUILD_ID, TARGET_ID)[0]).toMatchObject({ action: CaseAction.WARN });
  });

  it("catches spam and deletes the whole burst", async () => {
    await use(automodWith({ spam: { action: "delete", messages: 3, seconds: 5 } }));
    const first = message("a");
    await automod.handleMessage(first);
    clock += 1000;
    await automod.handleMessage(message("b"));
    clock += 1000;
    const third = message("c");
    await automod.handleMessage(third);

    expect(channel.bulkDelete).toHaveBeenCalledWith([first.id, String(Number(first.id) + 1), third.id], true);
    // The count starts again afterwards.
    clock += 500;
    const fourth = message("d");
    await automod.handleMessage(fourth);
    expect(fourth.delete).not.toHaveBeenCalled();
  });

  it("doesn't count messages outside the spam window", async () => {
    await use(automodWith({ spam: { messages: 3, seconds: 5 } }));
    await automod.handleMessage(message("a"));
    clock += 10_000;
    await automod.handleMessage(message("b"));
    await automod.handleMessage(message("c"));
    expect(channel.bulkDelete).not.toHaveBeenCalled();
  });

  it("catches the same message repeated", async () => {
    await use(automodWith({ duplicates: { count: 3 } }));
    await automod.handleMessage(message("BUY GOLD"));
    clock += 20_000;
    await automod.handleMessage(message("buy   gold"));
    clock += 20_000;
    await automod.handleMessage(message("buy gold"));
    expect(channel.bulkDelete).toHaveBeenCalledTimes(1);
    expect(channel.bulkDelete.mock.calls[0][0]).toHaveLength(3);
  });

  it("only punishes once per burst", async () => {
    await use(automodWith({ caps: { action: "warn", minLength: 5 } }));
    await automod.handleMessage(message("STOP THAT NOW"));
    clock += 1000;
    const second = message("I SAID STOP");
    await automod.handleMessage(second);

    expect(second.delete).toHaveBeenCalled();
    expect(store.listCases(GUILD_ID, TARGET_ID)).toHaveLength(1);
    expect(channel.send).toHaveBeenCalledTimes(1);

    clock += PUNISH_COOLDOWN_MS;
    await automod.handleMessage(message("STILL SHOUTING"));
    expect(store.listCases(GUILD_ID, TARGET_ID)).toHaveLength(2);
  });

  it("escalates after enough warnings in 24 hours", async () => {
    await use(
      automodWith({ bannedWords: { action: "warn", words: ["noob"] } }, { escalation: { warnings: 2, action: "kick", timeoutMinutes: 60 } }),
    );
    await automod.handleMessage(message("noob"));
    expect(member.kick).not.toHaveBeenCalled();
    clock += PUNISH_COOLDOWN_MS;
    await automod.handleMessage(message("noob again"));
    expect(member.kick).toHaveBeenCalledWith(expect.stringContaining("Automod: 2 warnings in 24 hours"));
    expect(store.listCases(GUILD_ID, TARGET_ID).map((entry) => entry.action)).toEqual([
      CaseAction.KICK,
      CaseAction.WARN,
      CaseAction.WARN,
    ]);
  });

  it("checks edited messages, but not for spam", async () => {
    await use(automodWith({ links: {}, spam: { messages: 3, seconds: 5 } }));
    const edited = message("now with https://scam.example");
    await automod.handleEdit({ partial: false, content: "hello" }, edited);
    expect(edited.delete).toHaveBeenCalled();

    const same = message("hello");
    await automod.handleEdit({ partial: false, content: "hello" }, same);
    expect(same.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["bots", (sent) => Object.assign(sent, { author: { id: TARGET_ID, bot: true } })],
    ["webhooks", (sent) => Object.assign(sent, { webhookId: "1" })],
    [
      "members with Manage Messages",
      (sent) => Object.assign(sent, { channel: { ...channel, permissionsFor: () => ({ has: (bit) => bit === PermissionFlagsBits.ManageMessages }) } }),
    ],
    ["the mod role", (sent) => Object.assign(sent, { member: fakeMember(TARGET_ID, { roleIds: [STAFF_ROLE_ID] }) })],
  ])("leaves %s alone", async (_name, change) => {
    await guildSettings.set(GUILD_ID, Setting.MOD_ROLE, STAFF_ROLE_ID);
    await use(automodWith({ bannedWords: { words: ["noob"] } }));
    const sent = change(message("noob"));
    await automod.handleMessage(sent);
    expect(sent.delete).not.toHaveBeenCalled();
  });

  it("leaves exempt roles, exempt channels (and their threads) and the /country channel alone", async () => {
    const ROLE = "700000000000000005";
    const CATEGORY = "800000000000000005";
    await use(automodWith({ bannedWords: { words: ["noob"] } }, { exemptRoleIds: [ROLE], exemptChannelIds: [CATEGORY] }));

    const byRole = message("noob", { member: fakeMember(TARGET_ID, { roleIds: [ROLE] }) });
    await automod.handleMessage(byRole);
    const inThread = message("noob", { channelId: "1", channel: { ...channel, id: "1", parentId: "2", parent: { parentId: CATEGORY } } });
    await automod.handleMessage(inThread);
    await guildSettings.set(GUILD_ID, Setting.COUNTRY_CHANNEL, CHANNEL_ID);
    const inCountry = message("noob");
    await automod.handleMessage(inCountry);

    for (const sent of [byRole, inThread, inCountry]) {
      expect(sent.delete).not.toHaveBeenCalled();
    }
  });

  it("keeps going when it can't delete", async () => {
    await use(automodWith({ bannedWords: { action: "warn", words: ["noob"] } }));
    const sent = message("noob", { delete: vi.fn(async () => Promise.reject(Object.assign(new Error("Missing Permissions"), { code: 50013 }))) });
    await automod.handleMessage(sent);
    expect(store.listCases(GUILD_ID, TARGET_ID)).toHaveLength(1);
  });
});
