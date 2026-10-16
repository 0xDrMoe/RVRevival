// The dashboard page. Plain JavaScript, no build step. Pages are picked by the
// part of the address after "#":
//
//   #/                    your servers
//   #/g/<id>/settings     a server's settings
//   #/g/<id>/cases        a server's moderation cases
//
// Everything shown comes from the JSON API in ../app.js. Text from Discord
// (names, reasons) is always set as text, never as HTML.

const LANGUAGES = { en: "English", es: "Español", de: "Deutsch", fr: "Français", pt: "Português", it: "Italiano", ar: "العربية" };
const LOG_EVENTS = ["messageEdit", "messageDelete", "bulkDelete", "memberJoin", "memberLeave", "memberUpdate"];
const CASE_ACTIONS = ["ban", "softban", "unban", "kick", "timeout", "untimeout", "warn", "note"];
const CHANNEL = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, FORUM: 15 };

const state = { language: "en", strings: {}, english: {}, me: null, guild: null };
const main = document.getElementById("main");

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
  try {
    localStorage.setItem("language", language);
  } catch {
    // Private windows may refuse; the choice just isn't remembered.
  }
}

function preferredLanguage() {
  let saved;
  try {
    saved = localStorage.getItem("language");
  } catch {
    saved = null;
  }
  const browser = (navigator.language ?? "en").slice(0, 2).toLowerCase();
  return [saved, browser].find((code) => code && code in LANGUAGES) ?? "en";
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
const iconUrl = (guild) => (guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=96` : null);
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

const formatDate = (ms) =>
  new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));

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
      url ? h("img", { class: "avatar", src: url, alt: "" }) : null,
      h("span", { class: "account-name" }, user.username),
      h("button", { class: "ghost", type: "button", onclick: logout }, t("logout")),
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
      h("img", { src: "favicon.svg", alt: "", width: 64, height: 64 }),
      h("h1", {}, t("loginTitle")),
      h("p", { class: "muted" }, t("loginIntro")),
      failedLogin ? h("p", { class: "error-text" }, t("loginFailed")) : null,
      h("a", { class: "button primary", href: "/auth/login" }, t("loginButton")),
    ),
  );
}

// --- Servers -----------------------------------------------------------------

async function showServers({ refresh = false } = {}) {
  state.me = await api(`/api/me${refresh ? "?refresh=1" : ""}`);
  renderAccount();
  const ready = state.me.guilds.filter((guild) => guild.botPresent);
  const invitable = state.me.guilds.filter((guild) => !guild.botPresent);

  const card = (guild) =>
    h(
      "a",
      { class: "server card", href: `#/g/${guild.id}/settings` },
      guildIcon(guild),
      h("span", { class: "server-name" }, guild.name),
    );
  const inviteCard = (guild) =>
    h(
      "a",
      { class: "server card faded", href: `${state.me.inviteUrl}&guild_id=${guild.id}`, target: "_blank", rel: "noopener" },
      guildIcon(guild),
      h("span", { class: "server-name" }, guild.name),
      h("span", { class: "badge" }, t("serversInvite")),
    );

  show(
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, t("serversTitle")),
      h("button", { class: "ghost", type: "button", onclick: () => showServers({ refresh: true }).catch(failed) }, t("serversRefresh")),
    ),
    ready.length > 0 ? h("div", { class: "server-grid" }, ready.map(card)) : h("p", { class: "muted" }, t("serversNone")),
    invitable.length > 0 ? h("h2", {}, t("serversWithoutBot")) : null,
    invitable.length > 0 ? h("div", { class: "server-grid" }, invitable.map(inviteCard)) : null,
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

