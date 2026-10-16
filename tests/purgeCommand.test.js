import { Collection, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createPurgeCommand, pickMessagesToPurge } from "../src/commands/purge.js";
import { Status } from "../src/logs/actionLog.js";
import { RecentIds } from "../src/logs/recentIds.js";
import { buildTranscript } from "../src/logs/transcript.js";
import { GuildSettings } from "../src/settings/guildSettings.js";
import { GUILD_ID, MOD_ID, TARGET_ID, fakeMember } from "./helpers/moderationFakes.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function message(id, { authorId = TARGET_ID, ageMs = 1000, pinned = false, content = `message ${id}` } = {}) {
  return {
    id,
    pinned,
    content,
    createdTimestamp: NOW - ageMs,
    author: { id: authorId, tag: `user-${authorId.slice(-2)}` },
    attachments: new Map(),
  };
}

describe("pickMessagesToPurge", () => {
  const messages = [
    message("1"),
    message("2", { pinned: true }),
    message("3", { authorId: MOD_ID }),
    message("4", { ageMs: 15 * DAY }),
    message("5"),
    message("6"),
  ];

  it("skips pinned and old messages and stops at the amount", () => {
    expect(pickMessagesToPurge(messages, { amount: 3, now: NOW }).map((entry) => entry.id)).toEqual(["1", "3", "5"]);
  });

  it("can keep to one member", () => {
    expect(pickMessagesToPurge(messages, { amount: 10, userId: MOD_ID, now: NOW }).map((entry) => entry.id)).toEqual(["3"]);
  });
});

describe("buildTranscript", () => {
  it("lists messages oldest first", () => {
    const text = buildTranscript([message("2", { ageMs: 1000 }), message("1", { ageMs: 5000 })]);
    expect(text.split("\n").map((line) => line.split(": ").at(-1))).toEqual(["message 1", "message 2"]);
    expect(text).toContain(`user-20 (${TARGET_ID})`);
  });
});

describe("/purge", () => {
  function setup({ permissions = [PermissionFlagsBits.ManageMessages], member } = {}) {
    const fetched = [message("1"), message("2", { pinned: true }), message("3")];
    const channel = {
      id: "800000000000000001",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => new Collection(fetched.map((entry) => [entry.id, entry]))) },
      bulkDelete: vi.fn(async (chosen) => new Collection(chosen.map((entry) => [entry.id, entry]))),
    };
    const modLog = { post: vi.fn(async (guild, build) => build({ canAttach: true })) };
    const botDeletions = new RecentIds();
    const command = createPurgeCommand({ guildSettings: new GuildSettings(), modLog, botDeletions, now: () => NOW });
    const moderator = fakeMember(MOD_ID);
    const interaction = {
      locale: "en-US",
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      channel,
      user: moderator.user,
      member: moderator,
      deferred: false,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => permissions.includes(bit) },
      options: { getInteger: () => 10, getUser: () => member ?? null },
      reply: vi.fn(async () => {}),
      deferReply: vi.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: vi.fn(async () => {}),
    };
    return { command, interaction, channel, modLog, botDeletions };
  }

  it("deletes unpinned messages, logs a transcript and skips them in the server log", async () => {
    const { command, interaction, channel, modLog, botDeletions } = setup();
    const outcome = await command.execute(interaction);

    expect(channel.bulkDelete.mock.calls[0][0].map((entry) => entry.id)).toEqual(["1", "3"]);
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "purgeDone", values: { count: 2 } });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Deleted 2 messages." });
    expect(botDeletions.has("1")).toBe(true);
    const built = await modLog.post.mock.results[0].value;
    expect(built.embed.toJSON().description).toContain("Purged 2 messages");
    expect(built.files).toHaveLength(1);
  });

  it("refuses without Manage Messages", async () => {
    const { command, interaction, channel } = setup({ permissions: [] });
    expect(await command.execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "modNoPermission" });
    expect(channel.bulkDelete).not.toHaveBeenCalled();
  });

  it("says when there's nothing to delete", async () => {
    const { command, interaction } = setup({ member: { id: "300000000000000077" } });
    expect(await command.execute(interaction)).toMatchObject({ status: Status.REFUSED, key: "purgeNothing" });
  });

  it("reports missing permissions", async () => {
    const { command, interaction, channel } = setup();
    channel.bulkDelete.mockRejectedValue(Object.assign(new Error("Missing Permissions"), { code: 50013 }));
    expect(await command.execute(interaction)).toMatchObject({ status: Status.FAILED, key: "purgeBotMissingPermission" });
  });
});
