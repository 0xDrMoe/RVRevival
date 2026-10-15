import { ApplicationCommandOptionType, InteractionContextType, MessageFlags } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCountryStaffCommand } from "../src/commands/countryStaff.js";
import { translate } from "../src/i18n/i18n.js";
import { CountryRoleService } from "../src/roles/countryRoles.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { FakeServer, fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const STAFF_ROLE_ID = "700000000000000001";
const STAFF_ID = "300000000000000009";
const TARGET_ID = "300000000000000001";

const noPings = { allowedMentions: { parse: [] } };

// A fake /country-staff <subcommand> interaction. By default the caller holds the staff role.
function fakeInteraction(subcommand, { country, callerRoles = [STAFF_ROLE_ID], target = { id: TARGET_ID }, ...overrides } = {}) {
  const interaction = {
    commandName: "country-staff",
    locale: "en-US",
    guildId: GUILD_ID,
    guild: {},
    user: { id: STAFF_ID },
    member: { roles: { cache: new Set(callerRoles) } },
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getMember: () => target,
      getString: () => country,
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {}),
    ...overrides,
  };
  return interaction;
}

describe("/country-staff definition", () => {
  const { data } = createCountryStaffCommand({ logger: fakeLogger() });

  it("has set and remove subcommands and only works in servers", () => {
    expect(data.name).toBe("country-staff");
    expect(data.contexts).toEqual([InteractionContextType.Guild]);
    expect(data.options.map((option) => option.name)).toEqual(["set", "remove"]);

    const [member, country] = data.options[0].options;
    expect(member).toMatchObject({ name: "member", type: ApplicationCommandOptionType.User, required: true });
    expect(country).toMatchObject({ name: "country", type: ApplicationCommandOptionType.String, autocomplete: true });
    expect(data.options[1].options.map((option) => option.name)).toEqual(["member"]);
  });
});

describe("/country-staff", () => {
  let server;
  let logger;
  let guildSettings;

  const makeCommand = (extra = {}) =>
    createCountryStaffCommand({
      logger,
      guildSettings,
      roleService: new CountryRoleService(logger),
      wrapServer: () => server,
      wrapMember: () => server.member(TARGET_ID),
      ...extra,
    });

  beforeEach(async () => {
    server = new FakeServer();
    logger = fakeLogger();
    guildSettings = new GuildSettings();
    await guildSettings.set(GUILD_ID, Setting.STAFF_ROLE, STAFF_ROLE_ID);
  });

  it("changes a member's country", async () => {
    const japanRole = server.addRole("Japan");
    server.member(TARGET_ID, [japanRole.id]);
    const interaction = fakeInteraction("set", { country: "canada" });

    await makeCommand().execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: `<@${TARGET_ID}> now has the Canada role.`, ...noPings });
    const roles = [...server.rolesByUser.get(TARGET_ID)];
    expect(roles).toHaveLength(1);
    expect(server.roles.find((role) => role.id === roles[0]).name).toBe("Canada");
    expect(logger.info).toHaveBeenCalledWith(
      "Staff changed a member's country role",
      expect.objectContaining({ staffUserId: STAFF_ID, userId: TARGET_ID, removedRoleIds: [japanRole.id] }),
    );
  });

  it("removes a member's country", async () => {
    const japanRole = server.addRole("Japan");
    server.member(TARGET_ID, [japanRole.id]);
    const interaction = fakeInteraction("remove");

    await makeCommand().execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({ content: `Removed the Japan role from <@${TARGET_ID}>.`, ...noPings });
    expect(server.rolesByUser.get(TARGET_ID).size).toBe(0);
  });

  it("says when there is nothing to remove", async () => {
    const interaction = fakeInteraction("remove");
    await makeCommand().execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: `<@${TARGET_ID}> doesn't have a country role.`, ...noPings });
  });

  it("refuses members without the staff role, even admins", async () => {
    const interaction = fakeInteraction("set", { country: "Canada", callerRoles: [] });
    await makeCommand().execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "staffOnly", { role: `<@&${STAFF_ROLE_ID}>` }),
      flags: MessageFlags.Ephemeral,
      ...noPings,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(server.createRole).not.toHaveBeenCalled();
  });

  it("tells staff when no staff role has been set", async () => {
    guildSettings = new GuildSettings();
    const interaction = fakeInteraction("remove");
    await makeCommand().execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "staffRoleNotSet"),
      flags: MessageFlags.Ephemeral,
      ...noPings,
    });
  });

  it("refuses someone who isn't in the server", async () => {
    const interaction = fakeInteraction("remove", { target: null });
    await makeCommand().execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "staffMemberNotFound"),
      flags: MessageFlags.Ephemeral,
      ...noPings,
    });
  });

  it("rejects an unknown country without touching roles", async () => {
    const interaction = fakeInteraction("set", { country: "Atlantis" });
    await makeCommand().execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "invalidCountry"),
      flags: MessageFlags.Ephemeral,
      ...noPings,
    });
    expect(server.createRole).not.toHaveBeenCalled();
  });

  it("names the role that is above the bot", async () => {
    server.addRole("Canada", { position: 99 });
    const interaction = fakeInteraction("set", { country: "Canada" });
    await makeCommand().execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: translate("en", "staffHierarchy", { country: "Canada" }),
      ...noPings,
    });
  });

  it("refuses to run outside a server", async () => {
    const interaction = fakeInteraction("remove", { inCachedGuild: () => false });
    await makeCommand().execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: translate("en", "guildOnly"),
      flags: MessageFlags.Ephemeral,
      ...noPings,
    });
  });

  it("suggests countries while staff type", async () => {
    const respond = vi.fn(async () => {});
    await makeCommand().autocomplete({ options: { getFocused: () => "canad" }, respond });
    expect(respond).toHaveBeenCalledWith([{ name: "Canada", value: "Canada" }]);
  });
});
