// Checks why autoroles aren't given, from this machine. Run it on the VPS:
//
//   npm run autoroles:check                 every server that has autoroles
//   npm run autoroles:check -- <server ID>  one server
//
// It reads the saved autoroles from data/bot.db (read-only) and asks Discord
// for the server's roles, the bot's own member and the server's Onboarding,
// then prints, for each autorole, whether the bot can give it and why not.
// Nothing is saved or changed.

import { DatabaseSync } from "node:sqlite";
import { PermissionFlagsBits } from "discord.js";
import { MODERATOR_PERMISSIONS } from "../src/permissions/moderatorPermissions.js";
import { DEFAULT_DATABASE_FILE } from "../src/storage/database.js";

const API = "https://discord.com/api/v10";
const KEYS = { autoroleIds: "members", botAutoroleIds: "bots" };
// Application flags (Developer Portal > Bot > Privileged Gateway Intents).
const MEMBERS_INTENT = (1 << 14) | (1 << 15);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN isn't set. Run this from the bot's folder (npm run reads .env).");
  process.exit(1);
}

async function discord(path) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status} ${await response.text().catch(() => "")}`.trim());
  }
  return response.json();
}

const permissionNames = (bits) =>
  Object.entries(PermissionFlagsBits)
    .filter(([, bit]) => (bits & bit) === bit && MODERATOR_PERMISSIONS.includes(bit))
    .map(([name]) => name);

// discord.js orders roles by position, then by ID (older first) on ties.
const above = (a, b) => (a.position === b.position ? BigInt(a.id) < BigInt(b.id) : a.position > b.position);

const db = new DatabaseSync(DEFAULT_DATABASE_FILE, { readOnly: true });
const wanted = process.argv[2]?.trim();
const rows = db
  .prepare("SELECT guild_id, key, value FROM guild_settings WHERE key IN ('autoroleIds', 'botAutoroleIds')")
  .all()
  .filter((row) => !wanted || row.guild_id === wanted);
db.close();

const app = await discord("/applications/@me");
const hasMembersIntent = (app.flags & MEMBERS_INTENT) !== 0;
console.log(`Bot: ${app.name} (${app.id})`);
console.log(`Server Members Intent: ${hasMembersIntent ? "on" : "OFF. Without it Discord never tells the bot someone joined, so no autoroles at all. Turn it on in the Developer Portal > Bot, then pm2 restart rv-bot."}`);

if (rows.length === 0) {
  console.log(wanted ? `\nNo autoroles saved for server ${wanted}. Save them on the dashboard's Roles & panels page or with /welcome autorole.` : "\nNo server has autoroles saved.");
  process.exit(0);
}

const byGuild = Map.groupBy(rows, (row) => row.guild_id);
for (const [guildId, guildRows] of byGuild) {
  console.log(`\n=== Server ${guildId}`);
  let guild;
  let me;
  try {
    guild = await discord(`/guilds/${guildId}`);
    me = await discord(`/guilds/${guildId}/members/${app.id}`);
  } catch (error) {
    console.log(`  Couldn't read the server: ${error.message}`);
    continue;
  }
  console.log(`  Name: ${guild.name}`);
  const roles = new Map(guild.roles.map((role) => [role.id, { ...role, permissions: BigInt(role.permissions) }]));
  const myRoles = [roles.get(guildId), ...me.roles.map((id) => roles.get(id))].filter(Boolean);
  const myPermissions = myRoles.reduce((bits, role) => bits | role.permissions, 0n);
  const isAdmin = (myPermissions & PermissionFlagsBits.Administrator) !== 0n;
  const canManageRoles = isAdmin || (myPermissions & PermissionFlagsBits.ManageRoles) !== 0n;
  const highest = myRoles.filter((role) => role.id !== guildId).reduce((top, role) => (!top || above(role, top) ? role : top), null);
  console.log(`  Bot's highest role: ${highest ? `${highest.name} (position ${highest.position})` : "none (only @everyone)"}`);
  console.log(`  Manage Roles: ${canManageRoles ? "yes" : "NO. Give the bot's role Manage Roles."}`);

  const screening = guild.features.includes("MEMBER_VERIFICATION_GATE_ENABLED");
  let onboarding = null;
  try {
    onboarding = await discord(`/guilds/${guildId}/onboarding`);
  } catch {
    // Not a Community server, or no access.
  }
  console.log(`  Rules screening: ${screening ? "on (autoroles wait until a member accepts the rules)" : "off"}`);
  console.log(`  Onboarding: ${onboarding?.enabled ? `on, ${onboarding.default_channel_ids?.length ?? 0} default channels` : "off"}`);

  for (const row of guildRows) {
    let ids;
    try {
      ids = JSON.parse(row.value);
    } catch {
      console.log(`  ${row.key}: saved value isn't valid JSON: ${row.value}`);
      continue;
    }
    console.log(`  Autoroles for ${KEYS[row.key]}:`);
    for (const id of Array.isArray(ids) ? ids : []) {
      const role = roles.get(id);
      const problems = [];
      if (!role) {
        problems.push("the role no longer exists");
      } else {
        if (role.managed) {
          problems.push("it's a bot or integration role");
        }
        const modPermissions = permissionNames(role.permissions);
        if (modPermissions.length > 0) {
          problems.push(`it has moderator permissions (${modPermissions.join(", ")}), which the bot never hands out`);
        }
        if (!highest || !above(highest, role)) {
          problems.push("it's at or above the bot's highest role");
        }
      }
      if (!canManageRoles) {
        problems.push("the bot has no Manage Roles");
      }
      const name = role ? `${role.name} (${id}, position ${role.position})` : id;
      console.log(`    ${problems.length === 0 ? "OK  " : "NO  "} ${name}${problems.length > 0 ? `: ${problems.join("; ")}` : ""}`);
    }
  }
}
