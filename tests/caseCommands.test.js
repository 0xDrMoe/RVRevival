import { PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaseCommand, createClearWarnsCommand, createModlogsCommand } from "../src/commands/cases.js";
import { Status } from "../src/logs/actionLog.js";
import { CaseAction, CaseStore } from "../src/moderation/caseStore.js";
import { createModerationService } from "../src/moderation/moderationService.js";
import { GuildSettings } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";
import { GUILD_ID, MOD_ID, TARGET_ID, fakeMember, fakeUser } from "./helpers/moderationFakes.js";

function fakeInteraction({ subcommand, number, reason, user, permissions = [PermissionFlagsBits.ModerateMembers], locale = "en-US" }) {
  const moderator = fakeMember(MOD_ID);
  return {
    locale,
    guildId: GUILD_ID,
    guild: { id: GUILD_ID },
    user: moderator.user,
    member: moderator,
    inCachedGuild: () => true,
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    options: {
      getSubcommand: () => subcommand,
      getInteger: () => number,
      getString: () => reason,
      getUser: () => user,
    },
    reply: vi.fn(async () => {}),
  };
}

describe("/case and /modlogs", () => {
  let store;
  let moderation;
  let modLog;
  let caseCommand;
  let modlogsCommand;

  beforeEach(() => {
    store = new CaseStore();
    modLog = { postCase: vi.fn(async () => {}), refreshCase: vi.fn(async () => true), post: vi.fn() };
    moderation = createModerationService({ store, modLog, logger: fakeLogger() });
    const options = { guildSettings: new GuildSettings(), moderation };
    caseCommand = createCaseCommand(options);
    modlogsCommand = createModlogsCommand(options);
    for (const action of [CaseAction.WARN, CaseAction.TIMEOUT, CaseAction.BAN]) {
      store.createCase({ guildId: GUILD_ID, action, userId: TARGET_ID, moderatorId: MOD_ID, reason: `${action} reason` });
    }
  });

  afterEach(() => store.close());

  it("shows a case in the moderator's language", async () => {
    const interaction = fakeInteraction({ subcommand: "view", number: 2, locale: "fr" });
    expect(await caseCommand.execute(interaction)).toMatchObject({ status: Status.SUCCESS });
    expect(interaction.reply.mock.calls[0][0].embeds[0].toJSON().title).toBe("Cas 2 · Exclusion");
  });

  it("says when a case doesn't exist", async () => {
    const interaction = fakeInteraction({ subcommand: "view", number: 99 });
    expect(await caseCommand.execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "caseNotFound" });
  });

  it("changes a reason and refreshes the mod-log post", async () => {
    const interaction = fakeInteraction({ subcommand: "reason", number: 1, reason: "  repeated spam " });
    expect(await caseCommand.execute(interaction)).toMatchObject({ status: Status.SUCCESS, key: "caseReasonUpdated" });
    expect(store.getCase(GUILD_ID, 1).reason).toBe("repeated spam");
    expect(modLog.refreshCase).toHaveBeenCalledTimes(1);
  });

  it("only lets Manage Server delete cases", async () => {
    const mod = fakeInteraction({ subcommand: "delete", number: 1 });
    expect(await caseCommand.execute(mod)).toMatchObject({ status: Status.REFUSED, key: "caseDeleteNoPermission" });

    const admin = fakeInteraction({
      subcommand: "delete",
      number: 1,
      permissions: [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageGuild],
    });
    expect(await caseCommand.execute(admin)).toMatchObject({ status: Status.SUCCESS, key: "caseDeleted" });
    expect(store.getCase(GUILD_ID, 1)).toBeUndefined();
  });

  it("refuses members who can't moderate", async () => {
    const interaction = fakeInteraction({ subcommand: "view", number: 1, permissions: [] });
    expect(await caseCommand.execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "modNoPermission" });
  });

  it("lists a member's history, newest first", async () => {
    const interaction = fakeInteraction({ user: fakeUser(TARGET_ID, { tag: "member" }) });
    await modlogsCommand.execute(interaction);
    const embed = interaction.reply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe("Moderation history of member");
    expect(embed.description.split("\n").map((line) => line.split(" · ")[0])).toEqual([
      "**#3** Ban",
      "**#2** Timeout",
      "**#1** Warning",
    ]);
  });

  it("says when a member has no cases", async () => {
    const interaction = fakeInteraction({ user: fakeUser("300000000000000055") });
    expect(await modlogsCommand.execute(interaction)).toMatchObject({ key: "modlogsNone" });
  });
});

describe("/clearwarns", () => {
  let store;
  let modLog;
  let command;

  beforeEach(() => {
    store = new CaseStore();
    modLog = { post: vi.fn(async () => {}) };
    command = createClearWarnsCommand({ moderation: createModerationService({ store, logger: fakeLogger() }), modLog });
    for (const action of [CaseAction.WARN, CaseAction.WARN, CaseAction.BAN]) {
      store.createCase({ guildId: GUILD_ID, action, userId: TARGET_ID, moderatorId: MOD_ID });
    }
  });

  afterEach(() => store.close());

  const admin = [PermissionFlagsBits.ManageGuild];

  it("deletes only the member's warnings and posts it in the mod log", async () => {
    const interaction = fakeInteraction({ user: fakeUser(TARGET_ID), permissions: admin });
    expect(await command.execute(interaction)).toMatchObject({ status: Status.SUCCESS, key: "clearwarnsDone", values: { count: 2 } });
    expect(store.listCases(GUILD_ID, TARGET_ID).map((entry) => entry.action)).toEqual([CaseAction.BAN]);
    expect(modLog.post).toHaveBeenCalledTimes(1);

    const again = fakeInteraction({ user: fakeUser(TARGET_ID), permissions: admin });
    expect(await command.execute(again)).toMatchObject({ status: Status.REFUSED, key: "clearwarnsNone" });
  });

  it("is only for Manage Server", async () => {
    const interaction = fakeInteraction({ user: fakeUser(TARGET_ID) });
    expect(await command.execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "caseDeleteNoPermission" });
    expect(store.listCases(GUILD_ID, TARGET_ID)).toHaveLength(3);
  });
});
