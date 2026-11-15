// /color: color roles members pick for themselves (colors/colorService.js).
//
// Everyone (unless the server limits who, see colors/options.js):
//   /color list                         every color, numbered, as a picture or a text list
//   /color set color:<name or number>   swap to that color
//   /color random                       a random color from the list
//   /color remove                       no color
//   /color info color:<…>               the color's role, hex, members and number
//
// Color managers (owner, Administrator, the color manager roles, or Manage
// Roles when the server has none):
//   /color give member color   /color take member
//   /color add name hex [gradient]       make a new color role
//   /color existing role [name]          use a role the server already has
//   /color edit color [name] [hex] [gradient] [single]
//   /color delete color   /color clear   /color pack pack   /color sort by
//   /color sync                          remake deleted roles, copy role edits
//   /color panel channel                 post a panel with menus to pick from
//   /color suggest                       a random color to add
//   /color settings [...]                the list picture, channel, join color, overlap warning

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  cleanColorName,
  colorChoices,
  findColor,
  hexToInt,
  MAX_COLORS,
  MAX_NAME_LENGTH,
  nameTaken,
  parseColor,
  SortKind,
  sortColors,
} from "../colors/colors.js";
import { ColorError, colorOptionsOf, GRADIENT_FEATURE, PICK_PREFIX, REMOVE_ID, createColorService } from "../colors/colorService.js";
import { checkColorOptions, InvalidColorOptions, RANDOM_JOIN_COLOR } from "../colors/options.js";
import { PACK_NAMES, PACKS } from "../colors/packs.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { isPermissionError } from "../utils/discordErrors.js";

const COMMAND_NAME = "color";
const MEMBER_SUBCOMMANDS = new Set(["list", "set", "random", "remove", "info"]);
const SORT_PREFIX = "color:sort:";
const CLEAR_PREFIX = "color:clear:";
const SUGGEST_PREFIX = "color:suggest:";
const NAME_FORM_PREFIX = "color:name:";
const NAME_INPUT = "name";

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const choice = (key, value) => ({ name: translate("en", key), name_localizations: discordLocalizations(key), value });
const colorOption = (option, key = "colorColorOptionDescription") => withDescription(option.setName("color"), key).setRequired(true).setAutocomplete(true).setMaxLength(MAX_NAME_LENGTH);
const hexOption = (option, name, key, required = false) => withDescription(option.setName(name), key).setRequired(required).setMaxLength(20);

