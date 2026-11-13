// The /welcome command: admins set up welcome and leave messages, the welcome
// DM and autoroles. The same settings are on the dashboard's Community page.
//
//   /welcome channel channel:#welcome        post a welcome message there when someone joins
//   /welcome message text:<…>                the welcome message ({user}, {username}, {server}, {count}; \n for a new line)
//   /welcome leave-channel channel:#goodbye  post a leave message there when someone leaves
//   /welcome leave-message text:<…>          the leave message
//   /welcome dm text:<…>                     DM new members this
//   /welcome embed message:<welcome|leave|dm> [title] [description] [colour] [image] [thumbnail] [avatar] [footer] [remove]
//                                            send that message as an embed (only the parts given change; - removes one)
//   /welcome autorole role:@Member [bots]    give new members (or, with bots:True, new bots) a role, or stop giving it
//   /welcome milestones channel [every] [message]  celebrate every Nth member there
//   /welcome persist enabled:<true|false>    give members their roles back when they rejoin
//   /welcome off what:<…>                    switch one of these off, or reset a message to the default
//   /welcome test                            preview everything privately, with yourself as the new member
//   /welcome show
//
// Only members with the Manage Server permission can see or use it.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { MAX_AUTOROLES, MAX_MESSAGE_LENGTH, renderTemplate, welcomePayload } from "../community/welcome.js";
import { DEFAULT_MILESTONE_EVERY, MAX_MILESTONE_EVERY, milestoneFor, milestonePayload, MIN_MILESTONE_EVERY, normalizeMilestones } from "../community/milestones.js";
import { checkWelcomeEmbed, defaultEmbedColor, describeWelcomeEmbed, EMBED_SETTING, renderWelcomeEmbed, savedEmbed, TEXT_SETTING, WELCOME_EMBED_KINDS } from "../community/welcomeEmbeds.js";
import { InvalidMessage, LIMITS } from "../messages/embedMessage.js";
import { parseColor } from "./embed.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { variableRefusal } from "./commandHelpers.js";
import { normalizeRolePersist } from "../members/rolePersistence.js";
import { isModeratorRole } from "../permissions/moderatorPermissions.js";
import { Setting } from "../settings/guildSettings.js";

const COMMAND_NAME = "welcome";

// What /welcome off can switch off or reset, and the reply for each.
const OFF_CHOICES = [
  { value: "welcome", nameKey: "welcomeOffWelcome", settings: [Setting.WELCOME_CHANNEL], doneKey: "welcomeOffWelcomeDone" },
  { value: "leave", nameKey: "welcomeOffLeave", settings: [Setting.LEAVE_CHANNEL], doneKey: "welcomeOffLeaveDone" },
  { value: "dm", nameKey: "welcomeOffDm", settings: [Setting.WELCOME_DM, Setting.WELCOME_DM_EMBED], doneKey: "welcomeOffDmDone" },
  { value: "autoroles", nameKey: "welcomeOffAutoroles", settings: [Setting.AUTOROLES, Setting.BOT_AUTOROLES], doneKey: "welcomeOffAutorolesDone" },
  { value: "milestones", nameKey: "welcomeOffMilestones", settings: [Setting.MILESTONES], doneKey: "welcomeOffMilestonesDone" },
  {
    value: "messages",
    nameKey: "welcomeOffMessages",
    settings: [Setting.WELCOME_MESSAGE, Setting.LEAVE_MESSAGE],
    doneKey: "welcomeOffMessagesDone",
  },
];

