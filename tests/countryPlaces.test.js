// Countries or regions, hidden places and members removing their own role
// (countries/options.js and the commands and buttons that follow it).

import { MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryCommand } from "../src/commands/country.js";
import { buildPostedRows, guideText } from "../src/commands/countryHelp.js";
import { PickerId, buildGuideRows } from "../src/commands/countryPicker.js";
import { createCountryStaffCommand } from "../src/commands/countryStaff.js";
import { CONTINENTS, continentOf } from "../src/countries/continents.js";
import { countryList } from "../src/countries/countries.js";
import {
  checkCountryOptions,
  describeCountryOptions,
  InvalidCountryOptions,
  normalizeCountryOptions,
  placesFor,
  regionList,
} from "../src/countries/options.js";
import { SUPPORTED_LANGUAGES, translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { CountryRoleService } from "../src/roles/countryRoles.js";
import { ConfirmId, createRoleConfirmations, RoleConfirmStore } from "../src/roles/roleConfirmations.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { FakeServer, fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const USER_ID = "300000000000000001";
const STAFF_ROLE = "700000000000000001";

const idsOf = (rows) => rows.flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
const lastEdit = (interaction) => interaction.editReply.mock.calls.at(-1)[0];

function fakeInteraction(customId, overrides = {}) {
  return {
    customId,
    locale: "en-US",
    guildId: GUILD_ID,
    channelId: "800000000000000001",
    guild: {},
    member: {},
    user: { id: USER_ID },
    inCachedGuild: () => true,
    reply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("country options", () => {
  it("defaults to every country, with only staff removing roles", () => {
    expect(normalizeCountryOptions(undefined)).toEqual({ mode: "countries", hidden: [], memberRemove: false });
    expect(placesFor(undefined)).toBe(countryList);
    expect(placesFor({ mode: "regions" })).toBe(regionList);
  });

  it("lists the six regions under their English names, and finds them in every language", () => {
    expect(regionList.countries.map((region) => region.code).sort()).toEqual([...CONTINENTS].sort());
    expect(regionList.find("north america")).toMatchObject({ code: "north-america", name: "North America", kind: "region" });
    for (const language of SUPPORTED_LANGUAGES) {
      expect(regionList.find(translate(language, "continentEurope"))?.code).toBe("europe");
    }
  });

  it("saves only what differs from the defaults", () => {
    expect(checkCountryOptions({ mode: "countries", hidden: [], memberRemove: false })).toBeNull();
    expect(checkCountryOptions({ hidden: ["US", "CA", "US"] })).toEqual({ hidden: ["CA", "US"] });
    expect(checkCountryOptions({ mode: "regions", memberRemove: true })).toEqual({ mode: "regions", memberRemove: true });
  });

  it("refuses unknown parts, modes and places, and an empty list", () => {
    expect(() => checkCountryOptions([])).toThrow(InvalidCountryOptions);
    expect(() => checkCountryOptions({ colour: 1 })).toThrow(InvalidCountryOptions);
    expect(() => checkCountryOptions({ mode: "planets" })).toThrow(InvalidCountryOptions);
    expect(() => checkCountryOptions({ hidden: ["XX"] })).toThrow(InvalidCountryOptions);
    expect(() => checkCountryOptions({ hidden: [1] })).toThrow(InvalidCountryOptions);
    expect(() => checkCountryOptions({ memberRemove: "yes" })).toThrow(InvalidCountryOptions);
    expect(() => checkCountryOptions({ mode: "regions", hidden: [...CONTINENTS] })).toThrow(/at least one region/);
    expect(() => checkCountryOptions({ hidden: countryList.countries.map((country) => country.code) })).toThrow(/at least one country/);
  });

  it("takes hidden places off the list, and keeps each mode's hidden places apart", () => {
    const options = { hidden: ["US", "europe"] };
    expect(placesFor(options).find("United States")).toBeNull();
    expect(placesFor(options).find("Canada")?.code).toBe("CA");
    // "europe" only matters when members pick regions.
    expect(placesFor(options).find("Germany")?.code).toBe("DE");
    expect(placesFor({ ...options, mode: "regions" }).find("Europe")).toBeNull();
    expect(placesFor(options)).toBe(placesFor({ hidden: ["europe", "US"] }));
  });

  it("describes the options for the logs channel", () => {
    expect(describeCountryOptions(undefined)).toBe("countries · none hidden · only staff remove roles");
    expect(describeCountryOptions({ mode: "regions", hidden: ["asia"], memberRemove: true })).toBe(
      "continents and regions · 1 hidden · members can remove their role",
    );
  });
});

describe("guide buttons", () => {
  it("keep the usual buttons by default", () => {
    expect(idsOf(buildGuideRows("en"))).toEqual([...CONTINENTS.map((continent) => PickerId.CONTINENT + continent), PickerId.BUTTON]);
  });

  it("show regions without Type my country, and Remove when members may", () => {
    const rows = buildPostedRows("en", { mode: "regions", hidden: ["oceania"], memberRemove: true });
    expect(idsOf(rows)).toEqual([
      ...CONTINENTS.filter((continent) => continent !== "oceania").map((continent) => PickerId.CONTINENT + continent),
      PickerId.REMOVE,
      "country-guide:translate",
    ]);
    expect(rows.flatMap((row) => row.toJSON().components).find((button) => button.custom_id === PickerId.REMOVE).label).toBe("Remove my region");
  });

  it("leave out a continent when every country in it is hidden", () => {
    const oceania = countryList.countries.filter((country) => continentOf(country.code) === "oceania").map((country) => country.code);
    expect(idsOf(buildGuideRows("en", { hidden: oceania }))).not.toContain(`${PickerId.CONTINENT}oceania`);
  });

  it("fit Discord's limits in every language and mode", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const mode of ["countries", "regions"]) {
        const rows = buildPostedRows(language, { mode, memberRemove: true });
        expect(rows.length).toBeLessThanOrEqual(5);
        for (const row of rows.map((entry) => entry.toJSON())) {
          expect(row.components.length).toBeLessThanOrEqual(5);
          row.components.forEach((button) => expect(button.label.length).toBeLessThanOrEqual(80));
        }
      }
    }
  });

  it("use the region wording and the remove note in the guide text", () => {
    const text = guideText("en", { places: { mode: "regions", memberRemove: true } });
    expect(text.title).toBe(translate("en", "helpRegionTitle"));
    expect(text.notes).toContain(translate("en", "helpRemoveRegionNote"));
    expect(guideText("en").notes).not.toContain(translate("en", "helpRemoveNote"));
  });
});

