// How quotes work in a server, saved under Setting.QUOTES and changed on the
// dashboard's Quotes page:
//
//   enabled         false turns quotes off: /quote and the Make it a quote app
//                   only say so. On by default.
//   channelId       new quote cards are posted in this channel. null = in the
//                   channel the quote was made in.
//   makeRoleIds     when there are any, only members with one of them can make quotes.
//   viewRoleIds     when there are any, only members with one of them can show
//                   and search quotes (/quote random, get, search, list).
//   managerRoleIds  roles that manage the quote book: delete or edit any quote,
//                   change any card's look. When there are any, Manage Messages
//                   (or the mod role) alone isn't enough; the owner,
//                   Administrator and Manage Server always can.
//   denyRoleIds     members with one of these can't make or show quotes (wins over the lists above).
//   removeOwn       true: the member quoted, and whoever made the quote, can remove it.
//   selfQuotes      true: members can quote their own messages.
//   botQuotes       true: messages from bots and apps can be quoted.
//   reactionEmoji   a message that gets `reactionCount` of this emoji becomes a
//                   quote, made by the first member who reacted. null = off.
//   reactionCount   how many reactions (1 to 50, 3 by default).
//   style           the look new cards start with (quotes/style.js).

import { cleanEmoji } from "../community/rolePanels.js";
import { DEFAULT_STYLE, describeStyle, isDefaultStyle, normalizeStyle } from "./style.js";

export const MAX_OPTION_ROLES = 25;
export const DEFAULT_REACTION_COUNT = 3;
export const MIN_REACTION_COUNT = 1;
export const MAX_REACTION_COUNT = 50;

export const DEFAULT_QUOTE_OPTIONS = Object.freeze({
  enabled: true,
  channelId: null,
  makeRoleIds: Object.freeze([]),
  viewRoleIds: Object.freeze([]),
  managerRoleIds: Object.freeze([]),
  denyRoleIds: Object.freeze([]),
  removeOwn: true,
  selfQuotes: true,
  botQuotes: true,
  reactionEmoji: null,
  reactionCount: DEFAULT_REACTION_COUNT,
  style: DEFAULT_STYLE,
});

const SNOWFLAKE = /^\d{17,20}$/;
const KEYS = Object.keys(DEFAULT_QUOTE_OPTIONS);
const ROLE_LISTS = ["makeRoleIds", "viewRoleIds", "managerRoleIds", "denyRoleIds"];
const SWITCHES = ["enabled", "removeOwn", "selfQuotes", "botQuotes"];
const idList = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && SNOWFLAKE.test(id)))].slice(0, MAX_OPTION_ROLES) : []);

export class InvalidQuoteOptions extends Error {
  name = "InvalidQuoteOptions";
}

// The saved options with every default filled in. Never throws.
export function normalizeQuoteOptions(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const count = Number.isInteger(value.reactionCount) ? value.reactionCount : DEFAULT_REACTION_COUNT;
  return {
    enabled: value.enabled !== false,
    channelId: typeof value.channelId === "string" && SNOWFLAKE.test(value.channelId) ? value.channelId : null,
    makeRoleIds: idList(value.makeRoleIds),
    viewRoleIds: idList(value.viewRoleIds),
    managerRoleIds: idList(value.managerRoleIds),
    denyRoleIds: idList(value.denyRoleIds),
    removeOwn: value.removeOwn !== false,
    selfQuotes: value.selfQuotes !== false,
    botQuotes: value.botQuotes !== false,
    reactionEmoji: cleanEmoji(value.reactionEmoji) ?? null,
    reactionCount: Math.min(MAX_REACTION_COUNT, Math.max(MIN_REACTION_COUNT, count)),
    style: normalizeStyle(value.style),
  };
}

const isDefault = (options) =>
  KEYS.every((key) => {
    if (key === "style") {
      return isDefaultStyle(options.style);
    }
    return Array.isArray(options[key]) ? options[key].length === 0 : options[key] === DEFAULT_QUOTE_OPTIONS[key];
  });

