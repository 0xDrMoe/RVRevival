// /rolepanel setup: a private editor for role panels, so admins can build a
// whole panel without running /rolepanel add once per role.
//
//   Start      pick a panel to change, or create a new one
//   Editor     a preview of the panel, its channel, mode and roles, and buttons:
//                Add roles      a role menu, to add up to 25 roles at once
//                Edit a role    pick a role, then set its emoji and button text
//                Remove roles   pick the roles to take off
//                Edit message   a form for the title and the text under it
//                Channel        where the panel is posted
//                Mode           any number of roles, or only one
//                Save           posts the changes (or the new panel)
//                Cancel         throws every unsaved change away
//                Delete panel   asks first, then deletes the panel and its message
//
// Every change is a draft until Save. Drafts live in memory only, for the
// admin who opened the editor, and expire after 30 idle minutes (or when the
// bot restarts). Saving checks every role again, as /rolepanel add does.

import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  buildPanelMessage,
  cleanEmoji,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PANEL_ROLES,
  MAX_PANELS,
  MAX_TITLE_LENGTH,
  PanelMode,
  panelsOf,
  roleProblem,
} from "../community/rolePanels.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";

export const WIZARD_PREFIX = "rpw:";
export const SESSION_IDLE_MS = 30 * 60 * 1000;
// Old drafts are dropped first once there are this many.
const MAX_SESSIONS = 500;
const PANEL_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
const SETUP_COLOR = 0x2b2d31;
// Discord's limit for a modal title.
const MAX_MODAL_TITLE = 45;

export const View = Object.freeze({
  HOME: "home",
  EDIT: "edit",
  ADD: "add",
  EDIT_ROLE: "editRole",
  REMOVE: "remove",
  CHANNEL: "channel",
  DELETE: "delete",
});

// Buttons that only switch what the editor shows.
const VIEW_BUTTONS = {
  vadd: View.ADD,
  vedit: View.EDIT_ROLE,
  vremove: View.REMOVE,
  vchannel: View.CHANNEL,
  vdelete: View.DELETE,
  back: View.EDIT,
};

// "rpw:<session>:<action>" or "rpw:<session>:<action>:<role ID>".
export const wizardId = (sessionId, action, arg) => `${WIZARD_PREFIX}${sessionId}:${action}${arg ? `:${arg}` : ""}`;

export function parseWizardId(customId) {
  const match = /^rpw:([0-9a-f]{12}):([a-z]+)(?::(\d{17,20}))?$/.exec(customId);
  return match ? { sessionId: match[1], action: match[2], arg: match[3] } : undefined;
}

// The parts of a panel the editor changes.
const contentOf = (panel) => ({
  channelId: panel.channelId ?? null,
  title: panel.title,
  description: panel.description ?? "",
  mode: panel.mode === PanelMode.UNIQUE ? PanelMode.UNIQUE : PanelMode.TOGGLE,
  roles: panel.roles.map((entry) => ({ roleId: entry.roleId, emoji: entry.emoji ?? null, label: entry.label ?? null })),
});

const sameContent = (a, b) => JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));
const roleList = (ids) => ids.map((id) => `<@&${id}>`).join(", ");

