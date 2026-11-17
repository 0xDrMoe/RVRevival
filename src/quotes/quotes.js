// Quotes: members turn messages into quote cards (quotes/card.js) that are
// saved in the server's numbered quote book (quotes/quoteStore.js).
//
//   - The Make it a quote app (right-click a message > Apps) makes a quote.
//   - With a quote reaction set on the dashboard, a message that gets enough
//     of that emoji becomes a quote too.
//   - /quote shows, searches and removes quotes (commands/quote.js).
//
// Under every card: light/dark, colour/greyscale avatar, bold and refresh
// buttons, a font menu, a colour theme menu, Remove my quote, To GIF
// (quotes/gif.js) and a link to the message. Whoever made the quote, the
// member quoted and quote managers can change the look; see quotes/options.js
// for who may make, show and remove quotes.
//
// Quotes never leak a channel: a quote from a channel @everyone can't see is
// only shown in channels @everyone can't see either (or only to you), and one
// from an age-restricted channel only in age-restricted channels.

import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder } from "discord.js";
import { accentColor } from "../branding/branding.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { canFeature, emojiMatches } from "../community/starboard.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { moderatorRoleId } from "../moderation/checks.js";
import { derivedSetting, Setting } from "../settings/guildSettings.js";
import { KeyedLock } from "../utils/keyedLock.js";
import { createRateLimiter } from "../utils/rateLimits.js";
import { readableText, renderQuoteCard } from "./card.js";
import { QuoteGifError, renderQuoteGif } from "./gif.js";
import { canRemoveQuote, canRestyleQuote, normalizeQuoteOptions, quoteAccess } from "./options.js";
import { QuoteError, QuoteVia } from "./quoteStore.js";
import { FONT_NAMES, FONTS, normalizeStyle, THEME_NAMES } from "./style.js";

export const QUOTE_PREFIX = "quote:";
// One quote per person every few seconds (each one draws a picture).
export const MAKE_COOLDOWN_MS = 5000;
// GIFs cost the most: one per person every 30 seconds, a few per server a minute.
export const GIF_COOLDOWN_MS = 30_000;
export const GIFS_PER_SERVER_MINUTE = 4;
// Above this many reactions the count is used as is, without checking who reacted.
const MAX_USERS_CHECKED = 100;
const BOT_NAME = "Rabble";

// Button and menu actions, in custom IDs as quote:<action>:<number>.
export const QuoteAction = Object.freeze({
  LIGHT: "t",
  COLOR: "c",
  BOLD: "b",
  REFRESH: "r",
  FONT: "f",
  THEME: "s",
  REMOVE: "x",
  GIF: "g",
});
const ACTIONS = new Set(Object.values(QuoteAction));

export const quoteOptionsOf = (guildSettings, guildId) => derivedSetting(guildSettings, guildId, Setting.QUOTES, normalizeQuoteOptions);

const isNsfw = (channel) => Boolean(channel?.nsfw ?? channel?.parent?.nsfw);
const everyoneCanSee = (channel, guild) => Boolean(channel?.permissionsFor?.(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));

// Whether a quote may be shown to everyone in `channel` (see the top of this file).
export function canShowIn(quote, channel, guild) {
  if (quote.nsfw && !isNsfw(channel)) {
    return false;
  }
  return !quote.private || !everyoneCanSee(channel, guild);
}

// Filters for quotes that fit `channel` (see QuoteStore.search).
export const showableIn = (channel, guild) => ({ hidePrivate: everyoneCanSee(channel, guild), hideNsfw: !isNsfw(channel) });

export const messageLink = (quote) =>
  quote.channelId && quote.messageId ? `https://discord.com/channels/${quote.guildId}/${quote.channelId}/${quote.messageId}` : null;

// A member's name, username and avatar for a card.
export function authorDetails(user, member) {
  const holder = member ?? user;
  return {
    name: member?.displayName ?? user.globalName ?? user.username,
    username: user.username,
    avatar: holder?.displayAvatarURL?.({ extension: "png", size: 512, forceStatic: true }) ?? null,
  };
}