describe("picking with server options", () => {
  let server;
  let guildSettings;
  let command;
  let confirmOn;

  beforeEach(() => {
    server = new FakeServer();
    guildSettings = new GuildSettings();
    confirmOn = false;
    const logger = fakeLogger();
    command = createCountryCommand({
      logger,
      guildSettings,
      roleService: new CountryRoleService(logger),
      wrapServer: () => server,
      wrapMember: () => server.member(USER_ID),
      confirmations: { ...createRoleConfirmations({ guildSettings, store: new RoleConfirmStore() }), isOn: () => confirmOn },
    });
  });

  const run = (interaction) => {
    const component =
      command.components[interaction.customId] ??
      Object.entries(command.componentPrefixes).find(([prefix]) => interaction.customId.startsWith(prefix))[1];
    return component.handle(interaction);
  };
  const slash = (typed) =>
    fakeInteraction(undefined, { commandName: "country", channel: { parentId: null }, options: { getString: () => typed } });
  const memberRoles = () => [...server.rolesByUser.get(USER_ID)].map((id) => server.roles.find((role) => role.id === id).name);

  it("gives a region's role straight from its button", async () => {
    guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { mode: "regions" });
    const click = fakeInteraction(`${PickerId.CONTINENT}north-america`);
    const outcome = await run(click);
    expect(click.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(lastEdit(click).content).toBe(translate("en", "regionAssigned", { country: "North America" }));
    expect(outcome.status).toBe(Status.SUCCESS);
    expect(memberRoles()).toEqual(["North America"]);

    // One region only.
    const again = fakeInteraction(`${PickerId.CONTINENT}europe`);
    expect((await run(again)).status).toBe(Status.REFUSED);
    expect(again.reply.mock.calls[0][0].content).toBe(translate("en", "regionLocked", { country: "North America" }));
  });

  it("asks before giving a region when confirmations are on", async () => {
    guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { mode: "regions" });
    confirmOn = true;
    const click = fakeInteraction(`${PickerId.CONTINENT}europe`);
    expect(await run(click)).toBeNull();
    expect(lastEdit(click).content).toBe(translate("en", "roleConfirmRegion", { country: "Europe" }));
    const confirm = fakeInteraction(`${PickerId.CONFIRM}europe`);
    expect((await run(confirm)).status).toBe(Status.SUCCESS);
    expect(memberRoles()).toEqual(["Europe"]);
  });

  it("doesn't count a region role as a country, or the other way round", async () => {
    const europe = server.addRole("Europe");
    server.member(USER_ID, [europe.id]);
    const click = fakeInteraction(`${PickerId.CONTINENT}europe`);
    expect(await run(click)).toBeNull();
    expect(click.reply.mock.calls[0][0].content).toContain("Europe");
  });

  it("leaves hidden countries out of lists and refuses them however they're picked", async () => {
    guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { hidden: ["DE"] });
    const click = fakeInteraction(`${PickerId.CONTINENT}europe`);
    await run(click);
    const listed = click.reply.mock.calls[0][0].components.flatMap((row) => row.toJSON().components[0].options.map((option) => option.label));
    expect(listed).toContain("France");
    expect(listed).not.toContain("Germany");

    const typed = fakeInteraction(PickerId.FORM, { fields: { getTextInputValue: () => "Deutschland" } });
    expect((await run(typed)).status).toBe(Status.REFUSED);
    expect(lastEdit(typed).content).toBe(translate("en", "placeNotOffered", { country: "Germany" }));

    const confirm = fakeInteraction(`${PickerId.CONFIRM}DE`);
    expect((await run(confirm)).status).toBe(Status.REFUSED);

    const viaCommand = slash("Germany");
    expect((await command.execute(viaCommand)).status).toBe(Status.REFUSED);
    expect(lastEdit(viaCommand).content).toBe(translate("en", "placeNotOffered", { country: "Germany" }));
    expect(server.roles).toEqual([]);
  });

  it("offers regions in /country and its suggestions", async () => {
    guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { mode: "regions" });
    const viaCommand = slash("Südamerika");
    expect((await command.execute(viaCommand)).status).toBe(Status.SUCCESS);
    expect(memberRoles()).toEqual(["South America"]);

    const wrong = slash("Germany");
    await command.execute(wrong);
    expect(lastEdit(wrong).content).toBe(translate("en", "invalidRegion"));

    const respond = vi.fn(async () => {});
    await command.autocomplete({ guildId: GUILD_ID, options: { getFocused: () => "" }, respond });
    expect(respond.mock.calls[0][0].map((choice) => choice.name)).toEqual(regionList.countries.map((region) => region.name));
  });

  describe("Remove my country", () => {
    it("is refused unless the server allows it", async () => {
      const remove = fakeInteraction(PickerId.REMOVE);
      expect((await run(remove)).status).toBe(Status.REFUSED);
      expect(lastEdit(remove).content).toBe(translate("en", "selfRemoveOff"));
    });

    it("removes the member's own country role so they can pick again", async () => {
      guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { memberRemove: true });
      await command.execute(slash("Canada"));
      expect(memberRoles()).toEqual(["Canada"]);

      // The "you already have it" reply offers the button.
      const locked = fakeInteraction(PickerId.BUTTON);
      await run(locked);
      const reply = locked.reply.mock.calls[0][0];
      expect(reply.content).toBe(translate("en", "placeLockedRemovable", { country: "Canada" }));
      expect(idsOf(reply.components)).toEqual([PickerId.REMOVE]);

      const remove = fakeInteraction(PickerId.REMOVE);
      const outcome = await run(remove);
      expect(remove.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(lastEdit(remove).content).toBe(translate("en", "selfRemoved", { country: "Canada" }));
      expect(outcome.status).toBe(Status.SUCCESS);
      expect(memberRoles()).toEqual([]);

      await command.execute(slash("Mexico"));
      expect(memberRoles()).toEqual(["Mexico"]);
    });

    it("asks first when confirmations are on, and changes the private reply in place", async () => {
      guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { memberRemove: true });
      await command.execute(slash("Canada"));
      confirmOn = true;

      const remove = fakeInteraction(PickerId.REMOVE, { message: { flags: { has: (flag) => flag === MessageFlags.Ephemeral } } });
      expect(await run(remove)).toBeNull();
      expect(remove.deferUpdate).toHaveBeenCalled();
      expect(lastEdit(remove).content).toBe(translate("en", "roleConfirmSelfRemove", { country: "Canada" }));
      expect(idsOf(lastEdit(remove).components)).toEqual([PickerId.REMOVE_CONFIRM, ConfirmId.CANCEL, ConfirmId.TURN_OFF]);
      expect(memberRoles()).toEqual(["Canada"]);

      const confirm = fakeInteraction(PickerId.REMOVE_CONFIRM);
      expect((await run(confirm)).status).toBe(Status.SUCCESS);
      expect(memberRoles()).toEqual([]);
    });

    it("says when there's nothing to remove", async () => {
      guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { memberRemove: true });
      const remove = fakeInteraction(PickerId.REMOVE);
      expect((await run(remove)).status).toBe(Status.REFUSED);
      expect(lastEdit(remove).content).toBe(translate("en", "selfNothingToRemove"));
    });
  });
});

