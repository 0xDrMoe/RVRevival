// The dashboard page. Plain JavaScript, no build step. Pages are picked by the
// part of the address after "#":
//
//   #/                     your servers
//   #/g/<id>/overview      a server's numbers at a glance
//   #/g/<id>/cases         moderation cases (?q=&action=&user=&moderator=&from=&to=)
//   #/g/<id>/moderation    staff and mod roles, the mod log
//   #/g/<id>/logging       log channels, events and ignored channels
//   #/g/<id>/automod       automod rules, punishments and exemptions
//   #/g/<id>/community     welcome and leave messages, autoroles, role panels
//   #/g/<id>/tags          custom commands (saved answers for /tag)
//   #/g/<id>/country       the /country channel
//   #/g/<id>/access        roles: who can open the dashboard, and every role
//
// Everything shown comes from the JSON API in ../app.js. Text from Discord
// (names, reasons) is always set as text, never as HTML.

const LANGUAGES = { en: "English", es: "Español", de: "Deutsch", fr: "Français", pt: "Português", it: "Italiano", ar: "العربية" };
const LOG_EVENTS = ["messageEdit", "messageDelete", "bulkDelete", "memberJoin", "memberLeave", "memberUpdate"];
const CASE_ACTIONS = ["ban", "softban", "unban", "kick", "timeout", "untimeout", "warn", "note"];
const AUTOMOD_RULES = ["bannedWords", "invites", "links", "mentions", "spam", "duplicates", "caps"];
const AUTOMOD_ACTIONS = ["delete", "warn", "timeout"];
const ESCALATION_ACTIONS = ["timeout", "kick", "ban"];
// The numbers each rule uses: where they live in the automod settings, and their range.
const AUTOMOD_NUMBERS = {
  mentions: [{ path: "rules.mentions.limit", key: "amMentionsLimit", min: 2, max: 50 }],
  spam: [
    { path: "rules.spam.messages", key: "amSpamMessages", min: 3, max: 20 },
    { path: "rules.spam.seconds", key: "amSpamSeconds", min: 2, max: 60 },
  ],
  duplicates: [{ path: "rules.duplicates.count", key: "amDuplicatesCount", min: 2, max: 10 }],
  caps: [
    { path: "rules.caps.percent", key: "amCapsPercent", min: 50, max: 100 },
    { path: "rules.caps.minLength", key: "amCapsMinLength", min: 5, max: 200 },
  ],
};
const MAX_MESSAGE_LENGTH = 1000;
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 2000;
const MAX_AUTOROLES = 10;
// Administrator and Manage Server: roles the bot won't give new members.
const AUTOROLE_FORBIDDEN = (1n << 3n) | (1n << 5n);
const CHANNEL = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, FORUM: 15 };
const DAY_MS = 24 * 60 * 60 * 1000;

// Look and feel, remembered per browser.
const THEMES = ["auto", "light", "dark"];
const ACCENTS = ["blurple", "violet", "pink", "orange", "gold", "green", "cyan", "red"];
const DENSITIES = ["comfortable", "compact"];
const DEFAULT_APPEARANCE = { theme: "auto", accent: "blurple", density: "comfortable" };

// The pages of one server. Pages in the settings group need Manage Server.
const PAGES = [
  { id: "overview", icon: "📊", tone: "blue" },
  { id: "cases", icon: "🗂️", tone: "pink" },
  { id: "moderation", icon: "🛡️", tone: "red", settings: true },
  { id: "logging", icon: "📜", tone: "amber", settings: true },
  { id: "automod", icon: "🤖", tone: "blue", settings: true },
  { id: "community", icon: "👋", tone: "pink", settings: true },
  { id: "tags", icon: "💬", tone: "amber", settings: true },
  { id: "country", icon: "🌍", tone: "green", settings: true },
  { id: "access", icon: "🎭", tone: "purple", settings: true },
];

// Permission bits shown as badges on the roles page. Administrator includes
// all the others, so it's shown alone.
const ADMINISTRATOR = 3n;
const PERMISSIONS = [
  { key: "permManageServer", bit: 5n },
  { key: "permManageRoles", bit: 28n },
  { key: "permManageChannels", bit: 4n },
  { key: "permBan", bit: 2n },
  { key: "permKick", bit: 1n },
  { key: "permTimeout", bit: 40n },
  { key: "permManageMessages", bit: 13n },
];

const state = {
  language: "en",
  strings: {},
  english: {},
  me: null,
  guild: null,
  appearance: { ...DEFAULT_APPEARANCE },
  // Set while a settings page has unsaved changes.
  unsaved: false,
  // The address of the page shown, to go back to if leaving is cancelled.
  lastHash: location.hash,
};
const main = document.getElementById("main");

// --- Storage -------------------------------------------------------------------

// Private windows may refuse storage; choices then just aren't remembered.
function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered.
  }
}

function recall(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

// --- Text --------------------------------------------------------------------

function t(key, values = {}) {
  const text = state.strings[key] ?? state.english[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

async function loadLanguage(language) {
  const load = async (code) => (await fetch(`locales/${code}.json`)).json();
  state.english = Object.keys(state.english).length > 0 ? state.english : await load("en");
  state.strings = language === "en" ? state.english : await load(language);
  state.language = language;
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  remember("language", language);
}

function preferredLanguage() {
  const saved = recall("language");
  const browser = (navigator.language ?? "en").slice(0, 2).toLowerCase();
  return [saved, browser].find((code) => code && code in LANGUAGES) ?? "en";
}

const formatNumber = (value) => new Intl.NumberFormat(state.language).format(value);
const formatDate = (ms) =>
  new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
const formatDay = (ms) => new Intl.DateTimeFormat(state.language, { month: "short", day: "numeric" }).format(new Date(ms));

// "2 hr", "3 days" for case durations.
function formatDuration(ms) {
  const units = [
    ["day", DAY_MS],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const [unit, size] = units.find(([, length]) => ms >= length) ?? units.at(-1);
  return new Intl.NumberFormat(state.language, { style: "unit", unit, unitDisplay: "short" }).format(Math.round(ms / size));
}

// --- Building the page ---------------------------------------------------------

// h("button", { class: "primary", onclick }, "Save") → <button class="primary">Save</button>
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (name.startsWith("on")) {
      element.addEventListener(name.slice(2), value);
    } else if (name in element && name !== "list") {
      element[name] = value;
    } else {
      element.setAttribute(name, value === true ? "" : value);
    }
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// The same for SVG elements (the activity chart).
function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children.flat().filter(Boolean));
  return element;
}

function show(...children) {
  main.replaceChildren(...children);
}

let toastTimer;
function toast(message, kind = "ok") {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), 4000);
}

const avatarUrl = (user) =>
  user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
const iconUrl = (guild) => (guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null);
const initials = (name) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 3);

function guildIcon(guild, size = "md") {
  const url = iconUrl(guild);
  return url
    ? h("img", { class: `guild-icon ${size}`, src: url, alt: "" })
    : h("span", { class: `guild-icon ${size} placeholder`, "aria-hidden": "true" }, initials(guild.name));
}

// One of eight colorful gradients, always the same for a server.
const bannerFor = (id) => `banner-${Number(BigInt(id) % 8n)}`;

// A small dot in the role's color (gray for roles without one).
function roleDot(role) {
  const dot = h("span", { class: "role-dot", "aria-hidden": "true" });
  if (role.color) {
    dot.style.setProperty("--role-color", `#${role.color.toString(16).padStart(6, "0")}`);
  }
  return dot;
}

// A meter or progress bar filled to `fraction` (0 to 1).
function fillBar(className, fraction) {
  const fill = h("span", { class: className });
  fill.style.setProperty("--fill", `${Math.round(fraction * 1000) / 10}%`);
  return fill;
}

function hero(title, intro, tone) {
  return h("header", { class: `hero tone-${tone}` }, h("h1", {}, title), intro ? h("p", {}, intro) : null);
}

function card(title, icon, tone, ...children) {
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card-title" }, h("span", { class: `chip-icon tone-${tone}`, "aria-hidden": "true" }, icon), title),
    ...children,
  );
}

function field(labelKey, helpKey, control) {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, t(labelKey)),
    control,
    helpKey ? h("span", { class: "help" }, t(helpKey)) : null,
  );
}

// --- Look and feel ---------------------------------------------------------------

function applyAppearance() {
  const root = document.documentElement;
  const { theme, accent, density } = state.appearance;
  if (theme === "auto") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
  root.dataset.accent = accent;
  root.dataset.density = density;
}