// Options:
//   guildSettings, logger, forcedLanguage
//   locks    the KeyedLock /rolepanel uses, so saves and commands take turns
//   save     (guildId, panels) => saves the server's panels
//   publish  (panel, guild, emptyText) => the posted panel, or undefined if the bot can't post
//   now      for tests
export function createRolePanelWizard({ guildSettings, logger, forcedLanguage, locks, save, publish, now = Date.now }) {
  // session ID -> { id, guildId, userId, language, serverLanguage, startChannelId, saved, draft, view, touchedAt }
  const sessions = new Map();

  function sweep() {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.touchedAt < cutoff) {
        sessions.delete(id);
      }
    }
    // Map keeps insertion order, and touched sessions are re-inserted, so the first is the oldest.
    while (sessions.size >= MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }

  function touch(session) {
    session.touchedAt = now();
    sessions.delete(session.id);
    sessions.set(session.id, session);
  }

  const isDirty = (session) => session.draft && (!session.saved || !sameContent(session.saved, session.draft));

  function openPanel(session, panel) {
    session.saved = panel;
    session.draft = contentOf(panel);
    session.view = View.EDIT;
  }

  function openNewPanel(session) {
    session.saved = null;
    session.draft = {
      channelId: session.startChannelId,
      title: translate(session.serverLanguage, "rolePanelWizardDefaultTitle"),
      description: "",
      mode: PanelMode.TOGGLE,
      roles: [],
    };
    session.view = View.EDIT;
  }

  // ---- What the editor shows ----

  function render(session, guild, notices = []) {
    const text = (key, values) => translate(session.language, key, values);
    const id = (action, arg) => wizardId(session.id, action, arg);
    const button = (action, key, style = ButtonStyle.Secondary, disabled = false, values) =>
      new ButtonBuilder().setCustomId(id(action)).setLabel(text(key, values).slice(0, 80)).setStyle(style).setDisabled(disabled);
    const row = (...components) => new ActionRowBuilder().addComponents(...components);
    // Always set, so an update clears the last notice.
    const content = notices.join("\n").slice(0, 2000);

    if (session.view === View.HOME) {
      const panels = panelsOf(guildSettings, session.guildId);
      const rows = [];
      if (panels.length > 0) {
        rows.push(
          row(
            new StringSelectMenuBuilder()
              .setCustomId(id("pick"))
              .setPlaceholder(text("rolePanelWizardPickPlaceholder"))
              .addOptions(
                panels.slice(0, 25).map((panel) => ({
                  label: `#${panel.id} ${panel.title}`.slice(0, 100),
                  description: text("rolePanelWizardPickOption", {
                    count: panel.roles.length,
                    channel: guild.channels.cache.get(panel.channelId)?.name ?? "?",
                  }).slice(0, 100),
                  value: String(panel.id),
                })),
              ),
          ),
        );
      }
      rows.push(
        row(
          button("new", "rolePanelWizardNewButton", ButtonStyle.Primary, panels.length >= MAX_PANELS),
          button("cancel", "rolePanelWizardCloseButton"),
        ),
      );
      const embed = new EmbedBuilder()
        .setColor(SETUP_COLOR)
        .setTitle(text("rolePanelWizardHomeTitle"))
        .setDescription(text(panels.length >= MAX_PANELS ? "rolePanelWizardHomeFull" : "rolePanelWizardHome", { count: panels.length, max: MAX_PANELS }));
      return { content, embeds: [embed], components: rows, allowedMentions: { parse: [] } };
    }

    const { draft, saved } = session;
    const emptyText = translate(session.serverLanguage, "rolePanelEmpty");
    const preview = buildPanelMessage({ id: saved?.id ?? 0, ...draft }, guild, emptyText).embeds[0];
    const roleLines = draft.roles.map((entry) =>
      [entry.emoji, `<@&${entry.roleId}>`, entry.label ? `· "${entry.label}"` : null].filter(Boolean).join(" "),
    );
    const dirty = isDirty(session);
    const setup = new EmbedBuilder()
      .setColor(SETUP_COLOR)
      .setTitle(saved ? text("rolePanelWizardEditTitle", { id: saved.id }) : text("rolePanelWizardNewTitle"))
      .setDescription(
        [
          text("rolePanelWizardChannelLine", { channel: draft.channelId ? `<#${draft.channelId}>` : text("rolePanelWizardNoChannel") }),
          text("rolePanelWizardModeLine", { mode: text(`rolePanelMode_${draft.mode}`) }),
          text("rolePanelWizardRolesLine", { count: draft.roles.length, max: MAX_PANEL_ROLES }),
          roleLines.length > 0 ? roleLines.join("\n") : text("rolePanelWizardNoRoles"),
        ].join("\n"),
      )
      .setFooter({ text: text(dirty ? "rolePanelWizardUnsaved" : "rolePanelWizardNoChanges") });
    const embeds = [preview, setup];
    const back = button("back", "rolePanelWizardBackButton");
    const roleOptions = () =>
      draft.roles.map((entry) => ({
        label: (guild.roles.cache.get(entry.roleId)?.name ?? entry.roleId).slice(0, 100),
        description: entry.label ? entry.label.slice(0, 100) : undefined,
        value: entry.roleId,
      }));

    let components;
    if (session.view === View.ADD) {
      const room = MAX_PANEL_ROLES - draft.roles.length;
      components = [
        row(
          new RoleSelectMenuBuilder()
            .setCustomId(id("addroles"))
            .setPlaceholder(text("rolePanelWizardAddPlaceholder", { room }))
            .setMinValues(1)
            .setMaxValues(Math.max(1, room))
            .setDisabled(room <= 0),
        ),
        row(back),
      ];
    } else if (session.view === View.EDIT_ROLE && draft.roles.length > 0) {
      components = [
        row(new StringSelectMenuBuilder().setCustomId(id("editpick")).setPlaceholder(text("rolePanelWizardEditPlaceholder")).addOptions(roleOptions())),
        row(back),
      ];
    } else if (session.view === View.REMOVE && draft.roles.length > 0) {
      components = [
        row(
          new StringSelectMenuBuilder()
            .setCustomId(id("removeroles"))
            .setPlaceholder(text("rolePanelWizardRemovePlaceholder"))
            .setMinValues(1)
            .setMaxValues(draft.roles.length)
            .addOptions(roleOptions()),
        ),
        row(back),
      ];
    } else if (session.view === View.CHANNEL) {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId(id("setchannel"))
        .setPlaceholder(text("rolePanelWizardChannelPlaceholder"))
        .setChannelTypes(...PANEL_CHANNEL_TYPES);
      if (draft.channelId) {
        menu.setDefaultChannels(draft.channelId);
      }
      components = [row(menu), row(back)];
    } else if (session.view === View.DELETE && saved) {
      embeds.push(new EmbedBuilder().setColor(0xed4245).setDescription(text("rolePanelWizardDeleteConfirm", { title: saved.title })));
      components = [row(button("confirmdelete", "rolePanelWizardDeleteButton", ButtonStyle.Danger), back)];
    } else {
      session.view = View.EDIT;
      const full = draft.roles.length >= MAX_PANEL_ROLES;
      const empty = draft.roles.length === 0;
      components = [
        row(
          button("vadd", "rolePanelWizardAddButton", ButtonStyle.Primary, full),
          button("vedit", "rolePanelWizardEditRoleButton", ButtonStyle.Secondary, empty),
          button("vremove", "rolePanelWizardRemoveButton", ButtonStyle.Secondary, empty),
        ),
        row(
          button("msg", "rolePanelWizardMessageButton"),
          button("vchannel", "rolePanelWizardChannelButton"),
          button("mode", "rolePanelWizardModeButton", ButtonStyle.Secondary, false, {
            mode: text(`rolePanelMode_${draft.mode === PanelMode.UNIQUE ? PanelMode.TOGGLE : PanelMode.UNIQUE}`),
          }),
        ),
        row(
          ...[
            button("save", saved ? "rolePanelWizardSaveButton" : "rolePanelWizardPostButton", ButtonStyle.Success, !dirty || !draft.channelId),
            button("cancel", dirty ? "rolePanelWizardCancelButton" : "rolePanelWizardCloseButton"),
            saved ? button("vdelete", "rolePanelWizardDeleteButton", ButtonStyle.Danger) : null,
          ].filter(Boolean),
        ),
      ];
    }
    return { content, embeds, components, allowedMentions: { parse: [] } };
  }

  // ---- Forms ----

  function messageForm(session) {
    const text = (key) => translate(session.language, key);
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(MAX_TITLE_LENGTH)
      .setValue(session.draft.title);
    const description = new TextInputBuilder()
      .setCustomId("description")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(MAX_DESCRIPTION_LENGTH);
    if (session.draft.description) {
      description.setValue(session.draft.description);
    }
    return new ModalBuilder()
      .setCustomId(wizardId(session.id, "msgform"))
      .setTitle(text("rolePanelWizardMessageFormTitle").slice(0, MAX_MODAL_TITLE))
      .addLabelComponents(
        new LabelBuilder().setLabel(text("rolePanelWizardTitleLabel")).setTextInputComponent(title),
        new LabelBuilder().setLabel(text("rolePanelWizardDescriptionLabel")).setTextInputComponent(description),
      );
  }

  function roleForm(session, entry, roleName) {
    const text = (key, values) => translate(session.language, key, values);
    const emoji = new TextInputBuilder().setCustomId("emoji").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(64);
    const label = new TextInputBuilder()
      .setCustomId("label")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(MAX_LABEL_LENGTH)
      .setPlaceholder(roleName.slice(0, 100));
    if (entry.emoji) {
      emoji.setValue(entry.emoji);
    }
    if (entry.label) {
      label.setValue(entry.label);
    }
    return new ModalBuilder()
      .setCustomId(wizardId(session.id, "roleform", entry.roleId))
      .setTitle(text("rolePanelWizardRoleFormTitle", { role: roleName }).slice(0, MAX_MODAL_TITLE))
      .addLabelComponents(
        new LabelBuilder().setLabel(text("rolePanelWizardEmojiLabel")).setTextInputComponent(emoji),
        new LabelBuilder().setLabel(text("rolePanelWizardLabelLabel")).setTextInputComponent(label),
      );
  }

  // ---- Starting ----

  // `/rolepanel setup [panel]`. `panelId` is null to start at the panel list.
  async function start(interaction, panelId) {
    sweep();
    const guild = interaction.guild;
    // One editor per admin per server: opening a new one closes the old one.
    for (const [id, other] of sessions) {
      if (other.guildId === guild.id && other.userId === interaction.user.id) {
        sessions.delete(id);
      }
    }
    const channel = interaction.channel;
    const session = {
      id: randomBytes(6).toString("hex"),
      guildId: guild.id,
      userId: interaction.user.id,
      language: pickLanguage(interaction.locale, forcedLanguage),
      serverLanguage: pickLanguage(guild.preferredLocale, forcedLanguage),
      startChannelId: channel && PANEL_CHANNEL_TYPES.includes(channel.type) ? channel.id : null,
      saved: null,
      draft: null,
      view: View.HOME,
      touchedAt: now(),
    };
    const panels = panelsOf(guildSettings, guild.id);
    if (panelId !== null) {
      const panel = panels.find((entry) => entry.id === panelId);
      if (!panel) {
        return { refusal: "rolePanelNotFound" };
      }
      openPanel(session, panel);
    } else if (panels.length === 0) {
      openNewPanel(session);
    }
    sessions.set(session.id, session);
    await interaction.reply({ ...render(session, guild), flags: MessageFlags.Ephemeral });
    return { session };
  }

  // ---- Buttons, menus and forms ----

  async function handle(interaction) {
    const parsed = parseWizardId(interaction.customId);
    sweep();
    const session = parsed ? sessions.get(parsed.sessionId) : undefined;
    if (!session || !interaction.inCachedGuild() || session.guildId !== interaction.guildId || session.userId !== interaction.user.id) {
      const language = pickLanguage(interaction.locale, forcedLanguage);
      await interaction.update({ content: translate(language, "rolePanelWizardExpired"), embeds: [], components: [] });
      return null;
    }
    touch(session);
    const guild = interaction.guild;
    const text = (key, values) => translate(session.language, key, values);
    const show = (notices) => interaction.update(render(session, guild, notices));
    const { action, arg } = parsed;
    const { draft } = session;
    // Every action but these needs a panel open in the editor.
    if (!draft && !["pick", "new", "cancel"].includes(action)) {
      session.view = View.HOME;
      await show();
      return null;
    }

    if (action in VIEW_BUTTONS) {
      session.view = VIEW_BUTTONS[action];
      await show();
      return null;
    }

    switch (action) {
      case "pick": {
        const panel = panelsOf(guildSettings, guild.id).find((entry) => String(entry.id) === interaction.values?.[0]);
        if (!panel) {
          await show([text("rolePanelNotFound")]);
          return null;
        }
        openPanel(session, panel);
        await show();
        return null;
      }
      case "new": {
        if (panelsOf(guildSettings, guild.id).length >= MAX_PANELS) {
          await show([text("rolePanelTooMany", { max: MAX_PANELS })]);
          return null;
        }
        openNewPanel(session);
        await show();
        return null;
      }
      case "mode": {
        draft.mode = draft.mode === PanelMode.UNIQUE ? PanelMode.TOGGLE : PanelMode.UNIQUE;
        await show();
        return null;
      }
      case "msg": {
        await interaction.showModal(messageForm(session));
        return null;
      }
      case "msgform": {
        const title = interaction.fields.getTextInputValue("title").trim();
        if (!title) {
          await show([text("rolePanelWizardNeedTitle")]);
          return null;
        }
        draft.title = title.slice(0, MAX_TITLE_LENGTH);
        draft.description = interaction.fields.getTextInputValue("description").trim().slice(0, MAX_DESCRIPTION_LENGTH);
        session.view = View.EDIT;
        await show([text("rolePanelWizardMessageChanged")]);
        return null;
      }
      case "addroles": {
        const added = [];
        const already = [];
        const tooMany = [];
        const problems = [];
        for (const roleId of interaction.values ?? []) {
          const role = guild.roles.cache.get(roleId);
          if (!role) {
            continue;
          }
          if (draft.roles.some((entry) => entry.roleId === roleId)) {
            already.push(roleId);
            continue;
          }
          const problem = roleProblem(role, { guild, admin: interaction.member, bot: guild.members.me });
          if (problem) {
            problems.push(text(problem, { role: `<@&${roleId}>` }));
          } else if (draft.roles.length >= MAX_PANEL_ROLES) {
            tooMany.push(roleId);
          } else {
            draft.roles.push({ roleId, emoji: null, label: null });
            added.push(roleId);
          }
        }
        const notices = [
          added.length > 0 ? text("rolePanelWizardAdded", { roles: roleList(added) }) : null,
          already.length > 0 ? text("rolePanelWizardAlreadyOn", { roles: roleList(already) }) : null,
          tooMany.length > 0 ? text("rolePanelWizardNoRoom", { roles: roleList(tooMany), max: MAX_PANEL_ROLES }) : null,
          ...problems,
        ].filter(Boolean);
        session.view = View.EDIT;
        await show(notices);
        return null;
      }
      case "editpick": {
        const roleId = interaction.values?.[0];
        const entry = draft.roles.find((existing) => existing.roleId === roleId);
        if (!entry) {
          session.view = View.EDIT;
          await show();
          return null;
        }
        await interaction.showModal(roleForm(session, entry, guild.roles.cache.get(roleId)?.name ?? "Role"));
        return null;
      }
      case "roleform": {
        const entry = draft.roles.find((existing) => existing.roleId === arg);
        session.view = View.EDIT;
        if (!entry) {
          await show();
          return null;
        }
        const emojiText = interaction.fields.getTextInputValue("emoji").trim();
        const emoji = emojiText ? cleanEmoji(emojiText) : null;
        if (emojiText && !emoji) {
          await show([text("rolePanelBadEmoji")]);
          return null;
        }
        entry.emoji = emoji;
        entry.label = interaction.fields.getTextInputValue("label").trim().slice(0, MAX_LABEL_LENGTH) || null;
        await show([text("rolePanelWizardRoleChanged", { role: `<@&${arg}>` })]);
        return null;
      }
      case "removeroles": {
        const picked = new Set(interaction.values ?? []);
        const removed = draft.roles.filter((entry) => picked.has(entry.roleId)).map((entry) => entry.roleId);
        draft.roles = draft.roles.filter((entry) => !picked.has(entry.roleId));
        session.view = View.EDIT;
        await show(removed.length > 0 ? [text("rolePanelWizardRemoved", { roles: roleList(removed) })] : []);
        return null;
      }
      case "setchannel": {
        const channel = guild.channels.cache.get(interaction.values?.[0]);
        session.view = View.EDIT;
        if (!channel || !PANEL_CHANNEL_TYPES.includes(channel.type)) {
          await show([text("rolePanelWizardBadChannel")]);
          return null;
        }
        if (channel.permissionsFor?.(guild.members.me)?.has(POST_PERMISSIONS) === false) {
          await show([text("rolePanelCannotPost", { channel: `<#${channel.id}>` })]);
          return null;
        }
        draft.channelId = channel.id;
        await show();
        return null;
      }
      case "save":
        return saveDraft(interaction, session);
      case "confirmdelete":
        return deletePanel(interaction, session);
      case "cancel": {
        const dirty = isDirty(session);
        sessions.delete(session.id);
        await interaction.update({
          content: text(dirty ? "rolePanelWizardCancelled" : "rolePanelWizardClosed"),
          embeds: [],
          components: [],
        });
        return null;
      }
      default:
        await show();
        return null;
    }
  }

  // Posts the draft and saves it. Saving and posting can take a moment, so the
  // click is acknowledged first.
  async function saveDraft(interaction, session) {
    await interaction.deferUpdate();
    const guild = interaction.guild;
    const text = (key, values) => translate(session.language, key, values);
    const show = (notices) => interaction.editReply(render(session, guild, notices));
    return locks.run(guild.id, async () => {
      const panels = panelsOf(guildSettings, guild.id);
      const { draft } = session;
      let current = session.saved ? panels.find((entry) => entry.id === session.saved.id) : undefined;
      if (session.saved && !current) {
        // Someone deleted it in the meantime: saving posts it again as a new panel.
        session.saved = null;
        await show([text("rolePanelWizardGone")]);
        return null;
      }
      if (!current && panels.length >= MAX_PANELS) {
        await show([text("rolePanelTooMany", { max: MAX_PANELS })]);
        return null;
      }
      const channel = guild.channels.cache.get(draft.channelId);
      if (!channel?.isTextBased?.()) {
        session.view = View.CHANNEL;
        await show([text("rolePanelWizardBadChannel")]);
        return null;
      }
      // Checked again: roles may have changed (or been deleted) since they were added.
      const missing = draft.roles.filter((entry) => !guild.roles.cache.has(entry.roleId));
      const problems = draft.roles
        .map((entry) => guild.roles.cache.get(entry.roleId))
        .filter(Boolean)
        .map((role) => {
          const problem = roleProblem(role, { guild, admin: interaction.member, bot: guild.members.me });
          return problem ? text(problem, { role: `<@&${role.id}>` }) : null;
        })
        .filter(Boolean);
      if (problems.length > 0) {
        await show([...problems, text("rolePanelWizardFixFirst")]);
        return null;
      }
      draft.roles = draft.roles.filter((entry) => guild.roles.cache.has(entry.roleId));

      const moved = current && current.channelId !== draft.channelId;
      const panel = {
        id: current?.id ?? Math.max(0, ...panels.map((entry) => entry.id)) + 1,
        ...contentOf(draft),
        messageId: moved ? null : (current?.messageId ?? null),
      };
      const posted = await publish(panel, guild, translate(session.serverLanguage, "rolePanelEmpty"));
      if (!posted) {
        await show([text("rolePanelCannotPost", { channel: `<#${panel.channelId}>` })]);
        return null;
      }
      if (moved && current.messageId) {
        const oldChannel = guild.channels.cache.get(current.channelId);
        await oldChannel?.messages?.delete(current.messageId).catch(() => {});
      }
      await save(guild.id, current ? panels.map((entry) => (entry === current ? posted : entry)) : [...panels, posted]);
      openPanel(session, posted);
      logger.info("Role panel saved from setup", { guildId: guild.id, panel: posted.id, roles: posted.roles.length });

      const values = { id: posted.id, title: posted.title, channel: `<#${posted.channelId}>` };
      const notices = [text(current ? "rolePanelWizardSaved" : "rolePanelWizardPosted", values)];
      if (missing.length > 0) {
        notices.push(text("rolePanelWizardDroppedMissing", { count: missing.length }));
      }
      // Community servers have Discord's own Onboarding, which we recommend over role panels.
      if (!current && guild.features?.includes("COMMUNITY")) {
        notices.push(text("rolePanelOnboardingTip"));
      }
      await show(notices);
      return result(Status.SUCCESS, current ? "rolePanelWizardSaved" : "rolePanelWizardPosted", values);
    });
  }

  async function deletePanel(interaction, session) {
    await interaction.deferUpdate();
    const guild = interaction.guild;
    const text = (key, values) => translate(session.language, key, values);
    return locks.run(guild.id, async () => {
      const panels = panelsOf(guildSettings, guild.id);
      const panel = session.saved ? panels.find((entry) => entry.id === session.saved.id) : undefined;
      const title = panel?.title ?? session.saved?.title ?? "";
      if (panel) {
        const channel = guild.channels.cache.get(panel.channelId);
        if (panel.messageId && channel?.isTextBased?.()) {
          await channel.messages.delete(panel.messageId).catch(() => {});
        }
        await save(guild.id, panels.filter((entry) => entry !== panel));
        logger.info("Role panel deleted from setup", { guildId: guild.id, panel: panel.id });
      }
      // Back to the list, to change or create another one.
      session.saved = null;
      session.draft = null;
      session.view = View.HOME;
      await interaction.editReply(render(session, guild, [text("rolePanelDeleted", { title })]));
      return panel ? result(Status.SUCCESS, "rolePanelDeleted", { title }) : null;
    });
  }

  return { start, handle, sessions };
}
