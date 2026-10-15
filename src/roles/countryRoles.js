// Gives members the role for their country, and lets staff change or remove it.
//
// A member picks their country once with /country:
//   1. If they already have a country role, stop. Only staff can change it.
//   2. Find the server's role for the country, or create it.
//   3. Check the bot is allowed to hand that role out.
//   4. Add the role to the member who ran the command (and nobody else).
//
// Staff can then set a member's country (replacing any country role they have)
// or remove it.
//
// A "country role" is any role named after a country in the country list.
//
// This file doesn't use discord.js directly. It works with two small objects,
// a "server" and a "member" (see discordAdapters.js), so the tests can use
// fake ones instead of a real Discord server.

import { countryList, normalizeName } from "../countries/countries.js";
import { getDiscordErrorCode, isPermissionError, isRoleLimitError } from "../utils/discordErrors.js";
import { KeyedLock } from "../utils/keyedLock.js";

// Every possible result. The values double as keys in the language files.
export const Outcome = Object.freeze({
  ASSIGNED: "assigned",
  ALREADY_ASSIGNED: "alreadyAssigned",
  LOCKED: "countryLocked",
  REMOVED: "removed",
  NOTHING_TO_REMOVE: "nothingToRemove",
  MISSING_PERMISSIONS: "missingPermissions",
  HIERARCHY: "hierarchy",
  ROLE_LIMIT: "roleLimit",
  CREATED_BUT_NOT_ASSIGNED: "createdButNotAssigned",
  ASSIGN_FAILED: "assignFailed",
  REMOVE_FAILED: "removeFailed",
  UNEXPECTED: "unexpected",
});

const CREATE_REASON = "Country role created by /country";
const ASSIGN_REASON = "Country role selected with /country";
const STAFF_REASON = "Country role changed by staff";

export class CountryRoleService {
  #logger;
  #countryNames;
  #lock = new KeyedLock();

  constructor(logger, countries = countryList) {
    this.#logger = logger;
    this.#countryNames = new Set(countries.countries.map((country) => normalizeName(country.name)));
  }