// The messages /welcome embed can add an embed to, with their names.
const EMBED_CHOICES = { welcome: "welcomeTestWelcome", leave: "welcomeTestLeave", dm: "welcomeTestDm" };
// Typed in a text option of /welcome embed, removes that part.
const REMOVE = "-";

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
      withDescription(sub.setName("embed"), "welcomeEmbedDescription")
        .addStringOption((option) =>
          withDescription(option.setName("message"), "welcomeEmbedMessageOption")
            .setRequired(true)
            .addChoices(
              ...WELCOME_EMBED_KINDS.map((value) => ({
                name: translate("en", EMBED_CHOICES[value]),
                name_localizations: discordLocalizations(EMBED_CHOICES[value]),
                value,
              })),
            ),
        )
        .addStringOption((option) => withDescription(option.setName("title"), "welcomeEmbedTitleOption").setMaxLength(LIMITS.title))
        .addStringOption((option) => withDescription(option.setName("description"), "welcomeEmbedDescriptionOption").setMaxLength(LIMITS.description))
        .addStringOption((option) => withDescription(option.setName("colour"), "welcomeEmbedColorOption").setMaxLength(20))
        .addStringOption((option) => withDescription(option.setName("image"), "welcomeEmbedImageOption").setMaxLength(LIMITS.url))
        .addStringOption((option) => withDescription(option.setName("thumbnail"), "welcomeEmbedThumbnailOption").setMaxLength(LIMITS.url))
        .addBooleanOption((option) => withDescription(option.setName("avatar"), "welcomeEmbedAvatarOption"))
        .addStringOption((option) => withDescription(option.setName("footer"), "welcomeEmbedFooterOption").setMaxLength(LIMITS.footerText))
        .addBooleanOption((option) => withDescription(option.setName("remove"), "welcomeEmbedRemoveOption")),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("autorole"), "welcomeAutoroleDescription")
        .addRoleOption((option) => withDescription(option.setName("role"), "welcomeAutoroleOptionDescription").setRequired(true))
        .addBooleanOption((option) => withDescription(option.setName("bots"), "welcomeAutoroleBotsOption")),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("milestones"), "welcomeMilestonesDescription")
        .addChannelOption((option) => channelOption(option, "welcomeMilestonesChannelOption"))
        .addIntegerOption((option) =>
          withDescription(option.setName("every"), "welcomeMilestonesEveryOption").setMinValue(MIN_MILESTONE_EVERY).setMaxValue(MAX_MILESTONE_EVERY),
        )
        .addStringOption((option) => withDescription(option.setName("message"), "welcomeMilestonesMessageOption").setMaxLength(MAX_MESSAGE_LENGTH)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("persist"), "welcomePersistDescription").addBooleanOption((option) =>
        withDescription(option.setName("enabled"), "welcomePersistOptionDescription").setRequired(true),
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
      const refusal = variableRefusal(value, "welcome");
      if (refusal) {
        return reply(Status.REFUSED, "variablesRefused", refusal);
      }
      await guildSettings.set(guildId, setting, value);
      const preview = renderTemplate(value, { member: interaction.member, guild });
      const missing = needsChannel && !guildSettings.get(guildId, needsChannel) ? ["welcomeNoChannelYet"] : [];
      return reply(Status.SUCCESS, doneKey, { preview }, missing);
    };

    // /welcome embed: changes only the parts given, then shows the result.
    const setEmbed = async () => {
      const kind = interaction.options.getString("message", true);
      const setting = EMBED_SETTING[kind];
      if (!setting) {
        return reply(Status.FAILED, "unexpected");
      }
      const which = text(EMBED_CHOICES[kind]);
      if (interaction.options.getBoolean("remove")) {
        await guildSettings.clear(guildId, setting);
        return reply(Status.SUCCESS, "welcomeEmbedRemoved", { which });
      }
      const option = (name) => {
        const value = interaction.options.getString(name);
        return value === null ? undefined : withNewLines(value);
      };
      const parts = Object.fromEntries(["title", "description", "colour", "image", "thumbnail", "footer"].map((name) => [name, option(name)]));
      const avatar = interaction.options.getBoolean("avatar");
      if (Object.values(parts).every((value) => value === undefined) && avatar === null) {
        return reply(Status.REFUSED, "welcomeEmbedNothing");
      }
      const embed = structuredClone(savedEmbed(guildSettings, guildId, kind) ?? {});
      const put = (value, apply) => value !== undefined && apply(value === REMOVE ? "" : value);
      put(parts.title, (value) => {
        embed.title = value;
        if (!value) {
          delete embed.url;
        }
      });
      put(parts.description, (value) => (embed.description = value));
      put(parts.footer, (value) => (embed.footer = { text: value }));
      put(parts.image, (value) => (embed.image = { url: value }));
      put(parts.thumbnail, (value) => {
        embed.thumbnail = { url: value };
        if (value) {
          delete embed.memberAvatar;
        }
      });
      if (avatar !== null) {
        embed.memberAvatar = avatar;
      }
      if (parts.colour !== undefined) {
        const color = parts.colour === REMOVE ? null : parseColor(parts.colour);
        if (color === undefined) {
          return reply(Status.REFUSED, "embedBadColor", { color: parts.colour.slice(0, 20) });
        }
        embed.color = color;
      }
      let checked;
      try {
        checked = checkWelcomeEmbed(embed);
      } catch (error) {
        if (error instanceof InvalidMessage) {
          return reply(Status.REFUSED, "welcomeEmbedInvalid", { reason: error.message });
        }
        throw error;
      }
      if (!checked) {
        await guildSettings.clear(guildId, setting);
        return reply(Status.SUCCESS, "welcomeEmbedRemoved", { which });
      }
      await guildSettings.set(guildId, setting, checked);
      const notes = [];
      if (kind !== "dm" && !guildSettings.get(guildId, TEXT_SETTING[kind])) {
        notes.push("welcomeEmbedTextNote");
      }
      if (kind !== "dm" && !guildSettings.get(guildId, kind === "leave" ? Setting.LEAVE_CHANNEL : Setting.WELCOME_CHANNEL)) {
        notes.push("welcomeNoChannelYet");
      }
      const preview = renderWelcomeEmbed(checked, { member: interaction.member, guild, color: defaultEmbedColor(guildSettings, guildId) });
      await interaction.reply({
        content: [text("welcomeEmbedSaved", { which }), ...notes.map((key) => text(key))].join("\n"),
        embeds: [preview],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return { status: Status.SUCCESS, note: `${translate("en", EMBED_CHOICES[kind])} embed: ${describeWelcomeEmbed(checked)}` };
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
      case "embed":
        return setEmbed();
      case "autorole": {
        const role = interaction.options.getRole("role", true);
        const forBots = interaction.options.getBoolean("bots") === true;
        const setting = forBots ? Setting.BOT_AUTOROLES : Setting.AUTOROLES;
        const values = { role: `<@&${role.id}>` };
        const roles = guildSettings.getList(guildId, setting);
        if (roles.includes(role.id)) {
          await guildSettings.toggleInList(guildId, setting, role.id);
          return reply(Status.SUCCESS, forBots ? "welcomeBotAutoroleRemoved" : "welcomeAutoroleRemoved", values);
        }
        if (role.id === guildId || role.managed) {
          return reply(Status.REFUSED, "welcomeAutoroleInvalid", values);
        }
        if (isModeratorRole(role)) {
          return reply(Status.REFUSED, "welcomeAutoroleDangerous", values);
        }
        if (roles.length >= MAX_AUTOROLES) {
          return reply(Status.REFUSED, "welcomeAutoroleFull", { max: MAX_AUTOROLES });
        }
        await guildSettings.toggleInList(guildId, setting, role.id);
        const botCanGive = Boolean(me && role.position < me.roles.highest.position && me.permissions.has(PermissionFlagsBits.ManageRoles));
        const notes = [...(botCanGive ? [] : ["welcomeAutoroleAboveBot"]), ...(hasOnboarding(guild) && !forBots ? ["welcomeOnboardingTip"] : [])];
        return reply(Status.SUCCESS, forBots ? "welcomeBotAutoroleAdded" : "welcomeAutoroleAdded", values, notes);
      }
      case "milestones": {
        const channel = interaction.options.getChannel("channel", true);
        const every = interaction.options.getInteger("every") ?? DEFAULT_MILESTONE_EVERY;
        const typed = interaction.options.getString("message");
        const message = typed === null ? normalizeMilestones(guildSettings.get(guildId, Setting.MILESTONES))?.message ?? null : withNewLines(typed) || null;
        if (message) {
          const refusal = variableRefusal(message, "welcome");
          if (refusal) {
            return reply(Status.REFUSED, "variablesRefused", refusal);
          }
        }
        const config = { channelId: channel.id, every, message };
        await guildSettings.set(guildId, Setting.MILESTONES, config);
        const canPost = Boolean(me && channel.permissionsFor?.(me)?.has(POST_PERMISSIONS));
        const count = guild.memberCount ?? 0;
        const next = milestoneFor(count, every) + every;
        const language = pickLanguage(guild.preferredLocale, forcedLanguage);
        const preview = milestonePayload(config, { member: interaction.member, guild, milestone: next, language }).content;
        return reply(
          Status.SUCCESS,
          "welcomeMilestonesSet",
          { channel: `<#${channel.id}>`, every: every.toLocaleString("en-US"), next: next.toLocaleString("en-US"), preview },
          canPost ? [] : ["welcomeCannotPost"],
        );
      }
      case "persist": {
        const enabled = interaction.options.getBoolean("enabled", true);
        const config = normalizeRolePersist(guildSettings.get(guildId, Setting.ROLE_PERSIST));
        await guildSettings.set(guildId, Setting.ROLE_PERSIST, { ...config, enabled });
        return reply(Status.SUCCESS, enabled ? "welcomePersistOn" : "welcomePersistOff");
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
        const lines = [text("welcomeTestTitle")];
        const embeds = [];
        const sections = [
          ["welcome", "welcomeTestWelcome", guildSettings.get(guildId, Setting.WELCOME_CHANNEL)],
          ["leave", "welcomeTestLeave", guildSettings.get(guildId, Setting.LEAVE_CHANNEL)],
          ["dm", "welcomeTestDm", true],
        ];
        for (const [kind, labelKey, on] of sections) {
          const payload = welcomePayload(guildSettings, guild, member, kind, forcedLanguage);
          lines.push(`**${text(labelKey)}** ${on && payload ? "" : text("welcomeTestOff")}`);
          if (payload?.content) {
            lines.push(`> ${payload.content.replace(/\n/g, "\n> ")}`);
          }
          if (payload?.embeds.length) {
            embeds.push(...payload.embeds);
            lines.push(`> ${text("welcomeTestEmbedBelow", { number: embeds.length })}`);
          }
        }
        await interaction.reply({ content: lines.join("\n").slice(0, 2000), embeds, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return result(Status.SUCCESS);
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
          text(guildSettings.get(guildId, Setting.WELCOME_DM) || savedEmbed(guildSettings, guildId, "dm") ? "welcomeShowDm" : "welcomeShowNoDm"),
          (() => {
            const withEmbeds = WELCOME_EMBED_KINDS.filter((kind) => savedEmbed(guildSettings, guildId, kind)).map((kind) => text(EMBED_CHOICES[kind]));
            return withEmbeds.length > 0 ? text("welcomeShowEmbeds", { list: withEmbeds.join(", ") }) : text("welcomeShowNoEmbeds");
          })(),
          roles.length > 0
            ? text("welcomeShowAutoroles", { roles: roles.map((id) => `<@&${id}>`).join(", ") })
            : text("welcomeShowNoAutoroles"),
          roles.length > 0 && hasOnboarding(guild) ? text("welcomeOnboardingTip") : "",
          (() => {
            const botRoles = guildSettings.getList(guildId, Setting.BOT_AUTOROLES);
            return botRoles.length > 0 ? text("welcomeShowBotAutoroles", { roles: botRoles.map((id) => `<@&${id}>`).join(", ") }) : "";
          })(),
          (() => {
            const milestones = normalizeMilestones(guildSettings.get(guildId, Setting.MILESTONES));
            return milestones
              ? text("welcomeShowMilestones", { every: milestones.every.toLocaleString("en-US"), channel: `<#${milestones.channelId}>` })
              : text("welcomeShowNoMilestones");
          })(),
          text(normalizeRolePersist(guildSettings.get(guildId, Setting.ROLE_PERSIST)).enabled ? "welcomeShowPersistOn" : "welcomeShowPersistOff"),
          text("welcomeShowTestHint"),
        ].filter(Boolean));
      }
    }
    return reply(Status.FAILED, "unexpected");
  }

  return { name: COMMAND_NAME, data: buildWelcomeCommandData(), execute };
}