function loadAppearance() {
  const saved = recall("appearance") ?? {};
  state.appearance = {
    theme: THEMES.includes(saved.theme) ? saved.theme : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULT_APPEARANCE.accent,
    density: DENSITIES.includes(saved.density) ? saved.density : DEFAULT_APPEARANCE.density,
  };
  applyAppearance();
}

function setAppearance(change) {
  Object.assign(state.appearance, change);
  applyAppearance();
  remember("appearance", state.appearance);
}

// Buttons where exactly one is pressed.
function pickOne(buttons, pressed) {
  buttons.forEach((button) => button.setAttribute("aria-pressed", String(button === pressed)));
}

function segmented(label, options, current, onPick) {
  const buttons = options.map(({ value, text }) =>
    h(
      "button",
      {
        type: "button",
        class: "segment",
        "aria-pressed": String(value === current),
        onclick: (event) => {
          pickOne(buttons, event.currentTarget);
          onPick(value);
        },
      },
      text,
    ),
  );
  return h("div", { class: "segmented", role: "group", "aria-label": label }, buttons);
}

function openAppearance() {
  const swatches = ACCENTS.map((accent) =>
    h("button", {
      type: "button",
      class: `swatch accent-${accent}`,
      title: t(`accent_${accent}`),
      "aria-label": t(`accent_${accent}`),
      "aria-pressed": String(accent === state.appearance.accent),
      onclick: (event) => {
        pickOne(swatches, event.currentTarget);
        setAppearance({ accent });
      },
    }),
  );
  const dialog = h(
    "dialog",
    { class: "card appearance" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, t("appearanceTitle")),
      h("p", { class: "help" }, t("appearanceHelp")),
      h("h3", {}, t("appearanceTheme")),
      segmented(
        t("appearanceTheme"),
        THEMES.map((value) => ({ value, text: t(`theme_${value}`) })),
        state.appearance.theme,
        (theme) => setAppearance({ theme }),
      ),
      h("h3", {}, t("appearanceAccent")),
      h("div", { class: "swatches" }, swatches),
      h("h3", {}, t("appearanceDensity")),
      segmented(
        t("appearanceDensity"),
        DENSITIES.map((value) => ({ value, text: t(`density_${value}`) })),
        state.appearance.density,
        (density) => setAppearance({ density }),
      ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            class: "ghost",
            onclick: () => {
              setAppearance({ ...DEFAULT_APPEARANCE });
              dialog.close();
            },
          },
          t("appearanceReset"),
        ),
        h("button", { class: "primary", value: "done" }, t("done")),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// --- Talking to the server -----------------------------------------------------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.me = null;
    renderAccount();
    showLogin();
    throw new ApiError(401, data);
  }
  if (!response.ok) {
    throw new ApiError(response.status, data);
  }
  return data;
}

// Shows a friendly message for anything that went wrong, except a logged-out session.
function failed(error) {
  if (error instanceof ApiError && error.status === 401) {
    return;
  }
  const messages = { 403: t("errorForbidden"), 404: t("errorNotFound"), 429: t("errorTooFast") };
  const message = error instanceof ApiError && error.body?.message ? error.body.message : messages[error.status];
  toast(message ?? t("errorGeneric"), "error");
}

// --- Account -----------------------------------------------------------------

function renderAccount() {
  const account = document.getElementById("account");
  if (!state.me) {
    account.replaceChildren();
    return;
  }
  const { user } = state.me;
  const url = avatarUrl(user);
  account.replaceChildren(
    h(
      "div",
      { class: "account" },
      url
        ? h("img", { class: "avatar", src: url, alt: "" })
        : h("span", { class: "avatar placeholder", "aria-hidden": "true" }, initials(user.username)),
      h("span", { class: "account-name" }, user.username),
      h("button", { class: "ghost small", type: "button", onclick: logout }, t("logout")),
    ),
  );
}

async function logout() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  state.me = null;
  renderAccount();
  location.hash = "#/";
  showLogin();
}

function showLogin() {
  const failedLogin = new URLSearchParams(location.hash.split("?")[1] ?? "").get("login") === "failed";
  show(
    h(
      "section",
      { class: "login card" },
      h("div", { class: "login-art" }, h("img", { src: "favicon.svg", alt: "", width: 72, height: 72 })),
      h("h1", {}, t("loginTitle")),
      h("p", { class: "muted" }, t("loginIntro")),
      failedLogin ? h("p", { class: "error-text" }, t("loginFailed")) : null,
      h("a", { class: "button primary big", href: "/auth/login" }, t("loginButton")),
    ),
  );
}

// --- Servers -----------------------------------------------------------------

async function showServers({ refresh = false } = {}) {
  state.me = await api(`/api/me${refresh ? "?refresh=1" : ""}`);
  renderAccount();
  const ready = state.me.guilds.filter((guild) => guild.botPresent);
  const invitable = state.me.guilds.filter((guild) => !guild.botPresent);

  const serverCard = (guild, { href, banner, badge, extra = {} }) =>
    h(
      "a",
      { class: `server card${guild.botPresent ? "" : " faded"}`, href, "data-name": guild.name.toLowerCase(), ...extra },
      h("span", { class: `server-banner ${banner}` }),
      h("span", { class: "server-body" }, guildIcon(guild), h("span", { class: "server-name" }, guild.name), badge),
    );
  const readyCards = ready.map((guild) =>
    serverCard(guild, {
      href: `#/g/${guild.id}/overview`,
      banner: bannerFor(guild.id),
      badge: h(
        "span",
        { class: `badge ${guild.access === "manage" ? "badge-accent" : "badge-pink"}` },
        t(guild.access === "manage" ? "accessManage" : "accessCases"),
      ),
    }),
  );
  const inviteCards = invitable.map((guild) =>
    serverCard(guild, {
      href: `${state.me.inviteUrl}&guild_id=${guild.id}`,
      banner: "banner-muted",
      badge: h("span", { class: "badge" }, `＋ ${t("serversInvite")}`),
      extra: { target: "_blank", rel: "noopener" },
    }),
  );

  const cards = [...readyCards, ...inviteCards];
  const noMatch = h("p", { class: "muted empty", hidden: true }, t("serversNoMatch"));
  const search = h("input", {
    type: "search",
    class: "grow",
    placeholder: t("serversSearch"),
    "aria-label": t("serversSearch"),
    oninput: () => {
      const text = search.value.trim().toLowerCase();
      cards.forEach((element) => (element.hidden = text !== "" && !element.dataset.name.includes(text)));
      noMatch.hidden = cards.length === 0 || cards.some((element) => !element.hidden);
    },
  });

  show(
    hero(t("serversWelcome", { name: state.me.user.username }), t("serversIntro"), "accent"),
    h(
      "div",
      { class: "toolbar" },
      search,
      h(
        "button",
        { class: "ghost", type: "button", onclick: () => showServers({ refresh: true }).catch(failed) },
        `↻ ${t("serversRefresh")}`,
      ),
    ),
    noMatch,
    readyCards.length > 0 ? h("div", { class: "server-grid" }, readyCards) : h("p", { class: "muted empty" }, t("serversNone")),
    inviteCards.length > 0 ? h("h2", { class: "section-title" }, t("serversWithoutBot")) : null,
    inviteCards.length > 0 ? h("div", { class: "server-grid" }, inviteCards) : null,
  );
}

// --- One server ----------------------------------------------------------------

async function loadGuild(guildId) {
  if (!state.me) {
    state.me = await api("/api/me");
    renderAccount();
  }
  state.guild = await api(`/api/guilds/${guildId}`);
  return state.guild;
}

const canManageGuild = (data) => data.access === "manage";

// The server for a settings page, or undefined (after moving on to the
// overview) for someone who only has a dashboard role.
async function loadManagedGuild(guildId) {
  const data = await loadGuild(guildId);
  if (!canManageGuild(data)) {
    location.replace(`#/g/${guildId}/overview`);
    return undefined;
  }
  return data;
}

