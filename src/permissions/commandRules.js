// Per-command rules, set on the dashboard's Permissions page (Advanced). The
// setting is { "<command>": { disabled, roleIds, blockedRoleIds, channelIds } }:
//
// - disabled: nobody can use the command in this server.
// - roleIds: for a command that needs a Discord permission (/ban needs Ban
//   Members), members with one of these roles may use it as if they had that
//   permission. For a command everyone can use (/rank), only members with one
//   of these roles may use it.
// - blockedRoleIds: members with one of these roles can't use the command.
// - channelIds: the command only works in these channels (or channels in these
//   categories, and threads in them).
//
// Members with Manage Server ignore the roles and channels, so admins can't
// lock themselves out; a disabled command is off for everyone.
//
// Discord hides a command from members without its permission. A role given a
// command here must also be allowed under Server Settings > Integrations > the
// bot, or its members won't see the command to use it.

import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { Setting } from "../settings/guildSettings.js";

export const MAX_RULE_ROLES = 25;
export const MAX_RULE_CHANNELS = 50;

// How a role list on a command works (see the top of the file).
export const RoleMode = Object.freeze({
  GRANT: "grant", // the command needs a permission: the roles may use it too
  RESTRICT: "restrict", // everyone may use it: only the roles may
  NONE: "none", // roles can't be set (it needs Administrator, or it has its own role)
});

// Commands whose own role decides who may use them (the staff role from /settings).
const OWN_ROLE_COMMANDS = new Set(["country-staff"]);

export class InvalidCommandRules extends Error {
  name = "InvalidCommandRules";
}

const SNOWFLAKE = /^\d{17,20}$/;
const idList = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && SNOWFLAKE.test(id)))] : []);

// The Discord permission a command needs by default, as a bigint (0n for none).
export function commandPermission(command) {
  const data = typeof command.data?.toJSON === "function" ? command.data.toJSON() : (command.data ?? {});
  const bits = data.default_member_permissions;
  return bits === undefined || bits === null ? 0n : BigInt(bits);
}

export function roleModeOf(command) {
  if (OWN_ROLE_COMMANDS.has(command.name)) {
    return RoleMode.NONE;
  }
  const permission = commandPermission(command);
  if ((permission & PermissionFlagsBits.Administrator) !== 0n) {
    return RoleMode.NONE;
  }
  return permission === 0n ? RoleMode.RESTRICT : RoleMode.GRANT;
}