  // /country: gives a member their first country role. Returns { outcome, role?, created? }.
  async giveCountryRole(server, member, country) {
    const details = { guildId: server.guildId, userId: member.userId, country: country.name };

    // One change per member at a time, so two quick /country commands can't
    // both see "no country yet" and give two roles.
    return this.#lock.run(memberKey(server, member), async () => {
      // 1. Already has a country?
      const heldRoles = this.heldCountryRoles(server, member);
      const sameCountry = heldRoles.find((role) => normalizeName(role.name) === normalizeName(country.name));
      if (sameCountry) {
        return { outcome: Outcome.ALREADY_ASSIGNED, role: sameCountry };
      }
      if (heldRoles.length > 0) {
        return { outcome: Outcome.LOCKED, role: heldRoles[0] };
      }

      const target = await this.#prepareRole(server, country, details);
      if (target.outcome) {
        return target;
      }

      // 4. Give it to the member.
      return this.#assignRole(member, target.role, target.created, ASSIGN_REASON, details);
    });
  }

  // Staff: makes `country` the member's only country role, removing any others.
  // Returns { outcome, role?, created?, removed? }.
  async setCountryRole(server, member, country, staffUserId) {
    const details = { guildId: server.guildId, userId: member.userId, staffUserId, country: country.name };

    return this.#lock.run(memberKey(server, member), async () => {
      const heldRoles = this.heldCountryRoles(server, member);
      const keep = heldRoles.find((role) => normalizeName(role.name) === normalizeName(country.name));
      const toRemove = heldRoles.filter((role) => role !== keep);
      if (keep && toRemove.length === 0) {
        return { outcome: Outcome.ALREADY_ASSIGNED, role: keep };
      }
      if (!server.botCanManageRoles()) {
        this.#logger.warn("The bot doesn't have the Manage Roles permission", details);
        return { outcome: Outcome.MISSING_PERMISSIONS };
      }

      let target = { role: keep, created: false };
      if (!keep) {
        target = await this.#prepareRole(server, country, details);
        if (target.outcome) {
          return target;
        }
      }

      // Check every old role up front, so we don't add the new one and then get
      // stuck unable to remove the old ones.
      const blocked = this.#roleAboveBot(server, toRemove, details);
      if (blocked) {
        return { outcome: Outcome.HIERARCHY, role: blocked };
      }

      if (!keep) {
        const assigned = await this.#assignRole(member, target.role, target.created, STAFF_REASON, details);
        if (assigned.outcome !== Outcome.ASSIGNED) {
          return assigned;
        }
      }

      const removed = await this.#removeRoles(member, toRemove, details);
      if (removed.outcome) {
        return removed;
      }
      return { outcome: Outcome.ASSIGNED, role: target.role, created: target.created, removed: toRemove };
    });
  }

  // Staff: removes every country role from the member. Returns { outcome, role?, removed? }.
  async removeCountryRoles(server, member, staffUserId) {
    const details = { guildId: server.guildId, userId: member.userId, staffUserId };

    return this.#lock.run(memberKey(server, member), async () => {
      const heldRoles = this.heldCountryRoles(server, member);
      if (heldRoles.length === 0) {
        return { outcome: Outcome.NOTHING_TO_REMOVE };
      }
      if (!server.botCanManageRoles()) {
        this.#logger.warn("The bot doesn't have the Manage Roles permission", details);
        return { outcome: Outcome.MISSING_PERMISSIONS };
      }
      const blocked = this.#roleAboveBot(server, heldRoles, details);
      if (blocked) {
        return { outcome: Outcome.HIERARCHY, role: blocked };
      }

      const removed = await this.#removeRoles(member, heldRoles, details);
      if (removed.outcome) {
        return removed;
      }
      return { outcome: Outcome.REMOVED, role: heldRoles[0], removed: heldRoles };
    });
  }

  // The country roles this member has, oldest first.
  heldCountryRoles(server, member) {
    return server
      .listRoles()
      .filter((role) => !role.managed && member.hasRole(role.id) && this.#countryNames.has(normalizeName(role.name)))
      .sort(oldestFirst);
  }

  // Roles whose name matches the country, ignoring case and spacing, oldest
  // first. Roles owned by integrations or bots ("managed") are skipped.
  findCountryRoles(server, country) {
    const wanted = normalizeName(country.name);
    return server
      .listRoles()
      .filter((role) => !role.managed && normalizeName(role.name) === wanted)
      .sort(oldestFirst);
  }

  // Steps 2 and 3: finds or creates the country's role and checks the bot can
  // hand it out. Returns { role, created } or { outcome } on failure.
  async #prepareRole(server, country, details) {
    if (!server.botCanManageRoles()) {
      this.#logger.warn("The bot doesn't have the Manage Roles permission", details);
      return { outcome: Outcome.MISSING_PERMISSIONS };
    }

    // Done one at a time per country so two simultaneous requests can't both create it.
    const lockKey = `${server.guildId}:${country.code}`;
    const found = await this.#lock.run(lockKey, () => this.#findOrCreateRole(server, country, details));
    if (found.outcome) {
      return found; // creating the role failed
    }

    // Discord only lets the bot hand out roles below its own highest role.
    const blocked = this.#roleAboveBot(server, [found.role], details);
    if (blocked) {
      return { outcome: Outcome.HIERARCHY, role: blocked };
    }
    return found;
  }

  // The first of `roles` the bot can't manage because it isn't below the bot's highest role.
  #roleAboveBot(server, roles, details) {
    const botPosition = server.botHighestRolePosition();
    const blocked = roles.find((role) => role.position >= botPosition);
    if (blocked) {
      this.#logger.warn("The country role is above the bot's highest role", {
        ...details,
        roleId: blocked.id,
        rolePosition: blocked.position,
        botRolePosition: botPosition,
      });
    }
    return blocked;
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

  async #assignRole(member, role, created, reason, details) {
    if (member.hasRole(role.id)) {
      return { outcome: Outcome.ALREADY_ASSIGNED, role };
    }

    try {
      await member.addRole(role.id, reason);
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

  // Returns {} when every role was removed, or { outcome, role } for the first failure.
  async #removeRoles(member, roles, details) {
    for (const role of roles) {
      try {
        await member.removeRole(role.id, STAFF_REASON);
      } catch (error) {
        this.#logger.error("Couldn't remove the country role", {
          ...details,
          roleId: role.id,
          discordErrorCode: getDiscordErrorCode(error),
          error,
        });
        if (isPermissionError(error)) return { outcome: Outcome.MISSING_PERMISSIONS, role };
        return { outcome: Outcome.REMOVE_FAILED, role };
      }
      this.#logger.info("Removed country role", { ...details, roleId: role.id });
    }
    return {};
  }
}

function memberKey(server, member) {
  return `${server.guildId}:member:${member.userId}`;
}

// Older roles have smaller IDs.
function oldestFirst(a, b) {
  return BigInt(a.id) < BigInt(b.id) ? -1 : 1;
}
