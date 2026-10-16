// The /welcome command: admins set up welcome and leave messages, the welcome
// DM and autoroles. The same settings are on the dashboard's Community page.
//
//   /welcome channel channel:#welcome        post a welcome message there when someone joins
//   /welcome message text:<…>                the welcome message ({user}, {username}, {server}, {count}; \n for a new line)
//   /welcome leave-channel channel:#goodbye  post a leave message there when someone leaves
//   /welcome leave-message text:<…>          the leave message
//   /welcome dm text:<…>                     DM new members this
//   /welcome autorole role:@Member           give new members a role, or stop giving it
//   /welcome off what:<…>                    switch one of these off, or reset a message to the default
//   /welcome test                            preview everything privately, with yourself as the new member
//   /welcome show
//
// Only members with the Manage Server permission can see or use it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { MAX_AUTOROLES, MAX_MESSAGE_LENGTH, renderTemplate, welcomeText } from "../community/welcome.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";

const COMMAND_NAME = "welcome";

// What /welcome off can switch off or reset, and the reply for each.
const OFF_CHOICES = [
  { value: "welcome", nameKey: "welcomeOffWelcome", settings: [Setting.WELCOME_CHANNEL], doneKey: "welcomeOffWelcomeDone" },
  { value: "leave", nameKey: "welcomeOffLeave", settings: [Setting.LEAVE_CHANNEL], doneKey: "welcomeOffLeaveDone" },
  { value: "dm", nameKey: "welcomeOffDm", settings: [Setting.WELCOME_DM], doneKey: "welcomeOffDmDone" },
  { value: "autoroles", nameKey: "welcomeOffAutoroles", settings: [Setting.AUTOROLES], doneKey: "welcomeOffAutorolesDone" },
  {
    value: "messages",
    nameKey: "welcomeOffMessages",
    settings: [Setting.WELCOME_MESSAGE, Setting.LEAVE_MESSAGE],
    doneKey: "welcomeOffMessagesDone",
  },
];

const POSTING_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// Community servers have Discord's own Onboarding, which we recommend over autoroles.
const hasOnboarding = (guild) => Boolean(guild.features?.includes("COMMUNITY"));
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const textOption = (option, key) =>
  withDescription(option.setName("text"), key).setRequired(true).setMaxLength(MAX_MESSAGE_LENGTH);
const channelOption = (option, key) =>
  withDescription(option.setName("channel"), key).setRequired(true).addChannelTypes(...POSTING_CHANNELS);