// Every command, for the dashboard: { name, permission, roleMode }, sorted by name.
export function commandCatalog(commands) {
  return [...commands.values()]
    .map((command) => ({ name: command.name, permission: String(commandPermission(command)), roleMode: roleModeOf(command) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const EMPTY_RULE = Object.freeze({ disabled: false, roleIds: [], blockedRoleIds: [], channelIds: [] });

// One saved rule with defaults for anything missing. Never throws.
export function normalizeRule(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return {
    disabled: value.disabled === true,
    roleIds: idList(value.roleIds),
    blockedRoleIds: idList(value.blockedRoleIds),
    channelIds: idList(value.channelIds),
  };
}

const isEmptyRule = (rule) => !rule.disabled && rule.roleIds.length === 0 && rule.blockedRoleIds.length === 0 && rule.channelIds.length === 0;

// The saved rules, without empty ones. Never throws.
export function normalizeCommandRules(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([name, rule]) => [name, normalizeRule(rule)])
      .filter(([, rule]) => !isEmptyRule(rule))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

// Checks rules from the dashboard. `catalog` is commandCatalog(); `isRole(id)`
// and `isChannel(id)` say whether an ID is a usable role or channel of the
// server. Returns what to save (null when no command has a rule). Throws
// InvalidCommandRules.
export function checkCommandRules(value, { catalog, isRole, isChannel }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCommandRules("Send the command rules as an object.");
  }
  const byName = new Map(catalog.map((command) => [command.name, command]));
  const rules = {};
  for (const [name, raw] of Object.entries(value)) {
    const command = byName.get(name);
    if (!command) {
      throw new InvalidCommandRules(`There's no /${name} command.`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InvalidCommandRules(`Send the rule for /${name} as an object.`);
    }
    const lists = ["roleIds", "blockedRoleIds", "channelIds"];
    for (const list of lists) {
      if (raw[list] !== undefined && !Array.isArray(raw[list])) {
        throw new InvalidCommandRules(`Send the ${list} of /${name} as a list.`);
      }
      if ((raw[list] ?? []).some((id) => typeof id !== "string" || !SNOWFLAKE.test(id))) {
        throw new InvalidCommandRules(`/${name} has an ID that isn't a role or channel.`);
      }
    }
    if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") {
      throw new InvalidCommandRules(`Send whether /${name} is off as true or false.`);
    }
    const rule = normalizeRule(raw);
    if (rule.roleIds.length > 0 && command.roleMode === RoleMode.NONE) {
      throw new InvalidCommandRules(`/${name} can't be given to roles here.`);
    }
    if (rule.roleIds.length > MAX_RULE_ROLES || rule.blockedRoleIds.length > MAX_RULE_ROLES) {
      throw new InvalidCommandRules(`Pick at most ${MAX_RULE_ROLES} roles for /${name}.`);
    }
    if (rule.channelIds.length > MAX_RULE_CHANNELS) {
      throw new InvalidCommandRules(`Pick at most ${MAX_RULE_CHANNELS} channels for /${name}.`);
    }
    if (![...rule.roleIds, ...rule.blockedRoleIds].every(isRole)) {
      throw new InvalidCommandRules(`Pick roles from this server for /${name} (not @everyone or bot roles).`);
    }
    if (!rule.channelIds.every(isChannel)) {
      throw new InvalidCommandRules(`Pick channels or categories from this server for /${name}.`);
    }
    if (rule.roleIds.some((id) => rule.blockedRoleIds.includes(id))) {
      throw new InvalidCommandRules(`A role can't be both allowed and blocked for /${name}.`);
    }
    if (!isEmptyRule(rule)) {
      rules[name] = rule;
    }
  }
  const sorted = normalizeCommandRules(rules);
  return Object.keys(sorted).length > 0 ? sorted : null;
}

// "/ban: off · /warn: also @Helpers", for the logs channel.
export function describeCommandRules(value) {
  const rules = normalizeCommandRules(value);
  const parts = Object.entries(rules).map(([name, rule]) => {
    const bits = [
      rule.disabled ? "off" : null,
      rule.roleIds.length > 0 ? `roles ${rule.roleIds.map((id) => `<@&${id}>`).join(", ")}` : null,
      rule.blockedRoleIds.length > 0 ? `blocked ${rule.blockedRoleIds.map((id) => `<@&${id}>`).join(", ")}` : null,
      rule.channelIds.length > 0 ? `only in ${rule.channelIds.map((id) => `<#${id}>`).join(", ")}` : null,
    ].filter(Boolean);
    return `/${name}: ${bits.join(", ")}`;
  });
  return parts.length > 0 ? parts.join(" · ") : "*none*";
}

const hasAnyRole = (member, ids) => ids.some((id) => member?.roles?.cache?.has(id));

// Whether `channel` is one of `ids`, or inside one (its category, or a thread's
// parent channel and that channel's category).
function inChannels(channel, ids) {
  if (!channel) {
    return false;
  }
  return [channel.id, channel.parentId, channel.parent?.parentId].some((id) => id && ids.includes(id));
}

// What the rules say about `interaction` using `command` (a slash command):
//   { refusal: "<translation key>", values }   it must not run
//   { grant: <permission bits> }               it runs as if the member had them
//   {}                                         it runs as usual
export function commandVerdict(interaction, command, guildSettings) {
  const guildId = interaction.guildId;
  if (!guildId || !guildSettings) {
    return {};
  }
  const rule = normalizeCommandRules(guildSettings.get(guildId, Setting.COMMAND_RULES))[command.name];
  if (!rule) {
    return {};
  }
  if (rule.disabled) {
    return { refusal: "commandRuleDisabled", values: { command: command.name } };
  }
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return {};
  }
  const member = interaction.member;
  if (hasAnyRole(member, rule.blockedRoleIds)) {
    return { refusal: "commandRuleBlocked", values: { command: command.name } };
  }
  if (rule.channelIds.length > 0 && !inChannels(interaction.channel, rule.channelIds)) {
    return {
      refusal: "commandRuleChannel",
      values: { command: command.name, channels: rule.channelIds.map((id) => `<#${id}>`).join(", ") },
    };
  }
  const mode = roleModeOf(command);
  if (rule.roleIds.length === 0 || mode === RoleMode.NONE) {
    return {};
  }
  const hasRole = hasAnyRole(member, rule.roleIds);
  if (mode === RoleMode.RESTRICT) {
    return hasRole ? {} : { refusal: "commandRuleRoles", values: { command: command.name } };
  }
  return hasRole ? { grant: commandPermission(command) } : {};
}

// The member's permissions plus `grant`, for the rest of the command to check.
export function withGrant(permissions, grant) {
  return new PermissionsBitField(permissions ?? 0n).add(grant).freeze();
}
