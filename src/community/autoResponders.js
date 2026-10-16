// Auto-responders: when a message matches a trigger ("how do I download"),
// the bot replies with a saved answer. Discord's own AutoMod can block or flag
// words but can't answer, so this fills that gap.
//
// Saved in the server's settings (Setting.AUTO_RESPONDERS) as a list of
// { trigger, match, reply, channelId }, sorted by trigger. `channelId` limits
// it to one channel or category (null = everywhere). Managed with
// /autoresponder or on the dashboard's Custom commands page.

import { Setting } from "../settings/guildSettings.js";

export const MAX_RESPONDERS = 25;
// Short enough to fit in the /autoresponder form's custom ID.
export const MAX_TRIGGER_LENGTH = 60;
export const MAX_REPLY_LENGTH = 2000;
// Each auto-responder answers at most once per channel in this time.
export const RESPONDER_COOLDOWN_MS = 30_000;

export const Match = Object.freeze({
  CONTAINS: "contains", // anywhere in the message
  WORD: "word", // as whole words ("hi" matches "hi there", not "this")
  EXACT: "exact", // the whole message
  STARTS: "starts", // the start of the message
});
const MATCHES = Object.values(Match);

// How triggers and messages are compared: case, accents' compatibility forms
// and extra spaces don't matter.
export const cleanTrigger = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const cleanReply = (text) => String(text ?? "").replace(/\r\n?/g, "\n").trim();

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether `content` (already cleaned) sets off this auto-responder.
export function matchesTrigger(responder, content) {
  const trigger = cleanTrigger(responder.trigger);
  if (!trigger) {
    return false;
  }
  switch (responder.match) {
    case Match.EXACT:
      return content === trigger;
    case Match.STARTS:
      return content.startsWith(trigger);
    case Match.WORD:
      return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trigger)}(?![\\p{L}\\p{N}_])`, "u").test(content);
    default:
      return content.includes(trigger);
  }
}

// The server's auto-responders, with anything malformed dropped.
export function respondersOf(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.AUTO_RESPONDERS);
  return Array.isArray(saved)
    ? saved
        .filter((responder) => responder && typeof responder.trigger === "string" && typeof responder.reply === "string")
        .map((responder) => ({
          trigger: responder.trigger,
          match: MATCHES.includes(responder.match) ? responder.match : Match.CONTAINS,
          reply: responder.reply,
          channelId: typeof responder.channelId === "string" ? responder.channelId : null,
        }))
    : [];
}

export const sortResponders = (responders) => [...responders].sort((a, b) => a.trigger.localeCompare(b.trigger));

export class InvalidResponders extends Error {
  name = "InvalidResponders";
}

// Checks a list from the dashboard. `channelOk(id)` says whether a channel or
// category may be picked. Returns the list to save (null when empty).
export function checkResponders(value, channelOk) {
  if (!Array.isArray(value) || value.length > MAX_RESPONDERS) {
    throw new InvalidResponders(`Add at most ${MAX_RESPONDERS} auto-responders.`);
  }
  const responders = value.map((responder) => ({
    trigger: cleanTrigger(responder?.trigger),
    match: responder?.match ?? Match.CONTAINS,
    reply: cleanReply(responder?.reply),
    channelId: responder?.channelId || null,
  }));
  for (const responder of responders) {
    if (!responder.trigger || responder.trigger.length > MAX_TRIGGER_LENGTH) {
      throw new InvalidResponders(`Each auto-responder needs a trigger of 1 to ${MAX_TRIGGER_LENGTH} characters.`);
    }
    if (!MATCHES.includes(responder.match)) {
      throw new InvalidResponders(`"${responder.trigger}" has an unknown match type.`);
    }
    if (!responder.reply || responder.reply.length > MAX_REPLY_LENGTH) {
      throw new InvalidResponders(`"${responder.trigger}" needs a reply of 1 to ${MAX_REPLY_LENGTH} characters.`);
    }
    if (responder.channelId && !channelOk(responder.channelId)) {
      throw new InvalidResponders(`"${responder.trigger}" needs a text channel or category from this server, or everywhere.`);
    }
  }
  const triggers = responders.map((responder) => responder.trigger);
  const duplicate = triggers.find((trigger, index) => triggers.indexOf(trigger) !== index);
  if (duplicate) {
    throw new InvalidResponders(`There are two auto-responders for "${duplicate}".`);
  }
  return responders.length > 0 ? sortResponders(responders) : null;
}

// {user} → a mention (it doesn't ping), {server} → the server's name, {channel} → the channel.
export const fillReply = (reply, message) =>
  reply
    .replaceAll("{user}", `<@${message.author.id}>`)
    .replaceAll("{server}", message.guild?.name ?? "")
    .replaceAll("{channel}", `<#${message.channelId}>`)
    .slice(0, 2000);

// Whether a responder limited to a channel or category applies to where the
// message was posted (a thread counts as its channel).
function appliesTo(responder, channel) {
  if (!responder.channelId) {
    return true;
  }
  const parent = channel?.isThread?.() ? channel.parent : channel;
  return [channel?.id, parent?.id, parent?.parentId].includes(responder.channelId);
}

// Options: guildSettings, logger, now
export function createAutoResponder({ guildSettings, logger, now = Date.now }) {
  // "<channel>:<trigger>" -> when it last answered there
  const lastAnswered = new Map();

  function coolingDown(key) {
    const at = now();
    for (const [entry, time] of lastAnswered) {
      if (at - time >= RESPONDER_COOLDOWN_MS) {
        lastAnswered.delete(entry);
      }
    }
    if (lastAnswered.has(key)) {
      return true;
    }
    lastAnswered.set(key, at);
    return false;
  }

  return {
    // Returns true when it replied.
    async handleMessage(message) {
      if (!message.inGuild?.() || message.author?.bot || message.webhookId || message.system || !message.content) {
        return false;
      }
      const responders = respondersOf(guildSettings, message.guildId);
      if (responders.length === 0) {
        return false;
      }
      const content = cleanTrigger(message.content);
      const responder = responders.find((entry) => appliesTo(entry, message.channel) && matchesTrigger(entry, content));
      if (!responder || coolingDown(`${message.channelId}:${responder.trigger}`)) {
        return false;
      }
      try {
        await message.reply({
          content: fillReply(responder.reply, message),
          allowedMentions: { parse: [], repliedUser: false },
          failIfNotExists: false,
        });
        return true;
      } catch (error) {
        logger.debug("Couldn't post an auto-response", { guildId: message.guildId, channelId: message.channelId, error });
        return false;
      }
    },
  };
}