export function buildWelcomeCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "welcomeCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("channel"), "welcomeChannelDescription").addChannelOption((option) =>
        channelOption(option, "welcomeChannelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("message"), "welcomeMessageDescription").addStringOption((option) =>
        textOption(option, "welcomeTextOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("leave-channel"), "welcomeLeaveChannelDescription").addChannelOption((option) =>
        channelOption(option, "welcomeLeaveChannelOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("leave-message"), "welcomeLeaveMessageDescription").addStringOption((option) =>
        textOption(option, "welcomeTextOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("dm"), "welcomeDmDescription").addStringOption((option) =>
        textOption(option, "welcomeTextOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("autorole"), "welcomeAutoroleDescription").addRoleOption((option) =>
        withDescription(option.setName("role"), "welcomeAutoroleOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("off"), "welcomeOffDescription").addStringOption((option) =>
        withDescription(option.setName("what"), "welcomeOffOptionDescription")
          .setRequired(true)
          .addChoices(
            ...OFF_CHOICES.map(({ value, nameKey }) => ({
              name: translate("en", nameKey),
              name_localizations: discordLocalizations(nameKey),
              value,
            })),
          ),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("test"), "welcomeTestDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("show"), "welcomeShowDescription"))
    .toJSON();
}

// "Hello\nthere" typed in Discord (which has no new lines in options) -> two lines.
const withNewLines = (text) => text.replace(/\\n/g, "\n").trim();

// Options:
//   guildSettings, forcedLanguage
export function createWelcomeCommand({ guildSettings, forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const reply = async (status, key, values, extraKeys = []) => {
      const keys = [key, ...extraKeys];
      await interaction.reply({
        content: keys.map((entry) => text(entry, values)).join("\n"),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return extraKeys.length === 0
        ? result(status, key, values)
        : { status, note: keys.map((entry) => translate("en", entry, values)).join("\n") };
    };
    const replyLines = async (lines) => {
      await interaction.reply({ content: lines.join("\n").slice(0, 2000), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(Status.SUCCESS);
    };

    if (!interaction.inCachedGuild()) {
      return reply(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return reply(Status.REFUSED, "settingsNoPermission");
    }
    const guild = interaction.guild;
    const guildId = interaction.guildId;
    const me = guild.members.me;

    const setChannel = async (setting, doneKey) => {
      const channel = interaction.options.getChannel("channel", true);
      await guildSettings.set(guildId, setting, channel.id);
      const canPost = Boolean(me && channel.permissionsFor?.(me)?.has(POST_PERMISSIONS));
      return reply(Status.SUCCESS, doneKey, { channel: `<#${channel.id}>` }, canPost ? [] : ["welcomeCannotPost"]);
    };
    const setText = async (setting, doneKey, needsChannel) => {
      const value = withNewLines(interaction.options.getString("text", true));
      if (!value) {
        return reply(Status.REFUSED, "welcomeEmptyText");
      }
      await guildSettings.set(guildId, setting, value);
      const preview = renderTemplate(value, { member: interaction.member, guild });
      const missing = needsChannel && !guildSettings.get(guildId, needsChannel) ? ["welcomeNoChannelYet"] : [];
      return reply(Status.SUCCESS, doneKey, { preview }, missing);
    };

    switch (interaction.options.getSubcommand()) {
      case "channel":
        return setChannel(Setting.WELCOME_CHANNEL, "welcomeChannelSet");
      case "leave-channel":
        return setChannel(Setting.LEAVE_CHANNEL, "welcomeLeaveChannelSet");
      case "message":
        return setText(Setting.WELCOME_MESSAGE, "welcomeMessageSet", Setting.WELCOME_CHANNEL);
      case "leave-message":
        return setText(Setting.LEAVE_MESSAGE, "welcomeLeaveMessageSet", Setting.LEAVE_CHANNEL);
      case "dm":
        return setText(Setting.WELCOME_DM, "welcomeDmSet");
      case "autorole": {
        const role = interaction.options.getRole("role", true);
        const values = { role: `<@&${role.id}>` };
        const roles = guildSettings.getList(guildId, Setting.AUTOROLES);
        if (roles.includes(role.id)) {
          await guildSettings.toggleInList(guildId, Setting.AUTOROLES, role.id);
          return reply(Status.SUCCESS, "welcomeAutoroleRemoved", values);
        }
        if (role.id === guildId || role.managed) {
          return reply(Status.REFUSED, "welcomeAutoroleInvalid", values);
        }
        if (role.permissions?.has(PermissionFlagsBits.Administrator) || role.permissions?.has(PermissionFlagsBits.ManageGuild)) {
          return reply(Status.REFUSED, "welcomeAutoroleDangerous", values);
        }
        if (roles.length >= MAX_AUTOROLES) {
          return reply(Status.REFUSED, "welcomeAutoroleFull", { max: MAX_AUTOROLES });
        }
        await guildSettings.toggleInList(guildId, Setting.AUTOROLES, role.id);
        const botCanGive = Boolean(me && role.position < me.roles.highest.position && me.permissions.has(PermissionFlagsBits.ManageRoles));
        const notes = [...(botCanGive ? [] : ["welcomeAutoroleAboveBot"]), ...(hasOnboarding(guild) ? ["welcomeOnboardingTip"] : [])];
        return reply(Status.SUCCESS, "welcomeAutoroleAdded", values, notes);
      }
      case "off": {
        const choice = OFF_CHOICES.find(({ value }) => value === interaction.options.getString("what", true));
        if (!choice) {
          return reply(Status.FAILED, "unexpected");
        }
        for (const setting of choice.settings) {
          await guildSettings.clear(guildId, setting);
        }
        return reply(Status.SUCCESS, choice.doneKey);
      }
      case "test": {
        const member = interaction.member;
        const dm = guildSettings.get(guildId, Setting.WELCOME_DM);
        return replyLines([
          text("welcomeTestTitle"),
          `**${text("welcomeTestWelcome")}** ${guildSettings.get(guildId, Setting.WELCOME_CHANNEL) ? "" : text("welcomeTestOff")}`,
          `> ${welcomeText(guildSettings, guild, member, "welcome", forcedLanguage).replace(/\n/g, "\n> ")}`,
          `**${text("welcomeTestLeave")}** ${guildSettings.get(guildId, Setting.LEAVE_CHANNEL) ? "" : text("welcomeTestOff")}`,
          `> ${welcomeText(guildSettings, guild, member, "leave", forcedLanguage).replace(/\n/g, "\n> ")}`,
          `**${text("welcomeTestDm")}** ${dm ? "" : text("welcomeTestOff")}`,
          dm ? `> ${renderTemplate(dm, { member, guild }).replace(/\n/g, "\n> ")}` : "",
        ].filter(Boolean));
      }
      case "show": {
        const channelLine = (setting, onKey, offKey) => {
          const id = guildSettings.get(guildId, setting);
          return id ? text(onKey, { channel: `<#${id}>` }) : text(offKey);
        };
        const roles = guildSettings.getList(guildId, Setting.AUTOROLES);
        return replyLines([
          channelLine(Setting.WELCOME_CHANNEL, "welcomeShowChannel", "welcomeShowNoChannel"),
          text(guildSettings.get(guildId, Setting.WELCOME_MESSAGE) ? "welcomeShowCustomMessage" : "welcomeShowDefaultMessage"),
          channelLine(Setting.LEAVE_CHANNEL, "welcomeShowLeaveChannel", "welcomeShowNoLeaveChannel"),
          text(guildSettings.get(guildId, Setting.WELCOME_DM) ? "welcomeShowDm" : "welcomeShowNoDm"),
          roles.length > 0
            ? text("welcomeShowAutoroles", { roles: roles.map((id) => `<@&${id}>`).join(", ") })
            : text("welcomeShowNoAutoroles"),
          roles.length > 0 && hasOnboarding(guild) ? text("welcomeOnboardingTip") : "",
          text("welcomeShowTestHint"),
        ].filter(Boolean));
      }
    }
    return reply(Status.FAILED, "unexpected");
  }

  return { name: COMMAND_NAME, data: buildWelcomeCommandData(), execute };
}
