// Settings backup and restore (the dashboard's Backup page). A backup is a
// JSON file with every saved setting of a server. Restoring checks each
// setting against the server it goes to, the same way the settings pages do,
// and skips what doesn't fit (a channel that doesn't exist there, say).
// Settings missing from the backup stay as they are.

import { Setting } from "../settings/guildSettings.js";
import { normalizeCounters } from "../stats/statsCounters.js";
import { checkSettingChanges, InvalidSetting, SETTING_RULES } from "./settingsRules.js";

export const BACKUP_FORMAT = "rvrevival-settings";
export const BACKUP_VERSION = 1;

// Running state, or facts about one server (who added the bot): never backed up.
const NOT_BACKED_UP = new Set([Setting.LOCKDOWN, Setting.BOT_INVITER]);
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

export const settingLabel = (setting) => SETTING_RULES[setting]?.label ?? SAME_SERVER_LABELS[setting] ?? setting;

// The backup file's contents.
export function buildBackup({ guildId, guildName, settings, now = Date.now() }) {
  const saved = Object.fromEntries(Object.entries(settings).filter(([setting, value]) => KNOWN.has(setting) && !NOT_BACKED_UP.has(setting) && value !== undefined && value !== null));
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), guild: { id: guildId, name: guildName }, settings: saved };
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
// `server` is { guildId, channels, roles, isOwner, canManagePermissions, current }
// (current: the saved settings now; canManagePermissions: the owner or whoever added the bot).
export function planRestore(backup, { guildId, channels, roles, isOwner, canManagePermissions = isOwner, current }) {
  if (!backup || typeof backup !== "object" || backup.format !== BACKUP_FORMAT) {
    throw new InvalidBackup("That isn't a settings backup from this bot.");
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new InvalidBackup("That backup was made by a different version of the bot.");
  }
  if (!backup.settings || typeof backup.settings !== "object" || Array.isArray(backup.settings)) {
    throw new InvalidBackup("That backup has no settings.");
  }
  const sameServer = backup.guild?.id === guildId;
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
      skipped.push({ setting, reason: "other-server" });
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
