// How color roles work in a server, saved under Setting.COLOR_OPTIONS and
// changed on the dashboard's Color roles page or with /color settings:
//
//   image           true: /color list and color panels show the colors as a
//                   picture (each name drawn in its colour). false: a text list
//                   of role mentions, which Discord also shows in colour.
//   channelId       /color set, random, remove and list only work in this
//                   channel. null = anywhere. Color managers can use them anywhere.
//   managerRoleIds  roles that manage the colors (add, edit, delete, sort, give
//                   members colors). When there are any, Manage Roles alone
//                   isn't enough; the owner and Administrator always can.
//   allowRoleIds    when there are any, only members with one of them can pick a color.
//   denyRoleIds     members with one of these can't pick a color (wins over allow).
//   joinColor       null (off), "random" or a color's role ID: given to new members.
//   overlapWarning  true: tell members when a higher role's colour hides theirs.

export const MAX_OPTION_ROLES = 25;

export const DEFAULT_COLOR_OPTIONS = Object.freeze({
  image: true,
  channelId: null,
  managerRoleIds: Object.freeze([]),
  allowRoleIds: Object.freeze([]),
  denyRoleIds: Object.freeze([]),
  joinColor: null,
  overlapWarning: true,
});

export const RANDOM_JOIN_COLOR = "random";

const SNOWFLAKE = /^\d{17,20}$/;
const KEYS = Object.keys(DEFAULT_COLOR_OPTIONS);
const ROLE_LISTS = ["managerRoleIds", "allowRoleIds", "denyRoleIds"];
const idList = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && SNOWFLAKE.test(id)))].slice(0, MAX_OPTION_ROLES) : []);

export class InvalidColorOptions extends Error {
  name = "InvalidColorOptions";
}

// The saved options with every default filled in. Never throws.
export function normalizeColorOptions(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const joinColor = value.joinColor === RANDOM_JOIN_COLOR || (typeof value.joinColor === "string" && SNOWFLAKE.test(value.joinColor)) ? value.joinColor : null;
  return {
    image: value.image !== false,
    channelId: typeof value.channelId === "string" && SNOWFLAKE.test(value.channelId) ? value.channelId : null,
    managerRoleIds: idList(value.managerRoleIds),
    allowRoleIds: idList(value.allowRoleIds),
    denyRoleIds: idList(value.denyRoleIds),
    joinColor,
    overlapWarning: value.overlapWarning !== false,
  };
}

const isDefault = (options) =>
  KEYS.every((key) => (Array.isArray(options[key]) ? options[key].length === 0 : options[key] === DEFAULT_COLOR_OPTIONS[key]));

// Checks dashboard or /color settings input. `isRole(id)` and `isChannel(id)`
// say whether an ID is a role (not @everyone) or a text channel of the
// server; `isColor(id)` whether a role is on the color list. Returns what to
// save, or null when everything is the default.
export function checkColorOptions(value, { isRole, isChannel, isColor = () => true }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidColorOptions(`Color role options are { ${KEYS.join(", ")} }.`);
  }
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) {
    throw new InvalidColorOptions(`Unknown color role option "${unknown}".`);
  }
  const merged = { ...DEFAULT_COLOR_OPTIONS, ...value };
  for (const key of ["image", "overlapWarning"]) {
    if (typeof merged[key] !== "boolean") {
      throw new InvalidColorOptions(`${key} is on or off (true or false).`);
    }
  }
  if (merged.channelId !== null && !(typeof merged.channelId === "string" && isChannel(merged.channelId))) {
    throw new InvalidColorOptions("Pick a text channel from this server for color commands, or none.");
  }
  for (const key of ROLE_LISTS) {
    const list = merged[key];
    if (!Array.isArray(list) || list.length > MAX_OPTION_ROLES || !list.every((id) => typeof id === "string" && isRole(id))) {
      throw new InvalidColorOptions(`Pick up to ${MAX_OPTION_ROLES} roles from this server (not @everyone).`);
    }
  }
  const join = merged.joinColor;
  if (join !== null && join !== RANDOM_JOIN_COLOR && !(typeof join === "string" && SNOWFLAKE.test(join) && isColor(join))) {
    throw new InvalidColorOptions("The join color is off, random, or one of the server's colors.");
  }
  const clean = normalizeColorOptions(merged);
  return isDefault(clean) ? null : clean;
}

// For the logs: "picture list · any channel · managers <@&1> · ...".
export function describeColorOptions(value) {
  const options = normalizeColorOptions(value);
  const roles = (ids) => ids.map((id) => `<@&${id}>`).join(", ");
  return [
    options.image ? "picture list" : "text list",
    options.channelId ? `only in <#${options.channelId}>` : "any channel",
    options.managerRoleIds.length > 0 ? `managers ${roles(options.managerRoleIds)}` : "managed with Manage Roles",
    ...(options.allowRoleIds.length > 0 ? [`only ${roles(options.allowRoleIds)}`] : []),
    ...(options.denyRoleIds.length > 0 ? [`not ${roles(options.denyRoleIds)}`] : []),
    options.joinColor === null ? "no join color" : options.joinColor === RANDOM_JOIN_COLOR ? "random join color" : `join color <@&${options.joinColor}>`,
    options.overlapWarning ? "overlap warning on" : "overlap warning off",
  ].join(" · ");
}
