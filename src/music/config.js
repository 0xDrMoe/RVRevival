// Per-server music settings, saved under Setting.MUSIC:
//
//   djRoleId           with a DJ role, only DJs (and Manage Server) can skip,
//                      stop or change the queue; anyone in the channel can
//                      still add songs and skip their own. null = everyone
//                      is a DJ.
//   djOnly             only DJs can add songs too (needs a DJ role).
//   voteSkipPercent    with a DJ role, members who aren't DJs vote to skip:
//                      the song is skipped once this share of the listeners
//                      voted, 0 (off: they can't skip) to 100.
//   maxSongMinutes     songs longer than this can't be added, 0 = no limit.
//                      Radio and live streams have no length and aren't
//                      affected.
//   stay247            the bot stays in the channel when the queue is done
//                      or nobody is listening (24/7).
//   defaultVolume      1 to 150 (%), the volume a new session starts at.
//   maxQueue           how many songs the queue holds, 10 to 500.
//   announce           post a "Now playing" message for every song.
//   leaveAfterMinutes  how long the bot stays when the queue is done or
//                      nobody is listening, 0 to 60 (unless stay247).

export const MIN_VOLUME = 1;
export const MAX_VOLUME = 150;
export const MIN_QUEUE = 10;
export const MAX_QUEUE = 500;
export const MAX_LEAVE_MINUTES = 60;
export const MAX_SONG_MINUTES = 720;

export const DEFAULT_MUSIC = Object.freeze({
  djRoleId: null,
  djOnly: false,
  voteSkipPercent: 50,
  maxSongMinutes: 0,
  stay247: false,
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
  const djRoleId = typeof value.djRoleId === "string" && SNOWFLAKE.test(value.djRoleId) ? value.djRoleId : null;
  return {
    djRoleId,
    djOnly: Boolean(djRoleId) && value.djOnly === true,
    voteSkipPercent: wholeIn(value.voteSkipPercent, 0, 100) ? value.voteSkipPercent : DEFAULT_MUSIC.voteSkipPercent,
    maxSongMinutes: wholeIn(value.maxSongMinutes, 0, MAX_SONG_MINUTES) ? value.maxSongMinutes : DEFAULT_MUSIC.maxSongMinutes,
    stay247: value.stay247 === true,
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
    throw new InvalidMusic(`Music settings are { ${KEYS.join(", ")} }.`);
  }
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) {
    throw new InvalidMusic(`Unknown music setting "${unknown}".`);
  }
  const merged = { ...DEFAULT_MUSIC, ...value };
  if (merged.djRoleId !== null && !(typeof merged.djRoleId === "string" && isRole(merged.djRoleId))) {
    throw new InvalidMusic("Pick a DJ role from this server (not @everyone), or none.");
  }
  if (typeof merged.djOnly !== "boolean") {
    throw new InvalidMusic("DJ-only mode is on or off.");
  }
  if (merged.djOnly && merged.djRoleId === null) {
    throw new InvalidMusic("DJ-only mode needs a DJ role.");
  }
  if (!wholeIn(merged.voteSkipPercent, 0, 100)) {
    throw new InvalidMusic("Vote skip is a share of listeners from 0 to 100 %.");
  }
  if (!wholeIn(merged.maxSongMinutes, 0, MAX_SONG_MINUTES)) {
    throw new InvalidMusic(`The longest song is 0 (no limit) to ${MAX_SONG_MINUTES} minutes.`);
  }
  if (typeof merged.stay247 !== "boolean") {
    throw new InvalidMusic("24/7 is on or off.");
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

// For the logs: "DJ <@&1> · DJ only · vote skip 50% · ... · leaves after 3 min".
export function describeMusic(value) {
  const config = normalizeMusic(value);
  return [
    config.djRoleId ? `DJ <@&${config.djRoleId}>` : "no DJ role",
    ...(config.djOnly ? ["DJ only"] : []),
    config.voteSkipPercent === 0 ? "vote skip off" : `vote skip ${config.voteSkipPercent}%`,
    config.maxSongMinutes === 0 ? "any length" : `songs up to ${config.maxSongMinutes} min`,
    `volume ${config.defaultVolume}%`,
    `queue ${config.maxQueue}`,
    `now playing ${config.announce ? "on" : "off"}`,
    config.stay247 ? "24/7" : config.leaveAfterMinutes === 0 ? "leaves right away" : `leaves after ${config.leaveAfterMinutes} min`,
  ].join(" · ");
}
