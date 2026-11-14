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
//
// Uploads go through readBackupFile before anything else looks at them: the
// file must be a small UTF-8 .json file in exactly the backup layout (version
// 2 also carries a SHA-256 checksum, so a damaged or edited file is refused),
// and every value in it is walked for size, depth and unsafe keys.

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { Setting } from "../settings/guildSettings.js";
import { normalizeCounters } from "../stats/statsCounters.js";
import { checkSettingChanges, InvalidSetting, SETTING_RULES } from "./settingsRules.js";
import { foldEscalationInto } from "../moderation/warnStepsMigration.js";

export const BACKUP_FORMAT = "rabble-settings-backup";
export const BACKUP_VERSION = 2;
// Files from before version 2: still read, with the same strict checks but no
// checksum (they never had one).
export const LEGACY_FORMAT = "rvrevival-settings";
export const LEGACY_VERSION = 1;

// Upload limits. Real backups are a few KB; these leave plenty of room while
// keeping a hostile file cheap to refuse.
export const BACKUP_LIMITS = Object.freeze({
  bytes: 512 * 1024,
  fileName: 200,
  settings: 100,
  depth: 12,
  values: 20_000,
  string: 8_000,
  key: 100,
});

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

const fail = (message) => {
  throw new InvalidBackup(message);
};

// JSON with object keys sorted at every level, so the checksum doesn't depend
// on key order (a JSON tool that sorts keys keeps the file valid).
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// The checksum of everything in a version 2 file except the checksum and signature.
export function checksum({ format, version, exportedAt, guild, settings }) {
  return `sha256:${createHash("sha256").update(canonical({ format, version, exportedAt, guild, settings })).digest("hex")}`;
}

// The signature for a backup's server and settings, made with a key from
// DASHBOARD_SESSION_SECRET (so a new secret makes older backups unsigned).
// Version 1 files signed the settings as written; version 2 signs them in
// canonical form.
function signature(secret, guildId, settings, version = BACKUP_VERSION) {
  const key = Buffer.from(hkdfSync("sha256", secret, "rv-dashboard", "settings-backup", 32));
  const body = version === LEGACY_VERSION ? JSON.stringify([LEGACY_FORMAT, LEGACY_VERSION, guildId, settings]) : canonical([BACKUP_FORMAT, BACKUP_VERSION, guildId, settings]);
  return createHmac("sha256", key).update(body).digest("base64url");
}

// Whether `backup` is unchanged since this dashboard made it for `guildId`.
function signedFor(backup, guildId, secret) {
  if (!secret || typeof backup.signature !== "string" || backup.guild?.id !== guildId) {
    return false;
  }
  const expected = Buffer.from(signature(secret, guildId, backup.settings, backup.version));
  const given = Buffer.from(backup.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const SNOWFLAKE = /^\d{17,20}$/;
const SETTING_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Keys that could reach an object's prototype if some later code merged them.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Control characters other than tab, newline and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The exact top-level fields of each version: anything else is refused.
const LAYOUT = {
  [BACKUP_VERSION]: { required: ["format", "version", "exportedAt", "guild", "settings", "checksum"], optional: ["signature"] },
  [LEGACY_VERSION]: { required: ["format", "version", "guild", "settings"], optional: ["exportedAt", "signature"] },
};

function onlyFields(object, { required, optional = [] }, where) {
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(`That backup has a field this bot doesn't use (${where}${key.slice(0, 40)}).`);
    }
  }
  for (const key of required) {
    if (!(key in object)) {
      fail(`That backup is missing ${where}${key}.`);
    }
  }
}

// Walks every value in a setting: limits nesting, total size and string
// length, and refuses keys or text that have no place in a setting.
function checkValues(root, setting) {
  let count = 0;
  const walk = (value, depth) => {
    count += 1;
    if (count > BACKUP_LIMITS.values) {
      fail("That backup holds too much data.");
    }
    if (depth > BACKUP_LIMITS.depth) {
      fail(`The ${setting} setting in that backup is nested too deeply.`);
    }
    if (typeof value === "string") {
      if (value.length > BACKUP_LIMITS.string) {
        fail(`The ${setting} setting in that backup has text that's too long.`);
      }
      if (CONTROL.test(value)) {
        fail(`The ${setting} setting in that backup has hidden control characters.`);
      }
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail(`The ${setting} setting in that backup has a number that isn't valid.`);
      }
      return;
    }
    if (value === null || typeof value === "boolean") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(key) || key.length > BACKUP_LIMITS.key || CONTROL.test(key)) {
          fail(`The ${setting} setting in that backup has a field name that isn't allowed.`);
        }
        walk(item, depth + 1);
      }
      return;
    }
    fail(`The ${setting} setting in that backup has a value that isn't allowed.`);
  };
  walk(root, 1);
  return count;
}

