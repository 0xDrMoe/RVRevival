// The Overview's "Server checkup": things that stop features working that
// staff can't easily see from Discord.
//   - invite permissions the bot's roles don't have (someone unticked them, or
//     edited the bot's role later);
//   - roles the bot is set to give (autoroles, role panels, rewards...) that
//     sit at or above the bot's highest role, so Discord refuses;
//   - channels a setting points at that no longer exist.
// Built from Discord's API answers, so the dashboard needs no bot process.

import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { INVITE_PERMISSIONS } from "../guilds/invite.js";
import { Setting } from "../settings/guildSettings.js";
import { SETTING_RULES } from "./settingsRules.js";

// Which dashboard page fixes a channel setting.
const CHANNEL_PAGES = {
  [Setting.LOGS_CHANNEL]: "logging",
  [Setting.MOD_LOG_CHANNEL]: "logging",
  [Setting.SERVER_LOG_CHANNEL]: "logging",
  [Setting.TICKET_LOG_CHANNEL]: "logging",
  [Setting.WELCOME_CHANNEL]: "welcome",
  [Setting.LEAVE_CHANNEL]: "welcome",
  [Setting.COUNTRY_CHANNEL]: "country",
  [Setting.WEEKLY_BOARD_CHANNEL]: "levels",
};

const isId = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);

// [{ roleId, use, page }] for every role a feature hands out.
function givenRoles(settings) {
  const list = [];
  const add = (roleId, use, page) => isId(roleId) && list.push({ roleId, use, page });
  for (const roleId of settings[Setting.AUTOROLES] ?? []) {
    add(roleId, "autorole", "roles");
  }
  for (const panel of Array.isArray(settings[Setting.ROLE_PANELS]) ? settings[Setting.ROLE_PANELS] : []) {
    for (const entry of panel?.roles ?? []) {
      add(entry?.roleId, "rolePanel", "roles");
    }
  }
  for (const reward of settings[Setting.LEVELING]?.rewards ?? []) {
    add(reward?.roleId, "levelReward", "levels");
  }
  add(settings[Setting.WEEKLY_BOARD_ROLE], "weeklyBoard", "levels");
  add(settings[Setting.QUARANTINE_ROLE], "quarantine", "moderation");
  add(settings[Setting.BIRTHDAYS]?.roleId, "birthday", "birthdays");
  return list;
}

// `guild` and `channels` as Discord's API gives them, `me` the bot's member
// (or null if Discord didn't say), `settings` the server's saved settings.
export function serverCheckup({ guildId, guild, channels, me, settings }) {
  const roles = new Map((guild.roles ?? []).map((role) => [role.id, role]));
  const myRoles = [guildId, ...(me?.roles ?? [])].map((id) => roles.get(id)).filter(Boolean);
  const permissions = myRoles.reduce((bits, role) => bits | BigInt(role.permissions ?? 0), 0n);
  const isAdmin = (permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
  const missingBits = isAdmin ? 0n : BigInt(INVITE_PERMISSIONS) & ~permissions;
  const missingPermissions = me ? new PermissionsBitField(missingBits).toArray() : [];

  const top = Math.max(0, ...myRoles.filter((role) => role.id !== guildId).map((role) => role.position ?? 0));
  const seen = new Set();
  const rolesTooHigh = me
    ? givenRoles(settings).filter(({ roleId, use }) => {
        const role = roles.get(roleId);
        const key = `${roleId}:${use}`;
        if (!role || seen.has(key) || role.position < top) {
          return false;
        }
        seen.add(key);
        return true;
      }).map(({ roleId, use, page }) => ({ roleId, name: roles.get(roleId).name, use, page }))
    : [];

  const channelIds = new Set(channels.map((channel) => channel.id));
  const missingChannels = Object.entries(SETTING_RULES)
    .filter(([setting, rule]) => rule.kind === "channel" && isId(settings[setting]) && !channelIds.has(settings[setting]))
    .map(([setting, rule]) => ({ setting, label: rule.label, page: CHANNEL_PAGES[setting] ?? "logging" }));

  return {
    // Unknown when Discord didn't give the bot's member.
    checked: Boolean(me),
    missingPermissions,
    rolesTooHigh,
    missingChannels,
  };
}