// The server's sidebar and the page next to it.
function guildLayout(data, pageId, ...content) {
  const { guild } = data;
  const pages = PAGES.filter((page) => !page.settings || canManageGuild(data));
  const link = (page) =>
    h(
      "a",
      {
        class: `nav-link${page.id === pageId ? " active" : ""}`,
        href: `#/g/${guild.id}/${page.id}`,
        "aria-current": page.id === pageId ? "page" : undefined,
      },
      h("span", { class: `nav-icon tone-${page.tone}`, "aria-hidden": "true" }, page.icon),
      h("span", {}, t(`page_${page.id}`)),
    );
  const counts = [
    guild.memberCount === null ? null : h("span", {}, t("membersCount", { count: formatNumber(guild.memberCount) })),
    guild.onlineCount === null ? null : h("span", { class: "online" }, t("onlineCount", { count: formatNumber(guild.onlineCount) })),
  ];
  const settingsPages = pages.filter((page) => page.settings);
  return h(
    "div",
    { class: "guild-layout" },
    h(
      "aside",
      { class: "sidebar" },
      h("a", { class: "back", href: "#/" }, t("backToServers")),
      h(
        "div",
        { class: `sidebar-guild ${bannerFor(guild.id)}` },
        guildIcon(guild, "lg"),
        h("div", { class: "sidebar-guild-text" }, h("strong", {}, guild.name), h("span", { class: "sidebar-counts" }, counts)),
      ),
      h(
        "nav",
        { class: "nav", "aria-label": guild.name },
        pages.filter((page) => !page.settings).map(link),
        settingsPages.length > 0 ? h("span", { class: "nav-heading" }, t("navSettings")) : null,
        settingsPages.map(link),
      ),
      canManageGuild(data) ? null : h("p", { class: "help sidebar-note" }, t("casesOnlyNote")),
    ),
    h("div", { class: "content" }, ...content),
  );
}

// A <select> of roles or channels, with "Not set" first. A saved value that
// isn't in the list (a deleted channel) stays selected, so saving doesn't clear it.
function picker({ id, options, value, emptyLabel }) {
  const missing = value && !options.some((option) => option.id === value);
  return h(
    "select",
    { id },
    h("option", { value: "" }, emptyLabel),
    missing ? h("option", { value, selected: true }, t("unknownOption", { id: value })) : null,
    options.map((option) => h("option", { value: option.id, selected: option.id === value }, option.label)),
  );
}

const channelLabel = (channel, channels) => {
  const parent = channels.find((other) => other.id === channel.parentId);
  const prefix = channel.type === CHANNEL.CATEGORY ? "▸ " : channel.type === CHANNEL.VOICE ? "🔊 " : "#";
  return parent ? `${prefix}${channel.name} (${parent.name})` : `${prefix}${channel.name}`;
};

const roleOptions = (data) =>
  data.roles.map((role) => ({ id: role.id, label: role.managed ? `@${role.name} (${t("botRole")})` : `@${role.name}` }));
const postableChannels = (data) =>
  data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

// Checkboxes with a filter box, a "ticked only" switch and a count.
function checkList({ name, items, checked, filterKey }) {
  const ticked = new Set(checked);
  const boxes = items.map((item) =>
    h(
      "label",
      { class: "check", "data-name": item.label.toLowerCase() },
      h("input", { type: "checkbox", name, value: item.id, checked: ticked.has(item.id) }),
      item.dot ?? null,
      h("span", {}, item.label),
    ),
  );
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted empty", hidden: true }, t("nothingMatches"));
  const onlyTicked = h("input", { type: "checkbox" });
  const filter = h("input", { type: "search", class: "grow", placeholder: t(filterKey), "aria-label": t(filterKey) });
  const update = () => {
    const text = filter.value.trim().toLowerCase();
    let shown = 0;
    let selected = 0;
    boxes.forEach((box) => {
      const isChecked = box.querySelector("input").checked;
      box.hidden = (text !== "" && !box.dataset.name.includes(text)) || (onlyTicked.checked && !isChecked);
      shown += box.hidden ? 0 : 1;
      selected += isChecked ? 1 : 0;
    });
    count.textContent = t("selectedCount", { count: selected });
    empty.hidden = shown > 0;
  };
  filter.addEventListener("input", update);
  const element = h(
    "div",
    { class: "check-list", onchange: update },
    h("div", { class: "toolbar" }, filter, h("label", { class: "switch" }, onlyTicked, h("span", {}, t("onlyTicked"))), count),
    h("div", { class: "checks scroll" }, boxes, empty),
  );
  update();
  return element;
}

// --- Settings pages -----------------------------------------------------------

