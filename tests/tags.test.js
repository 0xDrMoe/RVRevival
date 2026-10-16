import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildTagsCommandData, createTagCommands } from "../src/commands/tags.js";
import { cleanTagContent, cleanTagName, MAX_TAGS } from "../src/community/tags.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const USER_ID = "300000000000000020";
const OTHER_ID = "300000000000000030";
const MOD_ROLE_ID = "700000000000000001";

function fakeInteraction({ subcommand, name, user = null, content, customId, manageMessages = true, roleIds = [] } = {}) {
  return {
    locale: "en-US",
    guildId: GUILD_ID,
    user: { id: USER_ID },
    member: { roles: { cache: new Map(roleIds.map((id) => [id, {}])) } },
    customId,
    inCachedGuild: () => true,
    memberPermissions: { has: (bit) => manageMessages && bit === PermissionFlagsBits.ManageMessages },
    options: {
      getSubcommand: () => subcommand,
      getString: () => name,
      getUser: () => user,
      getFocused: () => name ?? "",
    },
    fields: { getTextInputValue: () => content },
    reply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
  };
}

function setup() {
  const guildSettings = new GuildSettings();
  let time = 1_000_000;
  const [tag, tags] = createTagCommands({ guildSettings, now: () => time });
  const form = tags.componentPrefixes["tagform:"].handle;
  return {
    guildSettings,
    tag,
    tags,
    form,
    later: (ms) => (time += ms),
    saved: () => guildSettings.get(GUILD_ID, Setting.TAGS),
    // Runs /tags add, then sends the form.
    add: async (name, content) => {
      const opened = fakeInteraction({ subcommand: "add", name });
      await tags.execute(opened);
      const modal = opened.showModal.mock.calls[0]?.[0]?.toJSON();
      return form(fakeInteraction({ customId: modal?.custom_id, content }));
    },
  };
}

describe("tag helpers", () => {
  it("cleans names", () => {
    expect(cleanTagName("  Download Link ")).toBe("download-link");
    expect(cleanTagName("faq-2")).toBe("faq-2");
    expect(cleanTagName("ayuda-año")).toBe("ayuda-año");
    expect(cleanTagName("bad:name")).toBeUndefined();
    expect(cleanTagName("x".repeat(33))).toBeUndefined();
    expect(cleanTagName("   ")).toBeUndefined();
  });

  it("cleans content", () => {
    expect(cleanTagContent("  line 1\r\nline 2  ")).toBe("line 1\nline 2");
  });
});