describe("/country-staff with server options", () => {
  let server;
  let guildSettings;
  let command;

  beforeEach(() => {
    server = new FakeServer();
    guildSettings = new GuildSettings();
    guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, STAFF_ROLE);
    const logger = fakeLogger();
    command = createCountryStaffCommand({
      logger,
      guildSettings,
      roleService: new CountryRoleService(logger),
      wrapServer: () => server,
      wrapMember: () => server.member(USER_ID),
    });
  });

  const staffInteraction = (subcommand, typed) =>
    fakeInteraction(undefined, {
      user: { id: "300000000000000099" },
      member: { roles: { cache: new Map([[STAFF_ROLE, {}]]) } },
      options: {
        getSubcommand: () => subcommand,
        getMember: () => ({ id: USER_ID }),
        getString: () => typed,
      },
    });

  it("sets and removes region roles when the server picks regions", async () => {
    guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { mode: "regions" });
    expect((await command.execute(staffInteraction("set", "Asia"))).status).toBe(Status.SUCCESS);
    expect(server.roles.map((role) => role.name)).toEqual(["Asia"]);
    expect((await command.execute(staffInteraction("remove"))).status).toBe(Status.SUCCESS);
    expect(server.rolesByUser.get(USER_ID).size).toBe(0);
  });

  it("refuses a hidden country", async () => {
    guildSettings.set(GUILD_ID, Setting.COUNTRY_ROLES, { hidden: ["FR"] });
    const interaction = staffInteraction("set", "France");
    expect((await command.execute(interaction)).status).toBe(Status.REFUSED);
    expect(interaction.reply.mock.calls[0][0].content).toBe(translate("en", "placeNotOffered", { country: "France" }));
  });
});