// Compares values the way the server stores them: empty lists are "not set",
// and neither list order nor key order matters.
function normalized(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${value.map(normalized).sort().join(",")}]` : "null";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${normalized(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// A settings page: cards of controls, and a save bar that appears when
// something changed. `fields` maps each setting to a function reading its
// value from the form. `after` goes below the form (it isn't saved).
function settingsPage({ data, pageId, intro, cards, fields, after = null }) {
  const guildId = data.guild.id;
  const saved = { ...data.settings };
  const changes = () =>
    Object.fromEntries(
      Object.entries(fields)
        .map(([key, read]) => [key, read(form)])
        .filter(([key, value]) => normalized(value) !== normalized(saved[key])),
    );

  const saveButton = h("button", { class: "primary", type: "submit" }, t("save"));
  const saveBar = h(
    "div",
    { class: "save-bar", hidden: true, role: "status" },
    h("span", { class: "grow" }, t("unsavedChanges")),
    h(
      "button",
      {
        class: "ghost",
        type: "button",
        onclick: () => {
          state.unsaved = false;
          route();
        },
      },
      t("reset"),
    ),
    saveButton,
  );
  const refresh = () => {
    state.unsaved = Object.keys(changes()).length > 0;
    saveBar.hidden = !state.unsaved;
  };
  const form = h(
    "form",
    {
      class: "settings",
      oninput: refresh,
      onchange: refresh,
      onsubmit: async (event) => {
        event.preventDefault();
        const pending = changes();
        if (Object.keys(pending).length === 0) {
          toast(t("noChanges"));
          return;
        }
        saveButton.disabled = true;
        try {
          const result = await api(`/api/guilds/${guildId}/settings`, { method: "PUT", body: pending });
          Object.keys(saved).forEach((key) => delete saved[key]);
          Object.assign(saved, result.settings);
          data.settings = result.settings;
          toast(t("saved"));
          refresh();
        } catch (error) {
          failed(error);
        } finally {
          saveButton.disabled = false;
        }
      },
    },
    cards,
    saveBar,
  );
  const page = PAGES.find((entry) => entry.id === pageId);
  show(guildLayout(data, pageId, hero(t(`page_${pageId}`), intro, page.tone), form, after));
}

const selectValue = (id) => (form) => form.querySelector(`#${id}`).value || null;
const checkedList = (name) => (form) => {
  const ids = [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((box) => box.value);
  return ids.length > 0 ? ids : null;
};

async function showModeration(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const roles = roleOptions(data);
  const rolePicker = (key) => picker({ id: key, options: roles, value: data.settings[key], emptyLabel: t("notSet") });
  settingsPage({
    data,
    pageId: "moderation",
    intro: t("moderationIntro"),
    cards: [
      card(
        t("sectionRoles"),
        "👮",
        "red",
        field("staffRole", "staffRoleHelp", rolePicker("staffRoleId")),
        field("modRole", "modRoleHelp", rolePicker("modRoleId")),
      ),
      card(
        t("sectionModLog"),
        "📋",
        "blue",
        field(
          "modLogChannel",
          "modLogChannelHelp",
          picker({
            id: "modLogChannelId",
            options: postableChannels(data),
            value: data.settings.modLogChannelId,
            emptyLabel: t("useLogsChannel"),
          }),
        ),
      ),
    ],
    fields: {
      staffRoleId: selectValue("staffRoleId"),
      modRoleId: selectValue("modRoleId"),
      modLogChannelId: selectValue("modLogChannelId"),
    },
  });
}

async function showLogging(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const postable = postableChannels(data);
  const channelPicker = (key) => picker({ id: key, options: postable, value: data.settings[key], emptyLabel: t("notSet") });

  const disabled = new Set(data.settings.disabledLogEvents ?? []);
  const eventSwitches = LOG_EVENTS.map((event) =>
    h(
      "label",
      { class: "switch-card" },
      h(
        "span",
        { class: "switch-text" },
        h("strong", {}, t(`logEvent_${event}`)),
        h("span", { class: "help" }, t(`logEventHelp_${event}`)),
      ),
      h(
        "span",
        { class: "switch" },
        h("input", { type: "checkbox", name: "logEvent", value: event, checked: !disabled.has(event), role: "switch" }),
      ),
    ),
  );
  const setAll = (on) => () => {
    eventSwitches.forEach((element) => (element.querySelector("input").checked = on));
    eventSwitches[0].dispatchEvent(new Event("change", { bubbles: true }));
  };

  const ignorable = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

  settingsPage({
    data,
    pageId: "logging",
    intro: t("loggingIntro"),
    cards: [
      card(
        t("sectionChannels"),
        "📨",
        "amber",
        field("logsChannel", "logsChannelHelp", channelPicker("logsChannelId")),
        field("serverLogChannel", "serverLogChannelHelp", channelPicker("serverLogChannelId")),
      ),
      card(
        t("sectionServerLog"),
        "⚡",
        "purple",
        h(
          "div",
          { class: "toolbar" },
          h("p", { class: "help grow" }, t("logEventsHelp")),
          h("button", { class: "ghost small", type: "button", onclick: setAll(true) }, t("allOn")),
          h("button", { class: "ghost small", type: "button", onclick: setAll(false) }, t("allOff")),
        ),
        h("div", { class: "switch-grid" }, eventSwitches),
      ),
      card(
        t("ignoredChannels"),
        "🙈",
        "gray",
        h("p", { class: "help" }, t("ignoredChannelsHelp")),
        checkList({ name: "ignore", items: ignorable, checked: data.settings.logIgnoredChannels ?? [], filterKey: "filterChannels" }),
      ),
    ],
    fields: {
      logsChannelId: selectValue("logsChannelId"),
      serverLogChannelId: selectValue("serverLogChannelId"),
      disabledLogEvents: (form) => {
        const off = [...form.querySelectorAll('input[name="logEvent"]')].filter((box) => !box.checked).map((box) => box.value);
        return off.length > 0 ? off : null;
      },
      logIgnoredChannels: checkedList("ignore"),
    },
  });
}

// --- Automod ---------------------------------------------------------------------

// "https://www.YouTube.com/x" -> "youtube.com", the way the bot saves websites.
const cleanSite = (text) =>
  text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
const lines = (text) => [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];

// An on/off switch whose checkbox is read into the automod settings at `path`.
function automodSwitch(path, checked, label) {
  return h(
    "span",
    { class: "switch" },
    h("input", { type: "checkbox", role: "switch", checked, "data-path": path, "data-kind": "bool", "aria-label": label }),
  );
}

function automodNumber({ path, key, min, max }, config) {
  const value = path.split(".").reduce((object, part) => object[part], config);
  return field(key, null, h("input", { type: "number", min, max, step: 1, required: true, value, "data-path": path, "data-kind": "int" }));
}

function automodSelect(path, options, value, labelPrefix) {
  return h(
    "select",
    { "data-path": path, "data-kind": "text" },
    options.map((option) => h("option", { value: option, selected: option === value }, t(`${labelPrefix}${option}`))),
  );
}

// One rule: its switch, what it does, and its own settings.
function automodRule(rule, config) {
  const settings = config.rules[rule];
  const extra = [];
  if (rule === "bannedWords") {
    extra.push(
      h(
        "label",
        { class: "field wide" },
        h("span", { class: "field-label" }, t("amWords")),
        h("textarea", { rows: 4, "data-path": "rules.bannedWords.words", "data-kind": "words", spellcheck: false }, settings.words.join("\n")),
        h("span", { class: "help" }, t("amWordsHelp")),
      ),
    );
  }
  if (rule === "links") {
    extra.push(
      h(
        "label",
        { class: "field wide" },
        h("span", { class: "field-label" }, t("amSites")),
        h("textarea", { rows: 3, "data-path": "rules.links.allowedDomains", "data-kind": "sites", spellcheck: false }, settings.allowedDomains.join("\n")),
        h("span", { class: "help" }, t("amSitesHelp")),
      ),
    );
  }
  return h(
    "div",
    { class: "rule" },
    h(
      "label",
      { class: "rule-head" },
      h("span", { class: "switch-text" }, h("strong", {}, t(`amRule_${rule}`)), h("span", { class: "help" }, t(`amRuleHelp_${rule}`))),
      automodSwitch(`rules.${rule}.enabled`, settings.enabled, t(`amRule_${rule}`)),
    ),
    h(
      "div",
      { class: "rule-body" },
      field("amAction", null, automodSelect(`rules.${rule}.action`, AUTOMOD_ACTIONS, settings.action, "amAction_")),
      (AUTOMOD_NUMBERS[rule] ?? []).map((number) => automodNumber(number, config)),
      extra,
    ),
  );
}

// Reads the whole automod settings back from the page.
function readAutomod(form, saved) {
  const config = structuredClone(saved);
  for (const input of form.querySelectorAll("[data-path]")) {
    const parts = input.dataset.path.split(".");
    const parent = parts.slice(0, -1).reduce((object, part) => object[part], config);
    const kind = input.dataset.kind;
    parent[parts.at(-1)] =
      kind === "bool"
        ? input.checked
        : kind === "int"
          ? Number.parseInt(input.value, 10)
          : kind === "words"
            ? lines(input.value.toLowerCase().replace(/[ \t]+/g, " "))
            : kind === "sites"
              ? [...new Set(lines(input.value.replace(/[,\s]+/g, "\n")).map(cleanSite).filter(Boolean))]
              : input.value;
  }
  config.exemptRoleIds = [...form.querySelectorAll('input[name="amRole"]:checked')].map((box) => box.value);
  config.exemptChannelIds = [...form.querySelectorAll('input[name="amChannel"]:checked')].map((box) => box.value);
  return config;
}

async function showAutomod(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const config = data.settings.automod;
  const roles = data.roles.filter((role) => !role.managed).map((role) => ({ id: role.id, label: role.name, dot: roleDot(role) }));
  const channels = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));

  settingsPage({
    data,
    pageId: "automod",
    intro: t("automodIntro"),
    cards: [
      card(
        t("amMaster"),
        "🤖",
        "blue",
        h(
          "label",
          { class: "switch-card" },
          h("span", { class: "switch-text" }, h("strong", {}, t("amMaster")), h("span", { class: "help" }, t("amMasterHelp"))),
          automodSwitch("enabled", config.enabled, t("amMaster")),
        ),
        h("p", { class: "help" }, t("amAlwaysExempt")),
      ),
      card(
        t("amRulesTitle"),
        "🧹",
        "pink",
        h("p", { class: "help" }, t("amRulesHelp")),
        h("div", { class: "rules" }, AUTOMOD_RULES.map((rule) => automodRule(rule, config))),
      ),
      card(
        t("amPunishTitle"),
        "⚖️",
        "red",
        h(
          "div",
          { class: "rule-body" },
          field(
            "amTimeoutMinutes",
            "amTimeoutMinutesHelp",
            h("input", { type: "number", min: 1, max: 40320, step: 1, required: true, value: config.timeoutMinutes, "data-path": "timeoutMinutes", "data-kind": "int" }),
          ),
          field(
            "amEscalationWarnings",
            "amEscalationWarningsHelp",
            h("input", { type: "number", min: 0, max: 20, step: 1, required: true, value: config.escalation.warnings, "data-path": "escalation.warnings", "data-kind": "int" }),
          ),
          field("amEscalationAction", null, automodSelect("escalation.action", ESCALATION_ACTIONS, config.escalation.action, "amEscalation_")),
          field(
            "amEscalationMinutes",
            null,
            h("input", { type: "number", min: 1, max: 40320, step: 1, required: true, value: config.escalation.timeoutMinutes, "data-path": "escalation.timeoutMinutes", "data-kind": "int" }),
          ),
        ),
      ),
      card(
        t("amExemptRoles"),
        "🎟️",
        "purple",
        h("p", { class: "help" }, t("amExemptRolesHelp")),
        checkList({ name: "amRole", items: roles, checked: config.exemptRoleIds, filterKey: "filterRoles" }),
      ),
      card(
        t("amExemptChannels"),
        "🙈",
        "gray",
        h("p", { class: "help" }, t("amExemptChannelsHelp")),
        checkList({ name: "amChannel", items: channels, checked: config.exemptChannelIds, filterKey: "filterChannels" }),
      ),
    ],
    fields: { automod: (form) => readAutomod(form, data.settings.automod) },
  });
}

// --- Community -------------------------------------------------------------------

// A message box with a character count. Empty means the default (or off, for the DM).
function messageBox(id, value, placeholder) {
  const count = h("span", { class: "char-count" });
  const box = h("textarea", { id, rows: 3, maxLength: MAX_MESSAGE_LENGTH, placeholder: placeholder ?? "" }, value ?? "");
  const update = () => {
    count.textContent = `${box.value.length}/${MAX_MESSAGE_LENGTH}`;
  };
  box.addEventListener("input", update);
  update();
  return h("span", { class: "message-box" }, box, count);
}

