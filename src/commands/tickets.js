// The /tickets command and the ticket buttons.
//
//   /tickets panel channel:#support [staff-role:@Support] [title:…] [message:…]
//   /tickets off                          remove the button (open tickets stay)
//   /tickets close [reason:…]             close the ticket you're in
//   /tickets add member:@x                bring someone into this ticket
//   /tickets remove member:@x             take them out again
//   /tickets list                         the open tickets
//
// Members open a ticket with the panel's button, which asks what they need
// help with. The ticket is a private thread in the panel's channel with the
// member and the staff role in it, and a Close button that the member or staff
// can press. Panel and off need Manage Server; the rest needs ticket staff
// (see tickets/tickets.js). Tickets are saved in data/bot.db (tickets/ticketStore.js).

import {
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
} from "discord.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import {
  addStaff,
  buildPanelMessage,
  buildTicketWelcome,
  CLOSE_BUTTON,
  FORM_ID,
  FORM_INPUT,
  isTicketStaff,
  MAX_MESSAGE_LENGTH,
  MAX_OPEN_TICKETS,
  MAX_REASON_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TITLE_LENGTH,
  OPEN_BUTTON,
  serverLanguage,
  threadName,
  TICKET_PERMISSIONS,
  ticketSettings,
  ticketStaffRoleId,
} from "../tickets/tickets.js";
import { isPermissionError } from "../utils/discordErrors.js";

const COMMAND_NAME = "tickets";

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const memberOption = (option) => withDescription(option.setName("member"), "ticketsMemberOptionDescription").setRequired(true);

export function buildTicketsCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "ticketsCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("panel"), "ticketsPanelDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "ticketsPanelChannelOptionDescription")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((option) => withDescription(option.setName("staff-role"), "ticketsPanelStaffRoleOptionDescription"))
        .addStringOption((option) =>
          withDescription(option.setName("title"), "ticketsPanelTitleOptionDescription").setMaxLength(MAX_TITLE_LENGTH),
        )
        .addStringOption((option) =>
          withDescription(option.setName("message"), "ticketsPanelMessageOptionDescription").setMaxLength(MAX_MESSAGE_LENGTH),
        ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("off"), "ticketsOffDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("close"), "ticketsCloseDescription").addStringOption((option) =>
        withDescription(option.setName("reason"), "ticketsReasonOptionDescription").setMaxLength(MAX_REASON_LENGTH),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("add"), "ticketsAddDescription").addUserOption(memberOption))
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "ticketsRemoveDescription").addUserOption(memberOption))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "ticketsListDescription"))
    .toJSON();
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

function buildTicketForm(language) {
  const input = new TextInputBuilder()
    .setCustomId(FORM_INPUT)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_SUBJECT_LENGTH)
    .setPlaceholder(translate(language, "ticketFormPlaceholder"));
  return new ModalBuilder()
    .setCustomId(FORM_ID)
    .setTitle(translate(language, "ticketFormTitle"))
    .addLabelComponents(new LabelBuilder().setLabel(translate(language, "ticketFormLabel")).setTextInputComponent(input));
}

