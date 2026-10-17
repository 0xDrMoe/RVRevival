// Posts entries in one of a server's log channels (the logs, mod-log or
// server-log channel from /settings). Posting never throws: if the channel is
// missing or the bot can't post there, the caller carries on and a warning goes
// to the console, once per server and channel until posting works again.
//
// Entries go through a webhook the bot creates in each log channel (it needs
// Manage Webhooks there), so busy logs don't use up the bot's own message rate
// limits. Without the permission, or if the webhook can't be made or used, the
// bot posts as itself. While a post is on its way, new entries for the same
// channel wait and then go out together, up to 10 per message.

import { embedLength, PermissionFlagsBits } from "discord.js";

// Discord's limits for one message.
const MAX_EMBEDS = 10;
const MAX_EMBED_TOTAL = 6000;

// After the webhook couldn't be made (the channel already has 15, say), the bot
// posts as itself for this long before trying again.
const WEBHOOK_RETRY_MS = 10 * 60 * 1000;

// Errors that mean the webhook is gone: Unknown Webhook, Invalid Webhook Token.
const WEBHOOK_GONE = new Set([10015, 50027]);

// Options:
//   guildSettings   where the channels are stored (GuildSettings)
//   logger
//   now             the clock (replaceable in tests)
export function createLogChannelPoster({ guildSettings, logger, now = Date.now }) {
  // "<server id>:<setting>" pairs already warned about.
  const warned = new Set();
  // channel ID (the parent, for threads) -> { webhook } | { promise } | { failedAt }
  const webhooks = new Map();
  // log channel ID -> { busy, pending: entries waiting to be sent }
  const queues = new Map();

  // The first of `settings` that is set, and its channel. Throws if that channel is gone.
  function channelFor(guild, settings) {
    for (const setting of settings) {
      const channelId = guildSettings.get(guild.id, setting);
      if (!channelId) {
        continue;
      }
      const channel = guild.channels?.cache.get(channelId);
      if (!channel?.isTextBased?.()) {
        throw Object.assign(new Error("The log channel no longer exists or isn't a text channel"), { setting });
      }
      return { setting, channel };
    }
    return undefined;
  }

  function warnOnce(guild, setting, error) {
    const key = `${guild.id}:${setting}`;
    if (!warned.has(key)) {
      warned.add(key);
      logger.warn(
        "Couldn't post in the logs channel. Give the bot View Channel, Send Messages, Embed Links and Attach Files there (and Manage Webhooks for faster logs).",
        { guildId: guild.id, setting, channelId: guildSettings.get(guild.id, setting), error },
      );
    }
  }

  function botCanAttachIn(guild, channel) {
    const me = guild.members?.me;
    return Boolean(me && channel.permissionsFor?.(me)?.has(PermissionFlagsBits.AttachFiles));
  }

  // Webhooks belong to a channel; a thread uses its parent's, with a thread ID.
  const webhookChannelOf = (channel) => (channel.isThread?.() ? channel.parent : channel);
  const threadIdOf = (channel) => (channel.isThread?.() ? channel.id : undefined);

  // The bot's webhook for `channel`, made if needed, or undefined to post as the bot.
  async function webhookFor(guild, channel) {
    const target = webhookChannelOf(channel);
    const me = guild.members?.me;
    if (
      !target ||
      !me ||
      typeof target.fetchWebhooks !== "function" ||
      !target.permissionsFor?.(me)?.has(PermissionFlagsBits.ManageWebhooks)
    ) {
      return undefined;
    }
    const cached = webhooks.get(target.id);
    if (cached?.webhook) {
      return cached.webhook;
    }
    if (cached?.promise) {
      return cached.promise;
    }
    if (cached?.failedAt && now() - cached.failedAt < WEBHOOK_RETRY_MS) {
      return undefined;
    }
    const promise = (async () => {
      try {
        const existing = await target.fetchWebhooks();
        const webhook =
          existing.find((hook) => hook.owner?.id === me.id && hook.token) ??
          (await target.createWebhook({
            name: me.user?.username ?? "Logs",
            avatar: me.user?.displayAvatarURL?.() ?? null,
            reason: "Posts the bot's log entries",
          }));
        webhooks.set(target.id, { webhook });
        return webhook;
      } catch (error) {
        logger.debug("Couldn't set up a webhook for a log channel; posting as the bot", {
          guildId: guild.id,
          channelId: target.id,
          error,
        });
        webhooks.set(target.id, { failedAt: now() });
        return undefined;
      }
    })();
    webhooks.set(target.id, { promise });
    return promise;
  }

  // Forgets `webhook` if it's still the cached one for its channel.
  function forgetWebhook(webhook) {
    if (webhooks.get(webhook.channelId)?.webhook === webhook) {
      webhooks.delete(webhook.channelId);
    }
  }

  // Builds entries that weren't built yet, or were built for a different `canAttach`.
  function buildEntries(guild, entries, canAttach) {
    return entries.filter((entry) => {
      if (entry.built && entry.builtFor === canAttach) {
        return true;
      }
      try {
        const { embed, files = [] } = entry.build({ canAttach });
        entry.built = { embed, length: embedLength(embed.toJSON?.() ?? embed), files: canAttach ? files : [] };
        entry.builtFor = canAttach;
        return true;
      } catch (error) {
        warnOnce(guild, entry.setting, error);
        entry.resolve(undefined);
        return false;
      }
    });
  }

  // Takes the entries for the next message off the front of `pending`. Entries
  // with files, or that will be edited later, go on their own.
  function takeBatch(pending) {
    const batch = [pending.shift()];
    if (batch[0].alone || batch[0].built.files.length > 0) {
      return batch;
    }
    let total = batch[0].built.length;
    while (pending.length > 0 && batch.length < MAX_EMBEDS) {
      const next = pending[0];
      const { length } = next.built;
      if (next.alone || next.built.files.length > 0 || total + length > MAX_EMBED_TOTAL) {
        break;
      }
      batch.push(pending.shift());
      total += length;
    }
    return batch;
  }

  const payloadOf = (batch) => ({
    embeds: batch.map((entry) => entry.built.embed),
    files: batch.flatMap((entry) => entry.built.files),
    allowedMentions: { parse: [] },
  });

  // Sends one message for `batch`: through the webhook when there is one, else
  // (or if that fails) as the bot. Returns the message.
  async function sendBatch(guild, channel, webhook, batch) {
    if (webhook) {
      try {
        // The bot's current name and avatar, in case they changed since the webhook was made.
        const user = guild.members?.me?.user;
        return await webhook.send({
          ...payloadOf(batch),
          username: user?.username,
          avatarURL: user?.displayAvatarURL?.(),
          threadId: threadIdOf(channel),
        });
      } catch (error) {
        if (WEBHOOK_GONE.has(error.code)) {
          forgetWebhook(webhook);
        }
        logger.debug("Couldn't post a log entry through the webhook; posting as the bot", {
          guildId: guild.id,
          channelId: channel.id,
          error,
        });
        // The webhook can always attach files; the bot might not be allowed to.
        const canAttach = botCanAttachIn(guild, channel);
        if (!canAttach && batch.some((entry) => entry.built.files.length > 0)) {
          buildEntries(guild, batch, false);
        }
      }
    }
    return channel.send(payloadOf(batch));
  }

  // Sends everything queued for `channel`, one message at a time, in order.
  async function drain(guild, channel, queue) {
    queue.busy = true;
    try {
      while (queue.pending.length > 0) {
        const webhook = await webhookFor(guild, channel);
        const canAttach = Boolean(webhook) || botCanAttachIn(guild, channel);
        queue.pending = buildEntries(guild, queue.pending, canAttach);
        if (queue.pending.length === 0) {
          break;
        }
        const batch = takeBatch(queue.pending);
        try {
          const message = await sendBatch(guild, channel, webhook, batch);
          for (const setting of new Set(batch.map((entry) => entry.setting))) {
            warned.delete(`${guild.id}:${setting}`);
          }
          batch.forEach((entry) => entry.resolve(message));
        } catch (error) {
          warnOnce(guild, batch[0].setting, error);
          batch.forEach((entry) => entry.resolve(undefined));
        }
      }
    } finally {
      queue.busy = false;
    }
  }

  return {
    // Whether any of `settings` has a channel in this server.
    isEnabled: (guild, settings) => Boolean(guild && settings.some((setting) => guildSettings.get(guild.id, setting))),

    // Posts in the first channel of `settings` that is set. `build({ canAttach })`
    // returns { embed, files? }. With `alone`, the entry gets a message of its
    // own (so it can be edited later). Returns the posted message, or undefined.
    async post(guild, settings, build, { alone = false } = {}) {
      if (!guild) {
        return undefined;
      }
      let target;
      try {
        target = channelFor(guild, settings);
      } catch (error) {
        warnOnce(guild, error.setting ?? settings[0], error);
        return undefined;
      }
      if (!target) {
        return undefined;
      }
      const { setting, channel } = target;
      let queue = queues.get(channel.id);
      if (!queue) {
        queue = { busy: false, pending: [] };
        queues.set(channel.id, queue);
      }
      const posted = new Promise((resolve) => queue.pending.push({ setting, build, alone, resolve }));
      if (!queue.busy) {
        drain(guild, channel, queue).catch((error) => logger.error("Log channel queue failed", { guildId: guild.id, error }));
      }
      return posted;
    },

    // Replaces the embed of an earlier entry. Returns whether it worked.
    async edit(guild, channelId, messageId, embed) {
      try {
        const channel = guild?.channels?.cache.get(channelId);
        if (!channel?.isTextBased?.()) {
          return false;
        }
        const message = await channel.messages.fetch(messageId);
        const payload = { embeds: [embed], allowedMentions: { parse: [] } };
        if (message.webhookId) {
          // The bot can't edit a webhook's message; only the webhook can.
          const cached = webhooks.get(webhookChannelOf(channel)?.id)?.webhook;
          const webhook = cached?.id === message.webhookId ? cached : await message.fetchWebhook();
          await webhook.editMessage(messageId, { ...payload, threadId: threadIdOf(channel) });
        } else {
          await message.edit(payload);
        }
        return true;
      } catch (error) {
        logger.debug("Couldn't edit a log entry", { guildId: guild?.id, channelId, messageId, error });
        return false;
      }
    },

    // Call when a channel's webhooks change, so the next post looks again.
    webhooksChanged(channelId) {
      if (!webhooks.get(channelId)?.promise) {
        webhooks.delete(channelId);
      }
    },
  };
}
