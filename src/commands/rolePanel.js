// The /rolepanel command and its buttons: admins post messages with a button
// per role, and members click to give themselves the role (or take it away).
//
//   /rolepanel create channel:#roles title:<…> description:<…> mode:<…>   post a new, empty panel
//   /rolepanel add panel:<…> role:@PC emoji:🖥️ label:<…>                  add a button to it
//   /rolepanel remove panel:<…> role:@PC                                   remove a button
//   /rolepanel delete panel:<…>                                            delete the panel and its message
//   /rolepanel list
//
// Needs Manage Roles. Roles with moderator or admin permissions, managed roles
// and roles above the bot or the admin can't go on a panel.

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  BUTTON_PREFIX,
  cleanEmoji,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PANEL_ROLES,
  MAX_PANELS,
  MAX_TITLE_LENGTH,
  PanelMode,
  panelsOf,
  parseButtonId,
  publishPanel,
  roleProblem,
} from "../community/rolePanels.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { KeyedLock } from "../utils/keyedLock.js";

const COMMAND_NAME = "rolepanel";

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const panelOption = (option) =>
  withDescription(option.setName("panel"), "rolePanelPanelOptionDescription").setRequired(true).setAutocomplete(true);

export function buildRolePanelCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);
  return withDescription(command, "rolePanelCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("create"), "rolePanelCreateDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "rolePanelChannelOptionDescription")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addStringOption((option) =>
          withDescription(option.setName("title"), "rolePanelTitleOptionDescription").setRequired(true).setMaxLength(MAX_TITLE_LENGTH),
        )
        .addStringOption((option) =>
          withDescription(option.setName("description"), "rolePanelDescriptionOptionDescription").setMaxLength(
            MAX_DESCRIPTION_LENGTH,
          ),
        )
        .addStringOption((option) =>
          withDescription(option.setName("mode"), "rolePanelModeOptionDescription").addChoices(
            ...Object.values(PanelMode).map((mode) => ({
              name: translate("en", `rolePanelMode_${mode}`),
              name_localizations: discordLocalizations(`rolePanelMode_${mode}`),
              value: mode,
            })),
          ),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "rolePanelAddDescription")
        .addIntegerOption(panelOption)
        .addRoleOption((option) => withDescription(option.setName("role"), "rolePanelRoleOptionDescription").setRequired(true))
        .addStringOption((option) => withDescription(option.setName("emoji"), "rolePanelEmojiOptionDescription").setMaxLength(64))
        .addStringOption((option) =>
          withDescription(option.setName("label"), "rolePanelLabelOptionDescription").setMaxLength(MAX_LABEL_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "rolePanelRemoveDescription")
        .addIntegerOption(panelOption)
        .addRoleOption((option) => withDescription(option.setName("role"), "rolePanelRoleOptionDescription").setRequired(true)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("delete"), "rolePanelDeleteDescription").addIntegerOption(panelOption))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "rolePanelListDescription"))
    .toJSON();
}

