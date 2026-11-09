// The weekly leaderboard: every Monday (UTC) the bot posts the members who
// earned the most XP in the 7 days before, in the channel picked on the
// dashboard's Leveling page (Setting.WEEKLY_BOARD_CHANNEL). With a role picked
// (Setting.WEEKLY_BOARD_ROLE), the week's top member gets it and last week's
// loses it.
//
// The first check after a channel is picked only remembers the current week,
// so the first post is the next Monday's. Each week is marked before posting,
// so a crash or restart never posts twice.

import { EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { accentColor } from "../branding/branding.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { Setting } from "../settings/guildSettings.js";
import { openDatabase } from "../storage/database.js";
import { normalizeLeveling } from "./config.js";
import { dayNumber } from "./levelStore.js";

export const BOARD_SIZE = 10;
export const CHECK_EVERY_MS = 10 * 60 * 1000;
const LEVELING_GREEN = 0x22c55e;
const MEDALS = ["🥇", "🥈", "🥉"];
const DAY_MS = 24 * 60 * 60 * 1000;

// Weeks start on Monday (UTC). Day 0 (1 January 1970) was a Thursday.
export const weekNumber = (time) => Math.floor((dayNumber(time) + 3) / 7);
// The first day of a week, as a day number.
export const weekStartDay = (week) => week * 7 - 3;

export class WeeklyBoardStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      get: db.prepare("SELECT week, winner_id FROM weekly_board_posts WHERE guild_id = ?"),
      set: db.prepare(`
        INSERT INTO weekly_board_posts (guild_id, week, winner_id) VALUES (?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET week = excluded.week, winner_id = excluded.winner_id`),
    };
  }

  // { week, winnerId } or undefined.
  get(guildId) {
    const row = this.#statements.get.get(guildId);
    return row ? { week: Number(row.week), winnerId: row.winner_id ?? null } : undefined;
  }

  set(guildId, week, winnerId = null) {
    this.#statements.set.run(guildId, week, winnerId);
  }
}

// The post itself. `top` is levelStore.topBetween's rows.
export function buildWeeklyBoard({ top, language, from, to, color, roleId = null }) {
  const lines = top.map((entry, index) => {
    const place = MEDALS[index] ?? `**${index + 1}.**`;
    return `${place} <@${entry.userId}> · ${translate(language, "weeklyBoardXp", { xp: entry.gained.toLocaleString("en-US") })}`;
  });
  const description = [translate(language, "weeklyBoardIntro", { from: `<t:${Math.floor(from / 1000)}:D>`, to: `<t:${Math.floor(to / 1000)}:D>` }), "", ...lines];
  if (roleId && top[0]) {
    description.push("", translate(language, "weeklyBoardWinner", { user: `<@${top[0].userId}>`, role: `<@&${roleId}>` }));
  }
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(translate(language, "weeklyBoardTitle"))
    .setDescription(description.join("\n"))
    .setFooter({ text: translate(language, "weeklyBoardFooter") });
}

export function createWeeklyBoard({ client, guildSettings, levels, store, logger, forcedLanguage, intervalMs = CHECK_EVERY_MS, now = Date.now }) {
  let timer;
  let running = false;

  // Moves the role from last week's top member to this week's.
  async function passRole(guild, roleId, previousId, winnerId) {
    const role = guild.roles.cache.get(roleId);
    const me = guild.members.me;
    if (!role || !me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
      logger.warn("Couldn't give the weekly top member role; check it exists and is below the bot's role", { guildId: guild.id });
      return;
    }
    if (previousId && previousId !== winnerId) {
      const previous = await guild.members.fetch(previousId).catch(() => null);
      await previous?.roles.remove(roleId, "No longer the week's top member").catch((error) => logger.warn("Couldn't take back the weekly top member role", { guildId: guild.id, error }));
    }
    const winner = await guild.members.fetch(winnerId).catch(() => null);
    await winner?.roles.add(roleId, "The week's top member").catch((error) => logger.warn("Couldn't give the weekly top member role", { guildId: guild.id, error }));
  }

  async function postFor(guild, week) {
    const channelId = guildSettings.get(guild.id, Setting.WEEKLY_BOARD_CHANNEL);
    if (!channelId || !normalizeLeveling(guildSettings.get(guild.id, Setting.LEVELING)).enabled) {
      return;
    }
    const saved = store.get(guild.id);
    if (!saved) {
      store.set(guild.id, week);
      return;
    }
    if (saved.week >= week) {
      return;
    }
    const fromDay = weekStartDay(week - 1);
    const top = levels.topBetween(guild.id, fromDay, fromDay + 7, BOARD_SIZE);
    const roleId = guildSettings.get(guild.id, Setting.WEEKLY_BOARD_ROLE) ?? null;
    // Marked first, so a crash can't post the same week twice.
    store.set(guild.id, week, top[0]?.userId ?? saved.winnerId);
    if (top.length === 0) {
      return;
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased?.()) {
      return;
    }
    const language = pickLanguage(guild.preferredLocale, forcedLanguage);
    const embed = buildWeeklyBoard({
      top,
      language,
      from: fromDay * DAY_MS,
      to: (fromDay + 6) * DAY_MS,
      color: accentColor(guildSettings, guild.id, LEVELING_GREEN),
      roleId,
    });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    if (roleId) {
      await passRole(guild, roleId, saved.winnerId, top[0].userId);
    }
  }

  // Checks every server. Never runs twice at once.
  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      const week = weekNumber(now());
      for (const guild of client.guilds.cache.values()) {
        await postFor(guild, week).catch((error) => logger.warn("Couldn't post the weekly leaderboard; check the bot's permissions in that channel", { guildId: guild.id, error }));
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
      const run = () => sweep().catch((error) => logger.error("Checking weekly leaderboards crashed", { error }));
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