const textValue = (id) => (form) => form.querySelector(`#${id}`).value.replace(/\r\n?/g, "\n").trim() || null;

// The server's role panels, read-only: they're made with /rolepanel in Discord.
function rolePanelList(data) {
  const panels = Array.isArray(data.settings.rolePanels) ? data.settings.rolePanels : [];
  if (panels.length === 0) {
    return h("p", { class: "muted" }, t("rolePanelsNone"));
  }
  const roleName = (id) => data.roles.find((role) => role.id === id)?.name ?? t("unknownOption", { id });
  const channelName = (id) => {
    const channel = data.channels.find((entry) => entry.id === id);
    return channel ? `#${channel.name}` : t("unknownOption", { id });
  };
  return h(
    "ul",
    { class: "panel-list" },
    panels.map((panel) =>
      h(
        "li",
        {},
        h(
          "div",
          { class: "toolbar" },
          h("strong", { class: "grow" }, `#${panel.id} ${panel.title}`),
          h("span", { class: "badge" }, t(`rolePanelMode_${panel.mode === "unique" ? "unique" : "toggle"}`)),
          h("span", { class: "muted" }, channelName(panel.channelId)),
        ),
        h(
          "div",
          { class: "badges" },
          panel.roles.length > 0
            ? panel.roles.map((entry) => h("span", { class: "badge" }, `${entry.emoji ? `${entry.emoji} ` : ""}@${roleName(entry.roleId)}`))
            : h("span", { class: "muted" }, t("rolePanelsEmpty")),
        ),
      ),
    ),
  );
}

async function showCommunity(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const { settings } = data;
  const defaults = data.communityDefaults ?? {};
  const postable = postableChannels(data);
  const channelPicker = (key) => picker({ id: key, options: postable, value: settings[key], emptyLabel: t("communityOff") });
  const givable = data.roles
    .filter((role) => !role.managed && (BigInt(role.permissions ?? 0) & AUTOROLE_FORBIDDEN) === 0n)
    .map((role) => ({ id: role.id, label: `@${role.name}`, dot: roleDot(role) }));

  settingsPage({
    data,
    pageId: "community",
    intro: t("communityIntro"),
    cards: [
      card(
        t("sectionWelcome"),
        "👋",
        "pink",
        field("welcomeChannel", "welcomeChannelHelp", channelPicker("welcomeChannelId")),
        field("welcomeMessage", "messagePlaceholdersHelp", messageBox("welcomeMessage", settings.welcomeMessage, defaults.welcomeMessage)),
        field("welcomeDm", "welcomeDmHelp", messageBox("welcomeDm", settings.welcomeDm, t("welcomeDmPlaceholder"))),
      ),
      card(
        t("sectionLeave"),
        "🚪",
        "gray",
        field("leaveChannel", "leaveChannelHelp", channelPicker("leaveChannelId")),
        field("leaveMessage", "messagePlaceholdersHelp", messageBox("leaveMessage", settings.leaveMessage, defaults.leaveMessage)),
      ),
      card(
        t("sectionAutoroles"),
        "🎁",
        "green",
        h("p", { class: "help" }, t("autorolesHelp", { max: MAX_AUTOROLES })),
        data.guild.community ? h("p", { class: "tip" }, t("onboardingTip")) : null,
        checkList({ name: "autorole", items: givable, checked: settings.autoroleIds ?? [], filterKey: "filterRoles" }),
      ),
    ],
    fields: {
      welcomeChannelId: selectValue("welcomeChannelId"),
      welcomeMessage: textValue("welcomeMessage"),
      welcomeDm: textValue("welcomeDm"),
      leaveChannelId: selectValue("leaveChannelId"),
      leaveMessage: textValue("leaveMessage"),
      autoroleIds: checkedList("autorole"),
    },
    after: card(
      t("sectionRolePanels"),
      "🔘",
      "blue",
      h("p", { class: "help" }, t("rolePanelsHelp")),
      data.guild.community ? h("p", { class: "tip" }, t("rolePanelsOnboardingTip")) : null,
      rolePanelList(data),
    ),
  });
}

// --- Custom commands ---------------------------------------------------------------

// "Download Link" -> "download-link", the way the bot saves tag names; "" if invalid.
function cleanTagName(text) {
  const name = text.trim().toLowerCase().replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return /^[\p{Ll}\p{Lo}\p{N}-]{1,32}$/u.test(name) ? name : "";
}

// One custom command: its name, its text and a remove button.
function tagRow(tag, onRemove) {
  const row = h(
    "div",
    { class: "tag-row" },
    h(
      "div",
      { class: "toolbar" },
      h("span", { class: "tag-slash", "aria-hidden": "true" }, "/tag"),
      h("input", {
        class: "grow tag-name",
        value: tag.name,
        maxLength: 32,
        placeholder: t("tagNamePlaceholder"),
        "aria-label": t("tagName"),
        spellcheck: false,
      }),
      h("button", { class: "ghost small", type: "button", onclick: () => onRemove(row) }, t("tagRemove")),
    ),
    h("textarea", { class: "tag-content", rows: 3, maxLength: MAX_TAG_LENGTH, placeholder: t("tagContentPlaceholder"), "aria-label": t("tagContent") }, tag.content),
  );
  return row;
}

// The custom commands on the page, as the bot saves them. Rows left completely
// empty are ignored; a row with a bad name is sent as typed so the server explains.
function readTags(form) {
  const tags = [...form.querySelectorAll(".tag-row")]
    .map((row) => ({
      typed: row.querySelector(".tag-name").value,
      content: row.querySelector(".tag-content").value.replace(/\r\n?/g, "\n").trim(),
    }))
    .filter((tag) => tag.typed.trim() || tag.content)
    .map((tag) => ({ name: cleanTagName(tag.typed) || tag.typed, content: tag.content }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return tags.length > 0 ? tags : null;
}

async function showTags(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const list = h("div", { class: "tag-list" });
  const count = h("span", { class: "count-pill" });
  const empty = h("p", { class: "muted" }, t("tagsNone"));
  const update = () => {
    const rows = list.querySelectorAll(".tag-row").length;
    count.textContent = t("tagsCount", { count: rows, max: MAX_TAGS });
    empty.hidden = rows > 0;
    addButton.disabled = rows >= MAX_TAGS;
  };
  const changed = () => list.dispatchEvent(new Event("change", { bubbles: true }));
  const remove = (row) => {
    row.remove();
    update();
    changed();
  };
  const addButton = h(
    "button",
    {
      class: "primary small",
      type: "button",
      onclick: () => {
        const row = tagRow({ name: "", content: "" }, remove);
        list.append(row);
        update();
        row.querySelector(".tag-name").focus();
      },
    },
    t("tagAdd"),
  );
  (data.settings.tags ?? []).forEach((tag) => list.append(tagRow(tag, remove)));
  update();

  settingsPage({
    data,
    pageId: "tags",
    intro: t("tagsIntro"),
    cards: [
      card(
        t("sectionTags"),
        "💬",
        "amber",
        h("div", { class: "toolbar" }, h("p", { class: "help grow" }, t("tagsHelp")), count, addButton),
        empty,
        list,
      ),
    ],
    fields: { tags: readTags },
  });
}

async function showCountry(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  settingsPage({
    data,
    pageId: "country",
    intro: t("countryIntro"),
    cards: [
      card(
        t("countryChannel"),
        "🗺️",
        "green",
        field(
          "countryChannel",
          "countryChannelHelp",
          picker({
            id: "countryChannelId",
            options: postableChannels(data),
            value: data.settings.countryChannelId,
            emptyLabel: t("anyChannel"),
          }),
        ),
      ),
    ],
    fields: { countryChannelId: selectValue("countryChannelId") },
  });
}

const hasPermission = (role, bit) => (BigInt(role.permissions) & (1n << bit)) !== 0n;

// Every role in a table, with a name filter and a kind filter.
function rolesTable(data) {
  const { settings } = data;
  const usedAs = (role) =>
    [
      role.id === settings.staffRoleId ? "usedStaff" : null,
      role.id === settings.modRoleId ? "usedMod" : null,
      (settings.dashboardRoleIds ?? []).includes(role.id) ? "usedDashboard" : null,
    ].filter(Boolean);

  const rows = data.roles.map((role) => {
    const admin = hasPermission(role, ADMINISTRATOR);
    const powers = admin ? [] : PERMISSIONS.filter((permission) => hasPermission(role, permission.bit));
    const used = usedAs(role);
    const row = h(
      "tr",
      {},
      h("td", { class: "role-name" }, roleDot(role), h("span", {}, role.emoji ? `${role.emoji} ${role.name}` : role.name)),
      h(
        "td",
        {},
        h(
          "div",
          { class: "badges" },
          role.managed ? h("span", { class: "badge badge-cyan" }, t("botRole")) : null,
          role.hoist ? h("span", { class: "badge" }, t("roleHoisted")) : null,
          admin ? h("span", { class: "badge badge-red" }, t("permAdmin")) : null,
          powers.map((permission) => h("span", { class: "badge badge-amber" }, t(permission.key))),
          !admin && powers.length === 0 && !role.managed ? h("span", { class: "muted" }, "—") : null,
        ),
      ),
      h("td", {}, h("div", { class: "badges" }, used.map((key) => h("span", { class: "badge badge-accent" }, t(key))))),
    );
    row.dataset.name = role.name.toLowerCase();
    row.dataset.kinds = [admin || powers.length > 0 ? "power" : "", role.managed ? "bot" : "", used.length > 0 ? "used" : ""].join(" ");
    return row;
  });

  const empty = h("tr", { hidden: true }, h("td", { colspan: 3, class: "muted empty" }, t("nothingMatches")));
  const shownCount = h("span", { class: "count-pill" });
  const search = h("input", { type: "search", class: "grow", placeholder: t("filterRoles"), "aria-label": t("filterRoles") });
  const kind = h(
    "select",
    { "aria-label": t("roleKind"), class: "auto" },
    ["all", "power", "bot", "used"].map((value) => h("option", { value }, t(`roleKind_${value}`))),
  );
  const filterRoles = () => {
    const text = search.value.trim().toLowerCase();
    let shown = 0;
    rows.forEach((row) => {
      row.hidden =
        (text !== "" && !row.dataset.name.includes(text)) ||
        (kind.value !== "all" && !row.dataset.kinds.split(" ").includes(kind.value));
      shown += row.hidden ? 0 : 1;
    });
    empty.hidden = shown > 0;
    shownCount.textContent = t("rolesShown", { shown, total: rows.length });
  };
  search.addEventListener("input", filterRoles);
  kind.addEventListener("change", filterRoles);
  filterRoles();

  return card(
    t("allRoles"),
    "🏷️",
    "blue",
    h("p", { class: "help" }, t("allRolesHelp")),
    h("div", { class: "toolbar" }, search, kind, shownCount),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "table roles" },
        h("thead", {}, h("tr", {}, ["roleColumn", "rolePowers", "roleUsedAs"].map((key) => h("th", { scope: "col" }, t(key))))),
        h("tbody", {}, rows, empty),
      ),
    ),
  );
}

