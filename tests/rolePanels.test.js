import { ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildRolePanelCommandData, createRolePanelCommand } from "../src/commands/rolePanel.js";
import { createRolePanelWizard, parseWizardId, SESSION_IDLE_MS, wizardId } from "../src/commands/rolePanelWizard.js";
import { buildPanelMessage, buttonId, cleanEmoji, PanelMode, parseButtonId, roleProblem } from "../src/community/rolePanels.js";
import { translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "300000000000000000";
const ADMIN_ID = "300000000000000010";
const USER_ID = "300000000000000020";
const CHANNEL_ID = "800000000000000001";
const PC_ROLE = "700000000000000001";
const CONSOLE_ROLE = "700000000000000002";
const MOD_ROLE = "700000000000000003";
const HIGH_ROLE = "700000000000000004";

const noPermissions = { has: () => false };
const role = (id, name, position, overrides = {}) => ({ id, name, position, managed: false, permissions: noPermissions, ...overrides });

function fakeGuild({ canManageRoles = true, features = [] } = {}) {
  const sent = [];
  const messages = new Map();
  const channel = {
    id: CHANNEL_ID,
    isTextBased: () => true,
    send: vi.fn(async (payload) => {
      const message = { id: `5000000000000000${sent.length + 10}`, payload, edit: vi.fn(async (next) => (message.payload = next)) };
      sent.push(message);
      messages.set(message.id, message);
      return message;
    }),
    messages: {
      fetch: vi.fn(async (id) => {
        if (!messages.has(id)) {
          throw new Error("Unknown Message");
        }
        return messages.get(id);
      }),
      delete: vi.fn(async (id) => messages.delete(id)),
    },
  };
  return {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    features,
    preferredLocale: "en-US",
    sent,
    channel,
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    roles: {
      cache: new Map(
        [
          role(PC_ROLE, "PC", 5),
          role(CONSOLE_ROLE, "Console", 6),
          role(MOD_ROLE, "Mod", 7, { permissions: { has: (bit) => bit === PermissionFlagsBits.BanMembers } }),
          role(HIGH_ROLE, "High", 60),
        ].map((entry) => [entry.id, entry]),
      ),
    },
    members: {
      me: {
        roles: { highest: { position: 50 } },
        permissions: { has: (bit) => canManageRoles || bit !== PermissionFlagsBits.ManageRoles },
      },
    },
  };
}

function fakeMember(id, position, roleIds = []) {
  const roles = new Set(roleIds);
  return {
    id,
    owned: roles,
    roles: {
      highest: { position },
      cache: { has: (roleId) => roles.has(roleId) },
      add: vi.fn(async (ids) => [ids].flat().forEach((roleId) => roles.add(roleId))),
      remove: vi.fn(async (ids) => [ids].flat().forEach((roleId) => roles.delete(roleId))),
    },
  };
}

describe("role panel helpers", () => {
  it("accepts emojis and rejects text", () => {
    expect(cleanEmoji("🖥️")).toBe("🖥️");
    expect(cleanEmoji(" 🇨🇦 ")).toBe("🇨🇦");
    expect(cleanEmoji("<:rumble:123456789012345678>")).toBe("<:rumble:123456789012345678>");
    expect(cleanEmoji("<a:dance:123456789012345678>")).toBe("<a:dance:123456789012345678>");
    expect(cleanEmoji("pc")).toBeUndefined();
    expect(cleanEmoji("🖥️ PC")).toBeUndefined();
    expect(cleanEmoji("")).toBeUndefined();
  });

  it("round-trips button IDs", () => {
    expect(parseButtonId(buttonId(3, PC_ROLE))).toEqual({ panelId: 3, roleId: PC_ROLE });
    expect(parseButtonId("rp:x:1")).toBeUndefined();
    expect(parseButtonId("country:help")).toBeUndefined();
  });

  it("refuses roles members must not give themselves", () => {
    const guild = fakeGuild();
    const bot = guild.members.me;
    const admin = fakeMember(ADMIN_ID, 6);
    const check = (id) => roleProblem(guild.roles.cache.get(id) ?? role(id, "x", 1), { guild, admin, bot });
    expect(check(PC_ROLE)).toBeUndefined();
    expect(check(GUILD_ID)).toBe("rolePanelEveryone");
    expect(check(MOD_ROLE)).toBe("rolePanelDangerous");
    expect(check(HIGH_ROLE)).toBe("rolePanelAboveBot");
    expect(check(CONSOLE_ROLE)).toBe("rolePanelAboveYou");
    expect(roleProblem(role("1", "Bot role", 2, { managed: true }), { guild, admin, bot })).toBe("rolePanelManaged");
    // The owner can add roles above their own top role.
    expect(roleProblem(guild.roles.cache.get(CONSOLE_ROLE), { guild, admin: fakeMember(OWNER_ID, 1), bot })).toBeUndefined();
  });

  it("builds rows of at most five buttons", () => {
    const guild = fakeGuild();
    const roles = Array.from({ length: 7 }, (_, index) => ({ roleId: PC_ROLE, emoji: index === 0 ? "🖥️" : null, label: index === 0 ? null : `R${index}` }));
    const message = buildPanelMessage({ id: 2, title: "Platforms", description: "", mode: PanelMode.TOGGLE, roles }, guild, "Empty");
    expect(message.components.map((row) => row.components.length)).toEqual([5, 2]);
    const first = message.components[0].components[0].toJSON();
    expect(first).toMatchObject({ custom_id: `rp:2:${PC_ROLE}`, label: "PC", style: ButtonStyle.Secondary });
    expect(first.emoji).toMatchObject({ name: "🖥️" });
    expect(message.allowedMentions).toEqual({ parse: [] });
  });

  it("shows a hint on an empty panel", () => {
    const message = buildPanelMessage({ id: 1, title: "T", description: "", roles: [] }, fakeGuild(), "No roles yet");
    expect(message.embeds[0].toJSON().description).toBe("No roles yet");
  });
});

describe("/rolepanel", () => {
  function fakeInteraction(guild, subcommand, { options = {}, member = fakeMember(ADMIN_ID, 40), canManageRoles = true } = {}) {
    const interaction = {
      locale: "en-US",
      guildId: GUILD_ID,
      guild,
      member,
      deferred: false,
      replied: false,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => canManageRoles && bit === PermissionFlagsBits.ManageRoles },
      options: {
        getSubcommand: () => subcommand,
        getChannel: () => guild.channel,
        getString: (name) => options[name] ?? null,
        getInteger: () => options.panel,
        getRole: () => guild.roles.cache.get(options.role) ?? role(options.role, "x", 1),
        getFocused: () => options.focused ?? "",
      },
      reply: vi.fn(async () => (interaction.replied = true)),
      deferReply: vi.fn(async () => (interaction.deferred = true)),
      editReply: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
    };
    return interaction;
  }

  const setup = () => {
    const guildSettings = new GuildSettings();
    const command = createRolePanelCommand({ guildSettings, logger: fakeLogger() });
    const guild = fakeGuild();
    const run = async (subcommand, options) => {
      const interaction = fakeInteraction(guild, subcommand, options);
      const outcome = await command.execute(interaction);
      return { interaction, outcome };
    };
    return { guildSettings, command, guild, run, panels: () => guildSettings.get(GUILD_ID, Setting.ROLE_PANELS) };
  };

  it("is hidden from members without Manage Roles", () => {
    const data = buildRolePanelCommandData();
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.ManageRoles.toString());
    expect(data.options.map((option) => option.name)).toEqual(["setup", "create", "add", "remove", "delete", "list"]);
  });

  it("refuses members without Manage Roles", async () => {
    const { command, guild } = setup();
    const outcome = await command.execute(fakeInteraction(guild, "list", { canManageRoles: false }));
    expect(outcome.status).toBe(Status.REFUSED);
  });

  it("recommends Onboarding when creating a panel on a Community server", async () => {
    const { run, guild } = setup();
    const tip = translate("en", "rolePanelOnboardingTip");
    const plain = await run("create", { options: { title: "Roles" } });
    expect(plain.interaction.editReply.mock.calls[0][0].content).not.toContain(tip);
    guild.features = ["COMMUNITY"];
    const community = await run("create", { options: { title: "More roles" } });
    expect(community.interaction.editReply.mock.calls[0][0].content).toContain(tip);
    expect(community.outcome.key).toBe("rolePanelCreated");
  });

  it("creates a panel, adds and removes buttons and edits the same message", async () => {
    const { run, guild, panels } = setup();
    const created = await run("create", { options: { title: "Platforms", description: "Pick\\nyours", mode: "unique" } });
    expect(created.outcome).toMatchObject({ status: Status.SUCCESS, key: "rolePanelCreated" });
    expect(panels()).toEqual([
      { id: 1, channelId: CHANNEL_ID, messageId: guild.sent[0].id, title: "Platforms", description: "Pick\nyours", mode: "unique", roles: [] },
    ]);

    await run("add", { options: { panel: 1, role: PC_ROLE, emoji: "🖥️" } });
    await run("add", { options: { panel: 1, role: CONSOLE_ROLE, label: "Consoles" } });
    expect(panels()[0].roles).toEqual([
      { roleId: PC_ROLE, emoji: "🖥️", label: null },
      { roleId: CONSOLE_ROLE, emoji: null, label: "Consoles" },
    ]);
    expect(guild.sent).toHaveLength(1);
    expect(guild.sent[0].payload.components[0].components).toHaveLength(2);

    await run("remove", { options: { panel: 1, role: PC_ROLE } });
    expect(panels()[0].roles.map((entry) => entry.roleId)).toEqual([CONSOLE_ROLE]);
  });

  it("refuses dangerous roles and bad emojis", async () => {
    const { run } = setup();
    await run("create", { options: { title: "Roles" } });
    expect((await run("add", { options: { panel: 1, role: MOD_ROLE } })).outcome.key).toBe("rolePanelDangerous");
    expect((await run("add", { options: { panel: 1, role: PC_ROLE, emoji: "hello" } })).outcome.key).toBe("rolePanelBadEmoji");
    expect((await run("add", { options: { panel: 9, role: PC_ROLE } })).outcome.key).toBe("rolePanelNotFound");
  });

  it("posts the panel again if its message was deleted", async () => {
    const { run, guild, panels } = setup();
    await run("create", { options: { title: "Roles" } });
    guild.channel.messages.delete(guild.sent[0].id);
    await run("add", { options: { panel: 1, role: PC_ROLE } });
    expect(guild.sent).toHaveLength(2);
    expect(panels()[0].messageId).toBe(guild.sent[1].id);
  });

  it("deletes a panel and its message", async () => {
    const { run, guild, panels } = setup();
    await run("create", { options: { title: "Roles" } });
    await run("delete", { options: { panel: 1 } });
    expect(guild.channel.messages.delete).toHaveBeenCalledWith(guild.sent[0].id);
    expect(panels()).toBeUndefined();
  });

  it("suggests panels by title", async () => {
    const { run, command, guild } = setup();
    await run("create", { options: { title: "Platforms" } });
    await run("create", { options: { title: "Regions" } });
    const interaction = fakeInteraction(guild, "add", { options: { focused: "reg" } });
    await command.autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "#2 Regions", value: 2 }]);
  });

  describe("buttons", () => {
    async function withPanel(mode) {
      const context = setup();
      await context.run("create", { options: { title: "Roles", mode } });
      await context.run("add", { options: { panel: 1, role: PC_ROLE } });
      await context.run("add", { options: { panel: 1, role: CONSOLE_ROLE } });
      const handle = context.command.componentPrefixes["rp:"].handle;
      const click = async (roleId, member) => {
        const interaction = fakeInteraction(context.guild, null, { member });
        interaction.customId = buttonId(1, roleId);
        const outcome = await handle(interaction);
        return { outcome, reply: interaction.reply.mock.calls[0][0] };
      };
      return { ...context, click };
    }

    it("toggles a role on and off", async () => {
      const { click } = await withPanel("toggle");
      const member = fakeMember(USER_ID, 1, [CONSOLE_ROLE]);
      const first = await click(PC_ROLE, member);
      expect(first.outcome.key).toBe("rolePanelYouGot");
      expect(first.reply.flags).toBe(MessageFlags.Ephemeral);
      expect([...member.owned].sort()).toEqual([PC_ROLE, CONSOLE_ROLE].sort());
      expect((await click(PC_ROLE, member)).outcome.key).toBe("rolePanelYouLost");
      expect([...member.owned]).toEqual([CONSOLE_ROLE]);
    });

    it("swaps roles in unique mode", async () => {
      const { click } = await withPanel("unique");
      const member = fakeMember(USER_ID, 1, [CONSOLE_ROLE]);
      const { outcome } = await click(PC_ROLE, member);
      expect(outcome.key).toBe("rolePanelYouSwapped");
      expect([...member.owned]).toEqual([PC_ROLE]);
    });

    it("answers buttons whose role was removed from the panel", async () => {
      const { click, run } = await withPanel("toggle");
      await run("remove", { options: { panel: 1, role: PC_ROLE } });
      const member = fakeMember(USER_ID, 1);
      expect((await click(PC_ROLE, member)).outcome.key).toBe("rolePanelButtonGone");
      expect(member.roles.add).not.toHaveBeenCalled();
    });

    it("won't give a role that became dangerous", async () => {
      const { click, guild } = await withPanel("toggle");
      guild.roles.cache.get(PC_ROLE).permissions = { has: (bit) => bit === PermissionFlagsBits.Administrator };
      const member = fakeMember(USER_ID, 1);
      expect((await click(PC_ROLE, member)).outcome.key).toBe("rolePanelButtonBroken");
      expect(member.roles.add).not.toHaveBeenCalled();
    });
  });
});

