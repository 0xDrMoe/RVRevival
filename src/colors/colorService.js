// Everything color roles do in Discord, shared by /color, the color panels and
// new members' join color: giving and swapping color roles, making, editing
// and deleting them, keeping them together as one block, and the list
// (as a picture or as text).
//
// Changes to the list take turns per server (one KeyedLock), so two managers
// can't overwrite each other's colors. The dashboard (another process) makes
// the same changes through Discord's REST API (dashboard/app.js).

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} from "discord.js";
import { accentColor } from "../branding/branding.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { isModeratorRole } from "../permissions/moderatorPermissions.js";
import { derivedSetting, Setting } from "../settings/guildSettings.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { KeyedLock } from "../utils/keyedLock.js";
import {
  anchorFor,
  blockPositions,
  cleanColorName,
  colorsOf,
  hexToInt,
  intToHex,
  MAX_COLORS,
  MENU_SIZE,
  nameTaken,
  randomColor,
  reorderPositions,
  saveColors,
  sortColors,
} from "./colors.js";
import { renderColorList } from "./listImage.js";
import { normalizeColorOptions, RANDOM_JOIN_COLOR } from "./options.js";

export const LIST_FILE = "colors.png";
export const MAX_PANELS = 5;
export const PICK_PREFIX = "color:pick:";
export const REMOVE_ID = "color:remove";
// Discord's server feature for gradient (two-colour) roles.
export const GRADIENT_FEATURE = "ENHANCED_ROLE_COLORS";
const DEFAULT_EMBED_COLOR = 0x9b6bff;
const REASON = "Color roles";

export class ColorError extends Error {
  name = "ColorError";
  // `key` is a translation key, `values` its placeholders.
  constructor(key, values = {}) {
    super(key);
    this.key = key;
    this.values = values;
  }
}

export const colorOptionsOf = (guildSettings, guildId) => derivedSetting(guildSettings, guildId, Setting.COLOR_OPTIONS, normalizeColorOptions);

// The colour Discord shows for a role (its first colour), 0 for none.
export const roleColorOf = (role) => role?.colors?.primaryColor ?? role?.color ?? 0;

// Why a role can't be a color role (a translation key), or undefined if it can.
export function colorRoleProblem(role, guild) {
  if (!role || role.id === guild.id) {
    return "colorRoleEveryone";
  }
  if (role.managed) {
    return "colorRoleManaged";
  }
  if (isModeratorRole(role)) {
    return "colorRoleDangerous";
  }
  const me = guild.members.me;
  if (!me || role.position >= me.roles.highest.position) {
    return "colorRoleAboveBot";
  }
  return undefined;
}

// The saved panels: [{ channelId, messageId, key }].
const panelsOf = (guildSettings, guildId) => {
  const saved = guildSettings.get(guildId, Setting.COLOR_PANELS);
  return Array.isArray(saved) ? saved.filter((panel) => panel && typeof panel.channelId === "string" && typeof panel.messageId === "string") : [];
};

// What a panel shows, so it's only edited when that changes.
const panelKey = (colors, options) => JSON.stringify([options.image, colors.map((color) => [color.roleId, color.name, color.hex, color.hex2])]);

