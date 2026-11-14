// Ticket panels. A server can have several, each its own message in its own
// channel with its own look, categories, staff roles and who may open
// tickets from it: a support panel in #support and an applications panel in
// #apply, say. Tickets open as private threads in their panel's channel.
//
// The first, "main", panel is saved the way the only panel always was, so
// servers set up before keep working untouched:
//
//   Setting.TICKETS            { channelId, messageId, staffRoleIds, openRoleIds, title, message }
//                              (older saves have one `staffRoleId` instead of staffRoleIds)
//   Setting.TICKET_PANEL       its look (tickets/panel.js)
//   Setting.TICKET_CATEGORIES  its categories (tickets/categories.js)
//
// Every other panel is one entry of Setting.TICKET_PANELS:
//
//   { id, channelId, messageId, staffRoleIds, openRoleIds, look, categories }
//
// What's shared by all panels: one open ticket per member, the open-ticket
// cap, support settings (auto-close, ratings) and the ticket log.

import { randomBytes } from "node:crypto";
import { Setting } from "../settings/guildSettings.js";
import { normalizeCategories, readRoleList } from "./categories.js";
import { normalizeLook } from "./panel.js";

export const MAIN_PANEL = "main";
// Panels per server, the main one included.
export const MAX_TICKET_PANELS = 10;

const PANEL_ID = /^[a-z0-9]{1,12}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const ignore = () => {};

const snowflakeOrNull = (value) => (typeof value === "string" && SNOWFLAKE.test(value) ? value : null);
const roleList = (value) => readRoleList(Array.isArray(value) ? value : [], ignore, "");

// The main panel's staff roles: the list, or the one role saved before lists.
const mainStaffRoleIds = (saved) => roleList(saved?.staffRoleIds ?? (saved?.staffRoleId ? [saved.staffRoleId] : []));

// The main panel's look. Servers that set their panel up before the look was
// its own setting have the title and text saved with the panel, so those are
// used until the look is saved.
export function mainPanelLook(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TICKET_PANEL);
  if (saved) {
    return normalizeLook(saved);
  }
  const panel = guildSettings.get(guildId, Setting.TICKETS);
  return normalizeLook({ title: panel?.title ?? null, description: panel?.message ?? null });
}

export const mainPanelCategories = (guildSettings, guildId) => normalizeCategories(guildSettings.get(guildId, Setting.TICKET_CATEGORIES));

// The main panel, posted or not (its look and categories are kept either way).
export function mainPanel(guildSettings, guildId) {
  const saved = guildSettings.get(guildId, Setting.TICKETS);
  return {
    id: MAIN_PANEL,
    channelId: snowflakeOrNull(saved?.channelId),
    messageId: typeof saved?.messageId === "string" ? saved.messageId : null,
    staffRoleIds: mainStaffRoleIds(saved),
    openRoleIds: roleList(saved?.openRoleIds),
    look: mainPanelLook(guildSettings, guildId),
    categories: mainPanelCategories(guildSettings, guildId),
  };
}

// The saved extra panels with anything broken left out. Never throws.
export function normalizeExtraPanels(saved) {
  if (!Array.isArray(saved)) {
    return [];
  }
  const seen = new Set([MAIN_PANEL]);
  const panels = [];
  for (const value of saved) {
    if (!value || typeof value !== "object" || !PANEL_ID.test(value.id ?? "") || seen.has(value.id) || !snowflakeOrNull(value.channelId)) {
      continue;
    }
    seen.add(value.id);
    panels.push({
      id: value.id,
      channelId: value.channelId,
      messageId: snowflakeOrNull(value.messageId),
      staffRoleIds: roleList(value.staffRoleIds),
      openRoleIds: roleList(value.openRoleIds),
      look: normalizeLook(value.look),
      categories: normalizeCategories(value.categories),
    });
  }
  return panels.slice(0, MAX_TICKET_PANELS - 1);
}

export const extraPanels = (guildSettings, guildId) => normalizeExtraPanels(guildSettings.get(guildId, Setting.TICKET_PANELS));

export async function saveExtraPanels(guildSettings, guildId, panels) {
  if (panels.length > 0) {
    await guildSettings.set(guildId, Setting.TICKET_PANELS, panels);
  } else {
    await guildSettings.clear(guildId, Setting.TICKET_PANELS);
  }
}

