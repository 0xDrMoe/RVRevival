// Everything the dashboard asks Discord. Two kinds of calls:
//
//   - as the person logged in (OAuth2): who they are and which servers they're in;
//   - as the bot (its token): the servers it's in, their channels and roles, a
//     member's roles (for role-based dashboard access and member history),
//     member search, bans (and lifting them for accepted appeals), posting in or
//     editing messages of the log channels, and DMing appeal decisions.
//
// Bot calls go through discord.js's REST client, which waits and retries when
// Discord rate-limits us. Server details are cached for a short while, since
// every page load needs them.

import { AuditLogEvent, REST, Routes } from "discord.js";

const API = "https://discord.com/api/v10";
// What we ask the person to share when they log in: their name and avatar, and
// their server list (with their permissions in each).
const SCOPES = ["identify", "guilds"];
const CACHE_MS = 30_000;
// Logins and server lists go straight to Discord; give up on a hung request.
const OAUTH_TIMEOUT_MS = 15_000;
// Expired cache entries are cleared out once a cache holds this many.
const CACHE_SWEEP_SIZE = 1000;
const MEMBER_SEARCH_LIMIT = 10;
// Discord's error for editing a message someone else (here, a webhook) posted.
const CANNOT_EDIT_OTHERS_MESSAGE = 50005;

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

// A value kept for CACHE_MS, then fetched again. A page asks for several
// things at once, so requests for a key already being fetched share that one
// request instead of each asking Discord (and using up the rate limit).
function cached(load) {
  const entries = new Map();
  const loading = new Map();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        return entry.value;
      }
      if (loading.has(key)) {
        return loading.get(key);
      }
      const request = Promise.resolve()
        .then(() => load(key))
        .then((value) => {
          // forget() during the request means the answer may already be out of date.
          if (loading.get(key) === request) {
            if (entries.size >= CACHE_SWEEP_SIZE) {
              const now = Date.now();
              entries.forEach((old, oldKey) => old.expiresAt <= now && entries.delete(oldKey));
            }
            entries.set(key, { value, expiresAt: Date.now() + CACHE_MS });
          }
          return value;
        })
        .finally(() => {
          if (loading.get(key) === request) {
            loading.delete(key);
          }
        });
      loading.set(key, request);
      return request;
    },
    forget: (key) => {
      loading.delete(key);
      entries.delete(key);
    },
  };
}

