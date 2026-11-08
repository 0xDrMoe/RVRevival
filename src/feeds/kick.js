// Kick's public API, for live notifications. Uses an app access token (client
// credentials: KICK_CLIENT_ID and KICK_CLIENT_SECRET in .env), which needs no
// Kick login and can read any public channel. https://docs.kick.com
//
// Same shape as twitch.js:
//   channels(slugs) → [{ login, name }] for the channels that exist
//   streams(slugs)  → [{ id, login, name, title, game }] for the ones live now
// Kick gives a stream no ID, so a broadcast is the channel plus its start time.

import { batched, createAppToken, getWithToken } from "./appToken.js";

const API_URL = "https://api.kick.com/public/v1/channels";
const LABEL = "Kick";
// Kick takes up to 50 slugs per request.
const BATCH = 50;

// Options: clientId, clientSecret, fetchImpl and now (tests).
export function createKickApi({ clientId, clientSecret, fetchImpl = fetch, now = Date.now }) {
  const getToken = createAppToken({ tokenUrl: "https://id.kick.com/oauth/token", clientId, clientSecret, label: LABEL, fetchImpl, now });

  async function channels(slugs) {
    return batched(slugs, BATCH, async (batch) => {
      const url = new URL(API_URL);
      for (const slug of batch) {
        url.searchParams.append("slug", slug);
      }
      const body = await getWithToken({ url, getToken, label: LABEL, fetchImpl });
      return Array.isArray(body?.data) ? body.data.filter((channel) => typeof channel?.slug === "string") : [];
    });
  }

  return {
    channels: async (slugs) => (await channels(slugs)).map((channel) => ({ login: channel.slug.toLowerCase(), name: channel.slug })),
    streams: async (slugs) =>
      (await channels(slugs))
        .filter((channel) => channel.stream?.is_live)
        .map((channel) => ({
          id: `${channel.broadcaster_user_id}:${channel.stream.start_time ?? ""}`,
          login: channel.slug.toLowerCase(),
          name: channel.slug,
          title: channel.stream_title || "",
          game: channel.category?.name || "",
        })),
  };
}