export function buildColorCommandData() {
  const command = new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild);
  return withDescription(command, "colorCommandDescription")
    .addSubcommand((sub) => withDescription(sub.setName("list"), "colorListDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("set"), "colorSetDescription").addStringOption((option) => colorOption(option)))
    .addSubcommand((sub) => withDescription(sub.setName("random"), "colorRandomDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "colorRemoveDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("info"), "colorInfoDescription").addStringOption((option) => colorOption(option)))
    .addSubcommand((sub) =>
      withDescription(sub.setName("give"), "colorGiveDescription")
        .addUserOption((option) => withDescription(option.setName("member"), "colorMemberOptionDescription").setRequired(true))
        .addStringOption((option) => colorOption(option)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("take"), "colorTakeDescription").addUserOption((option) =>
        withDescription(option.setName("member"), "colorMemberOptionDescription").setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "colorAddDescription")
        .addStringOption((option) => withDescription(option.setName("name"), "colorNameOptionDescription").setRequired(true).setMaxLength(MAX_NAME_LENGTH))
        .addStringOption((option) => hexOption(option, "hex", "colorHexOptionDescription", true))
        .addStringOption((option) => hexOption(option, "gradient", "colorGradientOptionDescription")),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("existing"), "colorExistingDescription")
        .addRoleOption((option) => withDescription(option.setName("role"), "colorRoleOptionDescription").setRequired(true))
        .addStringOption((option) => withDescription(option.setName("name"), "colorExistingNameOptionDescription").setMaxLength(MAX_NAME_LENGTH)),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("edit"), "colorEditDescription")
        .addStringOption((option) => colorOption(option))
        .addStringOption((option) => withDescription(option.setName("name"), "colorNewNameOptionDescription").setMaxLength(MAX_NAME_LENGTH))
        .addStringOption((option) => hexOption(option, "hex", "colorNewHexOptionDescription"))
        .addStringOption((option) => hexOption(option, "gradient", "colorGradientOptionDescription"))
        .addBooleanOption((option) => withDescription(option.setName("single"), "colorSingleOptionDescription")),
    )
    .addSubcommand((sub) => withDescription(sub.setName("delete"), "colorDeleteDescription").addStringOption((option) => colorOption(option)))
    .addSubcommand((sub) =>
      withDescription(sub.setName("pack"), "colorPackDescription").addStringOption((option) =>
        withDescription(option.setName("pack"), "colorPackOptionDescription")
          .setRequired(true)
          .addChoices(...PACK_NAMES.map((name) => choice(`colorPack_${name}`, name))),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("sort"), "colorSortDescription").addStringOption((option) =>
        withDescription(option.setName("by"), "colorSortOptionDescription")
          .setRequired(true)
          .addChoices(...Object.values(SortKind).map((kind) => choice(`colorSort_${kind}`, kind))),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("sync"), "colorSyncDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("clear"), "colorClearDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("panel"), "colorPanelDescription").addChannelOption((option) =>
        withDescription(option.setName("channel"), "colorPanelChannelOptionDescription")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("suggest"), "colorSuggestDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("settings"), "colorSettingsDescription")
        .addBooleanOption((option) => withDescription(option.setName("image"), "colorImageOptionDescription"))
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "colorChannelOptionDescription").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addBooleanOption((option) => withDescription(option.setName("any-channel"), "colorAnyChannelOptionDescription"))
        .addStringOption((option) => withDescription(option.setName("join"), "colorJoinOptionDescription").setAutocomplete(true).setMaxLength(MAX_NAME_LENGTH))
        .addBooleanOption((option) => withDescription(option.setName("overlap-warning"), "colorOverlapOptionDescription")),
    )
    .toJSON();
}

// The closest named color in the packs, as a starting name for a suggestion.
export function nearestName(hex) {
  const target = hexToInt(hex);
  const distance = (other) => {
    const value = hexToInt(other);
    return ((target >> 16) - (value >> 16)) ** 2 + (((target >> 8) & 255) - ((value >> 8) & 255)) ** 2 + ((target & 255) - (value & 255)) ** 2;
  };
  return Object.values(PACKS)
    .flat()
    .reduce((best, entry) => (distance(entry[1]) < distance(best[1]) ? entry : best))[0];
}

