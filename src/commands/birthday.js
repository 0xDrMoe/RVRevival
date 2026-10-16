// Birthdays.
//
//   /birthday set month:<1-12> day:<1-31>     save your birthday (no year)
//   /birthday remove [user]                    forget yours (someone else's needs Manage Server)
//   /birthday show [user]                      see a saved birthday
//   /birthday upcoming                         the next birthdays in this server
//   /birthday setup [channel] [role] [timezone] [message]   turn it on or change it (Manage Server)
//   /birthday off                              turn it off (Manage Server)
//
// See birthdays/birthdays.js for the greeting and the role.

import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import {
  birthdaySettings,
  DEFAULT_TIMEZONE,
  daysUntil,
  formatBirthday,
  isValidDate,
  isValidTimeZone,
  MAX_BIRTHDAY_MESSAGE_LENGTH,
  todayIn,
} from "../birthdays/birthdays.js";
import { roleProblem } from "../community/rolePanels.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";

const COMMAND_NAME = "birthday";
const UPCOMING_COUNT = 10;
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

export function buildBirthdayCommandData() {
  const command = new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild);
  return withDescription(command, "birthdayCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "birthdaySetDescription")
        .addIntegerOption((option) =>
          withDescription(option.setName("month"), "birthdayMonthOptionDescription").setRequired(true).setMinValue(1).setMaxValue(12),
        )
        .addIntegerOption((option) =>
          withDescription(option.setName("day"), "birthdayDayOptionDescription").setRequired(true).setMinValue(1).setMaxValue(31),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "birthdayRemoveDescription").addUserOption((option) =>
        withDescription(option.setName("user"), "birthdayRemoveUserOptionDescription"),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("show"), "birthdayShowDescription").addUserOption((option) =>
        withDescription(option.setName("user"), "birthdayShowUserOptionDescription"),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("upcoming"), "birthdayUpcomingDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("setup"), "birthdaySetupDescription")
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "birthdayChannelOptionDescription").addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          ),
        )
        .addRoleOption((option) => withDescription(option.setName("role"), "birthdayRoleOptionDescription"))
        .addStringOption((option) =>
          withDescription(option.setName("timezone"), "birthdayTimezoneOptionDescription").setAutocomplete(true).setMaxLength(64),
        )
        .addStringOption((option) =>
          withDescription(option.setName("message"), "birthdayMessageOptionDescription").setMaxLength(MAX_BIRTHDAY_MESSAGE_LENGTH),
        ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("off"), "birthdayOffDescription"))
    .toJSON();
}

// Options: guildSettings, store (BirthdayStore; only needed to run the command), forcedLanguage, now
export function createBirthdayCommand({ guildSettings, store, forcedLanguage, now = Date.now }) {
  async function setup(interaction, answer) {
    const guild = interaction.guild;
    const saved = guildSettings.get(guild.id, Setting.BIRTHDAYS) ?? {};
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");
    const timezone = interaction.options.getString("timezone")?.trim();
    const message = interaction.options.getString("message")?.replace(/\\n/g, "\n").trim();
    const me = guild.members.me;

    if (timezone && !isValidTimeZone(timezone)) {
      return answer(Status.REFUSED, "birthdayBadTimezone");
    }
    if (channel && !(me && channel.permissionsFor?.(me)?.has(POST_PERMISSIONS))) {
      return answer(Status.REFUSED, "birthdayBotCantPost", { channel: `<#${channel.id}>` });
    }
    if (role && roleProblem(role, { guild, admin: interaction.member, bot: me })) {
      return answer(Status.REFUSED, "birthdayBadRole", { role: `<@&${role.id}>` });
    }
    const config = {
      channelId: channel?.id ?? saved.channelId ?? null,
      roleId: role?.id ?? saved.roleId ?? null,
      message: message || saved.message || null,
      timezone: timezone || saved.timezone || DEFAULT_TIMEZONE,
    };
    if (!config.channelId && !config.roleId) {
      return answer(Status.REFUSED, "birthdayNeedsChannelOrRole");
    }
    await guildSettings.set(guild.id, Setting.BIRTHDAYS, config);
    return answer(Status.SUCCESS, "birthdaySetupDone", {
      channel: config.channelId ? `<#${config.channelId}>` : "—",
      role: config.roleId ? `<@&${config.roleId}>` : "—",
      timezone: config.timezone,
    });
  }

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const guildId = interaction.guildId;
    const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    const config = birthdaySettings(guildSettings, guildId);

    switch (interaction.options.getSubcommand()) {
      case "set": {
        const month = interaction.options.getInteger("month", true);
        const day = interaction.options.getInteger("day", true);
        if (!isValidDate(month, day)) {
          return answer(Status.REFUSED, "birthdayBadDate");
        }
        store.set({ guildId, userId: interaction.user.id, month, day, createdAt: now() });
        return answer(Status.SUCCESS, config ? "birthdaySaved" : "birthdaySavedOff", { date: formatBirthday(language, { month, day }) });
      }
      case "remove": {
        const user = interaction.options.getUser("user");
        if (user && user.id !== interaction.user.id && !canManage) {
          return answer(Status.REFUSED, "birthdayNeedsManageGuild");
        }
        const userId = user?.id ?? interaction.user.id;
        if (!store.remove(guildId, userId)) {
          return answer(Status.REFUSED, "birthdayNotSaved", { user: `<@${userId}>` });
        }
        return answer(Status.SUCCESS, "birthdayRemoved", { user: `<@${userId}>` });
      }
      case "show": {
        const userId = interaction.options.getUser("user")?.id ?? interaction.user.id;
        const birthday = store.get(guildId, userId);
        if (!birthday) {
          return answer(Status.SUCCESS, "birthdayNotSaved", { user: `<@${userId}>` });
        }
        return answer(Status.SUCCESS, "birthdayShow", { user: `<@${userId}>`, date: formatBirthday(language, birthday) });
      }
      case "upcoming": {
        const today = todayIn(config?.timezone ?? DEFAULT_TIMEZONE, now());
        const next = store
          .all(guildId)
          .map((birthday) => ({ ...birthday, days: daysUntil(birthday, today) }))
          .sort((a, b) => a.days - b.days)
          .slice(0, UPCOMING_COUNT);
        if (next.length === 0) {
          return answer(Status.SUCCESS, "birthdayUpcomingEmpty");
        }
        const lines = next.map(
          (birthday) =>
            `• ${formatBirthday(language, birthday)}: <@${birthday.userId}>${birthday.days === 0 ? ` 🎂 ${text("birthdayToday")}` : ""}`,
        );
        await interaction.reply({
          content: [text("birthdayUpcomingTitle"), ...lines].join("\n").slice(0, 2000),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return result(Status.SUCCESS);
      }
      case "setup":
      case "off": {
        if (!canManage) {
          return answer(Status.REFUSED, "birthdayNeedsManageGuild");
        }
        if (interaction.options.getSubcommand() === "setup") {
          return setup(interaction, answer);
        }
        if (!guildSettings.get(guildId, Setting.BIRTHDAYS)) {
          return answer(Status.REFUSED, "birthdayAlreadyOff");
        }
        await guildSettings.clear(guildId, Setting.BIRTHDAYS);
        return answer(Status.SUCCESS, "birthdayOffDone");
      }
    }
    return answer(Status.FAILED, "unexpected");
  }

  // Suggests time zones.
  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    const choices = TIME_ZONES.filter((zone) => zone.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((zone) => ({ name: zone, value: zone }));
    await interaction.respond(choices);
  }

  return { name: COMMAND_NAME, data: buildBirthdayCommandData(), execute, autocomplete };
}
