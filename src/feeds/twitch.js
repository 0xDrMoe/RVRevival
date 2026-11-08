// Twitch's Helix API, for live notifications. Uses an app access token
// (client credentials: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env),
// which needs no Twitch login and can read any public channel. The token is
// kept until it expires and fetched again when Twitch answers 401.
// https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow

import { FeedError } from "./fetchFeed.js";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_URL = "https://api.twitch.tv/helix";
const TIMEOUT_MS = 10_000;
// Helix takes up to 100 logins per request.
const BATCH = 100;
// Fetch a new token a minute before the old one runs out.
const EXPIRY_MARGIN_MS = 60_000;

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size));

// Options: clientId, clientSecret, fetchImpl and now (tests).
export function createTwitchApi({ clientId, clientSecret, fetchImpl = fetch, now = Date.now }) {
  let token = null;
  let expiresAt = 0;
  let pending = null;

  async function fetchToken() {
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FeedError("unreachable", "Twitch didn't answer.");
    }
    if (!response.ok) {
      // Wrong keys: never echo them.
      throw new FeedError("unreachable", `Twitch refused the bot's keys (${response.status}).`);
    }
    const body = await response.json();
    if (typeof body.access_token !== "string") {
      throw new FeedError("unreachable", "Twitch sent no token.");
    }
    token = body.access_token;
    expiresAt = now() + Number(body.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS;
    return token;
  }

  // One token request at a time, shared by everyone waiting.
  function getToken(force = false) {
    if (!force && token && now() < expiresAt) {
      return Promise.resolve(token);
    }
    pending ??= fetchToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function helix(path, logins) {
    const url = new URL(`${API_URL}/${path}`);
    for (const login of logins) {
      url.searchParams.append(path === "streams" ? "user_login" : "login", login);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await getToken(attempt > 0);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { "Client-Id": clientId, Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new FeedError("unreachable", "Twitch didn't answer.");
      }
      if (response.status === 401 && attempt === 0) {
        continue;
      }
      if (!response.ok) {
        throw new FeedError("unreachable", `Twitch answered ${response.status}.`);
      }
      const body = await response.json();
      return Array.isArray(body.data) ? body.data : [];
    }
    throw new FeedError("unreachable", "Twitch refused the bot's token.");
  }

  async function batched(path, logins) {
    const unique = [...new Set(logins)];
    const results = [];
    for (const batch of chunks(unique, BATCH)) {
      results.push(...(await helix(path, batch)));
    }
    return results;
  }

  return {
    // [{ id, login, display_name, … }] for the logins that exist.
    users: (logins) => batched("users", logins),
    // [{ id, user_login, user_name, title, game_name, … }] for the logins live now.
    streams: async (logins) => (await batched("streams", logins)).filter((stream) => stream.type === "live"),
  };
}
