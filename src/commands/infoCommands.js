// Cards about a member, their avatar, and a role:
//
//   /userinfo [member] [private]   account age, join date, roles, key permissions
//   /avatar [member] [private]     profile picture, server picture and banner, full size
//   /roleinfo role [private]       colour, members, position, settings, key permissions
//
// Everyone can use them. Leave out `member` for yourself. The cards are posted
// in the channel unless `private` is True. Nothing is saved, and mentions in
// the cards never ping.

import { EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { accentColor } from "../branding/branding.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { createMemberLoader } from "../guilds/memberCache.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { withDescription } from "./moderation.js";

// The permissions worth showing on a card, in this order, with their names.
// Administrator alone is shown when someone has it, since it includes the rest.
export const KEY_PERMISSIONS = [
  ["ManageGuild", "permManageGuild"],
  ["ManageRoles", "permManageRoles"],
  ["ManageChannels", "permManageChannels"],
  ["ManageMessages", "permManageMessages"],
  ["ManageNicknames", "permManageNicknames"],
  ["ManageWebhooks", "permManageWebhooks"],
  ["BanMembers", "permBanMembers"],
  ["KickMembers", "permKickMembers"],
  ["ModerateMembers", "permModerateMembers"],
  ["ViewAuditLog", "permViewAuditLog"],
  ["MentionEveryone", "permMentionEveryone"],
];

// How many role mentions fit on a user card before "and N more".
const MAX_ROLES_SHOWN = 20;
const FIELD_LIMIT = 1024;

const seconds = (timestamp) => Math.floor(timestamp / 1000);
const dateLine = (timestamp) => `<t:${seconds(timestamp)}:D>\n<t:${seconds(timestamp)}:R>`;
const yesNo = (text, value) => text(value ? "infoYes" : "infoNo");

// The names of the key permissions in `permissions` (a PermissionsBitField).
export function keyPermissionNames(permissions, text) {
  if (!permissions) {
    return [];
  }
  if (permissions.has(PermissionFlagsBits.Administrator)) {
    return [text("permAdministrator")];
  }
  return KEY_PERMISSIONS.filter(([flag]) => permissions.has(PermissionFlagsBits[flag])).map(([, key]) => text(key));
}

// Role mentions, highest first, without @everyone, at most MAX_ROLES_SHOWN
// and always short enough for one embed field.
export function roleList(roles, text, guildId) {
  const sorted = [...roles].filter((role) => role.id !== guildId).sort((a, b) => b.position - a.position);
  if (sorted.length === 0) {
    return text("infoNone");
  }
  const shown = [];
  let length = 0;
  for (const role of sorted.slice(0, MAX_ROLES_SHOWN)) {
    const mention = `<@&${role.id}>`;
    // Leave room for the "and N more" note.
    if (length + mention.length + 1 > FIELD_LIMIT - 40) {
      break;
    }
    shown.push(mention);
    length += mention.length + 1;
  }
  const hidden = sorted.length - shown.length;
  return hidden > 0 ? `${shown.join(" ")} ${text("infoMoreRoles", { count: hidden })}` : shown.join(" ");
}

const privateOption = (option) => withDescription(option.setName("private"), "infoPrivateOptionDescription");

export function buildUserInfoCommandData() {
  return withDescription(new SlashCommandBuilder().setName("userinfo").setContexts(InteractionContextType.Guild), "userInfoCommandDescription")
    .addUserOption((option) => withDescription(option.setName("member"), "infoMemberOptionDescription"))
    .addBooleanOption(privateOption)
    .toJSON();
}

export function buildAvatarCommandData() {
  return withDescription(new SlashCommandBuilder().setName("avatar").setContexts(InteractionContextType.Guild), "avatarCommandDescription")
    .addUserOption((option) => withDescription(option.setName("member"), "infoMemberOptionDescription"))
    .addBooleanOption(privateOption)
    .toJSON();
}

export function buildRoleInfoCommandData() {
  return withDescription(new SlashCommandBuilder().setName("roleinfo").setContexts(InteractionContextType.Guild), "roleInfoCommandDescription")
    .addRoleOption((option) => withDescription(option.setName("role"), "roleInfoRoleOptionDescription").setRequired(true))
    .addBooleanOption(privateOption)
    .toJSON();
}

// The user card. `member` is undefined for someone who isn't in the server.
export function buildUserInfoEmbed({ user, member, guild, language, color }) {
  const text = (key, values) => translate(language, key, values);
  const embed = new EmbedBuilder()
    .setColor(member?.displayColor || color)
    .setAuthor({ name: user.tag ?? user.username, iconURL: user.displayAvatarURL?.({ size: 64 }) })
    .setThumbnail(member?.displayAvatarURL?.({ size: 256 }) ?? user.displayAvatarURL?.({ size: 256 }) ?? null)
    .setFooter({ text: text("infoIdFooter", { id: user.id }) });

  const badges = [];
  if (member && member.id === guild.ownerId) {
    badges.push(text("userInfoOwner"));
  }
  if (user.bot) {
    badges.push(text("userInfoBot"));
  }
  if (member?.premiumSinceTimestamp) {
    badges.push(text("userInfoBooster", { since: `<t:${seconds(member.premiumSinceTimestamp)}:D>` }));
  }
  if (member?.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
    badges.push(text("userInfoTimedOut", { until: `<t:${seconds(member.communicationDisabledUntilTimestamp)}:R>` }));
  }
  if (member?.pending) {
    badges.push(text("userInfoPending"));
  }
  if (!member) {
    badges.push(text("userInfoNotMember"));
  }
  const name = member?.nickname ?? user.globalName;
  embed.setDescription([`<@${user.id}>${name ? ` · ${name}` : ""}`, ...badges].join("\n").slice(0, 4096));

  embed.addFields({ name: text("userInfoCreated"), value: dateLine(user.createdTimestamp), inline: true });
  if (member) {
    if (member.joinedTimestamp) {
      embed.addFields({ name: text("userInfoJoined"), value: dateLine(member.joinedTimestamp), inline: true });
    }
    const roles = [...(member.roles?.cache?.values?.() ?? [])];
    const counted = roles.filter((role) => role.id !== guild.id).length;
    embed.addFields({ name: text("userInfoRoles", { count: counted }), value: roleList(roles, text, guild.id) });
    const permissions = keyPermissionNames(member.permissions, text);
    if (permissions.length > 0) {
      embed.addFields({ name: text("infoKeyPermissions"), value: permissions.join(", ").slice(0, FIELD_LIMIT) });
    }
  }
  return embed;
}

// Links to an image in each format Discord offers, like "PNG · WebP · GIF".
export function imageLinks(makeUrl, animated) {
  const formats = [["PNG", "png"], ["JPG", "jpg"], ["WebP", "webp"], ...(animated ? [["GIF", "gif"]] : [])];
  return formats.map(([label, extension]) => `[${label}](${makeUrl({ extension, size: 4096 })})`).join(" · ");
}

// One embed per picture: the profile picture, the server picture (if the
// member set one) and the profile banner (if they have one).
export function buildAvatarEmbeds({ user, member, language, color }) {
  const text = (key, values) => translate(language, key, values);
  const embeds = [];
  const add = (titleKey, makeUrl, hash) => {
    const animated = Boolean(hash?.startsWith("a_"));
    embeds.push(
      new EmbedBuilder()
        .setColor(color)
        .setTitle(text(titleKey, { name: member?.displayName ?? user.globalName ?? user.username }).slice(0, 256))
        .setDescription(imageLinks(makeUrl, animated))
        .setImage(makeUrl({ extension: animated ? "gif" : "png", size: 1024 })),
    );
  };
  add("avatarProfile", (options) => user.displayAvatarURL(options), user.avatar);
  if (member?.avatar) {
    add("avatarServer", (options) => member.avatarURL(options), member.avatar);
  }
  if (user.banner) {
    add("avatarBanner", (options) => user.bannerURL(options), user.banner);
  }
  return embeds;
}

// The role card. `memberCount` is null when the member list couldn't be
// loaded; `complete` says whether the count is exact.
export function buildRoleInfoEmbed({ role, guild, language, memberCount, complete }) {
  const text = (key, values) => translate(language, key, values);
  const number = (value) => new Intl.NumberFormat(language).format(value);
  const hex = `#${role.color.toString(16).padStart(6, "0")}`;
  const totalRoles = Math.max(1, (guild.roles?.cache?.size ?? 1) - 1);
  const managedBy = role.tags?.botId
    ? text("roleInfoManagedBot", { bot: `<@${role.tags.botId}>` })
    : role.tags?.premiumSubscriberRole
      ? text("roleInfoManagedBoost")
      : role.tags?.integrationId || role.tags?.subscriptionListingId
        ? text("roleInfoManagedIntegration")
        : null;

  const embed = new EmbedBuilder()
    .setColor(role.color || null)
    .setTitle(role.name.slice(0, 256))
    .setDescription([`<@&${role.id}>`, managedBy].filter(Boolean).join("\n"))
    .setFooter({ text: text("infoIdFooter", { id: role.id }) });
  const icon = role.iconURL?.({ size: 128 });
  if (icon) {
    embed.setThumbnail(icon);
  }
  const members =
    memberCount === null ? text("roleInfoMembersUnknown") : complete ? number(memberCount) : text("roleInfoMembersAtLeast", { count: number(memberCount) });
  embed.addFields(
    { name: text("roleInfoColor"), value: role.color ? hex : text("roleInfoNoColor"), inline: true },
    { name: text("roleInfoMembers"), value: members, inline: true },
    // Discord counts positions from the bottom; people read them from the top.
    { name: text("roleInfoPosition"), value: text("roleInfoPositionValue", { position: number(Math.max(1, totalRoles - role.position + 1)), total: number(totalRoles) }), inline: true },
    { name: text("roleInfoCreated"), value: dateLine(role.createdTimestamp), inline: true },
    { name: text("roleInfoHoisted"), value: yesNo(text, role.hoist), inline: true },
    { name: text("roleInfoMentionable"), value: yesNo(text, role.mentionable), inline: true },
  );
  const permissions = keyPermissionNames(role.permissions, text);
  embed.addFields({ name: text("infoKeyPermissions"), value: permissions.length > 0 ? permissions.join(", ").slice(0, FIELD_LIMIT) : text("infoNone") });
  return embed;
}

// Options: guildSettings (for the Branding colour), forcedLanguage,
// memberLoader (guilds/memberCache.js; one is made if left out)
export function createInfoCommands({ guildSettings, forcedLanguage, memberLoader = createMemberLoader() }) {
  // Checks the server and works out the reply's language and visibility.
  const begin = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const flags = interaction.options.getBoolean("private") ? MessageFlags.Ephemeral : undefined;
    const refuse = async () => {
      await interaction.reply({ content: translate(language, "guildOnly"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "guildOnly");
    };
    return { language, flags, refuse, ok: interaction.inCachedGuild() };
  };
  const colorOf = (guild) => accentColor(guildSettings, guild.id, BRAND_COLOR);

  async function userinfo(interaction) {
    const { language, flags, refuse, ok } = begin(interaction);
    if (!ok) {
      return refuse();
    }
    const user = interaction.options.getUser("member") ?? interaction.user;
    const member = interaction.options.getMember("member") ?? (user.id === interaction.user.id ? interaction.member : undefined);
    const embed = buildUserInfoEmbed({ user, member: member ?? undefined, guild: interaction.guild, language, color: colorOf(interaction.guild) });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] }, flags });
    return result(Status.SUCCESS);
  }

  async function avatar(interaction) {
    const { language, flags, refuse, ok } = begin(interaction);
    if (!ok) {
      return refuse();
    }
    await interaction.deferReply({ flags });
    const picked = interaction.options.getUser("member") ?? interaction.user;
    const member = interaction.options.getMember("member") ?? (picked.id === interaction.user.id ? interaction.member : undefined);
    // The banner only comes with a fresh fetch of the user. Without it the
    // card still shows the pictures.
    const user = await picked.fetch(true).catch(() => picked);
    const embeds = buildAvatarEmbeds({ user, member: member ?? undefined, language, color: colorOf(interaction.guild) });
    await interaction.editReply({ embeds, allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  async function roleinfo(interaction) {
    const { language, flags, refuse, ok } = begin(interaction);
    if (!ok) {
      return refuse();
    }
    const role = interaction.options.getRole("role", true);
    const guild = interaction.guild;
    let memberCount;
    let complete = true;
    if (role.id === guild.id) {
      memberCount = guild.memberCount;
    } else {
      // Counting needs the member list, which can take a few seconds to load.
      await interaction.deferReply({ flags });
      complete = await memberLoader.loadAll(guild, { timeMs: 10_000 });
      memberCount = guild.roles.cache.get(role.id)?.members?.size ?? null;
    }
    const embed = buildRoleInfoEmbed({ role: guild.roles.cache.get(role.id) ?? role, guild, language, memberCount, complete });
    const payload = { embeds: [embed], allowedMentions: { parse: [] } };
    await (interaction.deferred ? interaction.editReply(payload) : interaction.reply({ ...payload, flags }));
    return result(Status.SUCCESS);
  }

  return [
    { name: "userinfo", data: buildUserInfoCommandData(), execute: userinfo },
    { name: "avatar", data: buildAvatarCommandData(), execute: avatar },
    { name: "roleinfo", data: buildRoleInfoCommandData(), execute: roleinfo },
  ];
}
