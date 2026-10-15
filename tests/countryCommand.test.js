import { ApplicationCommandOptionType, InteractionContextType, MessageFlags, RESTJSONErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SUGGESTIONS, createCountryCommand } from "../src/commands/country.js";
import { countryList } from "../src/countries/countries.js";
import { translate } from "../src/i18n/i18n.js";
import { CountryRoleService } from "../src/roles/countryRoles.js";
import { ChannelSettings } from "../src/settings/channelSettings.js";
import { FakeServer, discordError, fakeLogger } from "./helpers/fakes.js";

const USER_ID = "300000000000000001";

// A fake /country interaction typed by USER_ID.
function fakeCommandInteraction(typed, overrides = {}) {
  const interaction = {
    commandName: "country",
    locale: "en-US",
    guildId: "900000000000000001",
    channelId: "800000000000000001",
    channel: { parentId: null },
    guild: {},
    member: {},
    user: { id: USER_ID },
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    options: { getString: () => typed },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
  return interaction;
}

function fakeAutocompleteInteraction(typed, respond = vi.fn(async () => {})) {
  return {
    commandName: "country",
    options: {
      getFocused: () => {
        if (typed instanceof Error) throw typed;
        return typed;
      },
    },
    respond,
  };
}

const suggestionsFrom = (interaction) => interaction.respond.mock.calls[0][0];

describe("/country definition", () => {
  const { data } = createCountryCommand({ logger: fakeLogger() });

  it("has one required, autocompleted text option and only works in servers", () => {
    expect(data.name).toBe("country");
    expect(data.contexts).toEqual([InteractionContextType.Guild]);
    expect(data.options).toHaveLength(1);
    expect(data.options[0]).toMatchObject({
      name: "country",
      type: ApplicationCommandOptionType.String,
      description: "Select or enter the country where you currently reside.",
      required: true,
      autocomplete: true,
    });
  });

  it("has translated descriptions for Discord's supported languages", () => {
    expect(data.description_localizations.de).toBe(translate("de", "commandDescription"));
    expect(data.options[0].description_localizations["pt-BR"]).toBe(translate("pt", "countryOptionDescription"));
  });
});

describe("/country", () => {
  let server;
  let logger;
  let roleService;

  const makeCommand = (extra = {}) =>
    createCountryCommand({
      logger,
      roleService,
      wrapServer: () => server,
      wrapMember: () => server.member(USER_ID),
      ...extra,
    });

  beforeEach(() => {
    server = new FakeServer();
    logger = fakeLogger();
    roleService = new CountryRoleService(logger);
  });

  it("acknowledges privately, creates and assigns the role, and confirms", async () => {
    const interaction = fakeCommandInteraction("  canada ");
    await makeCommand().execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "Your country role has been set to Canada." });
    expect(server.roles.map((role) => role.name)).toEqual(["Canada"]);
    expect(server.rolesByUser.get(USER_ID).size).toBe(1);
  });

  it("tells members they already have the role", async () => {
    const role = server.addRole("Canada");
    server.member(USER_ID, [role.id]);
    const interaction = fakeCommandInteraction("CANADA");

    await makeCommand().execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "You already have the Canada role." });
  });

  it.each(["Atlantis", "", "   ", null])("rejects %j without touching any roles", async (typed) => {
    const giveCountryRole = vi.spyOn(roleService, "giveCountryRole");
    const interaction = fakeCommandInteraction(typed);

    await makeCommand().execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("en", "invalidCountry") });
    expect(giveCountryRole).not.toHaveBeenCalled();
    expect(server.createRole).not.toHaveBeenCalled();
  });

  it("refuses to run outside a server", async () => {
    const interaction = fakeCommandInteraction("Canada", { inCachedGuild: () => false });
    await makeCommand().execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "guildOnly"),
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("explains missing permissions", async () => {
    server.canManageRoles = false;
    const interaction = fakeCommandInteraction("Canada");
    await makeCommand().execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("en", "missingPermissions") });
  });

  it("explains role hierarchy problems", async () => {
    server.addRole("Canada", { position: 99 });
    const interaction = fakeCommandInteraction("Canada");
    await makeCommand().execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: translate("en", "hierarchy", { country: "Canada" }),
    });
  });

  it("reports a role that was created but not assigned", async () => {
    const command = makeCommand({
      wrapMember: () => {
        const member = server.member(USER_ID);
        member.addRole.mockRejectedValueOnce(discordError(RESTJSONErrorCodes.MissingPermissions));
        return member;
      },
    });
    const interaction = fakeCommandInteraction("Canada");

    await command.execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: translate("en", "createdButNotAssigned", { country: "Canada" }),
    });
  });

  describe("channel restriction", () => {
    const ALLOWED = "800000000000000001";
    const OTHER = "800000000000000002";
    let channelSettings;

    beforeEach(async () => {
      channelSettings = new ChannelSettings();
      await channelSettings.set("900000000000000001", ALLOWED);
    });

    it("works in the channel the admin chose", async () => {
      const interaction = fakeCommandInteraction("Canada", { channelId: ALLOWED });
      await makeCommand({ channelSettings }).execute(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: "Your country role has been set to Canada." });
    });

    it("works in a thread inside the chosen channel", async () => {
      const interaction = fakeCommandInteraction("Canada", { channelId: OTHER, channel: { parentId: ALLOWED } });
      await makeCommand({ channelSettings }).execute(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: "Your country role has been set to Canada." });
    });

    it("points members to the chosen channel and changes no roles anywhere else", async () => {
      const interaction = fakeCommandInteraction("Canada", { channelId: OTHER });
      await makeCommand({ channelSettings }).execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: `This command can only be used in <#${ALLOWED}>.`,
        flags: MessageFlags.Ephemeral,
      });
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(server.createRole).not.toHaveBeenCalled();
    });

    it("works in every channel when no channel is chosen", async () => {
      const interaction = fakeCommandInteraction("Canada", { channelId: OTHER });
      await makeCommand({ channelSettings: new ChannelSettings() }).execute(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: "Your country role has been set to Canada." });
    });
  });

  describe("languages", () => {
    it.each([
      ["es-ES", "Tu rol de país se ha establecido en Canada."],
      ["de", "Deine Länderrolle wurde auf Canada gesetzt."],
      ["fr", "Votre rôle de pays a été défini sur Canada."],
      ["pt-BR", "Seu cargo de país foi definido como Canada."],
      ["it", "Il tuo ruolo paese è stato impostato su Canada."],
      ["ja", "Your country role has been set to Canada."],
    ])("replies in the user's Discord language (%s)", async (locale, expected) => {
      const interaction = fakeCommandInteraction("Canada", { locale });
      await makeCommand().execute(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: expected });
    });

    it("uses BOT_LANGUAGE for everyone when it is set", async () => {
      const interaction = fakeCommandInteraction("Atlantis", { locale: "de" });
      await makeCommand({ forcedLanguage: "ar" }).execute(interaction);
      expect(interaction.editReply).toHaveBeenCalledWith({ content: translate("ar", "invalidCountry") });
    });
  });
});