// The answer, or null when Discord says there's no such thing (404).
async function orNull(request) {
  try {
    return await request;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

// Options:
//   config   from loadDashboardConfig (token, clientId, clientSecret, url)
//   fetch    replaceable in tests
//   rest     a discord.js REST client (made from the token when left out)
const isProfileChange = (limit) => limit.method.toUpperCase() === "PATCH" && /\/members\/@me$/.test(limit.route);

export function createDiscordApi({ config, fetch = globalThis.fetch, rest }) {
  // Changing the bot's profile has a tight limit. Waiting it out would leave
  // the Branding page hanging, so that request fails at once instead.
  const bot = rest ?? new REST({ version: "10", rejectOnRateLimit: isProfileChange }).setToken(config.token);
  const redirectUri = `${config.url}/auth/callback`;

  async function oauthRequest(path, init) {
    const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS), ...init });
    if (!response.ok) {
      throw new DiscordApiError(response.status, `Discord answered ${response.status} to ${path}`);
    }
    return response.json();
  }

  const asUser = (accessToken, path) => oauthRequest(path, { headers: { Authorization: `Bearer ${accessToken}` } });

  // The bot's server IDs, and the members across them (Discord's rough counts).
  // Paged by 200, Discord's maximum.
  const botGuilds = cached(async () => {
    const ids = new Set();
    let members = 0;
    let after;
    for (;;) {
      const query = new URLSearchParams({ limit: "200", with_counts: "true", ...(after ? { after } : {}) });
      const page = await bot.get(Routes.userGuilds(), { query });
      for (const guild of page) {
        ids.add(guild.id);
        members += guild.approximate_member_count ?? 0;
      }
      if (page.length < 200) {
        return { ids, members };
      }
      after = page.at(-1).id;
    }
  });

  // A server's name, icon, roles and rough member counts (GET /guilds/:id
  // includes the roles).
  const guilds = cached((guildId) => bot.get(Routes.guild(guildId), { query: new URLSearchParams({ with_counts: "true" }) }));
  // A member's roles in a server, or null if they aren't in it. Keyed "guild:user".
  const members = cached(async (key) => {
    const [guildId, userId] = key.split(":");
    try {
      return await bot.get(Routes.guildMember(guildId, userId));
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  });
  const channels = cached((guildId) => bot.get(Routes.guildChannels(guildId)));
  // Any Discord user (also people who left), or null if there's no such user.
  const users = cached((userId) => orNull(bot.get(Routes.user(userId))));
  // A ban { reason, user }, or null if they aren't banned. Keyed "guild:user".
  const bans = cached((key) => orNull(bot.get(Routes.guildBan(...key.split(":")))));

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

    botGuildIds: async () => (await botGuilds.get("all")).ids,
    // How many servers the bot is in and how many members they have together.
    async botReach() {
      const { ids, members } = await botGuilds.get("all");
      return { servers: ids.size, members };
    },
    guild: (guildId) => guilds.get(guildId),
    channels: (guildId) => channels.get(guildId),
    member: (guildId, userId) => members.get(`${guildId}:${userId}`),
    user: (userId) => users.get(userId),
    ban: (guildId, userId) => bans.get(`${guildId}:${userId}`),
    // Members whose username or nickname starts with `query`.
    searchMembers: (guildId, query) =>
      bot.get(Routes.guildMembersSearch(guildId), {
        query: new URLSearchParams({ query, limit: String(MEMBER_SEARCH_LIMIT) }),
      }),

    // Posts a message as the bot. Mentions never ping.
    postMessage: (channelId, payload) =>
      bot.post(Routes.channelMessages(channelId), { body: { ...payload, allowed_mentions: { parse: [] } } }),
    // Log entries are posted by the bot's webhook, and only that webhook can
    // edit them (Discord answers 50005 to the bot), so those go through it.
    async editMessage(channelId, messageId, payload) {
      const body = { ...payload, allowed_mentions: { parse: [] } };
      try {
        return await bot.patch(Routes.channelMessage(channelId, messageId), { body });
      } catch (error) {
        if (error.code !== CANNOT_EDIT_OTHERS_MESSAGE) {
          throw error;
        }
        const message = await bot.get(Routes.channelMessage(channelId, messageId));
        const webhook = message.webhook_id && (await bot.get(Routes.webhook(message.webhook_id)));
        if (!webhook?.token) {
          throw error;
        }
        // A message in a thread is edited through its parent channel's webhook.
        const query = webhook.channel_id === channelId ? undefined : new URLSearchParams({ thread_id: channelId });
        return bot.patch(Routes.webhookMessage(webhook.id, webhook.token, messageId), { body, query, auth: false });
      }
    },
    deleteMessage: (channelId, messageId) => bot.delete(Routes.channelMessage(channelId, messageId)),
    // One message, or null if it's gone (or the bot can't see the channel).
    message: (channelId, messageId) => orNull(bot.get(Routes.channelMessage(channelId, messageId))),

    // Lifts a ban (an accepted appeal). `reason` goes in the audit log.
    async unban(guildId, userId, reason) {
      await bot.delete(Routes.guildBan(guildId, userId), { reason });
      bans.forget(`${guildId}:${userId}`);
    },

    // DMs someone as the bot. Fails if they don't share a server with it or
    // closed their DMs.
    async dm(userId, payload) {
      const channel = await bot.post(Routes.userChannels(), { body: { recipient_id: userId } });
      return bot.post(Routes.channelMessages(channel.id), { body: { ...payload, allowed_mentions: { parse: [] } } });
    },

    // Deletes a channel the bot made (a stats counter). `reason` goes in the audit log.
    async deleteChannel(guildId, channelId, reason) {
      await bot.delete(Routes.channel(channelId), { reason });
      channels.forget(guildId);
    },

    // Who added the bot to the server, from the audit log (kept 45 days), or
    // null if it isn't there or the bot can't read it (View Audit Log).
    // The bot's user ID is its application's ID.
    async botInviter(guildId) {
      try {
        const log = await bot.get(Routes.guildAuditLog(guildId), {
          query: new URLSearchParams({ action_type: String(AuditLogEvent.BotAdd), limit: "50" }),
        });
        return log.audit_log_entries?.find((entry) => entry.target_id === config.clientId)?.user_id ?? null;
      } catch {
        return null;
      }
    },

    // The bot's own Discord account (name and avatar everywhere).
    botUser: () => users.get(config.clientId),
    // The bot's member in a server: its nickname, avatar and banner there.
    // Not cached, so the Branding page always shows what Discord has now.
    botMember: (guildId) => bot.get(Routes.guildMember(guildId, config.clientId)),
    // Changes the bot's own profile in one server: { nick, avatar, banner },
    // images as data: URLs and null for the bot's default. Returns the member.
    async editBotProfile(guildId, profile, reason) {
      const member = await bot.patch(Routes.guildMember(guildId, "@me"), { body: profile, reason });
      members.forget(`${guildId}:${config.clientId}`);
      return member;
    },

    // The bot's own user ID, for the invite link.
    clientId: config.clientId,
  };
}
