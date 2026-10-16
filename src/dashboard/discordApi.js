// Everything the dashboard asks Discord. Two kinds of calls:
//
//   - as the person logged in (OAuth2): who they are and which servers they're in;
//   - as the bot (its token): the servers it's in, their channels and roles, and
//     posting in or editing messages of the log channels.
//
// Bot calls go through discord.js's REST client, which waits and retries when
// Discord rate-limits us. Server details are cached for a short while, since
// every page load needs them.

import { REST, Routes } from "discord.js";

const API = "https://discord.com/api/v10";
// What we ask the person to share when they log in: their name and avatar, and
// their server list (with their permissions in each).
const SCOPES = ["identify", "guilds"];
const CACHE_MS = 30_000;

const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

// Whether someone with this entry of their server list can manage the server.
export function canManage(guild) {
  if (guild.owner) {
    return true;
  }
  const permissions = BigInt(guild.permissions ?? 0);
  return (permissions & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
}

export class DiscordApiError extends Error {
  name = "DiscordApiError";
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A value kept for CACHE_MS, then fetched again.
function cached(load) {
  const entries = new Map();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        return entry.value;
      }
      const value = await load(key);
      entries.set(key, { value, expiresAt: Date.now() + CACHE_MS });
      return value;
    },
    forget: (key) => entries.delete(key),
  };
}

// Options:
//   config   from loadDashboardConfig (token, clientId, clientSecret, url)
//   fetch    replaceable in tests
//   rest     a discord.js REST client (made from the token when left out)
export function createDiscordApi({ config, fetch = globalThis.fetch, rest }) {
  const bot = rest ?? new REST({ version: "10" }).setToken(config.token);
  const redirectUri = `${config.url}/auth/callback`;

  async function oauthRequest(path, init) {
    const response = await fetch(`${API}${path}`, init);
    if (!response.ok) {
      throw new DiscordApiError(response.status, `Discord answered ${response.status} to ${path}`);
    }
    return response.json();
  }

  const asUser = (accessToken, path) => oauthRequest(path, { headers: { Authorization: `Bearer ${accessToken}` } });

  // The bot's server IDs. Paged by 200, Discord's maximum.
  const botGuilds = cached(async () => {
    const ids = new Set();
    let after;
    for (;;) {
      const query = new URLSearchParams({ limit: "200", ...(after ? { after } : {}) });
      const page = await bot.get(Routes.userGuilds(), { query });
      page.forEach((guild) => ids.add(guild.id));
      if (page.length < 200) {
        return ids;
      }
      after = page.at(-1).id;
    }
  });

  // A server's name, icon and roles (GET /guilds/:id includes the roles).
  const guilds = cached((guildId) => bot.get(Routes.guild(guildId)));
  const channels = cached((guildId) => bot.get(Routes.guildChannels(guildId)));

  return {
    // Where the "Log in with Discord" button sends people.
    authorizeUrl(state) {
      const query = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: SCOPES.join(" "),
        state,
        prompt: "none",
      });
      return `https://discord.com/oauth2/authorize?${query}`;
    },

    // Swaps the code Discord sent back for an access token.
    async exchangeCode(code) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      const token = await oauthRequest("/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return { accessToken: token.access_token, expiresInSeconds: token.expires_in };
    },

    // Tells Discord to forget the access token (on log out).
    async revokeToken(accessToken) {
      const body = new URLSearchParams({
        token: accessToken,
        token_type_hint: "access_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      await fetch(`${API}/oauth2/token/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }).catch(() => {});
    },

    fetchUser: (accessToken) => asUser(accessToken, "/users/@me"),
    fetchUserGuilds: (accessToken) => asUser(accessToken, "/users/@me/guilds"),

    botGuildIds: () => botGuilds.get("all"),
    guild: (guildId) => guilds.get(guildId),
    channels: (guildId) => channels.get(guildId),

    // Posts a message as the bot. Mentions never ping.
    postMessage: (channelId, payload) =>
      bot.post(Routes.channelMessages(channelId), { body: { ...payload, allowed_mentions: { parse: [] } } }),
    editMessage: (channelId, messageId, payload) =>
      bot.patch(Routes.channelMessage(channelId, messageId), { body: payload }),

    // The bot's own user ID, for the invite link.
    clientId: config.clientId,
  };
}
