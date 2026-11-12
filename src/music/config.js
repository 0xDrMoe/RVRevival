// Per-server music settings, saved under Setting.MUSIC:
//
//   djRoleId           with a DJ role, only DJs (and Manage Server) can skip,
//                      stop or change the queue; anyone in the channel can
//                      still add songs and skip their own. null = everyone.
//   defaultVolume      1 to 150 (%), the volume a new session starts at.
//   maxQueue           how many songs the queue holds, 10 to 500.
//   announce           post a "Now playing" message for every song.
//   leaveAfterMinutes  how long the bot stays when the queue is done or
//                      nobody is listening, 0 to 60.

export const MIN_VOLUME = 1;
export const MAX_VOLUME = 150;
export const MIN_QUEUE = 10;
export const MAX_QUEUE = 500;
export const MAX_LEAVE_MINUTES = 60;

export const DEFAULT_MUSIC = Object.freeze({
  djRoleId: null,
  defaultVolume: 80,
  maxQueue: 200,
  announce: true,
  leaveAfterMinutes: 3,
});

const SNOWFLAKE = /^\d{17,20}$/;
const KEYS = Object.keys(DEFAULT_MUSIC);

export class InvalidMusic extends Error {
  name = "InvalidMusic";
}

const wholeIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// The saved setting with every default filled in and anything unusable dropped.
export function normalizeMusic(saved) {
  const value = saved && typeof saved === "object" ? saved : {};
  return {
    djRoleId: typeof value.djRoleId === "string" && SNOWFLAKE.test(value.djRoleId) ? value.djRoleId : null,
    defaultVolume: wholeIn(value.defaultVolume, MIN_VOLUME, MAX_VOLUME) ? value.defaultVolume : DEFAULT_MUSIC.defaultVolume,
    maxQueue: wholeIn(value.maxQueue, MIN_QUEUE, MAX_QUEUE) ? value.maxQueue : DEFAULT_MUSIC.maxQueue,
    announce: value.announce !== false,
    leaveAfterMinutes: wholeIn(value.leaveAfterMinutes, 0, MAX_LEAVE_MINUTES) ? value.leaveAfterMinutes : DEFAULT_MUSIC.leaveAfterMinutes,
  };
}

// Checks dashboard or /music settings input. `isRole(id)` says whether the
// role exists on the server and isn't @everyone. Returns what to save, or
// null when everything is the default.
export function checkMusic(value, { isRole }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMusic("Music settings are { djRoleId, defaultVolume, maxQueue, announce, leaveAfterMinutes }.");
  }
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) {
    throw new InvalidMusic(`Unknown music setting "${unknown}".`);
  }
  const merged = { ...DEFAULT_MUSIC, ...value };
  if (merged.djRoleId !== null && !(typeof merged.djRoleId === "string" && isRole(merged.djRoleId))) {
    throw new InvalidMusic("Pick a DJ role from this server (not @everyone), or none.");
  }
  if (!wholeIn(merged.defaultVolume, MIN_VOLUME, MAX_VOLUME)) {
    throw new InvalidMusic(`The volume is a whole number from ${MIN_VOLUME} to ${MAX_VOLUME}.`);
  }
  if (!wholeIn(merged.maxQueue, MIN_QUEUE, MAX_QUEUE)) {
    throw new InvalidMusic(`The queue holds ${MIN_QUEUE} to ${MAX_QUEUE} songs.`);
  }
  if (typeof merged.announce !== "boolean") {
    throw new InvalidMusic("Now playing messages are on or off.");
  }
  if (!wholeIn(merged.leaveAfterMinutes, 0, MAX_LEAVE_MINUTES)) {
    throw new InvalidMusic(`The bot waits 0 to ${MAX_LEAVE_MINUTES} minutes before leaving.`);
  }
  const clean = Object.fromEntries(KEYS.map((key) => [key, merged[key]]));
  return KEYS.every((key) => clean[key] === DEFAULT_MUSIC[key]) ? null : clean;
}

// For the logs: "DJ <@&1> · volume 80% · queue 200 · now playing on · leaves after 3 min".
export function describeMusic(value) {
  const config = normalizeMusic(value);
  return [
    config.djRoleId ? `DJ <@&${config.djRoleId}>` : "no DJ role",
    `volume ${config.defaultVolume}%`,
    `queue ${config.maxQueue}`,
    `now playing ${config.announce ? "on" : "off"}`,
    config.leaveAfterMinutes === 0 ? "leaves right away" : `leaves after ${config.leaveAfterMinutes} min`,
  ].join(" · ");
}
