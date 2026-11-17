import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCardSvg, cardFonts, drawable, fitQuote, readableText, renderQuoteCard, wrapText, fetchAvatar } from "../src/quotes/card.js";
import { gifArgs } from "../src/quotes/gif.js";
import { canRemoveQuote, canRestyleQuote, checkQuoteOptions, describeQuoteOptions, InvalidQuoteOptions, normalizeQuoteOptions, quoteAccess } from "../src/quotes/options.js";
import { canShowIn, createQuotes, MAKE_COOLDOWN_MS } from "../src/quotes/quotes.js";
import { MAX_QUOTES_PER_SERVER, QuoteError, QuoteStore, QuoteVia } from "../src/quotes/quoteStore.js";
import { DEFAULT_STYLE, normalizeStyle } from "../src/quotes/style.js";
import { createQuoteCommands } from "../src/commands/quote.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { closeDatabase, openDatabase } from "../src/storage/database.js";
import { createPersonalData } from "../src/members/personalData.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "300000000000000009";
const MAKER_ID = "300000000000000001";
const AUTHOR_ID = "300000000000000002";
const OTHER_ID = "300000000000000003";
const CHANNEL_ID = "500000000000000001";
const PRIVATE_ID = "500000000000000002";
const QUOTE_CHANNEL_ID = "500000000000000003";
const MESSAGE_ID = "600000000000000001";
const VIP = "700000000000000001";
const MOD = "700000000000000002";
const BLOCKED = "700000000000000003";

const roleSet = (ids = []) => ({ cache: new Map(ids.map((id) => [id, { id }])) });
const permissions = (...names) => ({ has: (name) => names.includes(name) });