describe("/rolepanel setup", () => {
  const OTHER_CHANNEL = "800000000000000002";

  // Fakes the parts of a slash command, button, menu or form the editor uses.
  function fakeEditorInteraction(guild, { customId, values, fields = {}, member = fakeMember(ADMIN_ID, 40), userId = ADMIN_ID, panel = null } = {}) {
    const interaction = {
      customId,
      values,
      locale: "en-US",
      guildId: GUILD_ID,
      guild,
      member,
      user: { id: userId },
      channel: guild.channel,
      deferred: false,
      replied: false,
      inCachedGuild: () => true,
      memberPermissions: { has: (bit) => bit === PermissionFlagsBits.ManageRoles },
      options: { getSubcommand: () => "setup", getInteger: () => panel },
      fields: { getTextInputValue: (name) => fields[name] ?? "" },
      reply: vi.fn(async (payload) => {
        interaction.replied = true;
        interaction.shown = payload;
      }),
      update: vi.fn(async (payload) => (interaction.shown = payload)),
      deferUpdate: vi.fn(async () => (interaction.deferred = true)),
      editReply: vi.fn(async (payload) => (interaction.shown = payload)),
      showModal: vi.fn(async (modal) => (interaction.modal = modal.toJSON())),
    };
    return interaction;
  }

  const customIds = (payload) => payload.components.flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
  const buttonLabels = (payload) => payload.components.flatMap((row) => row.toJSON().components.map((component) => component.label)).filter(Boolean);

  function setupEditor({ guild = fakeGuild() } = {}) {
    guild.channel.type = ChannelType.GuildText;
    const other = { ...guild.channel, id: OTHER_CHANNEL, send: vi.fn(async (payload) => ({ id: "500000000000000099", payload })) };
    guild.channels.cache.set(OTHER_CHANNEL, other);
    const guildSettings = new GuildSettings();
    const command = createRolePanelCommand({ guildSettings, logger: fakeLogger() });
    const handle = command.componentPrefixes["rpw:"].handle;
    let shown;
    const open = async (panel = null) => {
      const interaction = fakeEditorInteraction(guild, { panel });
      const outcome = await command.execute(interaction);
      shown = interaction.shown;
      return { interaction, outcome };
    };
    // Clicks the component whose ID ends with `action` on the editor as last shown.
    const click = async (action, options = {}) => {
      const customId = options.customId ?? customIds(shown).find((id) => id.split(":")[2] === action);
      expect(customId, action).toBeDefined();
      const interaction = fakeEditorInteraction(guild, { ...options, customId });
      const outcome = await handle(interaction);
      if (interaction.shown) {
        shown = interaction.shown;
      }
      return { interaction, outcome };
    };
    const sessionId = () => customIds(shown)[0].split(":")[1];
    const submit = (action, fields, arg) => click(action, { customId: wizardId(sessionId(), action, arg), fields });
    return { guild, other, guildSettings, command, open, click, submit, shown: () => shown, panels: () => guildSettings.get(GUILD_ID, Setting.ROLE_PANELS) ?? [] };
  }

  it("round-trips its custom IDs", () => {
    expect(parseWizardId(wizardId("0123456789ab", "save"))).toEqual({ sessionId: "0123456789ab", action: "save", arg: undefined });
    expect(parseWizardId(wizardId("0123456789ab", "roleform", PC_ROLE))).toEqual({ sessionId: "0123456789ab", action: "roleform", arg: PC_ROLE });
    expect(parseWizardId(`rp:1:${PC_ROLE}`)).toBeUndefined();
  });

  it("starts a new panel when there are none, and posts nothing until Save", async () => {
    const editor = setupEditor();
    const { interaction } = await editor.open();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(buttonLabels(editor.shown())).toEqual(
      expect.arrayContaining(["Add roles", "Edit message", "Post panel", "Cancel all changes"]),
    );
    expect(editor.shown().embeds[0].toJSON().title).toBe("Pick your roles");

    await editor.click("vadd");
    const menu = editor.shown().components[0].toJSON().components[0];
    expect(menu).toMatchObject({ type: 6, max_values: 25 });
    // Bulk add: two good roles, one with moderator permissions, one above the bot.
    await editor.click("addroles", { values: [PC_ROLE, CONSOLE_ROLE, MOD_ROLE, HIGH_ROLE] });
    const notice = editor.shown().content;
    expect(notice).toContain(`Added <@&${PC_ROLE}>, <@&${CONSOLE_ROLE}>.`);
    expect(notice).toContain(translate("en", "rolePanelDangerous", { role: `<@&${MOD_ROLE}>` }));
    expect(notice).toContain(translate("en", "rolePanelAboveBot", { role: `<@&${HIGH_ROLE}>` }));

    await editor.click("msg");
    await editor.submit("msgform", { title: "Platforms", description: "Pick yours" });
    await editor.click("vedit");
    const { interaction: picked } = await editor.click("editpick", { values: [PC_ROLE] });
    expect(picked.modal.custom_id).toContain(`roleform:${PC_ROLE}`);
    await editor.submit("roleform", { emoji: "pc", label: "" }, PC_ROLE);
    expect(editor.shown().content).toBe(translate("en", "rolePanelBadEmoji"));
    await editor.submit("roleform", { emoji: "🖥️", label: "Computer" }, PC_ROLE);
    await editor.click("mode");

    expect(editor.guild.sent).toHaveLength(0);
    expect(editor.panels()).toEqual([]);

    const { outcome } = await editor.click("save");
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "rolePanelWizardPosted" });
    expect(editor.guild.sent).toHaveLength(1);
    expect(editor.panels()).toEqual([
      expect.objectContaining({
        id: 1,
        channelId: CHANNEL_ID,
        title: "Platforms",
        description: "Pick yours",
        mode: PanelMode.UNIQUE,
        roles: [
          { roleId: PC_ROLE, emoji: "🖥️", label: "Computer" },
          { roleId: CONSOLE_ROLE, emoji: null, label: null },
        ],
      }),
    ]);
    // Saved: the editor stays open on the saved panel, with nothing left to save.
    expect(editor.shown().embeds[1].toJSON().footer.text).toBe("No unsaved changes.");
    expect(buttonLabels(editor.shown())).toContain("Delete panel");
  });

  it("throws every change away on Cancel", async () => {
    const editor = setupEditor();
    await editor.open();
    await editor.click("vadd");
    await editor.click("addroles", { values: [PC_ROLE] });
    await editor.click("cancel");
    expect(editor.shown()).toMatchObject({ content: "Cancelled. None of your changes were saved.", components: [] });
    expect(editor.panels()).toEqual([]);
    expect(editor.guild.sent).toHaveLength(0);
  });

  it("edits an existing panel: removes roles, moves it and deletes the old message", async () => {
    const editor = setupEditor();
    await editor.open();
    await editor.click("vadd");
    await editor.click("addroles", { values: [PC_ROLE, CONSOLE_ROLE] });
    await editor.click("save");
    const firstMessage = editor.panels()[0].messageId;

    await editor.open(1);
    await editor.click("vremove");
    await editor.click("removeroles", { values: [CONSOLE_ROLE] });
    expect(editor.shown().content).toBe(`Removed <@&${CONSOLE_ROLE}>.`);
    await editor.click("vchannel");
    await editor.click("setchannel", { values: [OTHER_CHANNEL] });
    const { outcome } = await editor.click("save");
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "rolePanelWizardSaved" });
    expect(editor.panels()).toEqual([expect.objectContaining({ id: 1, channelId: OTHER_CHANNEL, roles: [{ roleId: PC_ROLE, emoji: null, label: null }] })]);
    expect(editor.other.send).toHaveBeenCalledTimes(1);
    expect(editor.guild.channel.messages.delete).toHaveBeenCalledWith(firstMessage);
  });

  it("lists the panels to pick from, and deletes one only after asking", async () => {
    const editor = setupEditor();
    await editor.open();
    await editor.click("save");
    await editor.open();
    expect(editor.shown().embeds[0].toJSON().title).toBe("Role panel setup");
    await editor.click("pick", { values: ["1"] });
    await editor.click("vdelete");
    expect(editor.panels()).toHaveLength(1);
    const { outcome } = await editor.click("confirmdelete");
    expect(outcome).toMatchObject({ status: Status.SUCCESS, key: "rolePanelDeleted" });
    expect(editor.panels()).toEqual([]);
    expect(editor.shown().content).toBe('Deleted the panel "Pick your roles".');
  });

  it("refuses a panel that doesn't exist", async () => {
    const editor = setupEditor();
    const { interaction, outcome } = await editor.open(7);
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "rolePanelNotFound" });
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: translate("en", "rolePanelNotFound") }));
  });

  it("closes for anyone else, and after 30 idle minutes", async () => {
    let time = 1_000;
    const editor = setupEditor();
    await editor.open();
    const stranger = await editor.click("vadd", { userId: USER_ID });
    expect(stranger.interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: translate("en", "rolePanelWizardExpired") }));
    // The command's own clock isn't injectable, so check the wizard directly.
    const wizard = createRolePanelWizard({
      guildSettings: new GuildSettings(),
      logger: fakeLogger(),
      locks: { run: (key, task) => task() },
      save: async () => {},
      publish: async (panel) => panel,
      now: () => time,
    });
    const interaction = fakeEditorInteraction(editor.guild, {});
    await wizard.start(interaction, null);
    const id = customIds(interaction.shown)[0];
    time += SESSION_IDLE_MS + 1;
    const late = fakeEditorInteraction(editor.guild, { customId: id });
    await wizard.handle(late);
    expect(late.update).toHaveBeenCalledWith(expect.objectContaining({ content: translate("en", "rolePanelWizardExpired") }));
  });
});