async function showAccess(guildId) {
  const data = await loadManagedGuild(guildId);
  if (!data) {
    return;
  }
  const dashboardRoles = data.roles
    .filter((role) => !role.managed)
    .map((role) => ({ id: role.id, label: role.name, dot: roleDot(role) }));
  settingsPage({
    data,
    pageId: "access",
    intro: t("accessIntro"),
    cards: [
      card(
        t("dashboardAccess"),
        "🔑",
        "purple",
        h("p", { class: "help" }, t("dashboardAccessHelp")),
        checkList({ name: "dashboardRole", items: dashboardRoles, checked: data.settings.dashboardRoleIds ?? [], filterKey: "filterRoles" }),
      ),
    ],
    fields: { dashboardRoleIds: checkedList("dashboardRole") },
    after: rolesTable(data),
  });
}

// --- Overview ----------------------------------------------------------------

async function showOverview(guildId) {
  const [data, stats] = await Promise.all([
    loadGuild(guildId),
    api(`/api/guilds/${guildId}/stats?tz=${new Date().getTimezoneOffset()}`),
  ]);
  const { guild } = data;
  const casesLink = (params = {}) => {
    const query = new URLSearchParams(params);
    return `#/g/${guildId}/cases${query.size > 0 ? `?${query}` : ""}`;
  };

  const total = Object.values(stats.caseCounts).reduce((sum, count) => sum + count, 0);
  const casesSince = (firstDay) =>
    stats.perDay.filter((entry) => entry.day >= firstDay).reduce((sum, entry) => sum + entry.total, 0);
  const tile = (icon, tone, value, label, sub, href) =>
    h(
      href ? "a" : "div",
      { class: `stat card tone-${tone}`, href },
      h("span", { class: `chip-icon tone-${tone}`, "aria-hidden": "true" }, icon),
      h("span", { class: "stat-value" }, value),
      h("span", { class: "stat-label" }, label),
      sub ? h("span", { class: "stat-sub" }, sub) : null,
    );
  const tiles = h(
    "div",
    { class: "stats" },
    tile(
      "👥",
      "blue",
      guild.memberCount === null ? "—" : formatNumber(guild.memberCount),
      t("statMembers"),
      guild.onlineCount === null ? null : t("onlineCount", { count: formatNumber(guild.onlineCount) }),
    ),
    tile("🗂️", "pink", formatNumber(total), t("statCases"), null, casesLink()),
    tile("📅", "amber", formatNumber(casesSince(stats.days - 7)), t("statWeek")),
    tile("📆", "green", formatNumber(casesSince(0)), t("statMonth")),
    tile("⏳", "red", formatNumber(stats.runningTempBans), t("statTempBans"), null, casesLink({ action: "ban" })),
  );

  // Cases per day, stacked by action. The legend chips show or hide actions.
  const hiddenActions = new Set();
  const chartBox = h("div", { class: "chart" });
  const drawChart = () => {
    const days = Array.from({ length: stats.days }, () => ({}));
    stats.perDay.forEach(({ day, action, total: count }) => {
      if (!hiddenActions.has(action) && days[day]) {
        days[day][action] = count;
      }
    });
    const totals = days.map((day) => Object.values(day).reduce((sum, count) => sum + count, 0));
    const max = Math.max(1, ...totals);
    const width = 10;
    const height = 100;
    const bars = days.map((day, index) => {
      let y = height;
      const actions = CASE_ACTIONS.filter((action) => day[action]);
      const segments = actions.map((action) => {
        const size = (day[action] / max) * (height - 4);
        y -= size;
        return svg("rect", {
          x: index * width + 1.5,
          y: y.toFixed(2),
          width: width - 3,
          height: size.toFixed(2),
          rx: 1.5,
          class: `seg act-${action}`,
        });
      });
      const summary =
        totals[index] === 0
          ? t("chartNoCases")
          : actions.map((action) => `${t(`action_${action}`)}: ${day[action]}`).join(", ");
      return svg(
        "g",
        { class: "bar" },
        svg("title", {}, `${formatDay(stats.dayStarts[index])} · ${summary}`),
        svg("rect", { x: index * width, y: 0, width, height, class: "bar-hit" }),
        segments,
      );
    });
    const grid = [0.25, 0.5, 0.75].map((fraction) =>
      svg("line", { x1: 0, x2: stats.days * width, y1: height * fraction, y2: height * fraction, class: "grid" }),
    );
    chartBox.replaceChildren(
      h("span", { class: "chart-max" }, formatNumber(max)),
      svg(
        "svg",
        { viewBox: `0 0 ${stats.days * width} ${height}`, preserveAspectRatio: "none", role: "img", "aria-label": t("chartTitle") },
        grid,
        bars,
      ),
      h(
        "div",
        { class: "chart-axis" },
        h("span", {}, formatDay(stats.dayStarts[0])),
        h("span", {}, formatDay(stats.dayStarts[Math.floor(stats.days / 2)])),
        h("span", {}, t("today")),
      ),
    );
  };
  const chartActions = CASE_ACTIONS.filter((action) => stats.perDay.some((entry) => entry.action === action));
  const legend = h(
    "div",
    { class: "legend" },
    chartActions.map((action) =>
      h(
        "button",
        {
          type: "button",
          class: `legend-chip act-${action}`,
          "aria-pressed": "true",
          onclick: (event) => {
            const wasHidden = hiddenActions.has(action);
            if (wasHidden) {
              hiddenActions.delete(action);
            } else {
              hiddenActions.add(action);
            }
            event.currentTarget.setAttribute("aria-pressed", String(wasHidden));
            drawChart();
          },
        },
        h("span", { class: "legend-dot" }),
        t(`action_${action}`),
      ),
    ),
  );
  drawChart();

  // All-time cases per action.
  const maxCount = Math.max(1, ...Object.values(stats.caseCounts));
  const breakdown = CASE_ACTIONS.filter((action) => stats.caseCounts[action]).map((action) =>
    h(
      "a",
      { class: "meter-row", href: casesLink({ action }) },
      h("span", { class: "meter-label" }, t(`action_${action}`)),
      h("span", { class: "meter" }, fillBar(`meter-fill act-${action}`, stats.caseCounts[action] / maxCount)),
      h("span", { class: "meter-value" }, formatNumber(stats.caseCounts[action])),
    ),
  );

  const leaderboard = (people, param) =>
    people.length === 0
      ? h("p", { class: "muted empty" }, t("nothingYet"))
      : h(
          "ol",
          { class: "leaders" },
          people.map((somebody, index) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: casesLink({ [param]: somebody.id }) },
                h("span", { class: `rank rank-${index + 1}` }, String(index + 1)),
                h("span", { class: "leader-name" }, somebody.tag ?? somebody.id),
                h("span", { class: "count-pill" }, formatNumber(somebody.total)),
              ),
            ),
          ),
        );

  const recent =
    stats.recent.length === 0
      ? h("p", { class: "muted empty" }, t("noCases"))
      : h(
          "ul",
          { class: "recent" },
          stats.recent.map((entry) =>
            h(
              "li",
              {},
              actionPill(entry),
              h(
                "span",
                { class: "recent-text" },
                h("strong", {}, entry.userTag ?? entry.userId),
                h("span", { class: "muted" }, entry.reason ?? t("noReason")),
              ),
              h("span", { class: "muted recent-date" }, `#${entry.number} · ${formatDay(entry.createdAt)}`),
            ),
          ),
        );

  show(
    guildLayout(
      data,
      "overview",
      hero(t("overviewTitle", { name: guild.name }), t(canManageGuild(data) ? "overviewIntro" : "overviewIntroCases"), "blue"),
      tiles,
      canManageGuild(data) ? setupCard(data) : null,
      card(t("chartTitle"), "📈", "pink", legend, chartBox),
      h(
        "div",
        { class: "grid-2" },
        card(
          t("byAction"),
          "🧮",
          "amber",
          breakdown.length > 0 ? h("div", { class: "meters" }, breakdown) : h("p", { class: "muted empty" }, t("nothingYet")),
        ),
        card(t("recentCases"), "🕒", "blue", recent, h("a", { class: "button ghost small", href: casesLink() }, t("allCases"))),
        card(t("topModerators"), "🏆", "green", leaderboard(stats.topModerators, "moderator")),
        card(t("topMembers"), "🚨", "red", leaderboard(stats.topMembers, "user")),
      ),
    ),
  );
}