describe("quote options", () => {
  const isRole = (id) => [VIP, MOD, BLOCKED].includes(id);
  const isChannel = (id) => id === QUOTE_CHANNEL_ID;

  it("fills in the defaults and saves nothing for them", () => {
    const options = normalizeQuoteOptions(undefined);
    expect(options).toMatchObject({ enabled: true, channelId: null, removeOwn: true, selfQuotes: true, botQuotes: true, reactionEmoji: null, reactionCount: 3, style: DEFAULT_STYLE });
    expect(checkQuoteOptions(options, { isRole, isChannel })).toBeNull();
  });

  it("checks roles, channel, reaction and look", () => {
    const saved = checkQuoteOptions(
      { enabled: false, channelId: QUOTE_CHANNEL_ID, makeRoleIds: [VIP], managerRoleIds: [MOD], denyRoleIds: [BLOCKED], reactionEmoji: "💬", reactionCount: 5, style: { ...DEFAULT_STYLE, theme: "ocean", bold: true } },
      { isRole, isChannel },
    );
    expect(saved).toMatchObject({ enabled: false, channelId: QUOTE_CHANNEL_ID, makeRoleIds: [VIP], reactionEmoji: "💬", reactionCount: 5, style: { theme: "ocean", bold: true } });
    expect(describeQuoteOptions(saved)).toContain("off");
    const bad = [
      { channelId: "500000000000000099" },
      { makeRoleIds: ["700000000000000099"] },
      { reactionEmoji: "not an emoji" },
      { reactionCount: 0 },
      { style: { ...DEFAULT_STYLE, theme: "neon" } },
      { enabled: "yes" },
      { surprise: true },
    ];
    for (const value of bad) {
      expect(() => checkQuoteOptions(value, { isRole, isChannel }), JSON.stringify(value)).toThrow(InvalidQuoteOptions);
    }
  });

  it("decides who may make, show, manage, remove and restyle", () => {
    const options = normalizeQuoteOptions({ makeRoleIds: [VIP], denyRoleIds: [BLOCKED] });
    const member = (id, roles = []) => ({ id, roles: roleSet(roles) });
    const plain = quoteAccess({ options, member: member(OTHER_ID), permissions: permissions(), ownerId: OWNER_ID });
    expect(plain).toMatchObject({ manage: false, make: false, view: true });
    expect(quoteAccess({ options, member: member(OTHER_ID, [VIP]), permissions: permissions(), ownerId: OWNER_ID }).make).toBe(true);
    expect(quoteAccess({ options, member: member(OTHER_ID, [VIP, BLOCKED]), permissions: permissions(), ownerId: OWNER_ID })).toMatchObject({ make: false, view: false, denied: true });
    expect(quoteAccess({ options, member: member(OTHER_ID), permissions: permissions("ManageMessages"), ownerId: OWNER_ID })).toMatchObject({ manage: true, make: true });
    expect(quoteAccess({ options, member: member(OTHER_ID, [MOD]), permissions: permissions(), ownerId: OWNER_ID, modRoleId: MOD }).manage).toBe(true);
    expect(quoteAccess({ options, member: member(OWNER_ID, [BLOCKED]), permissions: permissions(), ownerId: OWNER_ID }).make).toBe(true);
    // Manager roles replace Manage Messages.
    const managed = normalizeQuoteOptions({ managerRoleIds: [MOD] });
    expect(quoteAccess({ options: managed, member: member(OTHER_ID), permissions: permissions("ManageMessages"), ownerId: OWNER_ID }).manage).toBe(false);
    expect(quoteAccess({ options: managed, member: member(OTHER_ID), permissions: permissions("ManageGuild"), ownerId: OWNER_ID }).manage).toBe(true);

    const quote = { authorId: AUTHOR_ID, addedBy: MAKER_ID };
    expect(canRemoveQuote(plain, options, quote, AUTHOR_ID)).toBe(true);
    expect(canRemoveQuote(plain, options, quote, MAKER_ID)).toBe(true);
    expect(canRemoveQuote(plain, options, quote, OTHER_ID)).toBe(false);
    expect(canRemoveQuote(plain, normalizeQuoteOptions({ removeOwn: false }), quote, AUTHOR_ID)).toBe(false);
    expect(canRestyleQuote(plain, quote, OTHER_ID)).toBe(false);
    expect(canRestyleQuote(plain, quote, MAKER_ID)).toBe(true);
  });

  it("keeps styles to the known themes and fonts", () => {
    expect(normalizeStyle({ theme: "nope", font: "serif", bold: "yes" })).toEqual({ ...DEFAULT_STYLE, font: "serif" });
    expect(normalizeStyle({}, { theme: "rose", light: true })).toMatchObject({ theme: "rose", light: true, font: "sans" });
  });
});

