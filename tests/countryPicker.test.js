import { ComponentType, MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryCommand } from "../src/commands/country.js";
import { MAX_CHOICES, PickerId, buildChoiceRows, buildGuideRows, buildPickForm } from "../src/commands/countryPicker.js";
import { CONTINENTS, continentOf } from "../src/countries/continents.js";
import { countryList } from "../src/countries/countries.js";
import { getTranslations, SUPPORTED_LANGUAGES, translate } from "../src/i18n/i18n.js";
import { Status } from "../src/logs/actionLog.js";
import { CountryRoleService } from "../src/roles/countryRoles.js";
import { FakeServer, fakeLogger } from "./helpers/fakes.js";

const USER_ID = "300000000000000001";
const LOG_LABEL = "Country picker buttons";

// Shared shape of a button click, form submit or menu choice by USER_ID.
function fakeInteraction(customId, overrides = {}) {
  return {
    customId,
    locale: "en-US",
    guildId: "900000000000000001",
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

const click = (overrides) => fakeInteraction(PickerId.BUTTON, overrides);
const submit = (typed, overrides) =>
  fakeInteraction(PickerId.FORM, { fields: { getTextInputValue: () => typed }, ...overrides });
const choose = (value, overrides) => fakeInteraction(`${PickerId.LIST}0`, { values: [value], ...overrides });
const pickContinent = (continent, overrides) => fakeInteraction(PickerId.CONTINENT + continent, overrides);

const lastEdit = (interaction) => interaction.editReply.mock.calls.at(-1)[0];
const componentsOf = (reply) => reply.components.flatMap((row) => row.toJSON().components);

describe("Pick my country button", () => {
  let server;
  let picker;

  beforeEach(() => {
    server = new FakeServer();
    const logger = fakeLogger();
    const command = createCountryCommand({
      logger,
      roleService: new CountryRoleService(logger),
      wrapServer: () => server,
      wrapMember: () => server.member(USER_ID),
    });
    picker = command.components;
  });

  const run = (interaction) => picker[interaction.customId].handle(interaction);

  it("handles every button and list it posts, with fixed IDs that survive restarts", () => {
    const posted = buildGuideRows("en").flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
    const lists = buildChoiceRows("en", countryList.countries.slice(0, 125)).map((row) => row.toJSON().components[0].custom_id);
    for (const id of [...posted, ...lists, PickerId.FORM]) {
      expect(picker).toHaveProperty([id]);
    }
  });

  describe("clicking a continent", () => {
    it("lists that continent's countries privately, 25 per list, A to Z", async () => {
      const interaction = pickContinent("africa");
      expect(await run(interaction)).toBeNull();

      const reply = interaction.reply.mock.calls[0][0];
      expect(reply.flags).toBe(MessageFlags.Ephemeral);
      expect(reply.content).toBe(translate("en", "pickContinentChoose", { continent: "Africa" }));
      const menus = componentsOf(reply);
      expect(menus.length).toBeGreaterThan(1);
      const names = menus.flatMap((menu) => menu.options.map((option) => option.value));
      const expected = countryList.countries.filter((c) => continentOf(c.code) === "africa").map((c) => c.name);
      expect(names).toEqual(expected);
      expect(names).toContain("Nigeria");
      for (const menu of menus) {
        expect(menu.options.length).toBeLessThanOrEqual(MAX_CHOICES);
        expect(menu.placeholder).toMatch(/^Countries [A-Z]–[A-Z]$/);
      }
      expect(new Set(menus.map((menu) => menu.custom_id)).size).toBe(menus.length);
    });

    it("uses one plain list for a short continent", async () => {
      const interaction = pickContinent("south-america");
      await run(interaction);
      const menus = componentsOf(interaction.reply.mock.calls[0][0]);
      expect(menus).toHaveLength(1);
      expect(menus[0].placeholder).toBe(translate("en", "pickListPlaceholder"));
    });

    it("tells members who already have a country right away", async () => {
      const role = server.addRole("Japan");
      server.member(USER_ID, [role.id]);
      const interaction = pickContinent("europe");
      const outcome = await run(interaction);
      expect(interaction.reply).toHaveBeenCalledWith({
        content: translate("en", "countryLocked", { country: "Japan" }),
        flags: MessageFlags.Ephemeral,
      });
      expect(outcome).toMatchObject({ status: Status.REFUSED, key: "countryLocked" });
    });
  });

  describe("clicking the button", () => {
    it("opens the form in the member's language without logging anything", async () => {
      const interaction = click({ locale: "fr" });
      expect(await run(interaction)).toBeNull();

      const form = interaction.showModal.mock.calls[0][0].toJSON();
      expect(form.custom_id).toBe(PickerId.FORM);
      expect(form.title).toBe(translate("fr", "pickFormTitle"));
      expect(form.components[0]).toMatchObject({
        type: ComponentType.Label,
        label: translate("fr", "pickFormLabel"),
        component: { type: ComponentType.TextInput, custom_id: PickerId.FORM_INPUT, required: true },
      });
    });

    it("tells members who already have a country right away, without opening the form", async () => {
      const role = server.addRole("Japan");
      server.member(USER_ID, [role.id]);
      const interaction = click();

      const outcome = await run(interaction);

      expect(interaction.showModal).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith({
        content: translate("en", "countryLocked", { country: "Japan" }),
        flags: MessageFlags.Ephemeral,
      });
      expect(outcome).toMatchObject({ status: Status.REFUSED, key: "countryLocked", action: { label: LOG_LABEL } });
    });

    it("refuses outside a server", async () => {
      const interaction = click({ inCachedGuild: () => false });
      const outcome = await run(interaction);
      expect(interaction.reply).toHaveBeenCalledWith({ content: translate("en", "guildOnly"), flags: MessageFlags.Ephemeral });
      expect(outcome.status).toBe(Status.REFUSED);
    });
  });

  describe("submitting the form", () => {
    it("gives the role straight away for an exact match", async () => {
      const interaction = submit("  usa ");
      const outcome = await run(interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(lastEdit(interaction)).toEqual({ content: translate("en", "assigned", { country: "United States" }) });
      expect(server.roles.map((role) => role.name)).toEqual(["United States"]);
      expect(outcome).toEqual({
        status: Status.SUCCESS,
        key: "assigned",
        values: { country: "United States" },
        action: { label: LOG_LABEL, fields: { typed: "  usa ", country: "United States" } },
      });
    });

    it("understands country names in the bot's other languages", async () => {
      await run(submit("Deutschland"));
      expect(server.roles.map((role) => role.name)).toEqual(["Germany"]);
    });

    it("shows a list of close matches instead of guessing", async () => {
      const interaction = submit("guin");
      expect(await run(interaction)).toBeNull();

      const reply = lastEdit(interaction);
      expect(reply.content).toBe(translate("en", "pickChoose"));
      const [menu] = componentsOf(reply);
      expect(menu.custom_id).toBe(`${PickerId.LIST}0`);
      expect(menu.options.map((option) => option.value)).toEqual(
        expect.arrayContaining(["Guinea", "Guinea-Bissau", "Equatorial Guinea", "Papua New Guinea"]),
      );
      expect(server.roles).toEqual([]);
    });

    it("shows even a single close match for the member to confirm", async () => {
      const interaction = submit("zealand");
      await run(interaction);
      const [menu] = componentsOf(lastEdit(interaction));
      expect(menu.options.map((option) => option.value)).toEqual(["New Zealand"]);
      expect(server.roles).toEqual([]);
    });

    it(`never lists more than ${MAX_CHOICES} countries`, async () => {
      const interaction = submit("a");
      await run(interaction);
      const [menu] = componentsOf(lastEdit(interaction));
      expect(menu.options).toHaveLength(MAX_CHOICES);
    });

    it("offers a Try again button when nothing matches", async () => {
      const interaction = submit("Atlantis");
      const outcome = await run(interaction);

      const reply = lastEdit(interaction);
      expect(reply.content).toBe(translate("en", "pickNoMatch"));
      expect(componentsOf(reply)).toEqual([
        expect.objectContaining({ custom_id: PickerId.BUTTON, label: translate("en", "pickTryAgainLabel") }),
      ]);
      expect(outcome).toMatchObject({
        status: Status.REFUSED,
        key: "pickNoMatch",
        action: { label: LOG_LABEL, fields: { typed: "Atlantis" } },
      });
    });

    it("still allows only one country", async () => {
      const role = server.addRole("Japan");
      server.member(USER_ID, [role.id]);
      const interaction = submit("Canada");

      const outcome = await run(interaction);

      expect(lastEdit(interaction).content).toBe(translate("en", "countryLocked", { country: "Japan" }));
      expect(outcome).toMatchObject({ status: Status.REFUSED, key: "countryLocked" });
      expect(server.roles.map((r) => r.name)).toEqual(["Japan"]);
    });
  });

  describe("choosing from the list", () => {
    it("gives the chosen role and removes the list", async () => {
      const interaction = choose("Guinea-Bissau");
      const outcome = await run(interaction);

      expect(interaction.deferUpdate).toHaveBeenCalled();
      expect(lastEdit(interaction)).toEqual({
        content: translate("en", "assigned", { country: "Guinea-Bissau" }),
        components: [],
      });
      expect(outcome).toMatchObject({
        status: Status.SUCCESS,
        action: { label: LOG_LABEL, fields: { country: "Guinea-Bissau" } },
      });
    });

    it("rejects a value that isn't a country", async () => {
      const interaction = choose("Atlantis");
      const outcome = await run(interaction);
      expect(lastEdit(interaction)).toEqual({ content: translate("en", "invalidCountry"), components: [] });
      expect(outcome.status).toBe(Status.REFUSED);
      expect(server.roles).toEqual([]);
    });

    it("still allows only one country", async () => {
      const role = server.addRole("Japan");
      server.member(USER_ID, [role.id]);
      const interaction = choose("Guinea");
      await run(interaction);
      expect(lastEdit(interaction).content).toBe(translate("en", "countryLocked", { country: "Japan" }));
    });
  });
});

// Discord rejects the whole form or message if a text is too long.
describe("picker texts fit Discord's limits", () => {
  it.each(SUPPORTED_LANGUAGES)("%s", (language) => {
    const text = getTranslations(language);
    expect(text.pickButtonLabel.length).toBeLessThanOrEqual(80);
    expect(text.pickTryAgainLabel.length).toBeLessThanOrEqual(80);
    expect(text.pickFormTitle.length).toBeLessThanOrEqual(45);
    expect(text.pickFormLabel.length).toBeLessThanOrEqual(45);
    expect(text.pickFormPlaceholder.length).toBeLessThanOrEqual(100);
    expect(text.pickListPlaceholder.length).toBeLessThanOrEqual(150);
    expect(translate(language, "pickListRangePlaceholder", { range: "A–Z" }).length).toBeLessThanOrEqual(150);
    expect(() => buildGuideRows(language).map((row) => row.toJSON())).not.toThrow();
    for (const row of buildGuideRows(language)) {
      for (const button of row.toJSON().components) {
        expect(button.label.length).toBeLessThanOrEqual(80);
      }
    }
    expect(() => buildPickForm(language).toJSON()).not.toThrow();
  });
});
