// Giveaways: a message with an "Enter" button; when time is up the bot picks
// random winners among the members who entered and announces them.
//
// Shared by /giveaway (commands/giveaway.js) and the scheduler that ends
// giveaways on time (giveawayScheduler.js).

import { randomInt } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";

export const BUTTON_PREFIX = "gw:";
export const MIN_GIVEAWAY_MS = 60 * 1000;
export const MAX_GIVEAWAY_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_WINNERS = 20;
export const MAX_PRIZE_LENGTH = 200;
export const MAX_RUNNING_GIVEAWAYS = 10;
// Ended giveaways can be rerolled for this long, then they're forgotten.
export const KEEP_ENDED_MS = 30 * 24 * 60 * 60 * 1000;
// How many entrants are checked (still in the server, still have the role)
// before giving up on filling every winner slot.
const MAX_CANDIDATES_CHECKED = 200;

const COLOR_RUNNING = 0xf1c40f;
const COLOR_ENDED = 0x95a5a6;

export const buttonId = (giveawayId) => `${BUTTON_PREFIX}${giveawayId}`;

export function parseButtonId(customId) {
  const match = /^gw:(\d+)$/.exec(customId);
  return match ? Number(match[1]) : undefined;
}

const timestamp = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
const mentions = (ids) => ids.map((id) => `<@${id}>`).join(", ");

// The language giveaway messages are posted in: the server's.
export const giveawayLanguage = (guild, forcedLanguage) => pickLanguage(guild?.preferredLocale, forcedLanguage);

// The giveaway's message. `state` is "running", "ended" or "cancelled".
export function buildGiveawayMessage(giveaway, { language, entries, state = "running" }) {
  const text = (key, values) => translate(language, key, values);
  const lines = [];
  if (state === "running") {
    lines.push(text("giveawayEmbedEnds", { when: timestamp(giveaway.endsAt, "R"), date: timestamp(giveaway.endsAt, "f") }));
  } else if (state === "ended") {
    lines.push(text("giveawayEmbedEnded", { when: timestamp(giveaway.endedAt ?? giveaway.endsAt, "R") }));
    lines.push(giveaway.winnerIds.length > 0 ? text("giveawayEmbedWinners", { winners: mentions(giveaway.winnerIds) }) : text("giveawayEmbedNoWinners"));
  } else {
    lines.push(text("giveawayEmbedCancelled"));
  }
  lines.push(text("giveawayEmbedHost", { host: `<@${giveaway.hostId}>` }));
  if (state === "running") {
    lines.push(text("giveawayEmbedWinnerCount", { count: giveaway.winnerCount }));
    if (giveaway.requiredRoleId) {
      lines.push(text("giveawayEmbedRole", { role: `<@&${giveaway.requiredRoleId}>` }));
    }
  }
  lines.push(text("giveawayEmbedEntries", { count: entries }));

  const embed = new EmbedBuilder()
    .setColor(state === "running" ? COLOR_RUNNING : COLOR_ENDED)
    .setTitle(`🎉 ${giveaway.prize}`.slice(0, 256))
    .setDescription(lines.join("\n"))
    .setFooter({ text: `#${giveaway.id}` });
  const button = new ButtonBuilder()
    .setCustomId(buttonId(giveaway.id))
    .setEmoji("🎉")
    .setStyle(state === "running" ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setLabel(text(state === "running" ? "giveawayEnterButton" : "giveawayEndedButton"))
    .setDisabled(state !== "running");
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] } };
}

// A random order of `items` (Fisher-Yates, with a cryptographic random source).
export function shuffle(items, random = randomInt) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = random(index + 1);
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list;
}

// Picks up to `count` winners among `entrants`, skipping `exclude` and anyone
// who left the server or no longer has the required role.
export async function pickWinners(guild, giveaway, entrants, { count, exclude = [], random } = {}) {
  const skip = new Set(exclude);
  const winners = [];
  let checked = 0;
  for (const userId of shuffle(entrants, random)) {
    if (winners.length >= count || checked >= MAX_CANDIDATES_CHECKED) {
      break;
    }
    if (skip.has(userId)) {
      continue;
    }
    checked += 1;
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => undefined));
    if (!member || member.user?.bot) {
      continue;
    }
    if (giveaway.requiredRoleId && !member.roles.cache.has(giveaway.requiredRoleId)) {
      continue;
    }
    winners.push(userId);
  }
  return winners;
}