// Options:
//   guildSettings, logger, forcedLanguage
//   now, random   replaceable in tests
//   render        (colors) => PNG buffer, the list picture (listImage.js)
export function createColorService({ guildSettings, logger, forcedLanguage, now = Date.now, random = Math.random, render = renderColorList }) {
  const locks = new KeyedLock();
  const colors = (guildId) => colorsOf(guildSettings, guildId);
  const options = (guildId) => colorOptionsOf(guildSettings, guildId);
  const language = (guild) => pickLanguage(guild?.preferredLocale, forcedLanguage);

  function needManageRoles(guild) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new ColorError("colorBotNeedsManageRoles");
    }
  }

  // --- Who may do what ------------------------------------------------------------

  // Owner, Administrator, a color manager role, or (when the server has no
  // manager roles) Manage Roles. `permissions` is interaction.memberPermissions.
  function canManage(guild, member, permissions) {
    if (!member) {
      return false;
    }
    if (member.id === guild.ownerId || permissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }
    const { managerRoleIds } = options(guild.id);
    if (managerRoleIds.length > 0) {
      return managerRoleIds.some((id) => member.roles.cache.has(id));
    }
    return Boolean(permissions?.has(PermissionFlagsBits.ManageRoles));
  }

  // Why this member can't pick a color (a translation key), or undefined.
  function pickRefusal(guild, member) {
    const { allowRoleIds, denyRoleIds } = options(guild.id);
    if (denyRoleIds.some((id) => member.roles.cache.has(id))) {
      return "colorDenied";
    }
    if (allowRoleIds.length > 0 && !allowRoleIds.some((id) => member.roles.cache.has(id))) {
      return "colorNotAllowed";
    }
    return undefined;
  }

  // --- Members' colors --------------------------------------------------------------

  // The color role a member has now (the first one on the list), or undefined.
  function currentColor(guild, member) {
    return colors(guild.id).find((color) => member.roles.cache.has(color.roleId));
  }

  // Gives `color` (or none, with null) and takes every other color role away.
  // Returns { changed, previous }.
  async function applyColor(guild, member, color, reason = REASON) {
    needManageRoles(guild);
    const list = colors(guild.id);
    const top = guild.members.me.roles.highest.position;
    const role = color && guild.roles.cache.get(color.roleId);
    if (color && !role) {
      throw new ColorError("colorRoleMissing", { name: color.name });
    }
    if (role && role.position >= top) {
      throw new ColorError("colorRoleAboveBot");
    }
    const held = list.filter((entry) => member.roles.cache.has(entry.roleId));
    const previous = held[0];
    const remove = held
      .filter((entry) => entry.roleId !== color?.roleId)
      .filter((entry) => (guild.roles.cache.get(entry.roleId)?.position ?? 0) < top)
      .map((entry) => entry.roleId);
    const add = color && !member.roles.cache.has(color.roleId);
    if (!add && remove.length === 0) {
      return { changed: false, previous };
    }
    if (add) {
      await member.roles.add(color.roleId, reason);
    }
    if (remove.length > 0) {
      await member.roles.remove(remove, reason);
    }
    return { changed: true, previous };
  }

  // A role above `color` whose own colour Discord shows instead, or undefined.
  function hidingRole(guild, member, color) {
    const role = guild.roles.cache.get(color.roleId);
    if (!role) {
      return undefined;
    }
    const colorIds = new Set(colors(guild.id).map((entry) => entry.roleId));
    return [...member.roles.cache.values()]
      .filter((entry) => entry.id !== guild.id && !colorIds.has(entry.id) && roleColorOf(entry) !== 0 && entry.position > role.position)
      .sort((a, b) => b.position - a.position)[0];
  }

  const randomPick = (list) => list[Math.floor(random() * list.length)];

  // --- Changing the list ------------------------------------------------------------

  const roleColors = (hex, hex2) => ({ primaryColor: hexToInt(hex), ...(hex2 ? { secondaryColor: hexToInt(hex2) } : {}) });

  function needGradient(guild, hex2) {
    if (hex2 && !guild.features?.includes(GRADIENT_FEATURE)) {
      throw new ColorError("colorNoGradients");
    }
  }

  // Moves every color role into one block in list order (see colors.js).
  // Best effort: a refusal leaves the roles where they are, with a warning.
  async function placeBlock(guild, list, previousIds) {
    const roles = [...guild.roles.cache.values()].map((role) => ({ id: role.id, position: role.position }));
    const below = anchorFor(roles, previousIds, guild.members.me.roles.highest.id);
    const changes = blockPositions(roles, list.map((color) => color.roleId), below, guild.id);
    if (changes.length === 0) {
      return;
    }
    try {
      await guild.roles.setPositions(changes.map((change) => ({ role: change.id, position: change.position })));
    } catch (error) {
      logger.warn("Couldn't move the color roles together", { guildId: guild.id, error });
    }
  }

  // Makes a role for each { name, hex, hex2 } and adds them to the list.
  // Names the list already has are skipped. Returns { added, skipped, full }.
  async function addColors(guild, entries) {
    needManageRoles(guild);
    return locks.run(guild.id, async () => {
      const list = colors(guild.id);
      const previousIds = list.map((color) => color.roleId);
      const added = [];
      const skipped = [];
      let full = false;
      for (const entry of entries) {
        const name = cleanColorName(entry.name);
        if (!name || nameTaken([...list, ...added], name)) {
          skipped.push(entry.name);
          continue;
        }
        if (list.length + added.length >= MAX_COLORS || guild.roles.cache.size >= 250) {
          full = true;
          break;
        }
        needGradient(guild, entry.hex2);
        const role = await guild.roles.create({ name, colors: roleColors(entry.hex, entry.hex2), permissions: [], hoist: false, mentionable: false, reason: REASON });
        added.push({ roleId: role.id, name, hex: entry.hex, hex2: entry.hex2 ?? null, made: true, addedAt: now() });
      }
      if (added.length > 0) {
        const next = [...list, ...added];
        await saveColors(guildSettings, guild.id, next);
        await placeBlock(guild, next, previousIds);
      }
      return { added, skipped, full };
    });
  }

  // Adds a role the server already has. Its name and colour stay as they are
  // unless `name` is given.
  async function addExisting(guild, role, name) {
    needManageRoles(guild);
    const problem = colorRoleProblem(role, guild);
    if (problem) {
      throw new ColorError(problem);
    }
    return locks.run(guild.id, async () => {
      const list = colors(guild.id);
      if (list.some((color) => color.roleId === role.id)) {
        throw new ColorError("colorAlreadyListed", { name: role.name });
      }
      if (list.length >= MAX_COLORS) {
        throw new ColorError("colorListFull", { max: MAX_COLORS });
      }
      const clean = cleanColorName(name ?? role.name);
      if (!clean || nameTaken(list, clean)) {
        throw new ColorError("colorNameTaken", { name: clean || role.name });
      }
      if (clean !== role.name) {
        await role.edit({ name: clean, reason: REASON });
      }
      const primary = roleColorOf(role);
      const secondary = role.colors?.secondaryColor ?? null;
      const color = { roleId: role.id, name: clean, hex: intToHex(primary), hex2: secondary ? intToHex(secondary) : null, made: false, addedAt: now() };
      await saveColors(guildSettings, guild.id, [...list, color]);
      return color;
    });
  }

  // Changes a color's name, colour or gradient. `changes` is { name?, hex?, hex2? }
  // (hex2 null makes it one colour again).
  async function editColor(guild, roleId, changes) {
    needManageRoles(guild);
    return locks.run(guild.id, async () => {
      const list = colors(guild.id);
      const color = list.find((entry) => entry.roleId === roleId);
      if (!color) {
        throw new ColorError("colorNotFound");
      }
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        throw new ColorError("colorRoleMissing", { name: color.name });
      }
      if (role.position >= guild.members.me.roles.highest.position) {
        throw new ColorError("colorRoleAboveBot");
      }
      const name = changes.name === undefined ? color.name : cleanColorName(changes.name);
      if (!name || nameTaken(list, name, roleId)) {
        throw new ColorError("colorNameTaken", { name: name || String(changes.name) });
      }
      const hex = changes.hex ?? color.hex;
      const hex2 = changes.hex2 === undefined ? color.hex2 : changes.hex2;
      needGradient(guild, hex2);
      const edit = { reason: REASON };
      if (name !== role.name) {
        edit.name = name;
      }
      if (hex !== color.hex || hex2 !== color.hex2) {
        edit.colors = { primaryColor: hexToInt(hex), ...(hex2 ? { secondaryColor: hexToInt(hex2) } : color.hex2 ? { secondaryColor: null } : {}) };
      }
      if (Object.keys(edit).length > 1) {
        await role.edit(edit);
      }
      const updated = { ...color, name, hex, hex2 };
      await saveColors(guildSettings, guild.id, list.map((entry) => (entry === color ? updated : entry)));
      return { before: color, after: updated };
    });
  }

  // Takes a color off the list. Roles the bot made are deleted; roles added
  // with /color existing are kept. Returns the color.
  async function deleteColor(guild, roleId) {
    return locks.run(guild.id, async () => {
      const list = colors(guild.id);
      const color = list.find((entry) => entry.roleId === roleId);
      if (!color) {
        throw new ColorError("colorNotFound");
      }
      await deleteRoleOf(guild, color);
      await saveColors(guildSettings, guild.id, list.filter((entry) => entry !== color));
      await forgetJoinColor(guild.id, [color.roleId]);
      return color;
    });
  }

  async function deleteRoleOf(guild, color) {
    const role = guild.roles.cache.get(color.roleId);
    if (!color.made || !role) {
      return;
    }
    try {
      await role.delete(REASON);
    } catch (error) {
      if (!isPermissionError(error) && error.code !== 10011) {
        throw error;
      }
      logger.warn("Couldn't delete a color role; it was taken off the list anyway", { guildId: guild.id, roleId: color.roleId, error });
    }
  }

  async function forgetJoinColor(guildId, roleIds) {
    const saved = guildSettings.get(guildId, Setting.COLOR_OPTIONS);
    if (saved?.joinColor && roleIds.includes(saved.joinColor)) {
      const { joinColor, ...rest } = saved;
      await (Object.keys(rest).length > 0 ? guildSettings.set(guildId, Setting.COLOR_OPTIONS, rest) : guildSettings.clear(guildId, Setting.COLOR_OPTIONS));
    }
  }

  // Empties the list (deleting the roles the bot made). Returns how many colors there were.
  async function clearColors(guild) {
    return locks.run(guild.id, async () => {
      const list = colors(guild.id);
      for (const color of list) {
        await deleteRoleOf(guild, color);
      }
      await saveColors(guildSettings, guild.id, []);
      await forgetJoinColor(guild.id, list.map((color) => color.roleId));
      return list.length;
    });
  }

  // Sorts the list and moves the roles to match. Returns the sorted list.
  async function sortList(guild, kind) {
    needManageRoles(guild);
    return locks.run(guild.id, async () => {
      const sorted = sortColors(colors(guild.id), kind);
      await saveColors(guildSettings, guild.id, sorted);
      const roles = [...guild.roles.cache.values()].map((role) => ({ id: role.id, position: role.position }));
      const changes = reorderPositions(roles, sorted.map((color) => color.roleId));
      if (changes.length > 0) {
        try {
          await guild.roles.setPositions(changes.map((change) => ({ role: change.id, position: change.position })));
        } catch (error) {
          logger.warn("Couldn't reorder the color roles", { guildId: guild.id, error });
        }
      }
      return sorted;
    });
  }

  // Brings the list and the roles back in step: a deleted role is made
  // again, and a name or colour changed in Discord's role settings is copied
  // to the list. Returns { remade, updated }.
  async function syncColors(guild) {
    needManageRoles(guild);
    return locks.run(guild.id, async () => {
      const list = colors(guild.id);
      const remade = [];
      const updated = [];
      const next = [];
      for (const color of list) {
        const role = guild.roles.cache.get(color.roleId);
        if (!role) {
          const made = await guild.roles.create({ name: color.name, colors: roleColors(color.hex, guild.features?.includes(GRADIENT_FEATURE) ? color.hex2 : null), permissions: [], reason: REASON });
          remade.push(color.name);
          next.push({ ...color, roleId: made.id, made: true });
          continue;
        }
        const hex = intToHex(roleColorOf(role));
        const secondary = role.colors?.secondaryColor ? intToHex(role.colors.secondaryColor) : null;
        const name = cleanColorName(role.name) || color.name;
        if (hex !== color.hex || secondary !== color.hex2 || name !== color.name) {
          updated.push(name);
          next.push({ ...color, name, hex, hex2: secondary });
        } else {
          next.push(color);
        }
      }
      if (remade.length > 0 || updated.length > 0) {
        await saveColors(guildSettings, guild.id, next);
      }
      if (remade.length > 0) {
        await placeBlock(guild, next, next.map((color) => color.roleId).filter((id) => list.some((color) => color.roleId === id)));
      }
      return { remade, updated };
    });
  }

  // --- The list, as a picture or as text ------------------------------------------

  // { embeds, files } for the list. `list` defaults to the saved one (a sort
  // preview passes its own). Falls back to text if the picture fails.
  async function listPayload(guild, lang, { list = colors(guild.id), title } = {}) {
    const text = (key, values) => translate(lang, key, values);
    const embed = new EmbedBuilder()
      .setColor(accentColor(guildSettings, guild.id, DEFAULT_EMBED_COLOR))
      .setTitle(title ?? text("colorListTitle", { count: list.length }))
      .setFooter({ text: text("colorListFooter") });
    if (list.length === 0) {
      embed.setDescription(text("colorListEmpty"));
      return { embeds: [embed], files: [] };
    }
    if (options(guild.id).image) {
      try {
        const png = await render(list);
        embed.setImage(`attachment://${LIST_FILE}`);
        return { embeds: [embed], files: [new AttachmentBuilder(png, { name: LIST_FILE, description: text("colorListAlt") })] };
      } catch (error) {
        logger.warn("Couldn't draw the color list; sending it as text", { guildId: guild.id, error });
      }
    }
    // Role mentions in an embed show in the role's colour and never ping.
    embed.setDescription(list.map((color, index) => `\`${String(index + 1).padStart(2, " ")}.\` <@&${color.roleId}>`).join("\n").slice(0, 4096));
    return { embeds: [embed], files: [] };
  }

  // --- Color panels ---------------------------------------------------------------

  // A panel: the list, up to four menus of 25 colors, and a Remove my color button.
  async function panelPayload(guild, lang) {
    const text = (key, values) => translate(lang, key, values);
    const list = colors(guild.id);
    const listed = await listPayload(guild, lang, { title: text("colorPanelTitle") });
    listed.embeds[0].setFooter({ text: text("colorPanelFooter") });
    const rows = [];
    for (let start = 0; start < list.length; start += MENU_SIZE) {
      const chunk = list.slice(start, start + MENU_SIZE);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`${PICK_PREFIX}${start / MENU_SIZE}`)
        .setPlaceholder(text("colorPanelMenu", { from: start + 1, to: start + chunk.length }))
        .addOptions(
          chunk.map((color, index) => ({
            label: `${start + index + 1}. ${color.name}`.slice(0, 100),
            value: color.roleId,
            description: color.hex2 ? `${color.hex} → ${color.hex2}` : color.hex,
          })),
        );
      rows.push(new ActionRowBuilder().addComponents(menu));
    }
    rows.push(
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(REMOVE_ID).setStyle(ButtonStyle.Secondary).setLabel(text("colorPanelRemove"))),
    );
    return { ...listed, components: rows };
  }

  // Posts a new panel in `channel` and remembers it.
  async function postPanel(guild, channel, lang) {
    if (colors(guild.id).length === 0) {
      throw new ColorError("colorListEmpty");
    }
    return locks.run(`${guild.id}:panels`, async () => {
      const panels = panelsOf(guildSettings, guild.id);
      if (panels.length >= MAX_PANELS) {
        throw new ColorError("colorPanelsFull", { max: MAX_PANELS });
      }
      const message = await channel.send({ ...(await panelPayload(guild, lang)), allowedMentions: { parse: [] } });
      const key = panelKey(colors(guild.id), options(guild.id));
      await guildSettings.set(guild.id, Setting.COLOR_PANELS, [...panels, { channelId: channel.id, messageId: message.id, key }]);
      return message;
    });
  }

  // Edits every panel whose colors or look changed since it was posted (all
  // of them with `force`). Panels whose message is gone are forgotten.
  async function refreshPanels(guild, { force = false } = {}) {
    return locks.run(`${guild.id}:panels`, async () => {
      const panels = panelsOf(guildSettings, guild.id);
      if (panels.length === 0) {
        return;
      }
      const list = colors(guild.id);
      const key = panelKey(list, options(guild.id));
      if (!force && panels.every((panel) => panel.key === key)) {
        return;
      }
      const lang = language(guild);
      let payload;
      const kept = [];
      for (const panel of panels) {
        if (!force && panel.key === key) {
          kept.push(panel);
          continue;
        }
        const channel = guild.channels.cache.get(panel.channelId);
        try {
          const message = channel?.isTextBased?.() ? await channel.messages.fetch(panel.messageId) : null;
          if (!message) {
            continue;
          }
          if (list.length === 0) {
            await message.delete();
            continue;
          }
          payload ??= await panelPayload(guild, lang);
          await message.edit({ ...payload, attachments: [] });
          kept.push({ ...panel, key });
        } catch (error) {
          if (error.code === 10008 || error.code === 10003) {
            continue;
          }
          logger.warn("Couldn't update a color panel", { guildId: guild.id, channelId: panel.channelId, error });
          kept.push(panel);
        }
      }
      await (kept.length > 0 ? guildSettings.set(guild.id, Setting.COLOR_PANELS, kept) : guildSettings.clear(guild.id, Setting.COLOR_PANELS));
    });
  }

  // Every few minutes: panels of servers whose colors changed elsewhere (the
  // dashboard, or a role edited in Discord and synced).
  async function sweepPanels(guilds) {
    for (const guild of guilds) {
      if (panelsOf(guildSettings, guild.id).length > 0) {
        await refreshPanels(guild).catch((error) => logger.warn("Couldn't check a server's color panels", { guildId: guild.id, error }));
      }
    }
  }

  // --- New members ----------------------------------------------------------------

  async function giveJoinColor(member) {
    const guild = member.guild;
    const { joinColor } = options(guild.id);
    if (!joinColor || member.user?.bot || pickRefusal(guild, member)) {
      return;
    }
    const list = colors(guild.id).filter((color) => guild.roles.cache.has(color.roleId));
    const color = joinColor === RANDOM_JOIN_COLOR ? randomPick(list) : list.find((entry) => entry.roleId === joinColor);
    if (!color || currentColor(guild, member)) {
      return;
    }
    try {
      await applyColor(guild, member, color, "Join color");
    } catch (error) {
      logger.warn("Couldn't give a new member their join color", { guildId: guild.id, error: error instanceof ColorError ? error.key : error });
    }
  }

  return {
    locks,
    colors,
    options,
    canManage,
    pickRefusal,
    currentColor,
    applyColor,
    hidingRole,
    randomColor: () => randomColor(random),
    randomPick,
    addColors,
    addExisting,
    editColor,
    deleteColor,
    clearColors,
    sortList,
    syncColors,
    listPayload,
    postPanel,
    refreshPanels,
    sweepPanels,
    panelCount: (guildId) => panelsOf(guildSettings, guildId).length,

    // New members get the join color, or once they accept the rules.
    async memberJoined(member) {
      if (!member.pending) {
        await giveJoinColor(member);
      }
    },
    async memberUpdated(before, after) {
      if (before?.pending === true && after.pending === false) {
        await giveJoinColor(after);
      }
    },
  };
}