// Options:
//   guildSettings, logger, forcedLanguage
//   service   colors/colorService.js (made here when left out)
export function createColorCommand({ guildSettings, logger, forcedLanguage, service = createColorService({ guildSettings, logger, forcedLanguage }) }) {
  const helpers = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    // Ephemeral, or the deferred reply's edit.
    const answer = async (status, key, values = {}, extra = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] }, ...extra };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return result(status, key, values);
    };
    // A ColorError becomes its message; anything else is a real crash.
    const refused = (error) => {
      if (error instanceof ColorError) {
        return answer(Status.REFUSED, error.key, error.values);
      }
      if (isPermissionError(error)) {
        return answer(Status.FAILED, "colorBotNeedsManageRoles");
      }
      throw error;
    };
    return { language, text, answer, refused };
  };

  // "Your color is now X" plus the overlap warning when a higher role hides it.
  function pickedText(text, interaction, member, color) {
    const lines = [text("colorSet", { color: `<@&${color.roleId}>` })];
    const hiding = colorOptionsOf(guildSettings, interaction.guildId).overlapWarning && service.hidingRole(interaction.guild, member, color);
    if (hiding) {
      lines.push(text("colorHidden", { role: `<@&${hiding.id}>` }));
    }
    return lines.join("\n");
  }

  async function pick(interaction, member, color) {
    const { text, answer, refused } = helpers(interaction);
    try {
      const { changed } = await service.applyColor(interaction.guild, member, color);
      if (!changed) {
        return answer(Status.SUCCESS, "colorAlreadyHave", { color: `<@&${color.roleId}>` });
      }
    } catch (error) {
      return refused(error);
    }
    const content = pickedText(text, interaction, member, color);
    await (interaction.deferred || interaction.replied
      ? interaction.editReply({ content, allowedMentions: { parse: [] } })
      : interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }));
    return { status: Status.SUCCESS, note: `Color set to ${color.name} (${color.hex}).` };
  }

  // The color named in an option, or a refusal reply.
  function colorFrom(interaction, name = "color") {
    return findColor(service.colors(interaction.guildId), interaction.options.getString(name, true));
  }

  // --- Members ----------------------------------------------------------------------

  async function memberSubcommand(interaction, subcommand) {
    const { language, text, answer, refused } = helpers(interaction);
    const guild = interaction.guild;
    const member = interaction.member;
    if (subcommand === "list") {
      const payload = await service.listPayload(guild, language);
      await interaction.reply({ ...payload, allowedMentions: { parse: [] } });
      return result(Status.SUCCESS);
    }
    if (subcommand === "info") {
      const color = colorFrom(interaction);
      if (!color) {
        return answer(Status.REFUSED, "colorNotFound");
      }
      const list = service.colors(guild.id);
      const role = guild.roles.cache.get(color.roleId);
      const embed = new EmbedBuilder()
        .setColor(hexToInt(color.hex))
        .setTitle(`${list.indexOf(color) + 1}. ${color.name}`)
        .addFields(
          { name: text("colorInfoRole"), value: role ? `<@&${role.id}>` : text("colorInfoRoleMissing"), inline: true },
          { name: text("colorInfoHex"), value: color.hex2 ? `\`${color.hex}\` → \`${color.hex2}\`` : `\`${color.hex}\``, inline: true },
          { name: text("colorInfoMembers"), value: role ? String(role.members.size) : "0", inline: true },
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(Status.SUCCESS);
    }

    const refusal = service.pickRefusal(guild, member);
    if (refusal) {
      return answer(Status.REFUSED, refusal);
    }
    if (subcommand === "remove") {
      try {
        const { changed } = await service.applyColor(guild, member, null);
        return answer(Status.SUCCESS, changed ? "colorRemoved" : "colorNoneToRemove");
      } catch (error) {
        return refused(error);
      }
    }
    const list = service.colors(guild.id).filter((color) => guild.roles.cache.has(color.roleId));
    if (list.length === 0) {
      return answer(Status.REFUSED, "colorListEmpty");
    }
    if (subcommand === "random") {
      const current = service.currentColor(guild, member);
      const others = list.filter((color) => color.roleId !== current?.roleId);
      return pick(interaction, member, service.randomPick(others.length > 0 ? others : list));
    }
    const color = colorFrom(interaction);
    if (!color) {
      return answer(Status.REFUSED, "colorNotFound");
    }
    return pick(interaction, member, color);
  }

  // --- Managers ---------------------------------------------------------------------

  async function giveOrTake(interaction, subcommand) {
    const { text, answer, refused } = helpers(interaction);
    const target = interaction.options.getMember("member");
    if (!target) {
      return answer(Status.REFUSED, "colorMemberNotHere");
    }
    const color = subcommand === "give" ? colorFrom(interaction) : null;
    if (subcommand === "give" && !color) {
      return answer(Status.REFUSED, "colorNotFound");
    }
    try {
      await service.applyColor(interaction.guild, target, color, `Color roles, by ${interaction.user.username}`);
    } catch (error) {
      return refused(error);
    }
    const key = color ? "colorGiven" : "colorTaken";
    const values = { member: `<@${target.id}>`, color: color ? `<@&${color.roleId}>` : "" };
    await answer(Status.SUCCESS, key, values);
    return { status: Status.SUCCESS, note: text(key, values) };
  }

  async function addColor(interaction) {
    const { answer, refused } = helpers(interaction);
    const name = cleanColorName(interaction.options.getString("name", true));
    const hex = parseColor(interaction.options.getString("hex", true));
    const gradient = interaction.options.getString("gradient");
    const hex2 = gradient ? parseColor(gradient) : null;
    if (!name) {
      return answer(Status.REFUSED, "colorBadName", { max: MAX_NAME_LENGTH });
    }
    if (!hex || (gradient && !hex2)) {
      return answer(Status.REFUSED, "colorBadHex");
    }
    if (hex2 && !interaction.guild.features?.includes(GRADIENT_FEATURE)) {
      return answer(Status.REFUSED, "colorNoGradients");
    }
    const list = service.colors(interaction.guildId);
    if (nameTaken(list, name)) {
      return answer(Status.REFUSED, "colorNameTaken", { name });
    }
    if (list.length >= MAX_COLORS) {
      return answer(Status.REFUSED, "colorListFull", { max: MAX_COLORS });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { added } = await service.addColors(interaction.guild, [{ name, hex, hex2 }]);
      if (added.length === 0) {
        return answer(Status.REFUSED, "colorNameTaken", { name });
      }
      await service.refreshPanels(interaction.guild);
      return answer(Status.SUCCESS, "colorAdded", { color: `<@&${added[0].roleId}>`, number: service.colors(interaction.guildId).length });
    } catch (error) {
      return refused(error);
    }
  }

  async function managerSubcommand(interaction, subcommand) {
    const { language, text, answer, refused } = helpers(interaction);
    const guild = interaction.guild;
    switch (subcommand) {
      case "give":
      case "take":
        return giveOrTake(interaction, subcommand);
      case "add":
        return addColor(interaction);
      case "existing": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const color = await service.addExisting(guild, interaction.options.getRole("role", true), interaction.options.getString("name"));
          await service.refreshPanels(guild);
          return answer(Status.SUCCESS, "colorAdded", { color: `<@&${color.roleId}>`, number: service.colors(guild.id).length });
        } catch (error) {
          return refused(error);
        }
      }
      case "edit": {
        const color = colorFrom(interaction);
        if (!color) {
          return answer(Status.REFUSED, "colorNotFound");
        }
        const name = interaction.options.getString("name");
        const hexText = interaction.options.getString("hex");
        const gradientText = interaction.options.getString("gradient");
        const single = interaction.options.getBoolean("single") === true;
        const changes = {};
        if (name !== null) {
          changes.name = name;
        }
        if (hexText !== null) {
          changes.hex = parseColor(hexText);
        }
        if (gradientText !== null) {
          changes.hex2 = parseColor(gradientText);
        }
        if (single) {
          changes.hex2 = null;
        }
        if (changes.hex === undefined && hexText !== null) {
          return answer(Status.REFUSED, "colorBadHex");
        }
        if (gradientText !== null && !single && !changes.hex2) {
          return answer(Status.REFUSED, "colorBadHex");
        }
        if (Object.keys(changes).length === 0) {
          return answer(Status.REFUSED, "colorEditNothing");
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const { before, after } = await service.editColor(guild, color.roleId, changes);
          await service.refreshPanels(guild);
          await answer(Status.SUCCESS, "colorEdited", { color: `<@&${after.roleId}>` });
          return { status: Status.SUCCESS, note: `Edited ${before.name} (${before.hex}${before.hex2 ? ` → ${before.hex2}` : ""}) → ${after.name} (${after.hex}${after.hex2 ? ` → ${after.hex2}` : ""}).` };
        } catch (error) {
          return refused(error);
        }
      }
      case "delete": {
        const color = colorFrom(interaction);
        if (!color) {
          return answer(Status.REFUSED, "colorNotFound");
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const deleted = await service.deleteColor(guild, color.roleId);
          await service.refreshPanels(guild);
          return answer(Status.SUCCESS, deleted.made ? "colorDeleted" : "colorDeletedKeptRole", { name: deleted.name });
        } catch (error) {
          return refused(error);
        }
      }
      case "pack": {
        const pack = interaction.options.getString("pack", true);
        const entries = (PACKS[pack] ?? []).map(([name, hex]) => ({ name, hex, hex2: null }));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply({ content: text("colorPackWorking", { count: entries.length }) });
        try {
          const { added, skipped, full } = await service.addColors(guild, entries);
          if (added.length > 0) {
            await service.refreshPanels(guild);
          }
          const key = full ? "colorPackFull" : "colorPackAdded";
          return answer(Status.SUCCESS, key, { added: added.length, skipped: skipped.length, pack: text(`colorPack_${pack}`), max: MAX_COLORS });
        } catch (error) {
          return refused(error);
        }
      }
      case "sort": {
        const kind = interaction.options.getString("by", true);
        const list = service.colors(guild.id);
        if (list.length < 2) {
          return answer(Status.REFUSED, "colorSortTooFew");
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const preview = await service.listPayload(guild, language, { list: sortColors(list, kind), title: text("colorSortPreview", { by: text(`colorSort_${kind}`) }) });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${SORT_PREFIX}${kind}`).setStyle(ButtonStyle.Primary).setLabel(text("colorSortApply")),
        );
        await interaction.editReply({ ...preview, components: [row], allowedMentions: { parse: [] } });
        return null;
      }
      case "sync": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const { remade, updated } = await service.syncColors(guild);
          await service.refreshPanels(guild, { force: true });
          return answer(Status.SUCCESS, "colorSynced", { remade: remade.length, updated: updated.length });
        } catch (error) {
          return refused(error);
        }
      }
      case "clear": {
        const count = service.colors(guild.id).length;
        if (count === 0) {
          return answer(Status.REFUSED, "colorListEmpty");
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${CLEAR_PREFIX}yes`).setStyle(ButtonStyle.Danger).setLabel(text("colorClearConfirm", { count })),
          new ButtonBuilder().setCustomId(`${CLEAR_PREFIX}no`).setStyle(ButtonStyle.Secondary).setLabel(text("colorCancel")),
        );
        await interaction.reply({ content: text("colorClearAsk", { count }), components: [row], flags: MessageFlags.Ephemeral });
        return null;
      }
      case "panel": {
        const channel = interaction.options.getChannel("channel", true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const message = await service.postPanel(guild, channel, pickLanguage(guild.preferredLocale, forcedLanguage));
          return answer(Status.SUCCESS, "colorPanelPosted", { link: message.url });
        } catch (error) {
          if (isPermissionError(error)) {
            return answer(Status.FAILED, "colorPanelCantPost", { channel: `<#${channel.id}>` });
          }
          return refused(error);
        }
      }
      case "suggest":
        await interaction.reply({ ...suggestion(text, service.randomColor()), flags: MessageFlags.Ephemeral });
        return null;
      case "settings":
        return settings(interaction);
    }
    return answer(Status.FAILED, "unexpected");
  }

  function suggestion(text, hex) {
    const embed = new EmbedBuilder().setColor(hexToInt(hex)).setTitle(text("colorSuggestTitle", { hex, name: nearestName(hex) })).setDescription(text("colorSuggestHelp"));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${SUGGEST_PREFIX}add:${hex.slice(1)}`).setStyle(ButtonStyle.Success).setLabel(text("colorSuggestAdd")),
      new ButtonBuilder().setCustomId(`${SUGGEST_PREFIX}again`).setStyle(ButtonStyle.Secondary).setLabel(text("colorSuggestAgain")),
    );
    return { embeds: [embed], components: [row] };
  }

  function describeSettings(text, guildId) {
    const options = colorOptionsOf(guildSettings, guildId);
    const join =
      options.joinColor === null ? text("colorSettingOff") : options.joinColor === RANDOM_JOIN_COLOR ? text("colorJoinRandom") : `<@&${options.joinColor}>`;
    const roles = (ids) => (ids.length > 0 ? ids.map((id) => `<@&${id}>`).join(", ") : text("colorSettingNone"));
    return text("colorSettingsShow", {
      image: options.image ? text("colorSettingOn") : text("colorSettingOff"),
      channel: options.channelId ? `<#${options.channelId}>` : text("colorSettingAnywhere"),
      join,
      overlap: options.overlapWarning ? text("colorSettingOn") : text("colorSettingOff"),
      managers: roles(options.managerRoleIds),
      allow: roles(options.allowRoleIds),
      deny: roles(options.denyRoleIds),
    });
  }

  async function settings(interaction) {
    const { text, answer } = helpers(interaction);
    const guild = interaction.guild;
    const changes = {};
    const image = interaction.options.getBoolean("image");
    const channel = interaction.options.getChannel("channel");
    const anyChannel = interaction.options.getBoolean("any-channel");
    const join = interaction.options.getString("join");
    const overlap = interaction.options.getBoolean("overlap-warning");
    if (image !== null) {
      changes.image = image;
    }
    if (channel) {
      changes.channelId = channel.id;
    }
    if (anyChannel) {
      changes.channelId = null;
    }
    if (overlap !== null) {
      changes.overlapWarning = overlap;
    }
    if (join !== null) {
      const value = join.trim().toLowerCase();
      if (value === "off" || value === "none") {
        changes.joinColor = null;
      } else if (value === RANDOM_JOIN_COLOR) {
        changes.joinColor = RANDOM_JOIN_COLOR;
      } else {
        const color = findColor(service.colors(guild.id), join);
        if (!color) {
          return answer(Status.REFUSED, "colorNotFound");
        }
        changes.joinColor = color.roleId;
      }
    }
    if (Object.keys(changes).length === 0) {
      await interaction.reply({ content: describeSettings(text, guild.id), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(Status.SUCCESS);
    }
    const current = colorOptionsOf(guildSettings, guild.id);
    let clean;
    try {
      clean = checkColorOptions(
        { ...current, ...changes },
        {
          isRole: (id) => id !== guild.id && guild.roles.cache.has(id),
          isChannel: (id) => guild.channels.cache.has(id),
          isColor: (id) => service.colors(guild.id).some((color) => color.roleId === id),
        },
      );
    } catch (error) {
      if (error instanceof InvalidColorOptions) {
        return answer(Status.REFUSED, "colorSettingsInvalid", { reason: error.message });
      }
      throw error;
    }
    await (clean ? guildSettings.set(guild.id, Setting.COLOR_OPTIONS, clean) : guildSettings.clear(guild.id, Setting.COLOR_OPTIONS));
    if (changes.image !== undefined) {
      await service.refreshPanels(guild).catch((error) => logger.warn("Couldn't update the color panels", { guildId: guild.id, error }));
    }
    const content = `${text("colorSettingsSaved")}\n${describeSettings(text, guild.id)}`;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return { status: Status.SUCCESS, note: `Color settings: ${Object.keys(changes).join(", ")}.` };
  }

  // --- The command ------------------------------------------------------------------

  async function execute(interaction) {
    const { answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const subcommand = interaction.options.getSubcommand();
    const manager = service.canManage(interaction.guild, interaction.member, interaction.memberPermissions);
    if (MEMBER_SUBCOMMANDS.has(subcommand)) {
      const { channelId } = colorOptionsOf(guildSettings, interaction.guildId);
      if (channelId && channelId !== interaction.channelId && !manager) {
        return answer(Status.REFUSED, "colorWrongChannel", { channel: `<#${channelId}>` });
      }
      return memberSubcommand(interaction, subcommand);
    }
    if (!manager) {
      const { managerRoleIds } = colorOptionsOf(guildSettings, interaction.guildId);
      return answer(Status.REFUSED, managerRoleIds.length > 0 ? "colorNotManagerRoles" : "colorNotManager", {
        roles: managerRoleIds.map((id) => `<@&${id}>`).join(", "),
      });
    }
    return managerSubcommand(interaction, subcommand);
  }

  async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const list = service.colors(interaction.guildId);
    const choices = colorChoices(list, focused.value);
    if (focused.name === "join") {
      const lang = pickLanguage(interaction.locale, forcedLanguage);
      choices.unshift({ name: translate(lang, "colorJoinOff"), value: "off" }, { name: translate(lang, "colorJoinRandom"), value: RANDOM_JOIN_COLOR });
    }
    await interaction.respond(choices.slice(0, 25));
  }

  // --- Panels and buttons -----------------------------------------------------------

  async function handlePick(interaction) {
    const { answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const refusal = service.pickRefusal(interaction.guild, interaction.member);
    if (refusal) {
      return answer(Status.REFUSED, refusal);
    }
    const color = service.colors(interaction.guildId).find((entry) => entry.roleId === interaction.values?.[0]);
    if (!color) {
      return answer(Status.REFUSED, "colorNotFound");
    }
    return pick(interaction, interaction.member, color);
  }

  async function handleRemove(interaction) {
    const { answer, refused } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    try {
      const { changed } = await service.applyColor(interaction.guild, interaction.member, null);
      return answer(Status.SUCCESS, changed ? "colorRemoved" : "colorNoneToRemove");
    } catch (error) {
      return refused(error);
    }
  }

  // Buttons on manager replies: the manager must still be one when clicking.
  const managerOnly = (handler) => async (interaction) => {
    const { answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!service.canManage(interaction.guild, interaction.member, interaction.memberPermissions)) {
      return answer(Status.REFUSED, "colorNotManager");
    }
    return handler(interaction);
  };

  async function handleSort(interaction) {
    const { text, refused } = helpers(interaction);
    const kind = interaction.customId.slice(SORT_PREFIX.length);
    if (!Object.values(SortKind).includes(kind)) {
      return null;
    }
    await interaction.deferUpdate();
    try {
      await service.sortList(interaction.guild, kind);
      await service.refreshPanels(interaction.guild);
    } catch (error) {
      return refused(error);
    }
    await interaction.editReply({ content: text("colorSorted", { by: text(`colorSort_${kind}`) }), embeds: [], files: [], attachments: [], components: [] });
    return { status: Status.SUCCESS, note: `Sorted the colors by ${kind}.` };
  }

  async function handleClear(interaction) {
    const { text, refused } = helpers(interaction);
    if (interaction.customId !== `${CLEAR_PREFIX}yes`) {
      await interaction.update({ content: text("colorCancelled"), components: [] });
      return null;
    }
    await interaction.update({ content: text("colorClearing"), components: [] });
    try {
      const count = await service.clearColors(interaction.guild);
      await service.refreshPanels(interaction.guild, { force: true });
      await interaction.editReply({ content: text("colorCleared", { count }) });
      return { status: Status.SUCCESS, note: `Cleared ${count} colors.` };
    } catch (error) {
      return refused(error);
    }
  }

  async function handleSuggest(interaction) {
    const { language, text } = helpers(interaction);
    const action = interaction.customId.slice(SUGGEST_PREFIX.length);
    if (action === "again") {
      await interaction.update(suggestion(text, service.randomColor()));
      return null;
    }
    const hex = parseColor(action.replace(/^add:/, ""));
    if (!hex) {
      return null;
    }
    const input = new TextInputBuilder()
      .setCustomId(NAME_INPUT)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(MAX_NAME_LENGTH)
      .setValue(nearestName(hex));
    const form = new ModalBuilder()
      .setCustomId(`${NAME_FORM_PREFIX}${hex.slice(1)}`)
      .setTitle(translate(language, "colorNameFormTitle", { hex }).slice(0, 45))
      .addLabelComponents(new LabelBuilder().setLabel(text("colorNameFormLabel")).setTextInputComponent(input));
    await interaction.showModal(form);
    return null;
  }

  async function handleNameForm(interaction) {
    const { answer, refused } = helpers(interaction);
    const hex = parseColor(interaction.customId.slice(NAME_FORM_PREFIX.length));
    const name = cleanColorName(interaction.fields.getTextInputValue(NAME_INPUT));
    if (!hex || !name) {
      return answer(Status.REFUSED, "colorBadName", { max: MAX_NAME_LENGTH });
    }
    if (nameTaken(service.colors(interaction.guildId), name)) {
      return answer(Status.REFUSED, "colorNameTaken", { name });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { added, full } = await service.addColors(interaction.guild, [{ name, hex, hex2: null }]);
      if (added.length === 0) {
        return answer(Status.REFUSED, full ? "colorListFull" : "colorNameTaken", { name, max: MAX_COLORS });
      }
      await service.refreshPanels(interaction.guild);
      return answer(Status.SUCCESS, "colorAdded", { color: `<@&${added[0].roleId}>`, number: service.colors(interaction.guildId).length });
    } catch (error) {
      return refused(error);
    }
  }

  return {
    name: COMMAND_NAME,
    data: buildColorCommandData(),
    execute,
    autocomplete,
    service,
    components: { [REMOVE_ID]: { label: "Remove my color", handle: handleRemove } },
    componentPrefixes: {
      [PICK_PREFIX]: { label: "Color panel", handle: handlePick },
      [SORT_PREFIX]: { label: "Apply color sorting", handle: managerOnly(handleSort) },
      [CLEAR_PREFIX]: { label: "Clear the color list", handle: managerOnly(handleClear) },
      [SUGGEST_PREFIX]: { label: "Color suggestion", handle: managerOnly(handleSuggest) },
      [NAME_FORM_PREFIX]: { label: "Add a suggested color", handle: managerOnly(handleNameForm) },
    },
  };
}