// Every panel, the main one first (even when it isn't posted).
export const ticketPanels = (guildSettings, guildId) => [mainPanel(guildSettings, guildId), ...extraPanels(guildSettings, guildId)];

export const isPosted = (panel) => Boolean(panel?.channelId);

// The panel with this ID ("main" or null for the main one), or undefined.
export function findPanel(guildSettings, guildId, panelId) {
  if (!panelId || panelId === MAIN_PANEL) {
    return mainPanel(guildSettings, guildId);
  }
  return extraPanels(guildSettings, guildId).find((panel) => panel.id === panelId);
}

// A new panel ID none of `panels` has.
export function newPanelId(panels) {
  const taken = new Set([MAIN_PANEL, ...panels.map((panel) => panel.id)]);
  for (;;) {
    const id = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    if (id.length === 6 && !taken.has(id)) {
      return id;
    }
  }
}

// Saves the main panel's message (posted, moved or removed) and its roles,
// keeping its saved title and text. `changes` holds only what changes.
export async function saveMainPanel(guildSettings, guildId, changes) {
  const saved = guildSettings.get(guildId, Setting.TICKETS) ?? {};
  const { staffRoleId: _old, ...rest } = saved;
  const next = { ...rest, staffRoleIds: mainStaffRoleIds(saved), openRoleIds: roleList(saved.openRoleIds), ...changes };
  const empty = !next.channelId && next.staffRoleIds.length === 0 && next.openRoleIds.length === 0;
  if (empty) {
    await guildSettings.clear(guildId, Setting.TICKETS);
  } else {
    await guildSettings.set(guildId, Setting.TICKETS, next);
  }
}

// Forgets every panel posted in a deleted channel. Returns how many.
export async function forgetPanelsIn(guildSettings, guildId, channelId) {
  let forgotten = 0;
  if (mainPanel(guildSettings, guildId).channelId === channelId) {
    await saveMainPanel(guildSettings, guildId, { channelId: null, messageId: null });
    forgotten += 1;
  }
  const extras = extraPanels(guildSettings, guildId);
  const kept = extras.filter((panel) => panel.channelId !== channelId);
  if (kept.length !== extras.length) {
    await saveExtraPanels(guildSettings, guildId, kept);
    forgotten += extras.length - kept.length;
  }
  return forgotten;
}

// The panel's name in lists and logs: its title, or "Main panel".
export const panelName = (panel, defaultTitle = "Ticket panel") => panel.look?.title || (panel.id === MAIN_PANEL ? "Main panel" : defaultTitle);

// --- Button, dropdown and form IDs ------------------------------------------
// The main panel keeps the IDs it always had, so panels posted before still
// work: "tk:open", "tk:open:<category>", "tk:menu", "tk:form", "tk:form:<category>".
// Other panels add their ID: "tk:p:<panel>:open[:<category>]", "tk:p:<panel>:menu",
// "tk:p:<panel>:form[:<category>]".

export const PANEL_PREFIX = "tk:p:";
const LEGACY = /^tk:(open|menu|form)(?::([a-z0-9]{1,12}))?$/;
const PANELLED = /^tk:p:([a-z0-9]{1,12}):(open|menu|form)(?::([a-z0-9]{1,12}))?$/;

export function panelCustomId(panelId, kind, categoryId = null) {
  const base = !panelId || panelId === MAIN_PANEL ? `tk:${kind}` : `${PANEL_PREFIX}${panelId}:${kind}`;
  return categoryId ? `${base}:${categoryId}` : base;
}

// { panelId, kind: "open" | "menu" | "form", categoryId } from a custom ID, or null.
export function parsePanelCustomId(customId) {
  const legacy = LEGACY.exec(customId ?? "");
  if (legacy) {
    return legacy[1] === "menu" && legacy[2] ? null : { panelId: MAIN_PANEL, kind: legacy[1], categoryId: legacy[2] ?? null };
  }
  const panelled = PANELLED.exec(customId ?? "");
  if (panelled) {
    return panelled[2] === "menu" && panelled[3] ? null : { panelId: panelled[1], kind: panelled[2], categoryId: panelled[3] ?? null };
  }
  return null;
}