function guildHeader(data, tab) {
  const total = Object.values(data.caseCounts).reduce((sum, count) => sum + count, 0);
  const tabLink = (name, label) =>
    h("a", { class: `tab${tab === name ? " active" : ""}`, href: `#/g/${data.guild.id}/${name}` }, label);
  return h(
    "div",
    { class: "guild-head" },
    h("a", { class: "back", href: "#/" }, t("backToServers")),
    h("div", { class: "guild-title" }, guildIcon(data.guild, "lg"), h("h1", {}, data.guild.name)),
    h("p", { class: "muted" }, t("guildCaseTotal", { count: total })),
    h("nav", { class: "tabs" }, tabLink("settings", t("tabSettings")), tabLink("cases", t("tabCases"))),
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

async function showSettings(guildId) {
  const data = await loadGuild(guildId);
  const settings = { ...data.settings };
  const roles = data.roles.map((role) => ({ id: role.id, label: role.managed ? `@${role.name} (${t("botRole")})` : `@${role.name}` }));
  const postable = data.channels
    .filter((channel) => [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT].includes(channel.type))
    .map((channel) => ({ id: channel.id, label: channelLabel(channel, data.channels) }));
  const ignorable = data.channels.filter((channel) =>
    [CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT, CHANNEL.FORUM, CHANNEL.VOICE, CHANNEL.CATEGORY].includes(channel.type),
  );

  const field = (labelKey, helpKey, control) =>
    h("label", { class: "field" }, h("span", { class: "field-label" }, t(labelKey)), control, h("span", { class: "help" }, t(helpKey)));

  const rolePicker = (key) => picker({ id: key, options: roles, value: settings[key], emptyLabel: t("notSet") });
  const channelPicker = (key, emptyKey = "notSet") =>
    picker({ id: key, options: postable, value: settings[key], emptyLabel: t(emptyKey) });

  const disabled = new Set(settings.disabledLogEvents ?? []);
  const eventBoxes = LOG_EVENTS.map((event) =>
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", name: "logEvent", value: event, checked: !disabled.has(event) }),
      t(`logEvent_${event}`),
    ),
  );

  const ignored = new Set(settings.logIgnoredChannels ?? []);
  const ignoreBoxes = ignorable.map((channel) =>
    h(
      "label",
      { class: "check", "data-name": channel.name.toLowerCase() },
      h("input", { type: "checkbox", name: "ignore", value: channel.id, checked: ignored.has(channel.id) }),
      channelLabel(channel, data.channels),
    ),
  );
  const ignoreFilter = h("input", {
    type: "search",
    class: "filter",
    placeholder: t("filterChannels"),
    oninput: (event) => {
      const text = event.target.value.trim().toLowerCase();
      ignoreBoxes.forEach((box) => (box.hidden = text !== "" && !box.dataset.name.includes(text)));
    },
  });

  const saveButton = h("button", { class: "primary", type: "submit" }, t("save"));
  const form = h(
    "form",
    {
      class: "settings",
      onsubmit: async (event) => {
        event.preventDefault();
        saveButton.disabled = true;
        try {
          const changes = collectSettings(form, settings);
          if (Object.keys(changes).length === 0) {
            toast(t("noChanges"));
            return;
          }
          const result = await api(`/api/guilds/${guildId}/settings`, { method: "PUT", body: changes });
          Object.keys(settings).forEach((key) => delete settings[key]);
          Object.assign(settings, result.settings);
          toast(t("saved"));
        } catch (error) {
          failed(error);
        } finally {
          saveButton.disabled = false;
        }
      },
    },
    h(
      "section",
      { class: "card" },
      h("h2", {}, t("sectionRoles")),
      field("staffRole", "staffRoleHelp", rolePicker("staffRoleId")),
      field("modRole", "modRoleHelp", rolePicker("modRoleId")),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, t("sectionChannels")),
      field("countryChannel", "countryChannelHelp", channelPicker("countryChannelId", "anyChannel")),
      field("logsChannel", "logsChannelHelp", channelPicker("logsChannelId")),
      field("modLogChannel", "modLogChannelHelp", channelPicker("modLogChannelId", "useLogsChannel")),
      field("serverLogChannel", "serverLogChannelHelp", channelPicker("serverLogChannelId")),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, t("sectionServerLog")),
      h("p", { class: "help" }, t("logEventsHelp")),
      h("div", { class: "checks" }, eventBoxes),
      h("h3", {}, t("ignoredChannels")),
      h("p", { class: "help" }, t("ignoredChannelsHelp")),
      ignoreFilter,
      h("div", { class: "checks scroll" }, ignoreBoxes),
    ),
    h("div", { class: "actions sticky" }, saveButton),
  );

  show(guildHeader(data, "settings"), form);
}

// Only the settings that differ from what's saved: { setting: value | null }.
function collectSettings(form, saved) {
  const changes = {};
  const compare = (key, value) => {
    const before = saved[key] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(value)) {
      changes[key] = value;
    }
  };
  for (const key of ["staffRoleId", "modRoleId", "countryChannelId", "logsChannelId", "modLogChannelId", "serverLogChannelId"]) {
    compare(key, form.querySelector(`#${key}`).value || null);
  }
  const off = [...form.querySelectorAll('input[name="logEvent"]')].filter((box) => !box.checked).map((box) => box.value);
  compare("disabledLogEvents", off.length > 0 ? off : null);
  const ignoredIds = [...form.querySelectorAll('input[name="ignore"]:checked')].map((box) => box.value);
  const sortedSaved = [...(saved.logIgnoredChannels ?? [])].sort();
  if (JSON.stringify(sortedSaved) !== JSON.stringify([...ignoredIds].sort())) {
    changes.logIgnoredChannels = ignoredIds.length > 0 ? ignoredIds : null;
  }
  return changes;
}

