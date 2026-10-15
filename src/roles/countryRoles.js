// Gives a member the role for their country.
//
//   1. If they already have it, stop.
//   2. Find the server's role for the country, or create it.
//   3. Check the bot is allowed to hand that role out.
//   4. Add the role to the member who ran the command (and nobody else).
//
// This file doesn't use discord.js directly. It works with two small objects,
// a "server" and a "member" (see discordAdapters.js), so the tests can use
// fake ones instead of a real Discord server.

import { normalizeName } from "../countries/countries.js";
import { getDiscordErrorCode, isPermissionError, isRoleLimitError } from "../utils/discordErrors.js";
import { KeyedLock } from "../utils/keyedLock.js";

// Every possible result. The values double as keys in the language files.
export const Outcome = Object.freeze({
  ASSIGNED: "assigned",
  ALREADY_ASSIGNED: "alreadyAssigned",
  MISSING_PERMISSIONS: "missingPermissions",
  HIERARCHY: "hierarchy",
  ROLE_LIMIT: "roleLimit",
  CREATED_BUT_NOT_ASSIGNED: "createdButNotAssigned",
  ASSIGN_FAILED: "assignFailed",
  UNEXPECTED: "unexpected",
});

const CREATE_REASON = "Country role created by /country";
const ASSIGN_REASON = "Country role selected with /country";

export class CountryRoleService {
  #logger;
  #lock = new KeyedLock();

  constructor(logger) {
    this.#logger = logger;
  }

  // Returns { outcome, role?, created? }.
  async giveCountryRole(server, member, country) {
    const details = { guildId: server.guildId, userId: member.userId, country: country.name };

    // 1. Already has it?
    const heldRole = this.findCountryRoles(server, country).find((role) => member.hasRole(role.id));
    if (heldRole) {
      return { outcome: Outcome.ALREADY_ASSIGNED, role: heldRole };
    }

    if (!server.botCanManageRoles()) {
      this.#logger.warn("The bot doesn't have the Manage Roles permission", details);
      return { outcome: Outcome.MISSING_PERMISSIONS };
    }

    // 2. Find or create the role. Done one at a time per country so two
    //    simultaneous requests can't both create it.
    const lockKey = `${server.guildId}:${country.code}`;
    const found = await this.#lock.run(lockKey, () => this.#findOrCreateRole(server, country, details));
    if (found.outcome) {
      return found; // creating the role failed
    }
    const { role, created } = found;

    // 3. Discord only lets the bot hand out roles below its own highest role.
    if (role.position >= server.botHighestRolePosition()) {
      this.#logger.warn("The country role is above the bot's highest role", {
        ...details,
        roleId: role.id,
        rolePosition: role.position,
        botRolePosition: server.botHighestRolePosition(),
      });
      return { outcome: Outcome.HIERARCHY, role };
    }

    // 4. Give it to the member.
    return this.#assignRole(member, role, created, details);
  }

  // Roles whose name matches the country, ignoring case and spacing, oldest
  // first. Roles owned by integrations or bots ("managed") are skipped.
  findCountryRoles(server, country) {
    const wanted = normalizeName(country.name);
    return server
      .listRoles()
      .filter((role) => !role.managed && normalizeName(role.name) === wanted)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // older roles have smaller IDs
  }

  async #findOrCreateRole(server, country, details) {
    const existingRoles = this.findCountryRoles(server, country);

    if (existingRoles.length > 0) {
      if (existingRoles.length > 1) {
        this.#logger.warn("Several roles have this country's name; using the oldest. Consider deleting the others.", {
          ...details,
          roleIds: existingRoles.map((role) => role.id),
        });
      }
      return { role: existingRoles[0], created: false };
    }

    try {
      const role = await server.createRole(country.name, CREATE_REASON);
      this.#logger.info("Created country role", { ...details, roleId: role.id });
      return { role, created: true };
    } catch (error) {
      this.#logger.error("Couldn't create the country role", {
        ...details,
        discordErrorCode: getDiscordErrorCode(error),
        error,
      });
      if (isPermissionError(error)) return { outcome: Outcome.MISSING_PERMISSIONS };
      if (isRoleLimitError(error)) return { outcome: Outcome.ROLE_LIMIT };
      return { outcome: Outcome.UNEXPECTED };
    }
  }

  async #assignRole(member, role, created, details) {
    if (member.hasRole(role.id)) {
      return { outcome: Outcome.ALREADY_ASSIGNED, role };
    }

    try {
      await member.addRole(role.id, ASSIGN_REASON);
    } catch (error) {
      this.#logger.error("Couldn't assign the country role", {
        ...details,
        roleId: role.id,
        roleCreated: created,
        discordErrorCode: getDiscordErrorCode(error),
        error,
      });
      if (created) return { outcome: Outcome.CREATED_BUT_NOT_ASSIGNED, role, created };
      if (isPermissionError(error)) return { outcome: Outcome.MISSING_PERMISSIONS, role, created };
      return { outcome: Outcome.ASSIGN_FAILED, role, created };
    }

    this.#logger.info("Assigned country role", { ...details, roleId: role.id, roleCreated: created });
    return { outcome: Outcome.ASSIGNED, role, created };
  }
}
