// Premade permission setups (the dashboard's Permissions page, Simple). Each
// one sets the roles the bot uses and which commands each role may use, in one
// step. Applying one only changes the settings listed in its plan; the
// Advanced tab can then fine-tune them.
//
// Every preset also marks the server as set up (PERMISSION_PRESET), after
// which the staff role is only for country changes and no longer doubles as
// the mod role (see moderation/checks.js).

import { Setting } from "../settings/guildSettings.js";
import { normalizeCommandRules } from "./commandRules.js";

export const Preset = Object.freeze({
  ADMINS_ONLY: "adminsOnly", // only members with Discord's own permissions
  ONE_TEAM: "oneTeam", // one staff role does everything
  TWO_TEAMS: "twoTeams", // moderators do everything, helpers the everyday commands
});
export const PRESETS = Object.values(Preset);
// What the dashboard shows when the rules were changed after applying a preset.
export const CUSTOM = "custom";

// The everyday commands helpers get in the two-team setup.
export const HELPER_COMMANDS = Object.freeze(["case", "modlogs", "note", "purge", "slowmode", "timeout", "untimeout", "warn"]);

// Which roles each preset needs: "moderator", "helper".
export const PRESET_ROLES = Object.freeze({
  [Preset.ADMINS_ONLY]: [],
  [Preset.ONE_TEAM]: ["moderator"],
  [Preset.TWO_TEAMS]: ["moderator", "helper"],
});

export class InvalidPreset extends Error {
  name = "InvalidPreset";
}

// The command rules with the roles of every command replaced by `grants`
// ({ command: [roleIds] }); whether a command is off, its blocked roles and
// its channels stay.
function rulesWithGrants(saved, grants) {
  const rules = normalizeCommandRules(saved);
  const names = new Set([...Object.keys(rules), ...Object.keys(grants)]);
  const next = {};
  for (const name of names) {
    const rule = rules[name] ?? { disabled: false, roleIds: [], blockedRoleIds: [], channelIds: [] };
    const roleIds = grants[name] ?? [];
    next[name] = { ...rule, roleIds, blockedRoleIds: rule.blockedRoleIds.filter((id) => !roleIds.includes(id)) };
  }
  const clean = normalizeCommandRules(next);
  return Object.keys(clean).length > 0 ? clean : null;
}

// The settings `preset` would save, as { setting: value | null }.
// `roles` is { moderator, helper } (role IDs); `isRole(id)` says whether an ID
// is a usable role of the server; `current` is the server's saved settings.
// Throws InvalidPreset.
export function planPreset(preset, { roles = {}, isRole, current = {} }) {
  if (!PRESETS.includes(preset)) {
    throw new InvalidPreset("Pick one of the premade setups.");
  }
  for (const kind of PRESET_ROLES[preset]) {
    if (!roles[kind] || !isRole(roles[kind])) {
      throw new InvalidPreset(kind === "moderator" ? "Pick the moderators' role." : "Pick the helpers' role.");
    }
  }
  const { moderator, helper } = roles;
  if (preset === Preset.TWO_TEAMS && moderator === helper) {
    throw new InvalidPreset("Pick two different roles for moderators and helpers.");
  }
  const rules = current[Setting.COMMAND_RULES];
  switch (preset) {
    case Preset.ADMINS_ONLY:
      return {
        [Setting.MOD_ROLE]: null,
        [Setting.DASHBOARD_ROLES]: null,
        [Setting.COMMAND_RULES]: rulesWithGrants(rules, {}),
        [Setting.PERMISSION_PRESET]: preset,
      };
    case Preset.ONE_TEAM:
      return {
        [Setting.MOD_ROLE]: moderator,
        [Setting.STAFF_ROLE]: moderator,
        [Setting.DASHBOARD_ROLES]: [moderator],
        [Setting.COMMAND_RULES]: rulesWithGrants(rules, {}),
        [Setting.PERMISSION_PRESET]: preset,
      };
    default:
      return {
        [Setting.MOD_ROLE]: moderator,
        [Setting.STAFF_ROLE]: helper,
        [Setting.DASHBOARD_ROLES]: [moderator, helper],
        [Setting.COMMAND_RULES]: rulesWithGrants(rules, Object.fromEntries(HELPER_COMMANDS.map((name) => [name, [helper]]))),
        [Setting.PERMISSION_PRESET]: preset,
      };
  }
}