// What a message says, for a quote: its text, or a bot's embed text.
export function messageText(message) {
  const text = message.content?.trim();
  if (text) {
    return text;
  }
  const embed = message.embeds?.[0];
  return [embed?.title, embed?.description].filter(Boolean).join("\n").trim();
}

// Mentions, channels and roles as names, from what the bot knows.
function namesIn(guild) {
  return {
    user: (id) => guild?.members?.cache?.get(id)?.displayName ?? guild?.client?.users?.cache?.get(id)?.username,
    role: (id) => guild?.roles?.cache?.get(id)?.name,
    channel: (id) => guild?.channels?.cache?.get(id)?.name,
  };
}

// The buttons and menus under a card.
export function cardComponents(quote, language, base) {
  const style = normalizeStyle(quote.style, base);
  const text = (key, values) => translate(language, key, values);
  const id = (action) => `${QUOTE_PREFIX}${action}:${quote.number}`;
  const toggle = (action, emoji, on, label) =>
    new ButtonBuilder().setCustomId(id(action)).setEmoji(emoji).setStyle(on ? ButtonStyle.Primary : ButtonStyle.Secondary).setLabel(label);
  const buttons = new ActionRowBuilder().addComponents(
    toggle(QuoteAction.LIGHT, style.light ? "☀️" : "🌙", false, text(style.light ? "quoteButtonLight" : "quoteButtonDark")),
    toggle(QuoteAction.COLOR, "🎨", style.color, text("quoteButtonColor")),
    toggle(QuoteAction.BOLD, "🅱️", style.bold, text("quoteButtonBold")),
    toggle(QuoteAction.REFRESH, "🔄", false, text("quoteButtonRefresh")),
  );
  const fonts = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(id(QuoteAction.FONT))
      .setPlaceholder(text("quoteFontPlaceholder"))
      .addOptions(FONT_NAMES.map((name) => ({ label: `${FONTS[name].family} (${text(`quoteFont_${name}`)})`.slice(0, 100), value: name, default: name === style.font }))),
  );
  const themes = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(id(QuoteAction.THEME))
      .setPlaceholder(text("quoteThemePlaceholder"))
      .addOptions(THEME_NAMES.map((name) => ({ label: text(`quoteTheme_${name}`).slice(0, 100), value: name, default: name === style.theme }))),
  );
  const last = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id(QuoteAction.REMOVE)).setEmoji("🗑️").setStyle(ButtonStyle.Danger).setLabel(text("quoteButtonRemove")),
    new ButtonBuilder().setCustomId(id(QuoteAction.GIF)).setEmoji("🎞️").setStyle(ButtonStyle.Secondary).setLabel(text("quoteButtonGif")),
  );
  const link = messageLink(quote);
  if (link) {
    last.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel(text("quoteButtonJump")));
  }
  return [buttons, fonts, themes, last];
}

// The line above a card: "Quote #12 · said in #general" or "added by @someone".
function cardLine(quote, language) {
  const key = quote.channelId ? "quoteCardLine" : "quoteCardLineAdded";
  return `-# ${translate(language, key, { number: quote.number, channel: `<#${quote.channelId}>`, user: `<@${quote.addedBy}>` })}`;
}

// The quote as an embed, for when the picture can't be drawn.
function fallbackEmbed(quote, guild, settingsSource) {
  return new EmbedBuilder()
    .setColor(accentColor(settingsSource, guild.id, BRAND_COLOR))
    .setAuthor({ name: `${quote.authorName} (@${quote.authorUsername})`.slice(0, 256), iconURL: quote.authorAvatar ?? undefined })
    .setDescription(quote.content.slice(0, 4096))
    .setTimestamp(quote.saidAt);
}

