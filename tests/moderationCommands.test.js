import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModerationCommands, MAX_TIMEOUT_MS } from "../src/commands/moderation.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { CaseStore } from "../src/moderation/caseStore.js";
import { createModerationService } from "../src/moderation/moderationService.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";
import {
  GUILD_ID,
  MOD_ID,
  OWNER_ID,
  STAFF_ROLE_ID,
  TARGET_ID,
  fakeGuild,
  fakeMember,
  fakeUser,
} from "./helpers/moderationFakes.js";

const ALL_MOD_PERMISSIONS = [
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
];

// A fake /<command> interaction. `options` holds the typed values; `target` is
// the member picked (or null when the user isn't in the server).
function fakeInteraction(commandName, guild, { options = {}, target, targetUser, permissions = ALL_MOD_PERMISSIONS, moderatorPosition = 10, roleIds = [], locale = "en-US" } = {}) {
  const moderatorMember = fakeMember(MOD_ID, { position: moderatorPosition, roleIds });
  const user = targetUser ?? target?.user;
  const interaction = {
    commandName,
    locale,
    guildId: GUILD_ID,
    guild,
    user: moderatorMember.user,
    member: moderatorMember,
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    options: {
      getUser: () => user,
      getMember: () => target ?? null,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
  };
  return interaction;
}

// What the moderator was finally told.
function lastAnswer(interaction) {
  const call = interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1);
  return call[0].content;
}