describe("quote store", () => {
  let db;
  let store;
  const quote = (extra = {}) => ({
    guildId: GUILD_ID,
    content: "Hello there",
    authorId: AUTHOR_ID,
    authorName: "Sam",
    authorUsername: "sam",
    channelId: CHANNEL_ID,
    messageId: null,
    saidAt: 1000,
    addedBy: MAKER_ID,
    addedAt: 2000,
    via: QuoteVia.APP,
    ...extra,
  });

  beforeEach(() => {
    db = openDatabase();
    store = new QuoteStore(db);
  });
  afterEach(() => closeDatabase(db));

  it("numbers quotes per server and never reuses a number", () => {
    expect(store.add(quote()).number).toBe(1);
    expect(store.add(quote()).number).toBe(2);
    expect(store.add(quote({ guildId: "900000000000000002" })).number).toBe(1);
    store.delete(GUILD_ID, 2);
    expect(store.add(quote()).number).toBe(3);
    expect(store.count(GUILD_ID)).toBe(2);
  });

  it("quotes a message once", () => {
    const first = store.add(quote({ messageId: MESSAGE_ID }));
    expect(() => store.add(quote({ messageId: MESSAGE_ID }))).toThrow(QuoteError);
    try {
      store.add(quote({ messageId: MESSAGE_ID }));
    } catch (error) {
      expect(error.reason).toBe("duplicate");
      expect(error.quote.number).toBe(first.number);
    }
    expect(store.byMessage(GUILD_ID, MESSAGE_ID).number).toBe(1);
  });

  it("searches, pages, picks at random and hides private quotes when asked", () => {
    store.add(quote({ content: "I love pizza" }));
    store.add(quote({ content: "100% sure_thing", authorId: OTHER_ID, authorName: "Ana" }));
    store.add(quote({ content: "secret pizza", private: true }));
    store.add(quote({ content: "spicy", nsfw: true }));
    expect(store.search(GUILD_ID, { text: "pizza" }).total).toBe(2);
    expect(store.search(GUILD_ID, { text: "pizza", hidePrivate: true }).quotes.map((entry) => entry.content)).toEqual(["I love pizza"]);
    expect(store.search(GUILD_ID, { text: "%" }).quotes.map((entry) => entry.number)).toEqual([2]);
    expect(store.search(GUILD_ID, { text: "_" }).total).toBe(1);
    expect(store.search(GUILD_ID, { text: "ana" }).total).toBe(1);
    expect(store.search(GUILD_ID, { authorId: OTHER_ID }).total).toBe(1);
    const paged = store.search(GUILD_ID, { page: 2, pageSize: 3 });
    expect(paged).toMatchObject({ total: 4, page: 2, pages: 2 });
    expect(paged.quotes.map((entry) => entry.number)).toEqual([1]);
    expect(store.search(GUILD_ID, { page: 99, pageSize: 3 }).page).toBe(2);
    expect(store.random(GUILD_ID, { random: () => 0 }).number).toBe(1);
    expect(store.random(GUILD_ID, { random: () => 0.99, hidePrivate: true, hideNsfw: true }).number).toBe(2);
    expect(store.random(GUILD_ID, { authorId: "300000000000000077" })).toBeUndefined();
    expect(store.topAuthors(GUILD_ID)[0]).toMatchObject({ authorId: AUTHOR_ID, total: 3 });
  });

  it("keeps style, card, author and edits", () => {
    const saved = store.add(quote());
    store.setStyle(GUILD_ID, saved.number, { theme: "rose" });
    store.setCard(GUILD_ID, saved.number, CHANNEL_ID, MESSAGE_ID);
    store.setAuthor(GUILD_ID, saved.number, { name: "Sammy", username: "sam", avatar: null });
    expect(store.setContent(GUILD_ID, saved.number, "Hello!", 3000)).toBe(true);
    expect(store.get(GUILD_ID, saved.number)).toMatchObject({ style: { theme: "rose" }, cardMessageId: MESSAGE_ID, authorName: "Sammy", content: "Hello!", editedAt: 3000 });
    expect(store.byCard(GUILD_ID, MESSAGE_ID).number).toBe(saved.number);
  });

  it("stops at the server limit", () => {
    const fill = db.prepare(
      "INSERT INTO quotes (guild_id, number, content, author_id, author_name, author_username, said_at, added_by, added_at, via) VALUES (?, ?, 'x', ?, 'a', 'a', 0, ?, 0, 'app')",
    );
    for (let number = 1; number <= MAX_QUOTES_PER_SERVER; number += 1) {
      fill.run(GUILD_ID, number, AUTHOR_ID, MAKER_ID);
    }
    expect(() => store.add(quote())).toThrow(expect.objectContaining({ reason: "full" }));
  });

  it("remembers opt-outs, and /mydata counts and deletes quotes of a member", () => {
    store.optOut(AUTHOR_ID);
    expect(store.isOptedOut(AUTHOR_ID)).toBe(true);
    expect(store.optIn(AUTHOR_ID)).toBe(true);
    expect(store.isOptedOut(AUTHOR_ID)).toBe(false);
    store.add(quote());
    store.add(quote({ guildId: "900000000000000002" }));
    const personal = createPersonalData({ database: db });
    expect(personal.summary(AUTHOR_ID).find((entry) => entry.key === "quotes").count).toBe(2);
    personal.deleteAll(AUTHOR_ID);
    expect(store.count(GUILD_ID)).toBe(0);
  });
});

