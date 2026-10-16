import { ButtonStyle, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildRolePanelCommandData, createRolePanelCommand } from "../src/commands/rolePanel.js";
import { buildPanelMessage, buttonId, cleanEmoji, PanelMode, parseButtonId, roleProblem } from "../src/community/rolePanels.js";
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

function fakeGuild({ canManageRoles = true } = {}) {
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
    expect(data.options.map((option) => option.name)).toEqual(["create", "add", "remove", "delete", "list"]);
  });

  it("refuses members without Manage Roles", async () => {
    const { command, guild } = setup();
    const outcome = await command.execute(fakeInteraction(guild, "list", { canManageRoles: false }));
    expect(outcome.status).toBe(Status.REFUSED);
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
