// The Twitch and Kick APIs for the platforms that have keys in .env
// (config.live), shared by the bot and the dashboard. A platform without keys
// is left out, and following it says it isn't switched on.

import { createKickApi } from "./kick.js";
import { createTwitchApi } from "./twitch.js";

export function createLiveApis(credentials = {}) {
  const apis = {};
  if (credentials.twitch) {
    apis.twitch = createTwitchApi(credentials.twitch);
  }
  if (credentials.kick) {
    apis.kick = createKickApi(credentials.kick);
  }
  return apis;
}

// Every secret, so the logger can hide them.
export const liveSecrets = (credentials = {}) => Object.values(credentials).filter(Boolean).map((keys) => keys.clientSecret);
