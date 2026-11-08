// Settings backup and restore (the dashboard's Backup page). A backup is a
// JSON file with every saved setting of a server. Restoring checks each
// setting against the server it goes to, the same way the settings pages do,
// and skips what doesn't fit (a channel that doesn't exist there, say).
// Settings missing from the backup stay as they are.
//
// Settings with no form (panels, posted messages, stats counter channels) hold
// raw channel, message and role IDs that the settings check can't vet. They're
// only restored from a file this dashboard made for this same server: each
// backup carries an HMAC signature over its server ID and settings, so a
// hand-edited file can't point them at other channels, roles or servers.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { Setting } from "../settings/guildSettings.js";
import { normalizeCounters } from "../stats/statsCounters.js";
import { checkSettingChanges, InvalidSetting, SETTING_RULES } from "./settingsRules.js";

export const BACKUP_FORMAT = "rvrevival-settings";
export const BACKUP_VERSION = 1;

// Running state, or facts about one server (who added the bot): never backed
// up. Branding is mostly the bot's Discord profile, which Discord keeps, so
// restoring only the saved half of it would leave the two out of step.
const NOT_BACKED_UP = new Set([Setting.LOCKDOWN, Setting.BOT_INVITER, Setting.BRANDING]);
// Settings the dashboard has no form for. They point at messages and
// channels of the server they were made on, so they're only restored there
// (stats counters get new channels elsewhere).
const SAME_SERVER_LABELS = {
  [Setting.ROLE_PANELS]: "Role panels",
  [Setting.TICKETS]: "Ticket panel",
  [Setting.TEMP_VOICE]: "Join-to-create voice",
  [Setting.STATS_COUNTERS]: "Server stats counters",
  [Setting.COUNTRY_GUIDE_POST]: "Posted country guide",
};
const KNOWN = new Set(Object.values(Setting));

export class InvalidBackup extends Error {
  name = "InvalidBackup";
}

// The signature for a backup's server and settings, made with a key from
// DASHBOARD_SESSION_SECRET (so a new secret makes older backups unsigned).
function signature(secret, guildId, settings) {
  const key = Buffer.from(hkdfSync("sha256", secret, "rv-dashboard", "settings-backup", 32));
  return createHmac("sha256", key).update(JSON.stringify([BACKUP_FORMAT, BACKUP_VERSION, guildId, settings])).digest("base64url");
}

// Whether `backup` is unchanged since this dashboard made it for `guildId`.
function signedFor(backup, guildId, secret) {
  if (!secret || typeof backup.signature !== "string" || backup.guild?.id !== guildId) {
    return false;
  }
  const expected = Buffer.from(signature(secret, guildId, backup.settings));
  const given = Buffer.from(backup.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const settingLabel = (setting) => SETTING_RULES[setting]?.label ?? SAME_SERVER_LABELS[setting] ?? setting;

// The backup file's contents.
// `secret` signs it (see signature); without one the file is unsigned.
export function buildBackup({ guildId, guildName, settings, secret, now = Date.now() }) {
  const saved = Object.fromEntries(Object.entries(settings).filter(([setting, value]) => KNOWN.has(setting) && !NOT_BACKED_UP.has(setting) && value !== undefined && value !== null));
  const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), guild: { id: guildId, name: guildName }, settings: saved };
  return secret ? { ...backup, signature: signature(secret, guildId, saved) } : backup;
}

// A saved value the way the settings check writes it (tags sorted, say), so
// equal settings compare equal however they were saved.
function normalized(setting, value, server) {
  if (value === undefined || value === null || !SETTING_RULES[setting]) {
    return value;
  }
  try {
    return checkSettingChanges({ [setting]: value }, server)[setting];
  } catch (error) {
    if (error instanceof InvalidSetting) {
      return value;
    }
    throw error;
  }
}

// What restoring `backup` would do: { apply: { setting: value | null }, skipped: [{ setting, reason, message }], unchanged }.
// `server` is { guildId, channels, roles, isOwner, canManagePermissions, current, secret }
// (current: the saved settings now; canManagePermissions: the owner or whoever
// added the bot; secret: what buildBackup signed with).
export function planRestore(backup, { guildId, channels, roles, isOwner, canManagePermissions = isOwner, current, secret }) {
  if (!backup || typeof backup !== "object" || backup.format !== BACKUP_FORMAT) {
    throw new InvalidBackup("That isn't a settings backup from this bot.");
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new InvalidBackup("That backup was made by a different version of the bot.");
  }
  if (!backup.settings || typeof backup.settings !== "object" || Array.isArray(backup.settings)) {
    throw new InvalidBackup("That backup has no settings.");
  }
  // Only a signed file proves it came from this server.
  const sameServer = signedFor(backup, guildId, secret);
  const claimsSameServer = backup.guild?.id === guildId;
  const apply = {};
  const skipped = [];
  let unchanged = 0;
  for (const [setting, value] of Object.entries(backup.settings)) {
    if (!KNOWN.has(setting) || NOT_BACKED_UP.has(setting)) {
      skipped.push({ setting, reason: "unknown" });
      continue;
    }
    let checked;
    if (SETTING_RULES[setting]) {
      if (SETTING_RULES[setting].ownerOnly && !isOwner) {
        skipped.push({ setting, reason: "owner-only" });
        continue;
      }
      if (SETTING_RULES[setting].permissionsOnly && !canManagePermissions) {
        skipped.push({ setting, reason: "permissions-only" });
        continue;
      }
      try {
        checked = checkSettingChanges({ [setting]: value }, { guildId, channels, roles })[setting];
      } catch (error) {
        if (error instanceof InvalidSetting) {
          skipped.push({ setting, reason: "invalid", message: error.message });
          continue;
        }
        throw error;
      }
    } else if (setting === Setting.STATS_COUNTERS) {
      const counters = normalizeCounters(value);
      // Elsewhere, the bot makes new channels for the counters.
      checked = sameServer ? counters : counters.map((counter) => ({ ...counter, channelId: null, categoryId: null, error: null }));
    } else if (sameServer) {
      checked = value;
    } else {
      skipped.push({ setting, reason: claimsSameServer ? "unsigned" : "other-server" });
      continue;
    }
    if (JSON.stringify(checked ?? null) === JSON.stringify(normalized(setting, current[setting], { guildId, channels, roles }) ?? null)) {
      unchanged += 1;
      continue;
    }
    apply[setting] = checked ?? null;
  }
  return { apply, skipped, unchanged };
}