async function fetchGiveawayMessage(guild, giveaway) {
  const channel = guild?.channels.cache.get(giveaway.channelId);
  if (!channel?.isTextBased?.() || !giveaway.messageId) {
    return { channel };
  }
  const message = await channel.messages.fetch(giveaway.messageId).catch(() => undefined);
  return { channel, message };
}

// Posts in the giveaway's channel, as a reply to the giveaway when it still exists.
async function announce(channel, message, content, winnerIds) {
  await channel.send({
    content: content.slice(0, 2000),
    allowedMentions: { users: winnerIds },
    ...(message ? { reply: { messageReference: message.id, failIfNotExists: false } } : {}),
  });
}

// Ends a giveaway: picks winners, updates its message and announces them.
// Returns the ended giveaway, or undefined if it had already ended.
export async function endGiveaway({ giveaway, guild, store, logger, forcedLanguage, now = Date.now, random }) {
  const entrants = store.entries(giveaway.id);
  const winnerIds = guild ? await pickWinners(guild, giveaway, entrants, { count: giveaway.winnerCount, random }) : [];
  const endedAt = now();
  if (!store.markEnded(giveaway.id, endedAt, winnerIds)) {
    return undefined;
  }
  const ended = { ...giveaway, endedAt, winnerIds };
  if (!guild) {
    return ended;
  }
  const language = giveawayLanguage(guild, forcedLanguage);
  const { channel, message } = await fetchGiveawayMessage(guild, giveaway);
  try {
    await message?.edit(buildGiveawayMessage(ended, { language, entries: entrants.length, state: "ended" }));
    if (channel?.isTextBased?.()) {
      const content =
        winnerIds.length > 0
          ? translate(language, "giveawayWon", { winners: mentions(winnerIds), prize: giveaway.prize })
          : translate(language, "giveawayNoEntries", { prize: giveaway.prize });
      await announce(channel, message, content, winnerIds);
    }
  } catch (error) {
    logger.warn("Couldn't announce a giveaway's winners", { guildId: guild.id, giveaway: giveaway.id, error });
  }
  return ended;
}

// Picks `count` new winners for an ended giveaway, never someone who already
// won it, and announces them. Returns the new winners (maybe none).
export async function rerollGiveaway({ giveaway, guild, store, logger, forcedLanguage, count, random }) {
  const winnerIds = await pickWinners(guild, giveaway, store.entries(giveaway.id), {
    count,
    exclude: giveaway.winnerIds,
    random,
  });
  if (winnerIds.length === 0) {
    return winnerIds;
  }
  store.setWinners(giveaway.id, [...giveaway.winnerIds, ...winnerIds]);
  const language = giveawayLanguage(guild, forcedLanguage);
  const { channel, message } = await fetchGiveawayMessage(guild, giveaway);
  if (channel?.isTextBased?.()) {
    await announce(channel, message, translate(language, "giveawayRerollWon", { winners: mentions(winnerIds), prize: giveaway.prize }), winnerIds).catch(
      (error) => logger.warn("Couldn't announce a giveaway's new winners", { guildId: guild.id, giveaway: giveaway.id, error }),
    );
  }
  return winnerIds;
}

// Shows a giveaway as cancelled (the giveaway itself is deleted by the caller).
export async function showCancelled({ giveaway, guild, entries, forcedLanguage }) {
  const { message } = await fetchGiveawayMessage(guild, giveaway);
  await message?.edit(buildGiveawayMessage(giveaway, { language: giveawayLanguage(guild, forcedLanguage), entries, state: "cancelled" }));
}

// Re-draws a running giveaway's message (its entry count).
export async function refreshGiveawayMessage({ giveaway, guild, store, forcedLanguage }) {
  const { message } = await fetchGiveawayMessage(guild, giveaway);
  await message?.edit(
    buildGiveawayMessage(giveaway, { language: giveawayLanguage(guild, forcedLanguage), entries: store.countEntries(giveaway.id) }),
  );
}