// Options:
//   guildSettings, store (QuoteStore), logger, forcedLanguage, now
//   render, renderGif   card and GIF makers (tests pass stand-ins)
export function createQuotes({ guildSettings, store, logger, forcedLanguage, now = Date.now, render = renderQuoteCard, renderGif = renderQuoteGif }) {
  const makeLimiter = createRateLimiter({ limit: 1, windowMs: MAKE_COOLDOWN_MS, now });
  const gifPerPerson = createRateLimiter({ limit: 1, windowMs: GIF_COOLDOWN_MS, now });
  const gifPerServer = createRateLimiter({ limit: GIFS_PER_SERVER_MINUTE, windowMs: 60_000, now });
  // One reaction quote at a time per message, so quick reactions can't make two.
  const reactionLocks = new KeyedLock();

  const optionsFor = (guildId) => quoteOptionsOf(guildSettings, guildId);
  const languageOf = (interaction) => pickLanguage(interaction?.locale, forcedLanguage);
  const serverLanguage = (guild) => pickLanguage(guild?.preferredLocale, forcedLanguage);

  // What this member may do. `permissions` defaults to the member's own.
  function accessFor(guild, member, permissions = member?.permissions) {
    return quoteAccess({
      options: optionsFor(guild.id),
      member,
      permissions,
      ownerId: guild.ownerId,
      modRoleId: moderatorRoleId(guildSettings, guild.id),
    });
  }

  const answer = async (interaction, status, key, values = {}) => {
    const payload = { content: translate(languageOf(interaction), key, values), allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ ...payload, files: [], components: [], embeds: [] });
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
    return result(status, key, values);
  };

  // Why this member can't make (or show) quotes, as a translation key and
  // values, or null when they can.
  function refusal(guild, access, what) {
    const options = optionsFor(guild.id);
    if (!options.enabled) {
      return { key: "quotesOff" };
    }
    if (access[what]) {
      return null;
    }
    if (access.denied) {
      return { key: "quoteDenied" };
    }
    const roles = (what === "make" ? options.makeRoleIds : options.viewRoleIds).map((id) => `<@&${id}>`).join(", ");
    return { key: what === "make" ? "quoteMakeRoles" : "quoteViewRoles", values: { roles } };
  }

  // The card message for a quote. Draws the picture (falls back to an embed).
  async function cardPayload(quote, guild, language) {
    const base = optionsFor(guild.id).style;
    const style = normalizeStyle(quote.style, base);
    const me = guild.members?.me;
    const mark = `${me?.displayName ?? BOT_NAME} · #${quote.number}`;
    const card = { text: readableText(quote.content, namesIn(guild)), name: quote.authorName, username: quote.authorUsername, mark, avatarUrl: quote.authorAvatar };
    let png = null;
    try {
      png = await render(card, style);
    } catch (error) {
      logger?.warn("Couldn't draw a quote card", { guildId: guild.id, quote: quote.number, error });
    }
    const altText = card.text.slice(0, 1000) || quote.content.slice(0, 1000);
    const payload = {
      content: cardLine(quote, language),
      components: cardComponents(quote, language, base),
      allowedMentions: { parse: [] },
      embeds: [],
      files: [],
      attachments: [],
    };
    if (png) {
      payload.files = [new AttachmentBuilder(png, { name: `quote-${quote.number}.png`, description: `${quote.authorName}: ${altText}`.slice(0, 1024) })];
    } else {
      payload.embeds = [fallbackEmbed(quote, guild, guildSettings)];
    }
    return payload;
  }

  // Where a new card goes: the quote channel when one is set, the bot can post
  // there and it wouldn't leak the message; else null (where it was made).
  function quoteChannelFor(guild, source) {
    const { channelId } = optionsFor(guild.id);
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (!channel?.isTextBased?.() || channel.id === source?.id) {
      return null;
    }
    const me = guild.members.me;
    const allowed = me && channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]);
    return allowed && source && canFeature(source, channel, guild) ? channel : null;
  }

  // Checks shared by the app, /quote add and reactions. Returns a refusal
  // key, or null when `maker` may quote `author`.
  function quoteProblem(guild, options, { author, makerId }) {
    if (author.bot && !options.botQuotes) {
      return "quoteNoBots";
    }
    if (author.id === makerId && !options.selfQuotes) {
      return "quoteNoSelf";
    }
    if (author.id !== makerId && store.isOptedOut(author.id)) {
      return "quoteOptedOut";
    }
    return null;
  }

  // Saves a quote of a message (or of typed text, with no message).
  function saveQuote({ guild, source, message, author, member, content, makerId, via }) {
    const details = authorDetails(author, member);
    return store.add({
      guildId: guild.id,
      content,
      authorId: author.id,
      authorName: details.name,
      authorUsername: details.username,
      authorAvatar: details.avatar,
      channelId: source?.id ?? null,
      messageId: message?.id ?? null,
      saidAt: message?.createdTimestamp ?? now(),
      addedBy: makerId,
      addedAt: now(),
      via,
      private: source ? !everyoneCanSee(source, guild) : false,
      nsfw: source ? isNsfw(source) : false,
    });
  }

  // Posts a new quote's card: in the quote channel when there is one (the
  // maker gets a link), else as the reply to the interaction.
  async function postNewCard(interaction, quote, source) {
    const guild = interaction.guild;
    const language = serverLanguage(guild);
    const channel = quoteChannelFor(guild, source);
    if (channel) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const posted = await channel.send(await cardPayload(quote, guild, language));
      store.setCard(guild.id, quote.number, channel.id, posted.id);
      await interaction.editReply({ content: translate(languageOf(interaction), "quoteSavedIn", { number: quote.number, link: posted.url }), allowedMentions: { parse: [] } });
      return;
    }
    await interaction.deferReply();
    const posted = await interaction.editReply(await cardPayload(quote, guild, language));
    store.setCard(guild.id, quote.number, posted.channelId ?? interaction.channelId, posted.id);
  }

  // A make limit check: true when the member must wait (and was told).
  async function tooSoon(interaction) {
    const key = `${interaction.guildId}:${interaction.user.id}`;
    const wait = makeLimiter.waitTime(key);
    if (wait > 0) {
      await answer(interaction, Status.REFUSED, "quoteTooFast", { seconds: Math.ceil(wait / 1000) });
      return true;
    }
    makeLimiter.take(key);
    return false;
  }

  function addFailed(interaction, error) {
    if (error instanceof QuoteError && error.reason === "full") {
      return answer(interaction, Status.REFUSED, "quoteBookFull");
    }
    throw error;
  }

  // --- Making quotes ---------------------------------------------------------------

  // The Make it a quote app, on `interaction.targetMessage`.
  async function makeFromMessage(interaction) {
    if (!interaction.inCachedGuild()) {
      return answer(interaction, Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const options = optionsFor(guild.id);
    const blocked = refusal(guild, accessFor(guild, interaction.member, interaction.memberPermissions), "make");
    if (blocked) {
      return answer(interaction, Status.REFUSED, blocked.key, blocked.values);
    }
    const message = interaction.targetMessage;
    const author = message.author;
    const problem = quoteProblem(guild, options, { author, makerId: interaction.user.id });
    if (problem) {
      return answer(interaction, Status.REFUSED, problem);
    }
    const content = messageText(message);
    if (!readableText(content)) {
      return answer(interaction, Status.REFUSED, "quoteNoText");
    }
    const existing = store.byMessage(guild.id, message.id);
    if (existing) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await cardPayload(existing, guild, languageOf(interaction));
      await interaction.editReply({ ...payload, content: translate(languageOf(interaction), "quoteAlready", { number: existing.number }) });
      return result(Status.REFUSED, "quoteAlready", { number: existing.number });
    }
    if (await tooSoon(interaction)) {
      return result(Status.REFUSED, "quoteTooFast");
    }
    let quote;
    try {
      const member = message.member ?? (await guild.members.fetch(author.id).catch(() => null));
      quote = saveQuote({ guild, source: message.channel, message, author, member, content, makerId: interaction.user.id, via: QuoteVia.APP });
    } catch (error) {
      if (error instanceof QuoteError && error.reason === "duplicate") {
        return answer(interaction, Status.REFUSED, "quoteAlready", { number: error.quote.number });
      }
      return addFailed(interaction, error);
    }
    await postNewCard(interaction, quote, message.channel);
    return { status: Status.SUCCESS, note: `Made quote #${quote.number} of <@${author.id}>.` };
  }

  // /quote add: words someone said (in voice, say), typed in.
  async function addTyped(interaction, { user, text }) {
    if (!interaction.inCachedGuild()) {
      return answer(interaction, Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const options = optionsFor(guild.id);
    const blocked = refusal(guild, accessFor(guild, interaction.member, interaction.memberPermissions), "make");
    if (blocked) {
      return answer(interaction, Status.REFUSED, blocked.key, blocked.values);
    }
    const problem = quoteProblem(guild, options, { author: user, makerId: interaction.user.id });
    if (problem) {
      return answer(interaction, Status.REFUSED, problem);
    }
    const content = String(text ?? "").trim();
    if (!readableText(content)) {
      return answer(interaction, Status.REFUSED, "quoteNoText");
    }
    if (await tooSoon(interaction)) {
      return result(Status.REFUSED, "quoteTooFast");
    }
    let quote;
    try {
      const member = await guild.members.fetch(user.id).catch(() => null);
      quote = saveQuote({ guild, source: null, message: null, author: user, member, content, makerId: interaction.user.id, via: QuoteVia.COMMAND });
    } catch (error) {
      return addFailed(interaction, error);
    }
    await postNewCard(interaction, quote, interaction.channel);
    return { status: Status.SUCCESS, note: `Added quote #${quote.number} of <@${user.id}>.` };
  }

  // A reaction added (Events.MessageReactionAdd): with enough of the server's
  // quote emoji, the message becomes a quote made by the member who reacted.
  async function reactionAdded(reaction, user) {
    const guild = reaction.message.guild;
    if (!guild || user?.bot) {
      return;
    }
    const options = optionsFor(guild.id);
    if (!options.enabled || !options.reactionEmoji || !emojiMatches(options.reactionEmoji, reaction.emoji)) {
      return;
    }
    if (reaction.partial) {
      reaction = await reaction.fetch().catch(() => reaction);
    }
    if ((reaction.count ?? 0) < options.reactionCount || store.byMessage(guild.id, reaction.message.id)) {
      return;
    }
    await reactionLocks.run(reaction.message.id, async () => {
      if (store.byMessage(guild.id, reaction.message.id)) {
        return;
      }
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const author = message.author;
      // Reactions from bots and from the author don't count.
      if (reaction.count <= MAX_USERS_CHECKED) {
        const users = await reaction.users.fetch({ limit: MAX_USERS_CHECKED });
        if ([...users.values()].filter((entry) => !entry.bot && entry.id !== author.id).length < options.reactionCount) {
          return;
        }
      }
      const maker = await guild.members.fetch(user.id).catch(() => null);
      if (!maker || !accessFor(guild, maker).make || quoteProblem(guild, options, { author, makerId: user.id })) {
        return;
      }
      const content = messageText(message);
      if (!readableText(content)) {
        return;
      }
      let quote;
      try {
        const member = message.member ?? (await guild.members.fetch(author.id).catch(() => null));
        quote = saveQuote({ guild, source: message.channel, message, author, member, content, makerId: user.id, via: QuoteVia.REACTION });
      } catch (error) {
        if (error instanceof QuoteError) {
          return;
        }
        throw error;
      }
      const language = serverLanguage(guild);
      const payload = await cardPayload(quote, guild, language);
      const channel = quoteChannelFor(guild, message.channel);
      const me = guild.members.me;
      const target = channel ?? (me && message.channel.permissionsFor?.(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]) ? message.channel : null);
      if (!target) {
        logger?.info("Saved a quote from reactions but couldn't post its card", { guildId: guild.id, quote: quote.number });
        return;
      }
      const posted = await target.send(channel ? payload : { ...payload, reply: { messageReference: message.id, failIfNotExists: false } });
      store.setCard(guild.id, quote.number, target.id, posted.id);
    });
  }

  // --- Showing quotes -----------------------------------------------------------------

  // Checks a member may show quotes; returns a refusal result or null.
  async function viewRefused(interaction) {
    if (!interaction.inCachedGuild()) {
      return answer(interaction, Status.REFUSED, "guildOnly");
    }
    const blocked = refusal(interaction.guild, accessFor(interaction.guild, interaction.member, interaction.memberPermissions), "view");
    return blocked ? answer(interaction, Status.REFUSED, blocked.key, blocked.values) : null;
  }

  // Shows a quote's card. Only to the member when they ask, or when showing it
  // in this channel would leak where it came from.
  async function showCard(interaction, quote, { privately = false } = {}) {
    const hidden = privately || !canShowIn(quote, interaction.channel, interaction.guild);
    await interaction.deferReply(hidden ? { flags: MessageFlags.Ephemeral } : {});
    const payload = await cardPayload(quote, interaction.guild, hidden ? languageOf(interaction) : serverLanguage(interaction.guild));
    await interaction.editReply(payload);
    return { status: Status.SUCCESS, note: `Showed quote #${quote.number}.` };
  }

  async function showNumber(interaction, number, { privately }) {
    const refused = await viewRefused(interaction);
    if (refused) {
      return refused;
    }
    const quote = store.get(interaction.guildId, number);
    if (!quote) {
      return answer(interaction, Status.REFUSED, "quoteNotFound", { number });
    }
    return showCard(interaction, quote, { privately });
  }

  async function showRandom(interaction, { user, privately }) {
    const refused = await viewRefused(interaction);
    if (refused) {
      return refused;
    }
    const filter = privately ? {} : showableIn(interaction.channel, interaction.guild);
    const quote = store.random(interaction.guildId, { authorId: user?.id ?? null, ...filter });
    if (!quote) {
      return answer(interaction, Status.SUCCESS, user ? "quoteNoneOf" : "quoteNone", { user: user ? `<@${user.id}>` : "" });
    }
    return showCard(interaction, quote, { privately });
  }

  // /quote list and /quote search: a page of quotes, only for the member.
  async function listPage(interaction, { user, text, page }) {
    const refused = await viewRefused(interaction);
    if (refused) {
      return refused;
    }
    const language = languageOf(interaction);
    const found = store.search(interaction.guildId, { authorId: user?.id ?? null, text: text || null, page });
    if (found.total === 0) {
      return answer(interaction, Status.SUCCESS, text ? "quoteSearchNone" : user ? "quoteNoneOf" : "quoteNone", { user: user ? `<@${user.id}>` : "", text: text ?? "" });
    }
    const lines = found.quotes.map((quote) => {
      const words = quote.content.replace(/\s+/g, " ");
      const short = words.length > 180 ? `${words.slice(0, 180).trimEnd()}…` : words;
      const link = messageLink(quote);
      return `**#${quote.number}** ${short}\n-# <@${quote.authorId}>${link ? ` · ${link}` : ""}`;
    });
    const embed = new EmbedBuilder()
      .setColor(accentColor(guildSettings, interaction.guildId, BRAND_COLOR))
      .setTitle(translate(language, text ? "quoteSearchTitle" : "quoteListTitle", { text: text ?? "", count: found.total }).slice(0, 256))
      .setDescription(lines.join("\n\n").slice(0, 4096))
      .setFooter({ text: translate(language, "quotePage", { page: found.page, pages: found.pages }) });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  // /quote top: the most quoted members.
  async function topAuthors(interaction) {
    const refused = await viewRefused(interaction);
    if (refused) {
      return refused;
    }
    const language = languageOf(interaction);
    const top = store.topAuthors(interaction.guildId, 10);
    if (top.length === 0) {
      return answer(interaction, Status.SUCCESS, "quoteNone");
    }
    const embed = new EmbedBuilder()
      .setColor(accentColor(guildSettings, interaction.guildId, BRAND_COLOR))
      .setTitle(translate(language, "quoteTopTitle"))
      .setDescription(top.map((entry, index) => `**${index + 1}.** <@${entry.authorId}> · ${translate(language, "quoteTopCount", { count: entry.total })}`).join("\n"));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  // --- Removing -----------------------------------------------------------------------

  async function deleteCardMessage(guild, quote, skipId = null) {
    if (!quote.cardChannelId || !quote.cardMessageId || quote.cardMessageId === skipId) {
      return;
    }
    const channel = guild.channels.cache.get(quote.cardChannelId);
    await channel?.messages?.delete(quote.cardMessageId).catch(() => {});
  }

  // /quote delete.
  async function removeNumber(interaction, number) {
    if (!interaction.inCachedGuild()) {
      return answer(interaction, Status.REFUSED, "guildOnly");
    }
    const guild = interaction.guild;
    const options = optionsFor(guild.id);
    if (!options.enabled) {
      return answer(interaction, Status.REFUSED, "quotesOff");
    }
    const quote = store.get(guild.id, number);
    if (!quote) {
      return answer(interaction, Status.REFUSED, "quoteNotFound", { number });
    }
    const access = accessFor(guild, interaction.member, interaction.memberPermissions);
    if (!canRemoveQuote(access, options, quote, interaction.user.id)) {
      return answer(interaction, Status.REFUSED, options.removeOwn ? "quoteCantRemove" : "quoteCantRemoveManagers");
    }
    store.delete(guild.id, number);
    await deleteCardMessage(guild, quote);
    await answer(interaction, Status.SUCCESS, "quoteRemoved", { number });
    return { status: Status.SUCCESS, note: `Removed quote #${number} of <@${quote.authorId}>.` };
  }

  // --- Opting out ----------------------------------------------------------------------

  async function setOptOut(interaction, optedOut) {
    if (optedOut) {
      store.optOut(interaction.user.id, now());
    } else {
      store.optIn(interaction.user.id);
    }
    return answer(interaction, Status.SUCCESS, optedOut ? "quoteOptedOutNow" : "quoteOptedInNow");
  }

  // --- Buttons and menus under a card ------------------------------------------------

  // Checks who may press; returns { quote, access, options } or a refusal result.
  async function pressCheck(interaction, number, check) {
    if (!interaction.inCachedGuild()) {
      return { refused: await answer(interaction, Status.REFUSED, "guildOnly") };
    }
    const options = optionsFor(interaction.guildId);
    if (!options.enabled) {
      return { refused: await answer(interaction, Status.REFUSED, "quotesOff") };
    }
    const quote = store.get(interaction.guildId, number);
    if (!quote) {
      return { refused: await answer(interaction, Status.REFUSED, "quoteGone", { number }) };
    }
    const access = accessFor(interaction.guild, interaction.member, interaction.memberPermissions);
    const problem = check(access, options, quote);
    return problem ? { refused: await answer(interaction, Status.REFUSED, problem) } : { quote, access, options };
  }

  // A new look (or refreshed name and avatar), drawn into the same message.
  async function restyle(interaction, quote, change) {
    await interaction.deferUpdate();
    const base = optionsFor(interaction.guildId).style;
    const updated = await change(normalizeStyle(quote.style, base));
    const fresh = store.get(interaction.guildId, quote.number) ?? quote;
    const next = updated ? { ...fresh, style: updated } : fresh;
    if (updated) {
      store.setStyle(interaction.guildId, quote.number, updated);
    }
    const payload = await cardPayload(next, interaction.guild, serverLanguage(interaction.guild));
    // A card shown only to the member keeps their language and its own line.
    if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) {
      payload.components = cardComponents(next, languageOf(interaction), base);
      payload.content = interaction.message.content ?? payload.content;
    }
    await interaction.editReply(payload);
    return null;
  }

  async function refreshAuthor(guild, quote) {
    const member = await guild.members.fetch({ user: quote.authorId, force: true }).catch(() => null);
    const user = member?.user ?? (await guild.client.users.fetch(quote.authorId, { force: true }).catch(() => null));
    if (user) {
      store.setAuthor(guild.id, quote.number, authorDetails(user, member));
    }
    return { member, user };
  }

  async function makeGif(interaction, quote) {
    const guild = interaction.guild;
    const personKey = `${guild.id}:${interaction.user.id}`;
    const wait = Math.max(gifPerPerson.waitTime(personKey), gifPerServer.waitTime(guild.id));
    if (wait > 0) {
      return answer(interaction, Status.REFUSED, "quoteGifTooFast", { seconds: Math.ceil(wait / 1000) });
    }
    if (!canShowIn(quote, interaction.channel, guild)) {
      return answer(interaction, Status.REFUSED, "quoteGifHere");
    }
    const member = await guild.members.fetch(quote.authorId).catch(() => null);
    const user = member?.user ?? (await guild.client.users.fetch(quote.authorId).catch(() => null));
    const animated = (member?.avatar ?? user?.avatar)?.startsWith("a_");
    if (!user || !animated) {
      return answer(interaction, Status.REFUSED, "quoteGifNotAnimated");
    }
    gifPerPerson.take(personKey);
    gifPerServer.take(guild.id);
    await interaction.deferReply();
    const style = normalizeStyle(quote.style, optionsFor(guild.id).style);
    const card = {
      text: readableText(quote.content, namesIn(guild)),
      name: quote.authorName,
      username: quote.authorUsername,
      mark: `${guild.members.me?.displayName ?? BOT_NAME} · #${quote.number}`,
    };
    let gif;
    try {
      gif = await renderGif(card, style, (member ?? user).displayAvatarURL({ extension: "gif", size: 256 }));
    } catch (error) {
      if (error instanceof QuoteGifError) {
        logger?.warn("Couldn't make a quote GIF", { guildId: guild.id, quote: quote.number, reason: error.reason, error });
        return answer(interaction, Status.FAILED, error.reason === "too-big" ? "quoteGifTooBig" : "quoteGifFailed");
      }
      throw error;
    }
    await interaction.editReply({
      content: cardLine(quote, serverLanguage(guild)),
      files: [new AttachmentBuilder(gif, { name: `quote-${quote.number}.gif`, description: `${quote.authorName}: ${card.text}`.slice(0, 1024) })],
      allowedMentions: { parse: [] },
    });
    return { status: Status.SUCCESS, note: `Made a GIF of quote #${quote.number}.` };
  }

  async function handleComponent(interaction) {
    const match = /^quote:([a-z]):(\d{1,9})$/.exec(interaction.customId);
    if (!match || !ACTIONS.has(match[1])) {
      return answer(interaction, Status.FAILED, "unexpected");
    }
    const [, action, raw] = match;
    const number = Number(raw);
    const restyleCheck = (access, options, quote) => (canRestyleQuote(access, quote, interaction.user.id) ? null : "quoteCantStyle");

    switch (action) {
      case QuoteAction.REMOVE: {
        const checked = await pressCheck(interaction, number, (access, options, quote) =>
          canRemoveQuote(access, options, quote, interaction.user.id) ? null : options.removeOwn ? "quoteCantRemove" : "quoteCantRemoveManagers",
        );
        if (checked.refused) {
          return checked.refused;
        }
        const { quote } = checked;
        store.delete(interaction.guildId, number);
        const pressedOn = interaction.message;
        await deleteCardMessage(interaction.guild, quote, pressedOn?.id);
        if (pressedOn && !pressedOn.flags?.has?.(MessageFlags.Ephemeral)) {
          await interaction.deferUpdate();
          await pressedOn.delete().catch(() => interaction.editReply({ content: translate(serverLanguage(interaction.guild), "quoteRemoved", { number }), files: [], attachments: [], embeds: [], components: [] }));
          await interaction.followUp({ content: translate(languageOf(interaction), "quoteRemoved", { number }), flags: MessageFlags.Ephemeral });
        } else {
          await interaction.update({ content: translate(languageOf(interaction), "quoteRemoved", { number }), files: [], attachments: [], embeds: [], components: [] });
        }
        return { status: Status.SUCCESS, note: `Removed quote #${number} of <@${quote.authorId}>.` };
      }
      case QuoteAction.GIF: {
        const checked = await pressCheck(interaction, number, (access) => (access.view ? null : "quoteDenied"));
        return checked.refused ?? makeGif(interaction, checked.quote);
      }
      default: {
        const checked = await pressCheck(interaction, number, restyleCheck);
        if (checked.refused) {
          return checked.refused;
        }
        const picked = interaction.values?.[0];
        return restyle(interaction, checked.quote, async (style) => {
          switch (action) {
            case QuoteAction.LIGHT:
              return { ...style, light: !style.light };
            case QuoteAction.COLOR:
              return { ...style, color: !style.color };
            case QuoteAction.BOLD:
              return { ...style, bold: !style.bold };
            case QuoteAction.FONT:
              return FONT_NAMES.includes(picked) ? { ...style, font: picked } : null;
            case QuoteAction.THEME:
              return THEME_NAMES.includes(picked) ? { ...style, theme: picked } : null;
            case QuoteAction.REFRESH:
              await refreshAuthor(interaction.guild, checked.quote);
              return null;
          }
          return null;
        });
      }
    }
  }

  return {
    makeFromMessage,
    addTyped,
    reactionAdded,
    showNumber,
    showRandom,
    listPage,
    topAuthors,
    removeNumber,
    setOptOut,
    handleComponent,
    accessFor,
    cardPayload,
  };
}