// --- Cases -------------------------------------------------------------------

async function showCases(guildId) {
  const data = await loadGuild(guildId);
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const filters = { user: query.get("user") ?? "", action: query.get("action") ?? "" };

  const rows = h("tbody");
  const more = h("button", { class: "ghost", type: "button", hidden: true }, t("loadMore"));
  let nextBefore = null;

  async function loadPage() {
    const params = new URLSearchParams();
    if (filters.user) params.set("user", filters.user);
    if (filters.action) params.set("action", filters.action);
    if (nextBefore) params.set("before", nextBefore);
    const page = await api(`/api/guilds/${guildId}/cases?${params}`);
    rows.append(...page.cases.map((entry) => caseRow(guildId, entry)));
    if (rows.childElementCount === 0) {
      rows.append(h("tr", {}, h("td", { colspan: 7, class: "muted empty" }, t("noCases"))));
    }
    nextBefore = page.nextBefore;
    more.hidden = !nextBefore;
  }
  more.addEventListener("click", () => loadPage().catch(failed));

  const userInput = h("input", {
    type: "search",
    inputmode: "numeric",
    pattern: "\\d{17,20}",
    placeholder: t("filterUser"),
    value: filters.user,
    "aria-label": t("filterUser"),
  });
  const actionSelect = h(
    "select",
    { "aria-label": t("filterAction") },
    h("option", { value: "" }, t("allActions")),
    CASE_ACTIONS.map((action) => h("option", { value: action, selected: action === filters.action }, t(`action_${action}`))),
  );
  const filterForm = h(
    "form",
    {
      class: "filters",
      onsubmit: (event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        if (userInput.value.trim()) params.set("user", userInput.value.trim());
        if (actionSelect.value) params.set("action", actionSelect.value);
        location.hash = `#/g/${guildId}/cases${params.size > 0 ? `?${params}` : ""}`;
      },
    },
    userInput,
    actionSelect,
    h("button", { class: "primary", type: "submit" }, t("search")),
  );

  show(
    guildHeader(data, "cases"),
    filterForm,
    h(
      "div",
      { class: "card table-wrap" },
      h(
        "table",
        { class: "cases" },
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
  );
  await loadPage();
}

// A name with its user ID underneath (ID "0" is an unknown moderator).
const person = (id, tag) =>
  id === "0"
    ? h("span", {}, tag ?? t("unknown"))
    : h("span", {}, h("span", { class: "name" }, tag ?? id), tag ? h("span", { class: "id" }, id) : null);

function caseRow(guildId, entry) {
  const reasonCell = h("td", { class: "reason" }, entry.reason ?? h("em", { class: "muted" }, t("noReason")));
  const actionLabel = entry.action === "ban" && entry.durationMs ? t("action_tempban") : t(`action_${entry.action}`);
  const row = h(
    "tr",
    {},
    h("td", { class: "number" }, `#${entry.number}`),
    h("td", {}, h("span", { class: `pill ${entry.action}` }, actionLabel)),
    h("td", { class: "person" }, person(entry.userId, entry.userTag)),
    h("td", { class: "person" }, person(entry.moderatorId, entry.moderatorTag)),
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

async function route() {
  const [path] = location.hash.replace(/^#/, "").split("?");
  const match = path.match(/^\/g\/(\d{17,20})\/(settings|cases)$/);
  show(h("p", { class: "muted loading" }, t("loading")));
  try {
    if (match) {
      await (match[2] === "cases" ? showCases(match[1]) : showSettings(match[1]));
    } else {
      await showServers();
    }
  } catch (error) {
    failed(error);
    if (!(error instanceof ApiError && error.status === 401) && match) {
      show(h("p", { class: "muted" }, t("errorGeneric")), h("a", { class: "button ghost", href: "#/" }, t("backToServers")));
    }
  }
}

async function start() {
  await loadLanguage(preferredLanguage());
  const select = document.getElementById("language");
  select.replaceChildren(
    ...Object.entries(LANGUAGES).map(([code, name]) => h("option", { value: code, selected: code === state.language }, name)),
  );
  select.addEventListener("change", async () => {
    await loadLanguage(select.value);
    renderAccount();
    route();
  });
  window.addEventListener("hashchange", route);
  route();
}

start();