// Checks an already parsed backup against the strict layout and returns it.
// Throws InvalidBackup, with a message for the person, on anything unexpected.
export function validateBackup(backup) {
  if (!isPlainObject(backup)) {
    fail("That isn't a settings backup from this bot.");
  }
  const known = (backup.format === BACKUP_FORMAT && backup.version === BACKUP_VERSION) || (backup.format === LEGACY_FORMAT && backup.version === LEGACY_VERSION);
  if (!known) {
    if (backup.format === BACKUP_FORMAT || backup.format === LEGACY_FORMAT) {
      fail("That backup was made by a different version of the bot.");
    }
    fail("That isn't a settings backup from this bot.");
  }
  onlyFields(backup, LAYOUT[backup.version], "");
  if (!isPlainObject(backup.guild)) {
    fail("That backup has no server.");
  }
  onlyFields(backup.guild, { required: ["id"], optional: ["name"] }, "guild.");
  if (typeof backup.guild.id !== "string" || !SNOWFLAKE.test(backup.guild.id)) {
    fail("That backup's server ID isn't valid.");
  }
  if ("name" in backup.guild && (typeof backup.guild.name !== "string" || backup.guild.name.length > 100 || CONTROL.test(backup.guild.name))) {
    fail("That backup's server name isn't valid.");
  }
  if ("exportedAt" in backup) {
    const time = typeof backup.exportedAt === "string" && ISO_TIME.test(backup.exportedAt) ? Date.parse(backup.exportedAt) : Number.NaN;
    // A day of leeway for clocks that are off.
    if (!Number.isFinite(time) || time > Date.now() + 24 * 60 * 60 * 1000) {
      fail("That backup's date isn't valid.");
    }
  }
  if ("signature" in backup && (typeof backup.signature !== "string" || !SIGNATURE.test(backup.signature))) {
    fail("That backup's signature isn't valid.");
  }
  if (!isPlainObject(backup.settings)) {
    fail("That backup has no settings.");
  }
  const names = Object.keys(backup.settings);
  if (names.length > BACKUP_LIMITS.settings) {
    fail("That backup has too many settings.");
  }
  for (const name of names) {
    if (!SETTING_NAME.test(name)) {
      fail("That backup has a setting name that isn't allowed.");
    }
    checkValues(backup.settings[name], name);
  }
  if (backup.version === BACKUP_VERSION) {
    if (typeof backup.checksum !== "string" || !CHECKSUM.test(backup.checksum)) {
      fail("That backup's checksum isn't valid.");
    }
    const expected = Buffer.from(checksum(backup));
    const given = Buffer.from(backup.checksum);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      fail("That backup was changed or damaged after it was downloaded, so it can't be restored.");
    }
  }
  return backup;
}

// Reads an uploaded backup file: `text` is its contents and `fileName` its
// name. Checks the file itself (name, size, encoding, that it's one JSON
// object) and then the layout (validateBackup). Returns the backup.
export function readBackupFile(text, fileName) {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > BACKUP_LIMITS.fileName || !/\.json$/i.test(fileName) || CONTROL.test(fileName)) {
    fail("Pick the .json file the Backup page downloaded.");
  }
  if (typeof text !== "string" || text.length === 0) {
    fail("That file is empty.");
  }
  if (Buffer.byteLength(text, "utf8") > BACKUP_LIMITS.bytes) {
    fail("That file is too big to be a settings backup.");
  }
  // An editor may add a byte order mark; nothing else may come before the JSON.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // A lone surrogate means the file wasn't valid UTF-8 text.
  if (!body.isWellFormed()) {
    fail("That file isn't UTF-8 text, so it isn't a settings backup.");
  }
  if (CONTROL.test(body)) {
    fail("That file has binary data in it, so it isn't a settings backup.");
  }
  if (!body.trimStart().startsWith("{")) {
    fail("That file isn't a settings backup.");
  }
  let parsed;
  try {
    parsed = JSON.parse(body, (key, value) => {
      if (UNSAFE_KEYS.has(key)) {
        fail("That backup has a field name that isn't allowed.");
      }
      return value;
    });
  } catch (error) {
    if (error instanceof InvalidBackup) {
      throw error;
    }
    fail("That file isn't valid JSON, so it isn't a settings backup.");
  }
  return validateBackup(parsed);
}

export const settingLabel = (setting) => SETTING_RULES[setting]?.label ?? SAME_SERVER_LABELS[setting] ?? setting;

// The backup file's contents.
// `secret` signs it (see signature); without one the file is unsigned.
export function buildBackup({ guildId, guildName, settings, secret, now = Date.now() }) {
  const saved = Object.fromEntries(Object.entries(settings).filter(([setting, value]) => KNOWN.has(setting) && !NOT_BACKED_UP.has(setting) && value !== undefined && value !== null));
  const guild = guildName === undefined || guildName === null ? { id: guildId } : { id: guildId, name: String(guildName).slice(0, 100) };
  const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), guild, settings: saved };
  const withChecksum = { ...backup, checksum: checksum(backup) };
  return secret ? { ...withChecksum, signature: signature(secret, guildId, saved) } : withChecksum;
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

// What restoring `backup` (checked again with validateBackup) would do: { apply: { setting: value | null }, skipped: [{ setting, reason, message }], unchanged }.
// `server` is { guildId, channels, roles, isOwner, canManagePermissions, current, secret }
// (current: the saved settings now; canManagePermissions: the owner or whoever
// added the bot; secret: what buildBackup signed with).
export function planRestore(backup, { guildId, channels, roles, isOwner, canManagePermissions = isOwner, current, secret }) {
  validateBackup(backup);
  // Only a signed file proves it came from this server.
  const sameServer = signedFor(backup, guildId, secret);
  const claimsSameServer = backup.guild?.id === guildId;
  const apply = {};
  const skipped = [];
  let unchanged = 0;
  // Older backups keep automod's warning escalation, now a warning step.
  for (const [setting, value] of Object.entries(foldEscalationInto(backup.settings))) {
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
