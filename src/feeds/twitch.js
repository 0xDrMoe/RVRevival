// Twitch's Helix API, for live notifications. Uses an app access token
// (client credentials: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env),
// which needs no Twitch login and can read any public channel.
// https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow
//
// Like kick.js, it answers in the shape feeds/livePoller.js uses:
//   channels(logins) → [{ login, name }] for the channels that exist
//   streams(logins)  → [{ id, login, name, title, game }] for the ones live now

import { batched, createAppToken, getWithToken } from "./appToken.js";

const API_URL = "https://api.twitch.tv/helix";
const LABEL = "Twitch";
// Helix takes up to 100 logins per request.
const BATCH = 100;

// Options: clientId, clientSecret, fetchImpl and now (tests).
export function createTwitchApi({ clientId, clientSecret, fetchImpl = fetch, now = Date.now }) {
  const getToken = createAppToken({ tokenUrl: "https://id.twitch.tv/oauth2/token", clientId, clientSecret, label: LABEL, fetchImpl, now });

  async function helix(path, parameter, logins) {
    const url = new URL(`${API_URL}/${path}`);
    for (const login of logins) {
      url.searchParams.append(parameter, login);
    }
    const body = await getWithToken({ url, getToken, headers: { "Client-Id": clientId }, label: LABEL, fetchImpl });
    return Array.isArray(body?.data) ? body.data : [];
  }

  return {
    channels: async (logins) =>
      (await batched(logins, BATCH, (batch) => helix("users", "login", batch))).map((user) => ({ login: String(user.login).toLowerCase(), name: user.display_name || user.login })),
    streams: async (logins) =>
      (await batched(logins, BATCH, (batch) => helix("streams", "user_login", batch)))
        .filter((stream) => stream.type === "live")
        .map((stream) => ({ id: String(stream.id), login: String(stream.user_login).toLowerCase(), name: stream.user_name, title: stream.title, game: stream.game_name })),
  };
}
