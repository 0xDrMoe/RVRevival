import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDashboardCommand, dashboardLink } from "../src/commands/dashboard.js";
import { SUPPORTED_LANGUAGES, translate } from "../src/i18n/i18n.js";

const GUILD_ID = "900000000000000001";
const DASHBOARD = "https://rabble.example.com";

function fakeInteraction({ inGuild = true, locale = "en-US", name = "Cool *Server*" } = {}) {
  return {
    locale,
    guildId: inGuild ? GUILD_ID : null,
    guild: inGuild ? { name } : null,
    inGuild: () => inGuild,
    reply: vi.fn(async () => {}),
  };
}

const replyOf = (interaction) => interaction.reply.mock.calls[0][0];

describe("/dashboard", () => {
  it("builds the server's dashboard link", () => {
    expect(dashboardLink(DASHBOARD, GUILD_ID)).toBe(`${DASHBOARD}/g/${GUILD_ID}`);
    expect(dashboardLink(undefined, GUILD_ID)).toBeNull();
    expect(dashboardLink(DASHBOARD, null)).toBeNull();
  });

  it("replies privately with a link button to the server's page", async () => {
    const interaction = fakeInteraction();
    const outcome = await createDashboardCommand({ dashboardUrl: DASHBOARD }).execute(interaction);
    const reply = replyOf(interaction);
    expect(outcome.status).toBe("success");
    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(reply.allowedMentions).toEqual({ parse: [] });
    expect(reply.content).toContain("Cool \\*Server\\*");
    const [button] = reply.components[0].toJSON().components;
    expect(button.url).toBe(`${DASHBOARD}/g/${GUILD_ID}`);
    expect(button.label).toBe("Open dashboard");
  });

  it("says so when there's no dashboard", async () => {
    const interaction = fakeInteraction();
    const outcome = await createDashboardCommand({}).execute(interaction);
    expect(outcome.status).toBe("failed");
    expect(replyOf(interaction).content).toBe(translate("en", "dashboardNotSetUp"));
    expect(replyOf(interaction).components).toEqual([]);
  });

  it("refuses outside a server", async () => {
    const interaction = fakeInteraction({ inGuild: false });
    const outcome = await createDashboardCommand({ dashboardUrl: DASHBOARD }).execute(interaction);
    expect(outcome.status).toBe("refused");
    expect(replyOf(interaction).content).toBe(translate("en", "guildOnly"));
  });

  it.each(SUPPORTED_LANGUAGES)("has every string in %s", (language) => {
    for (const key of ["dashboardCommandDescription", "dashboardLink", "dashboardOpen", "dashboardThisServer", "dashboardNotSetUp"]) {
      expect(translate(language, key)).not.toBe(key);
    }
  });
});
