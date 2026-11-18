// How the AI ticket assistant works in a server, saved under
// Setting.TICKET_AI and changed on the dashboard's AI assistant page. Off
// until a server turns it on: ticket text is sent to an AI provider
// (Anthropic) only for servers that opt in.
//
//   enabled       the switch for everything below. Off by default.
//   triage        when a ticket opens, the AI reads the form answers and
//                 notes a priority, a short summary for staff, the category
//                 that fits best and the knowledge base articles that answer
//                 it, in the ticket's history and the ticket log.
//   helpers       the Staff assist button in tickets: Summarize ticket and
//                 Suggest reply (staff read and edit the reply before it's sent).
//   closeSummary  a short AI summary of the conversation in the ticket log
//                 and the ticket's history when it closes.
//   useTags       the server's tags (/tag) count as knowledge base articles too.
//   monthlyLimit  AI requests a month for the whole server. The bot's own
//                 limit (AI_MONTHLY_LIMIT) caps it.
//   panelIds      when there are any, only tickets from these panels use the
//                 assistant ("main" is the main panel).

export const DEFAULT_MONTHLY_LIMIT = 200;
export const MIN_MONTHLY_LIMIT = 1;
export const MAX_MONTHLY_LIMIT = 5000;
export const MAX_AI_PANELS = 10;

export const DEFAULT_TICKET_AI = Object.freeze({
  enabled: false,
  triage: true,
  helpers: true,
  closeSummary: true,
  useTags: true,
  monthlyLimit: DEFAULT_MONTHLY_LIMIT,
  panelIds: Object.freeze([]),
});

const KEYS = Object.keys(DEFAULT_TICKET_AI);
const SWITCHES = ["enabled", "triage", "helpers", "closeSummary", "useTags"];
const PANEL_ID = /^[a-z0-9-]{1,32}$/;
const panelList = (value) => (Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && PANEL_ID.test(id)))].slice(0, MAX_AI_PANELS) : []);

export class InvalidTicketAi extends Error {
  name = "InvalidTicketAi";
}

// The saved options with every default filled in. Never throws.
export function normalizeTicketAi(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const limit = Number.isInteger(value.monthlyLimit) ? value.monthlyLimit : DEFAULT_MONTHLY_LIMIT;
  return {
    enabled: value.enabled === true,
    triage: value.triage !== false,
    helpers: value.helpers !== false,
    closeSummary: value.closeSummary !== false,
    useTags: value.useTags !== false,
    monthlyLimit: Math.min(MAX_MONTHLY_LIMIT, Math.max(MIN_MONTHLY_LIMIT, limit)),
    panelIds: panelList(value.panelIds),
  };
}

// Whether tickets from this panel (null = the main panel) use the assistant.
export function panelUsesAi(options, panelId) {
  return options.panelIds.length === 0 || options.panelIds.includes(panelId ?? "main");
}

// Checks dashboard input. `isPanel(id)` says whether a panel exists. Returns
// what to save, or null when everything is the default.
export function checkTicketAi(value, { isPanel = () => true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidTicketAi(`AI assistant options are { ${KEYS.join(", ")} }.`);
  }
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) {
    throw new InvalidTicketAi(`Unknown AI assistant option "${unknown}".`);
  }
  const merged = { ...DEFAULT_TICKET_AI, ...value };
  for (const key of SWITCHES) {
    if (typeof merged[key] !== "boolean") {
      throw new InvalidTicketAi(`${key} is on or off (true or false).`);
    }
  }
  if (!Number.isInteger(merged.monthlyLimit) || merged.monthlyLimit < MIN_MONTHLY_LIMIT || merged.monthlyLimit > MAX_MONTHLY_LIMIT) {
    throw new InvalidTicketAi(`The monthly limit is ${MIN_MONTHLY_LIMIT} to ${MAX_MONTHLY_LIMIT} requests.`);
  }
  if (
    !Array.isArray(merged.panelIds) ||
    merged.panelIds.length > MAX_AI_PANELS ||
    !merged.panelIds.every((id) => typeof id === "string" && PANEL_ID.test(id) && isPanel(id))
  ) {
    throw new InvalidTicketAi(`Pick up to ${MAX_AI_PANELS} ticket panels from this server, or none for every panel.`);
  }
  const clean = normalizeTicketAi(merged);
  const isDefault = KEYS.every((key) => (Array.isArray(clean[key]) ? clean[key].length === 0 : clean[key] === DEFAULT_TICKET_AI[key]));
  return isDefault ? null : clean;
}

// One line for the dashboard's change log.
export function describeTicketAi(value) {
  const options = normalizeTicketAi(value);
  if (!options.enabled) {
    return "off";
  }
  const parts = [
    options.triage ? "triage" : null,
    options.helpers ? "staff helpers" : null,
    options.closeSummary ? "close summaries" : null,
    options.useTags ? "tags as knowledge" : null,
  ].filter(Boolean);
  const panels = options.panelIds.length > 0 ? `panels ${options.panelIds.join(", ")}` : "every panel";
  return `on (${parts.join(", ") || "nothing"}; ${panels}; ${options.monthlyLimit} requests a month)`;
}