describe("/tags", () => {
  it("is hidden from members without Manage Messages", () => {
    const data = buildTagsCommandData();
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageMessages.toString());
    expect(data.options.map((option) => option.name)).toEqual(["add", "edit", "remove", "list"]);
  });

  it("adds a tag through the form", async () => {
    const { add, saved } = setup();
    const outcome = await add("Download", "  Get the game at https://example.com\r\nHave fun!  ");
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "tagsAdded" });
    expect(saved()).toEqual([{ name: "download", content: "Get the game at https://example.com\nHave fun!" }]);
  });

  it("refuses bad names, duplicates and a full list", async () => {
    const { add, tags, guildSettings } = setup();
    const bad = fakeInteraction({ subcommand: "add", name: "no:colons" });
    expect((await tags.execute(bad)).key).toBe("tagsBadName");
    expect(bad.showModal).not.toHaveBeenCalled();

    await add("faq", "Read the FAQ");
    const again = fakeInteraction({ subcommand: "add", name: "FAQ" });
    expect((await tags.execute(again)).key).toBe("tagsExists");

    await guildSettings.set(
      GUILD_ID,
      Setting.TAGS,
      Array.from({ length: MAX_TAGS }, (_, index) => ({ name: `t${index}`, content: "x" })),
    );
    expect((await tags.execute(fakeInteraction({ subcommand: "add", name: "one-more" }))).key).toBe("tagsFull");
  });

  it("re-checks for duplicates when the form is sent", async () => {
    const { tags, form, guildSettings } = setup();
    const opened = fakeInteraction({ subcommand: "add", name: "rules" });
    await tags.execute(opened);
    await guildSettings.set(GUILD_ID, Setting.TAGS, [{ name: "rules", content: "Someone else's" }]);
    const customId = opened.showModal.mock.calls[0][0].toJSON().custom_id;
    expect((await form(fakeInteraction({ customId, content: "Mine" }))).key).toBe("tagsExists");
  });

  it("edits with the current text filled in, and removes", async () => {
    const { add, tags, form, saved } = setup();
    await add("faq", "Old text");
    const opened = fakeInteraction({ subcommand: "edit", name: "faq" });
    await tags.execute(opened);
    const modal = opened.showModal.mock.calls[0][0].toJSON();
    expect(JSON.stringify(modal)).toContain("Old text");
    expect((await form(fakeInteraction({ customId: modal.custom_id, content: "New text" }))).key).toBe("tagsEdited");
    expect(saved()).toEqual([{ name: "faq", content: "New text" }]);

    expect((await tags.execute(fakeInteraction({ subcommand: "remove", name: "faq" }))).key).toBe("tagsRemoved");
    expect(saved()).toBeUndefined();
  });

  it("lets the mod role manage tags without Manage Messages, and refuses everyone else", async () => {
    const { tags, guildSettings } = setup();
    expect((await tags.execute(fakeInteraction({ subcommand: "list", manageMessages: false }))).key).toBe("modNoPermission");
    await guildSettings.set(GUILD_ID, Setting.MOD_ROLE, MOD_ROLE_ID);
    const outcome = await tags.execute(fakeInteraction({ subcommand: "list", manageMessages: false, roleIds: [MOD_ROLE_ID] }));
    expect(outcome.key).toBe("tagsListEmpty");
  });

  it("refuses a form sent by someone who can't manage tags", async () => {
    const { form, saved } = setup();
    const outcome = await form(fakeInteraction({ customId: "tagform:add:faq", content: "x", manageMessages: false }));
    expect(outcome.key).toBe("modNoPermission");
    expect(saved()).toBeUndefined();
  });

  it("lists tags", async () => {
    const { add, tags } = setup();
    await add("rules", "a");
    await add("download", "b");
    const interaction = fakeInteraction({ subcommand: "list" });
    await tags.execute(interaction);
    expect(interaction.reply.mock.calls[0][0].content).toContain("`download`, `rules`");
  });
});

describe("/tag", () => {
  it("posts the tag publicly, pinging only the chosen member", async () => {
    const { add, tag } = setup();
    await add("download", "Get it at https://example.com @everyone");
    const interaction = fakeInteraction({ name: "download", user: { id: OTHER_ID } });
    const outcome = await tag.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: `<@${OTHER_ID}>\nGet it at https://example.com @everyone`,
      allowedMentions: { users: [OTHER_ID] },
    });
    expect(outcome.status).toBe(Status.SUCCESS);
  });

  it("answers privately when the tag doesn't exist", async () => {
    const { tag } = setup();
    const interaction = fakeInteraction({ name: "nope" });
    expect((await tag.execute(interaction)).key).toBe("tagNotFound");
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
  });

  it("has a short cooldown per member", async () => {
    const { add, tag, later } = setup();
    await add("faq", "Read the FAQ");
    await tag.execute(fakeInteraction({ name: "faq" }));
    expect((await tag.execute(fakeInteraction({ name: "faq" }))).key).toBe("tagCooldown");
    later(5000);
    expect((await tag.execute(fakeInteraction({ name: "faq" }))).status).toBe(Status.SUCCESS);
  });

  it("suggests tags by name", async () => {
    const { add, tag } = setup();
    await add("download", "a");
    await add("bug-report", "b");
    const interaction = fakeInteraction({ name: "bug" });
    await tag.autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "bug-report", value: "bug-report" }]);
  });
});