// Options:
//   tickets    the TicketStore (only needed to run the command, not to register it)
//   guildSettings, logger, forcedLanguage, now
export function createTicketsCommand({ tickets, guildSettings, logger, forcedLanguage, now = Date.now }) {
  // Replies privately (or edits the deferred reply) and returns the log outcome.
  function answerer(interaction) {
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
    return { language, text, answer };
  }

  // The panel's channel, if the bot can open tickets there.
  function usableChannel(guild, channelId) {
    const channel = guild.channels.cache.get(channelId);
    const me = guild.members.me;
    return channel?.type === ChannelType.GuildText && me && channel.permissionsFor(me)?.has(TICKET_PERMISSIONS) ? channel : undefined;
  }

  // The member's open ticket, unless its thread is gone or archived (then it's
  // closed on the spot, so they can open a new one).
  function liveTicket(guild, userId) {
    const ticket = tickets.openForUser(guild.id, userId);
    if (!ticket) {
      return undefined;
    }
    const thread = ticket.threadId && guild.channels.cache.get(ticket.threadId);
    if (thread && !thread.archived) {
      return ticket;
    }
    tickets.close(ticket.id, { reason: "Thread archived or deleted", closedAt: now() });
    return undefined;
  }

  // Marks the ticket closed, says so in the thread, then locks and archives it
  // so only staff can read it afterwards.
  async function closeTicket(interaction, ticket, reason) {
    const { answer } = answerer(interaction);
    const closed = tickets.close(ticket.id, { closedBy: interaction.user.id, reason, closedAt: now() });
    if (!closed) {
      return answer(Status.REFUSED, "ticketAlreadyClosed");
    }
    const language = serverLanguage(interaction.guild, forcedLanguage);
    const values = { user: `<@${interaction.user.id}>`, number: ticket.number, reason };
    await interaction.reply({
      content: translate(language, reason ? "ticketClosedReason" : "ticketClosedMessage", values),
      allowedMentions: { parse: [] },
    });
    await interaction.channel
      .edit({ locked: true, archived: true, reason: `Ticket #${ticket.number} closed by ${interaction.user.id}` })
      .catch((error) => logger.warn("Couldn't lock and archive a closed ticket", { guildId: ticket.guildId, ticket: ticket.number, error }));
    logger.info("Ticket closed", { guildId: ticket.guildId, ticket: ticket.number });
    return result(Status.SUCCESS, "ticketClosedLog", { number: ticket.number });
  }

  async function execute(interaction) {
    const { text, answer } = answerer(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "panel" || subcommand === "off") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageGuild") });
      }
      const saved = ticketSettings(guildSettings, guildId);
      // Removes the old panel's message, if it's still there.
      const removeOldPanel = async () => {
        const oldChannel = saved && guild.channels.cache.get(saved.channelId);
        await oldChannel?.messages
          ?.delete(saved.messageId)
          .catch((error) => logger.debug("Couldn't delete the old ticket panel", { guildId, error }));
      };

      if (subcommand === "off") {
        if (!saved) {
          return answer(Status.REFUSED, "ticketPanelNone");
        }
        await removeOldPanel();
        await guildSettings.clear(guildId, Setting.TICKETS);
        return answer(Status.SUCCESS, "ticketPanelRemoved");
      }

      const picked = interaction.options.getChannel("channel", true);
      const channel = usableChannel(guild, picked.id);
      if (!channel) {
        return answer(Status.FAILED, "ticketCannotCreate", { channel: `<#${picked.id}>` });
      }
      const role = interaction.options.getRole("staff-role");
      if (role?.id === guildId) {
        return answer(Status.REFUSED, "ticketStaffEveryone");
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panel = buildPanelMessage(serverLanguage(guild, forcedLanguage), {
        title: interaction.options.getString("title")?.trim(),
        message: interaction.options.getString("message")?.trim(),
      });
      let message;
      try {
        message = await channel.send(panel);
      } catch (error) {
        if (isPermissionError(error)) {
          return answer(Status.FAILED, "ticketCannotCreate", { channel: `<#${channel.id}>` });
        }
        throw error;
      }
      await removeOldPanel();
      await guildSettings.set(guildId, Setting.TICKETS, { channelId: channel.id, messageId: message.id, staffRoleId: role?.id ?? null });
      const staffRoleId = ticketStaffRoleId(guildSettings, guildId);
      return answer(Status.SUCCESS, staffRoleId ? "ticketPanelPosted" : "ticketPanelPostedNoStaff", {
        channel: `<#${channel.id}>`,
        staff: `<@&${staffRoleId}>`,
      });
    }

    if (!isTicketStaff(interaction, guildSettings) && subcommand !== "close") {
      return answer(Status.REFUSED, "ticketStaffOnly");
    }

    if (subcommand === "list") {
      const open = tickets.listOpen(guildId);
      if (open.length === 0) {
        return answer(Status.SUCCESS, "ticketsListEmpty");
      }
      const lines = open.map((ticket) =>
        text("ticketsListLine", {
          number: ticket.number,
          thread: ticket.threadId ? `<#${ticket.threadId}>` : "—",
          user: `<@${ticket.userId}>`,
          when: timestamp(ticket.createdAt, "R"),
        }),
      );
      await interaction.reply({
        content: [text("ticketsListTitle", { count: open.length }), ...lines].join("\n").slice(0, 2000),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return result(Status.SUCCESS);
    }

    // close, add and remove work inside a ticket.
    const ticket = tickets.byThread(interaction.channelId);
    if (!ticket || ticket.guildId !== guildId) {
      return answer(Status.REFUSED, "ticketNotATicket");
    }
    if (subcommand === "close") {
      if (ticket.userId !== interaction.user.id && !isTicketStaff(interaction, guildSettings)) {
        return answer(Status.REFUSED, "ticketCloseNoPermission");
      }
      return closeTicket(interaction, ticket, interaction.options.getString("reason")?.trim() || null);
    }
    if (ticket.closedAt !== null) {
      return answer(Status.REFUSED, "ticketAlreadyClosed");
    }
    const user = interaction.options.getUser("member", true);
    const values = { member: `<@${user.id}>`, number: ticket.number };
    if (subcommand === "add") {
      try {
        await interaction.channel.members.add(user.id);
      } catch (error) {
        // Discord refuses people who can't see the panel's channel.
        logger.debug("Couldn't add someone to a ticket", { guildId, ticket: ticket.number, error });
        return answer(Status.FAILED, "ticketCannotAdd", values);
      }
      return answer(Status.SUCCESS, "ticketAdded", values);
    }
    if (user.id === ticket.userId) {
      return answer(Status.REFUSED, "ticketCannotRemoveOwner");
    }
    await interaction.channel.members.remove(user.id);
    return answer(Status.SUCCESS, "ticketRemoved", values);
  }

  // "Open a ticket" on the panel: asks what they need help with.
  async function handleOpenButton(interaction) {
    const { language, answer } = answerer(interaction);
    if (!interaction.inCachedGuild() || !ticketSettings(guildSettings, interaction.guildId)) {
      return answer(Status.REFUSED, "ticketsOff");
    }
    const open = liveTicket(interaction.guild, interaction.user.id);
    if (open) {
      return answer(Status.REFUSED, "ticketAlreadyOpen", { thread: `<#${open.threadId}>` });
    }
    await interaction.showModal(buildTicketForm(language));
    return undefined;
  }

  // The form: opens the ticket's private thread.
  async function handleForm(interaction) {
    const { answer } = answerer(interaction);
    const settings = interaction.inCachedGuild() && ticketSettings(guildSettings, interaction.guildId);
    if (!settings) {
      return answer(Status.REFUSED, "ticketsOff");
    }
    const guild = interaction.guild;
    const channel = usableChannel(guild, settings.channelId);
    if (!channel) {
      logger.warn("Can't open tickets in the panel's channel; check the bot's permissions there", { guildId: guild.id });
      return answer(Status.FAILED, "ticketsBroken");
    }
    const open = liveTicket(guild, interaction.user.id);
    if (open) {
      return answer(Status.REFUSED, "ticketAlreadyOpen", { thread: `<#${open.threadId}>` });
    }
    if (tickets.countOpen(guild.id) >= MAX_OPEN_TICKETS) {
      return answer(Status.REFUSED, "ticketTooMany");
    }
    const subject = interaction.fields.getTextInputValue(FORM_INPUT).replace(/\r\n?/g, "\n").trim().slice(0, MAX_SUBJECT_LENGTH);
    const ticket = tickets.open({ guildId: guild.id, userId: interaction.user.id, subject: subject || "—", createdAt: now() });
    if (!ticket) {
      const existing = tickets.openForUser(guild.id, interaction.user.id);
      return answer(Status.REFUSED, "ticketAlreadyOpen", { thread: existing?.threadId ? `<#${existing.threadId}>` : "—" });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const name = interaction.member.displayName ?? interaction.user.username;
    let thread;
    try {
      thread = await channel.threads.create({
        name: threadName(ticket.number, name),
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: `Ticket #${ticket.number} opened by ${interaction.user.id}`,
      });
    } catch (error) {
      tickets.delete(ticket.id);
      if (isPermissionError(error)) {
        return answer(Status.FAILED, "ticketsBroken");
      }
      throw error;
    }
    tickets.setThread(ticket.id, thread.id);

    const staffRoleId = settings.staffRoleId ?? ticketStaffRoleId(guildSettings, guild.id);
    await thread.members.add(interaction.user.id);
    await thread.send({
      ...buildTicketWelcome(serverLanguage(guild, forcedLanguage), { ticket, staffRoleId }),
      allowedMentions: { users: [interaction.user.id], roles: staffRoleId ? [staffRoleId] : [] },
    });
    logger.info("Ticket opened", { guildId: guild.id, ticket: ticket.number });
    const outcome = await answer(Status.SUCCESS, "ticketOpened", { thread: `<#${thread.id}>`, number: ticket.number });
    // After answering, since it can take a while on a big staff team.
    await addStaff({ thread, guild, staffRoleId, logger });
    return outcome;
  }

  // "Close ticket" inside a ticket.
  async function handleCloseButton(interaction) {
    const { answer } = answerer(interaction);
    const ticket = tickets.byThread(interaction.channelId);
    if (!interaction.inCachedGuild() || !ticket || ticket.guildId !== interaction.guildId) {
      return answer(Status.REFUSED, "ticketNotATicket");
    }
    if (ticket.userId !== interaction.user.id && !isTicketStaff(interaction, guildSettings)) {
      return answer(Status.REFUSED, "ticketCloseNoPermission");
    }
    return closeTicket(interaction, ticket, null);
  }

  // A deleted ticket thread closes its ticket.
  function threadDeleted(thread) {
    const ticket = tickets.byThread(thread.id);
    if (ticket && tickets.close(ticket.id, { reason: "Thread deleted", closedAt: now() })) {
      logger.info("Ticket closed because its thread was deleted", { guildId: ticket.guildId, ticket: ticket.number });
    }
  }

  return {
    name: COMMAND_NAME,
    data: buildTicketsCommandData(),
    execute,
    threadDeleted,
    components: {
      [OPEN_BUTTON]: { label: "Open ticket button", handle: handleOpenButton },
      [FORM_ID]: { label: "Ticket form", handle: handleForm },
      [CLOSE_BUTTON]: { label: "Close ticket button", handle: handleCloseButton },
    },
  };
}
