// Birthdays: members save their birthday with /birthday (month and day, no
// year). When the day starts in the server's time zone, the bot posts a
// greeting in the birthday channel and gives the birthday role for the day.
// Discord has no birthday feature.
//
// Settings (Setting.BIRTHDAYS): { channelId, roleId, message, timezone }. It's
// on when a channel or a role is set. Members born on 29 February are
// celebrated on the 28th in other years.

import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";

export const MAX_BIRTHDAY_MESSAGE_LENGTH = 1000;
export const DEFAULT_TIMEZONE = "UTC";
// How often the bot checks for a new day.
const CHECK_EVERY_MS = 5 * 60 * 1000;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidTimeZone(timezone) {
  if (typeof timezone !== "string" || !timezone || timezone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// Whether a month and day exist in some year (29 February counts).
export const isValidDate = (month, day) =>
  Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];

// The saved settings with defaults, or undefined when birthdays are off.
export function birthdaySettings(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.BIRTHDAYS);
  if (!saved || (!saved.channelId && !saved.roleId)) {
    return undefined;
  }
  return {
    channelId: saved.channelId ?? null,
    roleId: saved.roleId ?? null,
    message: typeof saved.message === "string" && saved.message.trim() ? saved.message : null,
    timezone: isValidTimeZone(saved.timezone) ? saved.timezone : DEFAULT_TIMEZONE,
  };
}

// Today's date in a time zone: { year, month, day, key: "2026-10-16" }.
export function todayIn(timezone, now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day, key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// The [month, day] pairs celebrated today: 29 February moves to the 28th in other years.
export function datesCelebrated({ year, month, day }) {
  const dates = [[month, day]];
  if (month === 2 && day === 28 && !isLeapYear(year)) {
    dates.push([2, 29]);
  }
  return dates;
}

// Days from today until the next birthday (0 = today), for sorting what's coming up.
export function daysUntil(birthday, today) {
  const start = Date.UTC(today.year, today.month - 1, today.day);
  for (const year of [today.year, today.year + 1, today.year + 2, today.year + 3, today.year + 4]) {
    const day = birthday.month === 2 && birthday.day === 29 && !isLeapYear(year) ? 28 : birthday.day;
    const date = Date.UTC(year, birthday.month - 1, day);
    if (date >= start) {
      return Math.round((date - start) / 86_400_000);
    }
  }
  return 366;
}

// "15 March" in the reader's language.
export const formatBirthday = (language, { month, day }) =>
  new Intl.DateTimeFormat(language, { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, day)));

// "<@1>, <@2> and <@3>" in the server's language.
const mentionList = (language, userIds) =>
  new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(userIds.map((id) => `<@${id}>`));

// Options: client, guildSettings, store (BirthdayStore), logger, forcedLanguage, now
export function createBirthdays({ client, guildSettings, store, logger, forcedLanguage, intervalMs = CHECK_EVERY_MS, now = Date.now }) {
  let timer;
  let running = false;

  const fetchMember = (guild, userId) => guild.members.fetch(userId).catch(() => null);

  async function takeBackRoles(guild, config, today) {
    for (const birthday of store.withRole(guild.id)) {
      if (birthday.roleGivenOn === today.key) {
        continue;
      }
      store.markRole(guild.id, birthday.userId, null);
      if (!config.roleId) {
        continue;
      }
      const member = await fetchMember(guild, birthday.userId);
      if (member?.roles.cache.has(config.roleId)) {
        await member.roles.remove(config.roleId, "Their birthday is over").catch((error) =>
          logger.warn("Couldn't take back the birthday role", { guildId: guild.id, error }),
        );
      }
    }
  }

  async function celebrate(guild, config, today) {
    const due = datesCelebrated(today)
      .flatMap(([month, day]) => store.on(guild.id, month, day))
      .filter((birthday) => birthday.celebratedOn !== today.key);
    const celebrated = [];
    for (const birthday of due) {
      // Marked first, so a crash can't announce it twice.
      store.markCelebrated(guild.id, birthday.userId, today.key);
      const member = await fetchMember(guild, birthday.userId);
      if (!member) {
        continue;
      }
      celebrated.push(member.id);
      if (config.roleId) {
        try {
          await member.roles.add(config.roleId, "Happy birthday!");
          store.markRole(guild.id, member.id, today.key);
        } catch (error) {
          logger.warn("Couldn't give the birthday role; check it's below the bot's role", { guildId: guild.id, error });
        }
      }
    }
    if (celebrated.length === 0 || !config.channelId) {
      return;
    }
    const channel = guild.channels.cache.get(config.channelId);
    if (!channel?.isTextBased?.()) {
      return;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    const template = config.message ?? translate(language, "birthdayDefaultMessage");
    const content = template.replaceAll("{user}", mentionList(language, celebrated)).replaceAll("{server}", guild.name).slice(0, 2000);
    await channel.send({ content, allowedMentions: { users: celebrated } }).catch((error) =>
      logger.warn("Couldn't post the birthday message; check the bot's permissions in that channel", { guildId: guild.id, error }),
    );
  }

  // Checks every server for a new day. Never runs twice at once.
  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        const config = birthdaySettings(guildSettings, guild.id);
        if (!config) {
          continue;
        }
        const today = todayIn(config.timezone, now());
        await takeBackRoles(guild, config, today).catch((error) => logger.error("Taking back birthday roles crashed", { guildId: guild.id, error }));
        await celebrate(guild, config, today).catch((error) => logger.error("Celebrating birthdays crashed", { guildId: guild.id, error }));
      }
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    start() {
      if (timer) {
        return;
      }
      const run = () => sweep().catch((error) => logger.error("Checking birthdays crashed", { error }));
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