// What's set up and what isn't, with links to fix it.
function setupCard(data) {
  const { settings, guild } = data;
  const steps = [
    { key: "setupLogs", done: Boolean(settings.logsChannelId), page: "logging" },
    { key: "setupServerLog", done: Boolean(settings.serverLogChannelId), page: "logging" },
    { key: "setupModLog", done: Boolean(settings.modLogChannelId || settings.logsChannelId), page: "moderation" },
    { key: "setupModRole", done: Boolean(settings.modRoleId), page: "moderation" },
    { key: "setupCountry", done: Boolean(settings.countryChannelId), page: "country" },
    { key: "setupDashboard", done: (settings.dashboardRoleIds ?? []).length > 0, page: "access" },
    { key: "setupAutomod", done: Boolean(settings.automod?.enabled), page: "automod" },
    { key: "setupWelcome", done: Boolean(settings.welcomeChannelId), page: "community" },
  ];
  const done = steps.filter((step) => step.done).length;
  return h(
    "section",
    { class: "card setup" },
    h(
      "div",
      { class: "toolbar" },
      h("h2", { class: "card-title grow" }, h("span", { class: "chip-icon tone-green", "aria-hidden": "true" }, "✅"), t("setupTitle")),
      h("span", { class: "count-pill" }, t("setupProgress", { done, total: steps.length })),
    ),
    h("div", { class: "progress" }, fillBar("progress-fill", done / steps.length)),
    h(
      "ul",
      { class: "steps" },
      steps.map((step) =>
        h(
          "li",
          { class: step.done ? "done" : "" },
          h("span", { class: "step-mark", "aria-hidden": "true" }, step.done ? "✓" : "•"),
          h("span", { class: "grow" }, t(step.key)),
          step.done
            ? h("span", { class: "muted" }, t("setupDone"))
            : h("a", { class: "button ghost small", href: `#/g/${guild.id}/${step.page}` }, t("setupFix")),
        ),
      ),
    ),
  );
}

// --- Cases -------------------------------------------------------------------

const actionLabel = (entry) =>
  entry.action === "ban" && entry.durationMs ? t("action_tempban") : t(`action_${entry.action}`);
const actionPill = (entry) => h("span", { class: `pill act-${entry.action}` }, actionLabel(entry));

// "2026-10-16" → when that day starts in the viewer's time zone.
function dayToMs(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? "");
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : undefined;
}

function nextDay(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

const NO_FILTERS = { q: "", actions: [], user: "", moderator: "", from: "", to: "" };

// The filters as the address shows them (dates as days).
function filtersToHash(filters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.actions.length > 0) params.set("action", filters.actions.join(","));
  for (const key of ["user", "moderator", "from", "to"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return params;
}

// The filters as the API wants them (dates as times; "to" includes that day).
function filtersToApi(filters, { before } = {}) {
  const params = filtersToHash({ ...filters, from: "", to: "" });
  const from = dayToMs(filters.from);
  const to = dayToMs(filters.to);
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(nextDay(to)));
  if (before) params.set("before", String(before));
  return params;
}

async function showCases(guildId) {
  const data = await loadGuild(guildId);
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const filters = {
    q: query.get("q") ?? "",
    actions: (query.get("action") ?? "").split(",").filter((action) => CASE_ACTIONS.includes(action)),
    user: query.get("user") ?? "",
    moderator: query.get("moderator") ?? "",
    from: query.get("from") ?? "",
    to: query.get("to") ?? "",
  };
  // Changing the address reloads the list.
  const apply = (next) => {
    const params = filtersToHash(next);
    location.hash = `#/g/${guildId}/cases${params.size > 0 ? `?${params}` : ""}`;
  };

  const rows = h("tbody");
  const more = h("button", { class: "ghost", type: "button", hidden: true }, t("loadMore"));
  const resultCount = h("span", { class: "count-pill" });
  let nextBefore = null;

  async function loadPage() {
    const page = await api(`/api/guilds/${guildId}/cases?${filtersToApi(filters, { before: nextBefore })}`);
    rows.append(...page.cases.map((entry) => caseRow(guildId, entry, filters, apply)));
    if (rows.childElementCount === 0) {
      rows.append(h("tr", {}, h("td", { colspan: 7, class: "muted empty" }, t("noCases"))));
    }
    if (page.total !== null) {
      resultCount.textContent = t("casesFound", { count: formatNumber(page.total) });
    }
    nextBefore = page.nextBefore;
    more.hidden = !nextBefore;
  }
  more.addEventListener("click", () => loadPage().catch(failed));

  // The filter panel.
  const textInput = h("input", {
    type: "search",
    class: "grow",
    placeholder: t("filterText"),
    value: filters.q,
    "aria-label": t("filterText"),
    maxLength: 100,
  });
  const actionChips = CASE_ACTIONS.map((action) =>
    h(
      "button",
      {
        type: "button",
        class: `legend-chip act-${action}`,
        "aria-pressed": String(filters.actions.includes(action)),
        "data-action": action,
        onclick: (event) => {
          const chip = event.currentTarget;
          chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
        },
      },
      h("span", { class: "legend-dot" }),
      t(`action_${action}`),
    ),
  );
  const idInput = (value, key) =>
    h("input", { type: "search", inputmode: "numeric", pattern: "\\d{17,20}", placeholder: t("pasteId"), value, "aria-label": t(key) });
  const userInput = idInput(filters.user, "filterUser");
  const moderatorInput = idInput(filters.moderator, "filterModerator");
  const fromInput = h("input", { type: "date", value: filters.from });
  const toInput = h("input", { type: "date", value: filters.to });

  const filterForm = h(
    "form",
    {
      class: "card filter-panel",
      onsubmit: (event) => {
        event.preventDefault();
        apply({
          q: textInput.value.trim(),
          actions: actionChips.filter((chip) => chip.getAttribute("aria-pressed") === "true").map((chip) => chip.dataset.action),
          user: userInput.value.trim(),
          moderator: moderatorInput.value.trim(),
          from: fromInput.value,
          to: toInput.value,
        });
      },
    },
    h("div", { class: "toolbar" }, textInput, h("button", { class: "primary", type: "submit" }, `🔎 ${t("search")}`)),
    h("div", { class: "legend" }, actionChips),
    h(
      "details",
      { class: "more-filters", open: Boolean(filters.user || filters.moderator || filters.from || filters.to) },
      h("summary", {}, t("moreFilters")),
      h(
        "div",
        { class: "filter-grid" },
        field("filterUser", null, userInput),
        field("filterModerator", null, moderatorInput),
        field("filterFrom", null, fromInput),
        field("filterTo", null, toInput),
      ),
    ),
  );

  // A chip for each filter in use; clicking one removes it.
  const activeChips = [
    filters.q ? [`“${filters.q}”`, { q: "" }] : null,
    ...filters.actions.map((action) => [t(`action_${action}`), { actions: filters.actions.filter((other) => other !== action) }]),
    filters.user ? [`${t("filterUser")}: ${filters.user}`, { user: "" }] : null,
    filters.moderator ? [`${t("filterModerator")}: ${filters.moderator}`, { moderator: "" }] : null,
    filters.from ? [`${t("filterFrom")}: ${filters.from}`, { from: "" }] : null,
    filters.to ? [`${t("filterTo")}: ${filters.to}`, { to: "" }] : null,
  ].filter(Boolean);
  const active = h(
    "div",
    { class: "active-filters" },
    resultCount,
    activeChips.map(([label, change]) =>
      h(
        "button",
        { type: "button", class: "filter-chip", title: t("removeFilter"), onclick: () => apply({ ...filters, ...change }) },
        label,
        h("span", { "aria-hidden": "true" }, "✕"),
      ),
    ),
    activeChips.length > 1
      ? h("button", { type: "button", class: "link-button", onclick: () => apply(NO_FILTERS) }, t("clearFilters"))
      : null,
    h(
      "a",
      {
        class: "button ghost small push-end",
        href: `/api/guilds/${guildId}/cases/export?${filtersToApi(filters)}`,
        download: `cases-${guildId}.csv`,
      },
      `⬇ ${t("exportCsv")}`,
    ),
  );

  show(
    guildLayout(
      data,
      "cases",
      hero(t("page_cases"), t("casesIntro"), "pink"),
      filterForm,
      active,
      h(
        "div",
        { class: "card table-wrap flush" },
        h(
          "table",
          { class: "table cases" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ["caseNumber", "caseAction", "caseUser", "caseModerator", "caseReason", "caseDate", ""].map((key) =>
                h("th", { scope: "col" }, key ? t(key) : ""),
              ),
            ),
          ),
          rows,
        ),
      ),
      h("div", { class: "actions" }, more),
    ),
  );
  await loadPage();
}