describe("quote cards", () => {
  it("reads Discord markup as plain words", () => {
    const names = { user: (id) => (id === AUTHOR_ID ? "Sam" : undefined), channel: () => "general", role: () => "Mods" };
    expect(readableText(`**hi** <@${AUTHOR_ID}> <@!${OTHER_ID}> in <#${CHANNEL_ID}> <@&${VIP}> <:wave:123456789012345678> ||secret||`, names)).toBe(
      "hi @Sam @unknown in #general @Mods :wave: [spoiler]",
    );
    expect(readableText("> quoted\n# Title\n`code` ~~gone~~ _soft_")).toBe("quoted\nTitle\ncode gone soft");
    expect(readableText("<t:0:R>")).toBe("1 Jan 1970");
  });

  it("wraps, shrinks and cuts long quotes to fit", async () => {
    const fonts = await cardFonts({});
    const metrics = fonts.quote.metrics;
    expect(drawable("hi 🦋 there", metrics)).toBe("hi there");
    const lines = wrapText("word ".repeat(40).trim(), metrics, 40, 300);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => metrics.width(line, 40) <= 300)).toBe(true);
    expect(wrapText("a".repeat(200), metrics, 40, 300).every((line) => metrics.width(line, 40) <= 300)).toBe(true);
    expect(fitQuote("Short", metrics)).toMatchObject({ size: 64, cut: false });
    const long = fitQuote("long words ".repeat(400), metrics);
    expect(long.cut).toBe(true);
    expect(long.lines.at(-1).endsWith("…")).toBe(true);
  });

  it("draws the avatar, the quote and the names, escaped", async () => {
    const fonts = await cardFonts({ theme: "rose", light: true });
    const svg = buildCardSvg({ quote: { text: "a < b & c", name: "Sam", username: "sam", mark: "Rabble · #1" }, avatar: { type: "image/png", base64: "AAAA" }, style: { theme: "rose", light: true }, fonts });
    expect(svg).toContain("a &#60; b &#38; c");
    expect(svg).toContain("- Sam");
    expect(svg).toContain("@sam");
    expect(svg).toContain('filter="url(#grey)"');
    expect(svg).toContain("#fff0f5");
    const colour = buildCardSvg({ quote: { text: "x", name: "Sam", username: "sam" }, avatar: { type: "image/png", base64: "AAAA" }, style: { color: true }, fonts });
    expect(colour).not.toContain('filter="url(#grey)"');
    const cutout = buildCardSvg({ quote: { text: "x", name: "Sam", username: "sam" }, avatar: { type: "image/png", base64: "AAAA" }, style: {}, fonts, cutout: true });
    expect(cutout).not.toContain("AAAA");
  });

  it("renders a PNG, and only fetches avatars from Discord", async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("not an image"), { headers: { "content-type": "text/html" } }));
    const png = await renderQuoteCard({ text: "Hello", name: "Sam", username: "sam", avatarUrl: "https://cdn.discordapp.com/avatars/1/a.png" }, { font: "hand", bold: true }, { fetchImpl });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(await fetchAvatar("https://evil.example.com/a.png", { fetchImpl })).toBeNull();
    expect(await fetchAvatar("http://cdn.discordapp.com/a.png", { fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("builds ffmpeg arguments that only read local files", () => {
    const args = gifArgs({ avatarFile: "/tmp/a.gif", cardFile: "/tmp/c.png", outFile: "/tmp/o.gif", background: "#000000", grey: true });
    expect(args.filter((arg) => /^https?:/.test(arg))).toEqual([]);
    expect(args.join(" ")).toContain("hue=s=0");
    expect(args.join(" ")).toContain("-t 6");
  });
});

// --- The bot side -----------------------------------------------------------------

function fakeChannel(id, { everyone = true, nsfw = false, botCanPost = true } = {}) {
  return {
    id,
    nsfw,
    isTextBased: () => true,
    permissionsFor: (who) => ({ has: () => (who?.id === GUILD_ID ? everyone : botCanPost) }),
    send: vi.fn(async () => ({ id: "610000000000000001", url: `https://discord.com/channels/${GUILD_ID}/${id}/610000000000000001` })),
    messages: { delete: vi.fn(async () => {}) },
  };
}

function fakeMember(id, { roles = [], name = `Member ${id.slice(-1)}`, avatar = null } = {}) {
  const user = { id, username: `user${id.slice(-1)}`, globalName: name, bot: false, avatar, displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/x.png` };
  return { id, user, displayName: name, avatar: null, roles: roleSet(roles), permissions: permissions(), displayAvatarURL: user.displayAvatarURL };
}

function fakeGuild() {
  const channels = new Map([
    [CHANNEL_ID, fakeChannel(CHANNEL_ID)],
    [PRIVATE_ID, fakeChannel(PRIVATE_ID, { everyone: false })],
    [QUOTE_CHANNEL_ID, fakeChannel(QUOTE_CHANNEL_ID)],
  ]);
  const members = new Map([MAKER_ID, AUTHOR_ID, OTHER_ID].map((id) => [id, fakeMember(id)]));
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    preferredLocale: "en-US",
    roles: { everyone: { id: GUILD_ID }, cache: new Map() },
    channels: { cache: channels },
    members: {
      me: { id: "100000000000000001", displayName: "Rabble" },
      cache: members,
      fetch: vi.fn(async (what) => {
        const id = typeof what === "string" ? what : what.user;
        const member = members.get(id);
        if (!member) {
          throw new Error("Unknown member");
        }
        return member;
      }),
    },
    client: { users: { cache: new Map(), fetch: vi.fn(async (id) => members.get(id)?.user) } },
  };
  return guild;
}

function fakeInteraction(guild, { userId = MAKER_ID, channelId = CHANNEL_ID, perms = permissions(), roles = [], ...extra } = {}) {
  const member = guild.members.cache.get(userId) ?? fakeMember(userId);
  member.roles = roleSet(roles);
  const interaction = {
    guildId: guild.id,
    guild,
    member,
    memberPermissions: perms,
    user: member.user,
    locale: "en-US",
    channelId,
    channel: guild.channels.cache.get(channelId),
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => ({ id: "620000000000000001", channelId })),
    followUp: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    ...extra,
  };
  return interaction;
}

function fakeMessage(guild, { authorId = AUTHOR_ID, channelId = CHANNEL_ID, content = "Pineapple belongs on pizza", bot = false } = {}) {
  const member = guild.members.cache.get(authorId);
  return {
    id: MESSAGE_ID,
    content,
    embeds: [],
    author: { ...member.user, bot },
    member,
    channel: guild.channels.cache.get(channelId),
    channelId,
    createdTimestamp: 5000,
  };
}

describe("quotes in Discord", () => {
  let db;
  let store;
  let guildSettings;
  let guild;
  let clock;
  let render;
  let quotes;

  beforeEach(() => {
    db = openDatabase();
    store = new QuoteStore(db);
    guildSettings = new GuildSettings(db);
    guild = fakeGuild();
    clock = 1_000_000;
    render = vi.fn(async () => Buffer.from("png"));
    quotes = createQuotes({ guildSettings, store, logger: fakeLogger(), now: () => clock, render, renderGif: vi.fn(async () => Buffer.from("gif")) });
  });
  afterEach(() => closeDatabase(db));

  const replyText = (interaction) => (interaction.reply.mock.calls.at(-1)?.[0] ?? interaction.editReply.mock.calls.at(-1)?.[0])?.content;

  it("makes a quote card from a message, in the same channel", async () => {
    const interaction = fakeInteraction(guild, { targetMessage: fakeMessage(guild) });
    const outcome = await quotes.makeFromMessage(interaction);
    expect(outcome.status).toBe("success");
    const quote = store.get(GUILD_ID, 1);
    expect(quote).toMatchObject({ content: "Pineapple belongs on pizza", authorId: AUTHOR_ID, addedBy: MAKER_ID, messageId: MESSAGE_ID, via: "app", private: false, cardMessageId: "620000000000000001" });
    const payload = interaction.editReply.mock.calls[0][0];
    expect(payload.files).toHaveLength(1);
    expect(payload.content).toContain("Quote #1");
    const ids = payload.components.flatMap((row) => row.components.map((component) => component.data.custom_id ?? component.data.url));
    expect(ids).toEqual(["quote:t:1", "quote:c:1", "quote:b:1", "quote:r:1", "quote:f:1", "quote:s:1", "quote:x:1", "quote:g:1", `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`]);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ text: "Pineapple belongs on pizza", mark: "Rabble · #1" }), DEFAULT_STYLE);
  });

  it("refuses quotes the server or the member doesn't allow", async () => {
    const tryIt = async (options, setup = {}) => {
      if (options) {
        await guildSettings.set(GUILD_ID, Setting.QUOTES, options);
      } else {
        await guildSettings.clear(GUILD_ID, Setting.QUOTES);
      }
      clock += MAKE_COOLDOWN_MS;
      const interaction = fakeInteraction(guild, { targetMessage: fakeMessage(guild, setup.message), ...setup.interaction });
      const outcome = await quotes.makeFromMessage(interaction);
      return outcome.key ?? outcome.status;
    };
    expect(await tryIt({ enabled: false })).toBe("quotesOff");
    expect(await tryIt({ makeRoleIds: [VIP] })).toBe("quoteMakeRoles");
    expect(await tryIt({ denyRoleIds: [BLOCKED] }, { interaction: { roles: [BLOCKED] } })).toBe("quoteDenied");
    expect(await tryIt({ selfQuotes: false }, { message: { authorId: MAKER_ID } })).toBe("quoteNoSelf");
    expect(await tryIt({ botQuotes: false }, { message: { bot: true } })).toBe("quoteNoBots");
    expect(await tryIt(null, { message: { content: "" } })).toBe("quoteNoText");
    store.optOut(AUTHOR_ID);
    expect(await tryIt(null)).toBe("quoteOptedOut");
    store.optIn(AUTHOR_ID);
    expect(store.count(GUILD_ID)).toBe(0);
    expect(await tryIt({ makeRoleIds: [VIP] }, { interaction: { roles: [VIP] } })).toBe("success");
  });

  it("shows the existing quote instead of making the same one twice, and slows down fast makers", async () => {
    await quotes.makeFromMessage(fakeInteraction(guild, { targetMessage: fakeMessage(guild) }));
    const again = fakeInteraction(guild, { targetMessage: fakeMessage(guild) });
    expect((await quotes.makeFromMessage(again)).key).toBe("quoteAlready");
    expect(store.count(GUILD_ID)).toBe(1);
    const other = fakeMessage(guild);
    other.id = "600000000000000002";
    expect((await quotes.makeFromMessage(fakeInteraction(guild, { targetMessage: other }))).key).toBe("quoteTooFast");
    clock += MAKE_COOLDOWN_MS;
    expect((await quotes.makeFromMessage(fakeInteraction(guild, { targetMessage: other }))).status).toBe("success");
  });

  it("posts in the quote channel, but never a private channel's quote in a public one", async () => {
    await guildSettings.set(GUILD_ID, Setting.QUOTES, { channelId: QUOTE_CHANNEL_ID });
    const interaction = fakeInteraction(guild, { targetMessage: fakeMessage(guild) });
    await quotes.makeFromMessage(interaction);
    const quoteChannel = guild.channels.cache.get(QUOTE_CHANNEL_ID);
    expect(quoteChannel.send).toHaveBeenCalledTimes(1);
    expect(replyText(interaction)).toContain("Saved as quote #1");
    expect(store.get(GUILD_ID, 1).cardChannelId).toBe(QUOTE_CHANNEL_ID);

    clock += MAKE_COOLDOWN_MS;
    const hidden = fakeMessage(guild, { channelId: PRIVATE_ID });
    hidden.id = "600000000000000003";
    const fromPrivate = fakeInteraction(guild, { channelId: PRIVATE_ID, targetMessage: hidden });
    await quotes.makeFromMessage(fromPrivate);
    expect(quoteChannel.send).toHaveBeenCalledTimes(1);
    expect(store.get(GUILD_ID, 2)).toMatchObject({ private: true, cardChannelId: PRIVATE_ID });

    // Shown in a public channel: only to the member.
    const show = fakeInteraction(guild);
    await quotes.showNumber(show, 2, { privately: false });
    expect(show.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(canShowIn(store.get(GUILD_ID, 2), guild.channels.cache.get(PRIVATE_ID), guild)).toBe(true);
    // Random in a public channel leaves it out.
    const random = fakeInteraction(guild);
    await quotes.showRandom(random, { user: null, privately: false });
    expect(random.editReply.mock.calls[0][0].content).toContain("Quote #1");
  });

  it("adds typed quotes and lists, searches and ranks them", async () => {
    const add = fakeInteraction(guild);
    await quotes.addTyped(add, { user: guild.members.cache.get(AUTHOR_ID).user, text: "I never lose at karts" });
    expect(store.get(GUILD_ID, 1)).toMatchObject({ via: "command", messageId: null, channelId: null });
    expect(add.editReply.mock.calls[0][0].content).toContain("added by");
    const list = fakeInteraction(guild);
    await quotes.listPage(list, { text: "karts", user: null, page: 1 });
    expect(list.reply.mock.calls[0][0].embeds[0].data.description).toContain("#1");
    const none = fakeInteraction(guild);
    expect((await quotes.listPage(none, { text: "zebra", user: null, page: 1 })).key).toBe("quoteSearchNone");
    const top = fakeInteraction(guild);
    await quotes.topAuthors(top);
    expect(top.reply.mock.calls[0][0].embeds[0].data.description).toContain(`<@${AUTHOR_ID}>`);
  });

  it("lets only the right people restyle or remove a card", async () => {
    await quotes.makeFromMessage(fakeInteraction(guild, { targetMessage: fakeMessage(guild) }));
    const press = (customId, userId, extra = {}) => fakeInteraction(guild, { userId, customId, message: { id: "620000000000000001", flags: { has: () => false }, delete: vi.fn(async () => {}) }, ...extra });

    const stranger = press("quote:b:1", OTHER_ID);
    expect((await quotes.handleComponent(stranger)).key).toBe("quoteCantStyle");

    const author = press("quote:b:1", AUTHOR_ID);
    expect(await quotes.handleComponent(author)).toBeNull();
    expect(store.get(GUILD_ID, 1).style).toMatchObject({ bold: true });
    expect(author.editReply.mock.calls[0][0].files).toHaveLength(1);

    const font = press("quote:f:1", MAKER_ID, { values: ["serif"] });
    await quotes.handleComponent(font);
    expect(store.get(GUILD_ID, 1).style).toMatchObject({ bold: true, font: "serif" });

    expect((await quotes.handleComponent(press("quote:x:1", OTHER_ID))).key).toBe("quoteCantRemove");
    const manager = press("quote:x:1", OTHER_ID, { perms: permissions("ManageMessages") });
    expect((await quotes.handleComponent(manager)).status).toBe("success");
    expect(manager.message.delete).toHaveBeenCalled();
    expect(store.get(GUILD_ID, 1)).toBeUndefined();
    expect((await quotes.handleComponent(press("quote:b:1", AUTHOR_ID))).key).toBe("quoteGone");
  });

  it("makes GIFs only for animated avatars, with limits", async () => {
    await quotes.makeFromMessage(fakeInteraction(guild, { targetMessage: fakeMessage(guild) }));
    const press = () => fakeInteraction(guild, { customId: "quote:g:1" });
    expect((await quotes.handleComponent(press())).key).toBe("quoteGifNotAnimated");
    guild.members.cache.get(AUTHOR_ID).user.avatar = "a_123";
    const first = press();
    expect((await quotes.handleComponent(first)).status).toBe("success");
    expect(first.editReply.mock.calls[0][0].files[0].name).toBe("quote-1.gif");
    expect((await quotes.handleComponent(press())).key).toBe("quoteGifTooFast");
  });

  it("removes with /quote delete and opts members out", async () => {
    await quotes.makeFromMessage(fakeInteraction(guild, { targetMessage: fakeMessage(guild) }));
    expect((await quotes.removeNumber(fakeInteraction(guild, { userId: OTHER_ID }), 1)).key).toBe("quoteCantRemove");
    expect((await quotes.removeNumber(fakeInteraction(guild, { userId: AUTHOR_ID }), 1)).status).toBe("success");
    expect((await quotes.removeNumber(fakeInteraction(guild), 1)).key).toBe("quoteNotFound");
    await quotes.setOptOut(fakeInteraction(guild, { userId: AUTHOR_ID }), true);
    expect(store.isOptedOut(AUTHOR_ID)).toBe(true);
  });

  it("turns enough quote reactions into a quote", async () => {
    await guildSettings.set(GUILD_ID, Setting.QUOTES, { reactionEmoji: "💬", reactionCount: 2 });
    const message = fakeMessage(guild);
    message.partial = false;
    message.guild = guild;
    const reaction = (count, users) => ({
      count,
      emoji: { id: null, name: "💬" },
      message,
      users: { fetch: async () => new Map(users.map((id) => [id, { id, bot: false }])) },
    });
    await quotes.reactionAdded(reaction(1, [MAKER_ID]), { id: MAKER_ID, bot: false });
    expect(store.count(GUILD_ID)).toBe(0);
    // The author's own reaction doesn't count.
    await quotes.reactionAdded(reaction(2, [MAKER_ID, AUTHOR_ID]), { id: MAKER_ID, bot: false });
    expect(store.count(GUILD_ID)).toBe(0);
    await quotes.reactionAdded(reaction(2, [MAKER_ID, OTHER_ID]), { id: OTHER_ID, bot: false });
    expect(store.get(GUILD_ID, 1)).toMatchObject({ via: "reaction", addedBy: OTHER_ID });
    expect(guild.channels.cache.get(CHANNEL_ID).send).toHaveBeenCalledWith(expect.objectContaining({ reply: { messageReference: MESSAGE_ID, failIfNotExists: false } }));
    await quotes.reactionAdded(reaction(3, [MAKER_ID, OTHER_ID, "300000000000000004"]), { id: MAKER_ID, bot: false });
    expect(store.count(GUILD_ID)).toBe(1);
  });

  it("routes /quote subcommands", async () => {
    const [command, menu] = createQuoteCommands({ quotes });
    expect(menu.data.type).toBe(3);
    expect(command.data.options.map((option) => option.name)).toEqual(["random", "get", "search", "list", "top", "add", "delete", "opt-out", "opt-in"]);
    const interaction = fakeInteraction(guild, {
      options: { getSubcommand: () => "opt-out", getBoolean: () => null, getUser: () => null, getInteger: () => null, getString: () => "" },
    });
    await command.execute(interaction);
    expect(store.isOptedOut(MAKER_ID)).toBe(true);
  });
});