// Checks dashboard input. `isRole(id)` and `isChannel(id)` say whether an ID
// is a role (not @everyone) or a channel cards can be posted in. Returns what
// to save, or null when everything is the default.
export function checkQuoteOptions(value, { isRole, isChannel }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidQuoteOptions(`Quote options are { ${KEYS.join(", ")} }.`);
  }
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) {
    throw new InvalidQuoteOptions(`Unknown quote option "${unknown}".`);
  }
  const merged = { ...DEFAULT_QUOTE_OPTIONS, ...value };
  for (const key of SWITCHES) {
    if (typeof merged[key] !== "boolean") {
      throw new InvalidQuoteOptions(`${key} is on or off (true or false).`);
    }
  }
  if (merged.channelId !== null && !(typeof merged.channelId === "string" && isChannel(merged.channelId))) {
    throw new InvalidQuoteOptions("Pick a text channel from this server for quote cards, or none.");
  }
  for (const key of ROLE_LISTS) {
    const list = merged[key];
    if (!Array.isArray(list) || list.length > MAX_OPTION_ROLES || !list.every((id) => typeof id === "string" && isRole(id))) {
      throw new InvalidQuoteOptions(`Pick up to ${MAX_OPTION_ROLES} roles from this server (not @everyone).`);
    }
  }
  if (merged.reactionEmoji !== null && !cleanEmoji(merged.reactionEmoji)) {
    throw new InvalidQuoteOptions("The quote reaction is one emoji, or none.");
  }
  if (!Number.isInteger(merged.reactionCount) || merged.reactionCount < MIN_REACTION_COUNT || merged.reactionCount > MAX_REACTION_COUNT) {
    throw new InvalidQuoteOptions(`The number of reactions is ${MIN_REACTION_COUNT} to ${MAX_REACTION_COUNT}.`);
  }
  if (!merged.style || typeof merged.style !== "object" || Array.isArray(merged.style)) {
    throw new InvalidQuoteOptions("The card look is { theme, light, color, bold, font }.");
  }
  const style = normalizeStyle(merged.style);
  if (Object.keys(merged.style).some((key) => !(key in style)) || Object.entries(merged.style).some(([key, part]) => style[key] !== part)) {
    throw new InvalidQuoteOptions("Pick a card theme and font from the lists.");
  }
  const clean = normalizeQuoteOptions(merged);
  return isDefault(clean) ? null : clean;
}

// For the logs: "on · cards where made · anyone makes · ...".
export function describeQuoteOptions(value) {
  const options = normalizeQuoteOptions(value);
  const roles = (ids) => ids.map((id) => `<@&${id}>`).join(", ");
  return [
    options.enabled ? "on" : "off",
    options.channelId ? `cards in <#${options.channelId}>` : "cards where made",
    options.makeRoleIds.length > 0 ? `made by ${roles(options.makeRoleIds)}` : "anyone makes",
    options.viewRoleIds.length > 0 ? `shown to ${roles(options.viewRoleIds)}` : "anyone shows",
    options.managerRoleIds.length > 0 ? `managers ${roles(options.managerRoleIds)}` : "managed with Manage Messages",
    ...(options.denyRoleIds.length > 0 ? [`not ${roles(options.denyRoleIds)}`] : []),
    options.removeOwn ? "members remove their own" : "only managers remove",
    options.selfQuotes ? "self quotes on" : "self quotes off",
    options.botQuotes ? "bot quotes on" : "bot quotes off",
    options.reactionEmoji ? `${options.reactionCount} × ${options.reactionEmoji} makes a quote` : "no quote reaction",
    `look: ${describeStyle(options.style)}`,
  ].join(" · ");
}

// --- Who may do what ------------------------------------------------------------
//
// `member` is a GuildMember, `permissions` its permissions (interaction.memberPermissions
// for commands, so command rules from the Permissions page count), `ownerId`
// the server owner, `modRoleId` the server's mod role (or undefined).

const hasAny = (member, ids) => ids.some((id) => member?.roles?.cache?.has(id));

export function quoteAccess({ options, member, permissions, ownerId, modRoleId }) {
  const admin = Boolean(member && (member.id === ownerId || permissions?.has?.("Administrator") || permissions?.has?.("ManageGuild")));
  let manage = admin;
  if (!manage && member) {
    manage = options.managerRoleIds.length > 0
      ? hasAny(member, options.managerRoleIds)
      : Boolean(permissions?.has?.("ManageMessages") || (modRoleId && member.roles?.cache?.has(modRoleId)));
  }
  const denied = !manage && hasAny(member, options.denyRoleIds);
  const allowed = (ids) => manage || (!denied && (ids.length === 0 || hasAny(member, ids)));
  return { manage, denied, make: allowed(options.makeRoleIds), view: allowed(options.viewRoleIds) };
}

// Whether this member may remove a quote: managers any, and (with removeOwn)
// the member quoted or whoever made it.
export const canRemoveQuote = (access, options, quote, userId) =>
  access.manage || (options.removeOwn && (quote.authorId === userId || quote.addedBy === userId));

// Whether this member may change a card's look: managers, whoever made the quote and the member quoted.
export const canRestyleQuote = (access, quote, userId) => access.manage || quote.authorId === userId || quote.addedBy === userId;
