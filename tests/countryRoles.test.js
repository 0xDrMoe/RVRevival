import { RESTJSONErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it } from "vitest";
import { countryList } from "../src/countries/countries.js";
import { CountryRoleService, Outcome } from "../src/roles/countryRoles.js";
import { FakeServer, discordError, fakeLogger } from "./helpers/fakes.js";

const canada = countryList.find("Canada");
const japan = countryList.find("Japan");
const ALICE = "300000000000000001";
const BOB = "300000000000000002";

describe("CountryRoleService", () => {
  let server;
  let logger;
  let service;

  beforeEach(() => {
    server = new FakeServer();
    logger = fakeLogger();
    service = new CountryRoleService(logger);
  });

  describe("finding and creating roles", () => {
    it("reuses an existing role regardless of case and spacing", async () => {
      const existing = server.addRole("  CANADA ");
      const alice = server.member(ALICE);

      const result = await service.giveCountryRole(server, alice, canada);

      expect(result).toEqual({ outcome: Outcome.ASSIGNED, role: existing, created: false });
      expect(server.createRole).not.toHaveBeenCalled();
      expect(alice.addRole).toHaveBeenCalledWith(existing.id, expect.any(String));
    });

    it("creates a missing role with the official name and assigns it", async () => {
      server.addRole("Moderator");
      const alice = server.member(ALICE);

      const result = await service.giveCountryRole(server, alice, canada);

      expect(server.createRole).toHaveBeenCalledOnce();
      expect(server.createRole).toHaveBeenCalledWith("Canada", expect.any(String));
      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED, created: true, role: { name: "Canada" } });
      expect(alice.addRole).toHaveBeenCalledWith(result.role.id, expect.any(String));
      expect(server.roles.filter((role) => role.name === "Canada")).toHaveLength(1);
    });

    it("uses the oldest role and warns when several roles match, without creating another", async () => {
      const oldest = server.addRole("Canada");
      server.addRole("canada");

      const result = await service.giveCountryRole(server, server.member(ALICE), canada);

      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED, role: oldest, created: false });
      expect(server.createRole).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Several roles"), expect.any(Object));
    });

    it("ignores roles owned by integrations", async () => {
      server.addRole("Canada", { managed: true });
      const result = await service.giveCountryRole(server, server.member(ALICE), canada);
      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED, created: true });
    });
  });

  describe("members who already have the role", () => {
    it("says so without calling Discord", async () => {
      const role = server.addRole("Canada");
      const alice = server.member(ALICE, [role.id]);

      const result = await service.giveCountryRole(server, alice, canada);

      expect(result).toEqual({ outcome: Outcome.ALREADY_ASSIGNED, role });
      expect(alice.addRole).not.toHaveBeenCalled();
      expect(server.createRole).not.toHaveBeenCalled();
    });

    it("counts any of several duplicate roles", async () => {
      server.addRole("Canada");
      const second = server.addRole("CANADA");
      const result = await service.giveCountryRole(server, server.member(ALICE, [second.id]), canada);
      expect(result).toEqual({ outcome: Outcome.ALREADY_ASSIGNED, role: second });
    });
  });

  describe("one country per member", () => {
    it("refuses a second country and names the one they have", async () => {
      const japanRole = server.addRole("Japan");
      const alice = server.member(ALICE, [japanRole.id]);

      const result = await service.giveCountryRole(server, alice, canada);

      expect(result).toEqual({ outcome: Outcome.LOCKED, role: japanRole });
      expect(alice.addRole).not.toHaveBeenCalled();
      expect(server.createRole).not.toHaveBeenCalled();
    });

    it("ignores roles that aren't countries", async () => {
      const moderator = server.addRole("Moderator");
      const result = await service.giveCountryRole(server, server.member(ALICE, [moderator.id]), canada);
      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED });
    });

    it("counts a country role however its name is written", async () => {
      const japanRole = server.addRole("  JAPAN ");
      const result = await service.giveCountryRole(server, server.member(ALICE, [japanRole.id]), canada);
      expect(result).toEqual({ outcome: Outcome.LOCKED, role: japanRole });
    });

    it("gives only one country when a member picks two at the same moment", async () => {
      server.createDelayMs = 10;
      const results = await Promise.all([
        service.giveCountryRole(server, server.member(ALICE), canada),
        service.giveCountryRole(server, server.member(ALICE), japan),
      ]);

      expect(results.map((result) => result.outcome)).toEqual([Outcome.ASSIGNED, Outcome.LOCKED]);
      expect(server.rolesByUser.get(ALICE).size).toBe(1);
    });
  });

  describe("staff changes", () => {
    const STAFF = "300000000000000009";

    it("replaces a member's country with another one", async () => {
      const japanRole = server.addRole("Japan");
      const alice = server.member(ALICE, [japanRole.id]);

      const result = await service.setCountryRole(server, alice, canada, STAFF);

      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED, role: { name: "Canada" }, removed: [japanRole] });
      expect([...server.rolesByUser.get(ALICE)]).toEqual([result.role.id]);
    });

    it("cleans up members who picked several countries before the lock existed", async () => {
      const japanRole = server.addRole("Japan");
      const canadaRole = server.addRole("Canada");
      const alice = server.member(ALICE, [japanRole.id, canadaRole.id]);

      const result = await service.setCountryRole(server, alice, canada, STAFF);

      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED, role: canadaRole, removed: [japanRole] });
      expect(alice.addRole).not.toHaveBeenCalled();
      expect([...server.rolesByUser.get(ALICE)]).toEqual([canadaRole.id]);
    });

    it("says when the member already has exactly that country", async () => {
      const canadaRole = server.addRole("Canada");
      const result = await service.setCountryRole(server, server.member(ALICE, [canadaRole.id]), canada, STAFF);
      expect(result).toEqual({ outcome: Outcome.ALREADY_ASSIGNED, role: canadaRole });
    });

    it("changes nothing when an old country role is above the bot", async () => {
      const japanRole = server.addRole("Japan", { position: 60 });
      const alice = server.member(ALICE, [japanRole.id]);

      const result = await service.setCountryRole(server, alice, canada, STAFF);

      expect(result).toEqual({ outcome: Outcome.HIERARCHY, role: japanRole });
      expect(alice.addRole).not.toHaveBeenCalled();
      expect(alice.removeRole).not.toHaveBeenCalled();
    });

    it("reports a failed removal", async () => {
      const japanRole = server.addRole("Japan");
      const alice = server.member(ALICE, [japanRole.id]);
      alice.removeRole.mockRejectedValueOnce(new Error("timeout"));

      const result = await service.setCountryRole(server, alice, canada, STAFF);
      expect(result).toEqual({ outcome: Outcome.REMOVE_FAILED, role: japanRole });
    });

    it("removes every country role and leaves other roles alone", async () => {
      const japanRole = server.addRole("Japan");
      const canadaRole = server.addRole("Canada");
      const moderator = server.addRole("Moderator");
      const alice = server.member(ALICE, [japanRole.id, canadaRole.id, moderator.id]);

      const result = await service.removeCountryRoles(server, alice, STAFF);

      expect(result).toEqual({ outcome: Outcome.REMOVED, role: japanRole, removed: [japanRole, canadaRole] });
      expect([...server.rolesByUser.get(ALICE)]).toEqual([moderator.id]);
    });

    it("says when there is nothing to remove", async () => {
      const result = await service.removeCountryRoles(server, server.member(ALICE), STAFF);
      expect(result).toEqual({ outcome: Outcome.NOTHING_TO_REMOVE });
    });

    it("lets the member pick again after staff remove their country", async () => {
      const japanRole = server.addRole("Japan");
      await service.removeCountryRoles(server, server.member(ALICE, [japanRole.id]), STAFF);
      const result = await service.giveCountryRole(server, server.member(ALICE), canada);
      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED });
    });
  });

  describe("safety", () => {
    it("only changes the member who ran the command, and never removes roles", async () => {
      const japanRole = server.addRole("Japan");
      const moderator = server.addRole("Moderator");
      const alice = server.member(ALICE, [moderator.id]);
      const bob = server.member(BOB, [japanRole.id]);

      await service.giveCountryRole(server, alice, canada);

      expect(bob.addRole).not.toHaveBeenCalled();
      expect([...server.rolesByUser.get(BOB)]).toEqual([japanRole.id]);
      const aliceRoles = server.rolesByUser.get(ALICE);
      expect(aliceRoles.has(moderator.id)).toBe(true);
      expect(aliceRoles.size).toBe(2);
      expect(alice.removeRole).not.toHaveBeenCalled();
    });

    it("stops early when the bot lacks Manage Roles", async () => {
      server.canManageRoles = false;
      const alice = server.member(ALICE);

      const result = await service.giveCountryRole(server, alice, canada);

      expect(result).toEqual({ outcome: Outcome.MISSING_PERMISSIONS });
      expect(server.createRole).not.toHaveBeenCalled();
      expect(alice.addRole).not.toHaveBeenCalled();
    });

    it("won't assign a role at or above the bot's highest role", async () => {
      const role = server.addRole("Canada", { position: 50 });
      const alice = server.member(ALICE);

      const result = await service.giveCountryRole(server, alice, canada);

      expect(result).toEqual({ outcome: Outcome.HIERARCHY, role });
      expect(alice.addRole).not.toHaveBeenCalled();
    });
  });

  describe("Discord failures", () => {
    it.each([
      [RESTJSONErrorCodes.MissingPermissions, Outcome.MISSING_PERMISSIONS],
      [RESTJSONErrorCodes.MaximumNumberOfGuildRolesReached, Outcome.ROLE_LIMIT],
      [undefined, Outcome.UNEXPECTED],
    ])("maps a role-creation failure with code %s to %s", async (code, outcome) => {
      server.createRole.mockRejectedValueOnce(code ? discordError(code) : new Error("socket hang up"));
      const alice = server.member(ALICE);

      expect(await service.giveCountryRole(server, alice, canada)).toEqual({ outcome });
      expect(alice.addRole).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith("Couldn't create the country role", expect.any(Object));
    });

    it("reports when the role was created but couldn't be assigned, with details in the log", async () => {
      const alice = server.member(ALICE);
      alice.addRole.mockRejectedValueOnce(discordError(RESTJSONErrorCodes.MissingPermissions));

      const result = await service.giveCountryRole(server, alice, canada);

      expect(result).toMatchObject({ outcome: Outcome.CREATED_BUT_NOT_ASSIGNED, created: true });
      expect(logger.error).toHaveBeenCalledWith(
        "Couldn't assign the country role",
        expect.objectContaining({
          guildId: server.guildId,
          userId: ALICE,
          roleCreated: true,
          discordErrorCode: RESTJSONErrorCodes.MissingPermissions,
        }),
      );
    });

    it.each([
      [discordError(RESTJSONErrorCodes.MissingPermissions), Outcome.MISSING_PERMISSIONS],
      [new Error("timeout"), Outcome.ASSIGN_FAILED],
    ])("maps an assignment failure on an existing role (%s) to %s", async (error, outcome) => {
      server.addRole("Canada");
      const alice = server.member(ALICE);
      alice.addRole.mockRejectedValueOnce(error);

      const result = await service.giveCountryRole(server, alice, canada);
      expect(result).toMatchObject({ outcome, created: false });
    });

    it("can retry after a failed creation", async () => {
      server.createRole.mockRejectedValueOnce(new Error("temporary"));
      await service.giveCountryRole(server, server.member(ALICE), canada);
      const result = await service.giveCountryRole(server, server.member(ALICE), canada);
      expect(result).toMatchObject({ outcome: Outcome.ASSIGNED, created: true });
    });
  });

  describe("simultaneous requests", () => {
    it("creates only one role when several people pick the same new country at once", async () => {
      server.createDelayMs = 20;
      const members = [ALICE, BOB, "300000000000000003", "300000000000000004"].map((id) => server.member(id));

      const results = await Promise.all(members.map((member) => service.giveCountryRole(server, member, canada)));

      expect(server.createRole).toHaveBeenCalledOnce();
      expect(server.roles.filter((role) => role.name === "Canada")).toHaveLength(1);
      expect(new Set(results.map((result) => result.role.id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      for (const member of members) {
        expect(member.addRole).toHaveBeenCalledOnce();
      }
    });

    it("doesn't make different countries wait for each other", async () => {
      server.createDelayMs = 10;
      await Promise.all([
        service.giveCountryRole(server, server.member(ALICE), canada),
        service.giveCountryRole(server, server.member(BOB), japan),
      ]);
      expect(server.roles.map((role) => role.name).sort()).toEqual(["Canada", "Japan"]);
    });
  });
});