describe("/country autocomplete", () => {
  const command = createCountryCommand({ logger: fakeLogger() });

  it("returns at most 25 valid suggestions within Discord's length limits", async () => {
    for (const typed of ["", "a", "an", "united", "CAN", "  ger "]) {
      const interaction = fakeAutocompleteInteraction(typed);
      await command.autocomplete(interaction);

      const suggestions = suggestionsFrom(interaction);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
      for (const suggestion of suggestions) {
        expect(suggestion.name.length).toBeGreaterThan(0);
        expect(suggestion.name.length).toBeLessThanOrEqual(100);
        expect(countryList.find(suggestion.value)?.name).toBe(suggestion.value);
      }
    }
  });

  it("puts the best match first", async () => {
    const interaction = fakeAutocompleteInteraction("canad");
    await command.autocomplete(interaction);
    expect(suggestionsFrom(interaction)).toEqual([{ name: "Canada", value: "Canada" }]);
  });

  it("returns no suggestions when nothing matches", async () => {
    for (const typed of ["zzzzqqq", 123]) {
      const interaction = fakeAutocompleteInteraction(typed);
      await command.autocomplete(interaction);
      expect(suggestionsFrom(interaction)).toEqual([]);
    }
  });

  it("returns no suggestions when the lookup throws", async () => {
    const interaction = fakeAutocompleteInteraction(new Error("broken"));
    await command.autocomplete(interaction);
    expect(suggestionsFrom(interaction)).toEqual([]);
  });

  it("ignores an expired autocomplete request", async () => {
    const respond = vi.fn(async () => {
      throw discordError(RESTJSONErrorCodes.UnknownInteraction);
    });
    await expect(command.autocomplete(fakeAutocompleteInteraction("can", respond))).resolves.toBeUndefined();
  });
});
