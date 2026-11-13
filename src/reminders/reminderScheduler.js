// Sends reminders (/remind) when they're due. The bot checks every 15 seconds,
// so a reminder can arrive a few seconds late; reminders that came due while
// the bot was offline are sent as soon as it's back.
//
// A reminder is posted in the channel it was set in, pinging the member, or
// DMed if they asked for a private one. If the channel is gone or the bot
// can't post there any more, it falls back to a DM.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { SNOOZE_WINDOW_MS } from "./reminderStore.js";
import { sendDm as sendUserDm } from "../utils/dms.js";

// Snooze buttons under a sent reminder: rsz:<reminder id>:<minutes>.
export const SNOOZE_PREFIX = "rsz:";
export const SNOOZE_MINUTES = [10, 60, 1440];

export function snoozeRow(reminderId, language) {
  return new ActionRowBuilder().addComponents(
    SNOOZE_MINUTES.map((minutes) =>
      new ButtonBuilder()
        .setCustomId(`${SNOOZE_PREFIX}${reminderId}:${minutes}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("⏰")
        .setLabel(translate(language, `reminderSnooze_${minutes}`)),
    ),
  );
}

export function parseSnoozeId(customId) {
  const match = /^rsz:(\d+):(\d+)$/.exec(customId ?? "");
  return match && SNOOZE_MINUTES.includes(Number(match[2])) ? { id: Number(match[1]), minutes: Number(match[2]) } : undefined;
}

// Options:
//   client, store (ReminderStore), logger
//   forcedLanguage   the reminder's language (BOT_LANGUAGE); otherwise the server's
export function createReminderScheduler({ client, store, logger, forcedLanguage, intervalMs = 15_000, now = Date.now }) {
  let timer;
  let running = false;

  async function sendDm(reminder, content, components) {
    const user = await client.users.fetch(reminder.userId);
    await sendUserDm(user, { content, components, allowedMentions: { parse: [] } });
  }

  async function deliver(reminder) {
    const guild = client.guilds.cache.get(reminder.guildId);
    const language = pickLanguage(guild?.preferredLocale, forcedLanguage);
    const values = { user: `<@${reminder.userId}>`, when: `<t:${Math.floor(reminder.createdAt / 1000)}:R>`, text: reminder.text };
    const content = translate(language, "reminderDue", values).slice(0, 2000);
    const components = [snoozeRow(reminder.id, language)];

    if (!reminder.private && guild) {
      const channel = guild.channels.cache.get(reminder.channelId);
      if (channel?.isTextBased?.()) {
        try {
          await channel.send({ content, components, allowedMentions: { users: [reminder.userId] } });
          return;
        } catch (error) {
          logger.debug("Couldn't post a reminder in its channel; sending it by DM", { guildId: guild.id, error });
        }
      }
    }
    const dmContent = guild ? `${content}\n-# ${translate(language, "reminderFrom", { server: guild.name })}` : content;
    await sendDm(reminder, dmContent.slice(0, 2000), components).catch((error) =>
      logger.debug("Couldn't DM a reminder; their DMs are closed", { guildId: reminder.guildId, error }),
    );
  }

  // Sends every reminder that is due. Never runs twice at once.
  async function sweep() {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const reminder of store.due(now())) {
        // Marked sent first, so a crash can't send it twice; a reminder that
        // can't be delivered anywhere is dropped rather than retried forever.
        store.markDelivered(reminder.id, now());
        await deliver(reminder).catch((error) =>
          logger.error("Sending a reminder crashed", { guildId: reminder.guildId, error }),
        );
      }
      store.forgetDeliveredBefore(now() - SNOOZE_WINDOW_MS);
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
      const run = () => sweep().catch((error) => logger.error("Checking reminders crashed", { error }));
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