describe("moderation commands", () => {
  let store;
  let guildSettings;
  let guild;
  let commands;

  beforeEach(() => {
    store = new CaseStore();
    guildSettings = new GuildSettings();
    guild = fakeGuild();
    const moderation = createModerationService({ store, logger: fakeLogger() });
    commands = new Map(
      createModerationCommands({ guildSettings, moderation, logger: fakeLogger() }).map((command) => [command.name, command]),
    );
  });

  afterEach(() => store.close());

  it("defines ban, unban, kick, timeout, untimeout and warn, hidden behind their permission", () => {
    expect([...commands.keys()]).toEqual(["ban", "unban", "kick", "timeout", "untimeout", "warn"]);
    expect(commands.get("ban").data.default_member_permissions).toBe(PermissionFlagsBits.BanMembers.toString());
    expect(commands.get("kick").data.default_member_permissions).toBe(PermissionFlagsBits.KickMembers.toString());
    expect(commands.get("warn").data.options.find((option) => option.name === "reason").required).toBe(true);
    const deleteChoices = commands.get("ban").data.options.find((option) => option.name === "delete-messages").choices;
    expect(deleteChoices.map((choice) => choice.value)).toEqual([0, 3600, 86400, 259200, 604800]);
  });

  it("bans a member and replies privately with the case number", async () => {
    const target = fakeMember(TARGET_ID, { position: 2 });
    const interaction = fakeInteraction("ban", guild, { target, options: { reason: "cheating" } });

    const outcome = await commands.get("ban").execute(interaction);

    expect(guild.members.ban).toHaveBeenCalledWith(TARGET_ID, { reason: "cheating (by user-10)", deleteMessageSeconds: 0 });
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(lastAnswer(interaction)).toBe(`Case #1: banned <@${TARGET_ID}>.`);
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "modBanned" });
  });

  it("bans someone who isn't in the server, for a while", async () => {
    const interaction = fakeInteraction("ban", guild, { targetUser: fakeUser(TARGET_ID), options: { duration: "7d" } });
    await commands.get("ban").execute(interaction);
    expect(lastAnswer(interaction)).toMatch(new RegExp(`^Case #1: banned <@${TARGET_ID}> until <t:\\d+:f>\\.$`));
    expect(store.getCase(GUILD_ID, 1).pendingUnban).toBe(true);
  });

  it("refuses a bad ban duration and someone already banned", async () => {
    const bad = fakeInteraction("ban", guild, { targetUser: fakeUser(TARGET_ID), options: { duration: "forever" } });
    expect(await commands.get("ban").execute(bad)).toMatchObject({ status: Status.REFUSED, key: "modInvalidDuration" });

    guild.banned.add(TARGET_ID);
    const again = fakeInteraction("ban", guild, { targetUser: fakeUser(TARGET_ID) });
    expect(await commands.get("ban").execute(again)).toMatchObject({ status: Status.REFUSED, key: "modAlreadyBanned" });
    expect(guild.members.ban).not.toHaveBeenCalled();
  });

  it("refuses members without the permission or the staff role", async () => {
    const target = fakeMember(TARGET_ID);
    const interaction = fakeInteraction("kick", guild, { target, permissions: [] });
    const outcome = await commands.get("kick").execute(interaction);
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "modNoPermission" });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You need the **Kick Members** permission or the staff role to use this command.",
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(target.kick).not.toHaveBeenCalled();
  });

  it("lets the staff role moderate without the Discord permission", async () => {
    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, STAFF_ROLE_ID);
    const target = fakeMember(TARGET_ID, { position: 2 });
    const interaction = fakeInteraction("kick", guild, { target, permissions: [], roleIds: [STAFF_ROLE_ID] });
    expect(await commands.get("kick").execute(interaction)).toMatchObject({ status: Status.SUCCESS, key: "modKicked" });
    expect(target.kick).toHaveBeenCalled();
  });

  it("refuses members at or above the moderator, before deferring", async () => {
    const target = fakeMember(TARGET_ID, { position: 10 });
    const interaction = fakeInteraction("kick", guild, { target });
    expect(await commands.get("kick").execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "modTargetHigher" });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(lastAnswer(interaction)).toBe(translate("en", "modTargetHigher", { user: `<@${TARGET_ID}>` }));
  });

  it("refuses the server owner", async () => {
    const interaction = fakeInteraction("warn", guild, { target: fakeMember(OWNER_ID), options: { reason: "x" } });
    expect(await commands.get("warn").execute(interaction)).toMatchObject({ key: "modOwner" });
  });

  it("refuses kicking someone who isn't in the server", async () => {
    const interaction = fakeInteraction("kick", guild, { targetUser: fakeUser(TARGET_ID) });
    expect(await commands.get("kick").execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "modMemberNotFound" });
  });

  it("times out for a valid duration only", async () => {
    const target = fakeMember(TARGET_ID, { position: 2 });
    const tooLong = fakeInteraction("timeout", guild, { target, options: { duration: "29d" } });
    expect(await commands.get("timeout").execute(tooLong)).toMatchObject({ key: "modInvalidDuration", values: { max: "28d" } });

    const ok = fakeInteraction("timeout", guild, { target, options: { duration: "1h" } });
    expect(await commands.get("timeout").execute(ok)).toMatchObject({ status: Status.SUCCESS, key: "modTimedOut" });
    expect(target.timeout).toHaveBeenCalledWith(3_600_000, "No reason given (by user-10)");
    expect(MAX_TIMEOUT_MS).toBe(28 * 86_400_000);
  });

  it("only ends a timeout that is running", async () => {
    const free = fakeInteraction("untimeout", guild, { target: fakeMember(TARGET_ID, { position: 2 }) });
    expect(await commands.get("untimeout").execute(free)).toMatchObject({ key: "modNotTimedOut" });

    const target = fakeMember(TARGET_ID, { position: 2, timedOutUntil: Date.now() + 60_000 });
    const muted = fakeInteraction("untimeout", guild, { target });
    expect(await commands.get("untimeout").execute(muted)).toMatchObject({ key: "modUntimedOut" });
  });

  it("warns, and says when the DM didn't arrive", async () => {
    const target = fakeMember(TARGET_ID, { position: 2, dmFails: true });
    const interaction = fakeInteraction("warn", guild, { target, options: { reason: "spam" } });
    await commands.get("warn").execute(interaction);
    expect(lastAnswer(interaction)).toBe(`Case #1: warned <@${TARGET_ID}>.\n${translate("en", "modDmFailed")}`);
  });

  it("unbans, or says the user isn't banned", async () => {
    const notBanned = fakeInteraction("unban", guild, { targetUser: fakeUser(TARGET_ID) });
    expect(await commands.get("unban").execute(notBanned)).toMatchObject({ status: Status.REFUSED, key: "modNotBanned" });

    guild.banned.add(TARGET_ID);
    const banned = fakeInteraction("unban", guild, { targetUser: fakeUser(TARGET_ID) });
    expect(await commands.get("unban").execute(banned)).toMatchObject({ status: Status.SUCCESS, key: "modUnbanned" });
  });

  it("reports a missing bot permission instead of crashing", async () => {
    const target = fakeMember(TARGET_ID, { position: 2 });
    target.kick.mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    const interaction = fakeInteraction("kick", guild, { target });
    expect(await commands.get("kick").execute(interaction)).toMatchObject({ status: Status.FAILED, key: "modBotMissingPermission" });
    expect(store.getCase(GUILD_ID, 1)).toBeUndefined();
  });

  it("replies in the moderator's language", async () => {
    const interaction = fakeInteraction("kick", guild, { target: fakeMember(TARGET_ID, { position: 2 }), locale: "es-ES" });
    await commands.get("kick").execute(interaction);
    expect(lastAnswer(interaction)).toBe(`Caso #1: <@${TARGET_ID}> expulsado.`);
  });
});
