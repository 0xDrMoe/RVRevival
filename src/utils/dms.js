// Every DM the bot sends goes through sendDm, so that:
//
//   - someone whose DMs are closed isn't asked again for a while. Each refused
//     DM counts toward Discord's invalid-request limit (10,000 per 10 minutes
//     gets the bot blocked for an hour), and a big server has many people
//     with closed DMs.
//   - DMs go out at most DMS_PER_SECOND at a time across the whole bot.
//     Discord watches bots that DM many people quickly and can flag them as spam.
//
// A skipped DM rejects with the same error code Discord would have answered
// (50007, Cannot send messages to this user), so callers handle it as before.

import { RESTJSONErrorCodes } from "discord.js";
import { createRateLimiter } from "./rateLimits.js";

const CLOSED_FOR_MS = 6 * 60 * 60 * 1000;
const DMS_PER_SECOND = 5;
const SWEEP_SIZE = 10_000;

export class DmClosedError extends Error {
  name = "DmClosedError";
  code = RESTJSONErrorCodes.CannotSendMessagesToThisUser;
  constructor() {
    super("This user's DMs are closed (remembered from an earlier try).");
  }
}

// Options: now, wait (tests)
export function createDmSender({ now = Date.now, wait } = {}) {
  // user ID -> until when their DMs count as closed
  const closed = new Map();
  const pace = createRateLimiter({ limit: DMS_PER_SECOND, windowMs: 1000, now, ...(wait ? { wait } : {}) });

  function sweep() {
    if (closed.size < SWEEP_SIZE) {
      return;
    }
    const time = now();
    closed.forEach((until, id) => until <= time && closed.delete(id));
  }

  return {
    async send(user, payload) {
      const id = user?.id;
      if (id && (closed.get(id) ?? 0) > now()) {
        throw new DmClosedError();
      }
      await pace.acquire("all");
      try {
        return await user.send(payload);
      } catch (error) {
        if (id && error?.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
          sweep();
          closed.set(id, now() + CLOSED_FOR_MS);
        }
        throw error;
      }
    },
    isClosed: (userId) => (closed.get(userId) ?? 0) > now(),
  };
}

// The one the bot uses.
let shared = createDmSender();
export const sendDm = (user, payload) => shared.send(user, payload);
// Forgets every closed DM and starts the pacing over (between tests).
export function resetDms() {
  shared = createDmSender();
}