// A name with its user ID underneath; clicking it shows only their cases.
// ID "0" is an unknown moderator.
function person(id, tag, onPick) {
  if (id === "0") {
    return h("span", {}, tag ?? t("unknown"));
  }
  return h(
    "button",
    { type: "button", class: "person-button", title: t("showTheirCases"), onclick: onPick },
    h("span", { class: "name" }, tag ?? id),
    tag ? h("span", { class: "id" }, id) : null,
  );
}

function caseRow(guildId, entry, filters, apply) {
  const reasonCell = h("td", { class: "reason" }, entry.reason ?? h("em", { class: "muted" }, t("noReason")));
  const duration = entry.durationMs ? h("span", { class: "duration" }, `⏱ ${formatDuration(entry.durationMs)}`) : null;
  const row = h(
    "tr",
    { class: `act-row act-${entry.action}` },
    h("td", { class: "number" }, `#${entry.number}`),
    h("td", {}, h("div", { class: "action-cell" }, actionPill(entry), duration)),
    h("td", { class: "person" }, person(entry.userId, entry.userTag, () => apply({ ...filters, user: entry.userId }))),
    h(
      "td",
      { class: "person" },
      person(entry.moderatorId, entry.moderatorTag, () => apply({ ...filters, moderator: entry.moderatorId })),
    ),
    reasonCell,
    h("td", { class: "date" }, formatDate(entry.createdAt)),
    h(
      "td",
      {},
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "ghost small", type: "button", onclick: () => editReason(guildId, entry, reasonCell) }, t("editReason")),
        h("button", { class: "danger small", type: "button", onclick: () => deleteCase(guildId, entry, row) }, t("delete")),
      ),
    ),
  );
  return row;
}

function editReason(guildId, entry, cell) {
  const input = h("textarea", { maxLength: 512, rows: 3 }, entry.reason ?? "");
  const dialog = h(
    "dialog",
    { class: "card" },
    h(
      "form",
      {
        method: "dialog",
        onsubmit: async (event) => {
          if (event.submitter?.value !== "save") {
            return;
          }
          event.preventDefault();
          try {
            const result = await api(`/api/guilds/${guildId}/cases/${entry.number}`, {
              method: "PATCH",
              body: { reason: input.value },
            });
            Object.assign(entry, result.case);
            cell.replaceChildren(entry.reason ?? h("em", { class: "muted" }, t("noReason")));
            toast(t("reasonSaved", { number: entry.number }));
            dialog.close();
          } catch (error) {
            failed(error);
          }
        },
      },
      h("h2", {}, t("editReasonTitle", { number: entry.number })),
      input,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "ghost", value: "cancel" }, t("cancel")),
        h("button", { class: "primary", value: "save" }, t("save")),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

async function deleteCase(guildId, entry, row) {
  if (!confirm(t("deleteConfirm", { number: entry.number }))) {
    return;
  }
  try {
    await api(`/api/guilds/${guildId}/cases/${entry.number}`, { method: "DELETE" });
    row.remove();
    toast(t("caseDeleted", { number: entry.number }));
  } catch (error) {
    failed(error);
  }
}

// --- Routing -----------------------------------------------------------------

const SHOW_PAGE = {
  overview: showOverview,
  cases: showCases,
  moderation: showModeration,
  logging: showLogging,
  automod: showAutomod,
  community: showCommunity,
  tags: showTags,
  country: showCountry,
  access: showAccess,
};

async function route() {
  const [path] = location.hash.replace(/^#/, "").split("?");
  const match = path.match(/^\/g\/(\d{17,20})(?:\/(\w+))?$/);
  state.unsaved = false;
  state.lastHash = location.hash;
  // Links from older versions went to "settings".
  const pageId = match && (match[2] === "settings" ? "moderation" : (match[2] ?? "overview"));
  show(h("p", { class: "muted loading" }, h("span", { class: "spinner", "aria-hidden": "true" }), t("loading")));
  try {
    if (match && SHOW_PAGE[pageId]) {
      await SHOW_PAGE[pageId](match[1]);
    } else {
      await showServers();
    }
  } catch (error) {
    failed(error);
    if (!(error instanceof ApiError && error.status === 401) && match) {
      show(h("p", { class: "muted empty" }, t("errorGeneric")), h("a", { class: "button ghost", href: "#/" }, t("backToServers")));
    }
  }
}

// Asks before leaving a settings page with unsaved changes.
function onHashChange() {
  if (state.unsaved && !confirm(t("leaveUnsaved"))) {
    history.replaceState(null, "", state.lastHash || "#/");
    return;
  }
  route();
}

async function start() {
  loadAppearance();
  await loadLanguage(preferredLanguage());
  const select = document.getElementById("language");
  select.replaceChildren(
    ...Object.entries(LANGUAGES).map(([code, name]) => h("option", { value: code, selected: code === state.language }, name)),
  );
  select.addEventListener("change", async () => {
    await loadLanguage(select.value);
    appearanceButton.title = t("appearanceTitle");
    renderAccount();
    route();
  });
  const appearanceButton = document.getElementById("appearance");
  appearanceButton.title = t("appearanceTitle");
  appearanceButton.setAttribute("aria-label", t("appearanceTitle"));
  appearanceButton.addEventListener("click", openAppearance);
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("beforeunload", (event) => {
    if (state.unsaved) {
      event.preventDefault();
    }
  });
  route();
}

start();
