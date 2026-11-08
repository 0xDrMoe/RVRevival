// An app access token from an OAuth client-credentials grant (Twitch, Kick):
// no user logs in, and the token can read any public channel. It is kept until
// it nearly expires, and one request is shared by everyone waiting for it.

import { FeedError } from "./fetchFeed.js";

export const TIMEOUT_MS = 10_000;
// Fetch a new token a minute before the old one runs out.
const EXPIRY_MARGIN_MS = 60_000;

// Options: tokenUrl, clientId, clientSecret, label (shown in errors), fetchImpl, now
export function createAppToken({ tokenUrl, clientId, clientSecret, label, fetchImpl = fetch, now = Date.now }) {
  let token = null;
  let expiresAt = 0;
  let pending = null;

  async function fetchToken() {
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new FeedError("unreachable", `${label} didn't answer.`);
    }
    if (!response.ok) {
      // Wrong keys: never echo them.
      throw new FeedError("unreachable", `${label} refused the bot's keys (${response.status}).`);
    }
    const body = await response.json().catch(() => ({}));
    if (typeof body.access_token !== "string") {
      throw new FeedError("unreachable", `${label} sent no token.`);
    }
    token = body.access_token;
    expiresAt = now() + Number(body.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS;
    return token;
  }

  // `force` gets a new token, after the API refused the old one.
  return function getToken(force = false) {
    if (!force && token && now() < expiresAt) {
      return Promise.resolve(token);
    }
    pending ??= fetchToken().finally(() => {
      pending = null;
    });
    return pending;
  };
}

// GETs `url` with the token, once more with a new token after a 401. Returns the JSON body.
export async function getWithToken({ url, getToken, headers = {}, label, fetchImpl = fetch }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getToken(attempt > 0);
    let response;
    try {
      response = await fetchImpl(url, { headers: { ...headers, Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new FeedError("unreachable", `${label} didn't answer.`);
    }
    if (response.status === 401 && attempt === 0) {
      continue;
    }
    if (!response.ok) {
      throw new FeedError("unreachable", `${label} answered ${response.status}.`);
    }
    return response.json();
  }
  throw new FeedError("unreachable", `${label} refused the bot's token.`);
}

export const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size));

// Every login once, asked `size` at a time.
export async function batched(logins, size, ask) {
  const results = [];
  for (const batch of chunks([...new Set(logins)], size)) {
    results.push(...(await ask(batch)));
  }
  return results;
}