// Options:
//   guildSettings, logger, forcedLanguage
export function createRolePanelCommand({ guildSettings, logger, forcedLanguage }) {
  // One change at a time per server, so two admins can't overwrite each other's panels.
  const locks = new KeyedLock();
  const save = (guildId, panels) =>
    panels.length > 0 ? guildSettings.set(guildId, Setting.ROLE_PANELS, panels) : guildSettings.clear(guildId, Setting.ROLE_PANELS);

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };

    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageRoles)) {
      return answer(Status.REFUSED, "rolePanelNoPermission");
    }
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    // Panels in the server's language; the reply in the admin's.
    const emptyText = translate(pickLanguage(guild.preferredLocale, forcedLanguage), "rolePanelEmpty");
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
      const panels = panelsOf(guildSettings, guildId);
      if (panels.length === 0) {
        return answer(Status.SUCCESS, "rolePanelListEmpty");
      }
      const lines = panels.map((panel) =>
        text("rolePanelListLine", {
          id: panel.id,
          title: panel.title,
          channel: `<#${panel.channelId}>`,
          roles: panel.roles.map((entry) => `<@&${entry.roleId}>`).join(" ") || "-",
          mode: text(`rolePanelMode_${panel.mode}`),
        }),
      );
      await interaction.reply({ content: lines.join("\n").slice(0, 2000), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(Status.SUCCESS);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return locks.run(guildId, async () => {
      const panels = panelsOf(guildSettings, guildId);
      const publish = async (panel) => {
        try {
          return await publishPanel(panel, guild, emptyText);
        } catch (error) {
          if (isPermissionError(error) || error.code === "NO_CHANNEL") {
            return undefined;
          }
          throw error;
        }
      };

      if (subcommand === "create") {
        if (panels.length >= MAX_PANELS) {
          return answer(Status.REFUSED, "rolePanelTooMany", { max: MAX_PANELS });
        }
        const channel = interaction.options.getChannel("channel", true);
        const panel = {
          id: Math.max(0, ...panels.map((entry) => entry.id)) + 1,
          channelId: channel.id,
          messageId: null,
          title: interaction.options.getString("title", true).trim(),
          description: interaction.options.getString("description")?.replace(/\\n/g, "\n").trim() || "",
          mode: interaction.options.getString("mode") === PanelMode.UNIQUE ? PanelMode.UNIQUE : PanelMode.TOGGLE,
          roles: [],
        };
        const posted = await publish(panel);
        if (!posted) {
          return answer(Status.FAILED, "rolePanelCannotPost", { channel: `<#${channel.id}>` });
        }
        await save(guildId, [...panels, posted]);
        return answer(Status.SUCCESS, "rolePanelCreated", { id: posted.id, channel: `<#${channel.id}>` });
      }

      const panelId = interaction.options.getInteger("panel", true);
      const panel = panels.find((entry) => entry.id === panelId);
      if (!panel) {
        return answer(Status.REFUSED, "rolePanelNotFound");
      }
      const others = panels.filter((entry) => entry !== panel);

      if (subcommand === "delete") {
        const channel = guild.channels.cache.get(panel.channelId);
        if (panel.messageId && channel?.isTextBased?.()) {
          await channel.messages.delete(panel.messageId).catch(() => {});
        }
        await save(guildId, others);
        return answer(Status.SUCCESS, "rolePanelDeleted", { title: panel.title });
      }

      const role = interaction.options.getRole("role", true);
      const values = { role: `<@&${role.id}>`, title: panel.title };
      let next;
      if (subcommand === "add") {
        const problem = roleProblem(role, { guild, admin: interaction.member, bot: guild.members.me });
        if (problem) {
          return answer(Status.REFUSED, problem, values);
        }
        if (panel.roles.length >= MAX_PANEL_ROLES && !panel.roles.some((entry) => entry.roleId === role.id)) {
          return answer(Status.REFUSED, "rolePanelFull", { max: MAX_PANEL_ROLES });
        }
        const emojiText = interaction.options.getString("emoji");
        const emoji = emojiText ? cleanEmoji(emojiText) : undefined;
        if (emojiText && !emoji) {
          return answer(Status.REFUSED, "rolePanelBadEmoji");
        }
        const entry = { roleId: role.id, emoji: emoji ?? null, label: interaction.options.getString("label")?.trim() || null };
        // Adding a role that's already there updates its button.
        const exists = panel.roles.some((existing) => existing.roleId === role.id);
        next = {
          ...panel,
          roles: exists ? panel.roles.map((existing) => (existing.roleId === role.id ? entry : existing)) : [...panel.roles, entry],
        };
      } else {
        if (!panel.roles.some((entry) => entry.roleId === role.id)) {
          return answer(Status.REFUSED, "rolePanelRoleNotOnPanel", values);
        }
        next = { ...panel, roles: panel.roles.filter((entry) => entry.roleId !== role.id) };
      }
      const posted = await publish(next);
      if (!posted) {
        return answer(Status.FAILED, "rolePanelCannotPost", { channel: `<#${panel.channelId}>` });
      }
      await save(guildId, panels.map((entry) => (entry === panel ? posted : entry)));
      logger.info("Role panel changed", { guildId, panel: panel.id, subcommand, roleId: role.id });
      return answer(Status.SUCCESS, subcommand === "add" ? "rolePanelRoleAdded" : "rolePanelRoleRemoved", values);
    });
  }

  // Suggests the server's panels by title.
  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").toLowerCase();
    const choices = panelsOf(guildSettings, interaction.guildId)
      .filter((panel) => panel.title.toLowerCase().includes(typed) || String(panel.id) === typed)
      .slice(0, 25)
      .map((panel) => ({ name: `#${panel.id} ${panel.title}`.slice(0, 100), value: panel.id }));
    await interaction.respond(choices);
  }

  // A member clicking one of the panel's buttons.
  async function handleButton(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const reply = async (status, key, values = {}) => {
      await interaction.reply({ content: translate(language, key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(status, key, values);
    };
    const parsed = parseButtonId(interaction.customId);
    if (!interaction.inCachedGuild() || !parsed) {
      return reply(Status.REFUSED, "rolePanelButtonGone");
    }
    const guild = interaction.guild;
    const panel = panelsOf(guildSettings, interaction.guildId).find((entry) => entry.id === parsed.panelId);
    const role = guild.roles.cache.get(parsed.roleId);
    if (!panel || !role || !panel.roles.some((entry) => entry.roleId === role.id)) {
      return reply(Status.REFUSED, "rolePanelButtonGone");
    }
    // Checked again here: the role's permissions may have changed since it was added.
    const me = guild.members.me;
    if (roleProblem(role, { guild, bot: me }) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return reply(Status.FAILED, "rolePanelButtonBroken");
    }
    const member = interaction.member;
    const values = { role: `<@&${role.id}>` };
    try {
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role.id, "Role panel");
        return reply(Status.SUCCESS, "rolePanelYouLost", values);
      }
      const swapped =
        panel.mode === PanelMode.UNIQUE
          ? panel.roles.map((entry) => entry.roleId).filter((id) => id !== role.id && member.roles.cache.has(id))
          : [];
      if (swapped.length > 0) {
        await member.roles.remove(swapped, "Role panel");
      }
      await member.roles.add(role.id, "Role panel");
      return swapped.length > 0
        ? reply(Status.SUCCESS, "rolePanelYouSwapped", { ...values, old: swapped.map((id) => `<@&${id}>`).join(", ") })
        : reply(Status.SUCCESS, "rolePanelYouGot", values);
    } catch (error) {
      if (isPermissionError(error)) {
        return reply(Status.FAILED, "rolePanelButtonBroken");
      }
      throw error;
    }
  }

  return {
    name: COMMAND_NAME,
    data: buildRolePanelCommandData(),
    execute,
    autocomplete,
    componentPrefixes: { [BUTTON_PREFIX]: { label: "Role panel button", handle: handleButton } },
  };
}
