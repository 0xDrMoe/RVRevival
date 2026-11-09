// Ready-made custom commands and auto-responders for the dashboard's Custom
// commands pages. Picking one adds a filled-in row that staff can still edit
// before saving, so nothing is saved until they press Save.
//
// The words live in the language files, so a template comes in the language
// the dashboard is shown in:
//   tags:        tagTpl_<id>_title, tagTpl_<id>_name, tagTpl_<id>_content
//   responders:  respTpl_<id>_title, respTpl_<id>_trigger, respTpl_<id>_reply
// Responder replies may use the "responder" variables (variables.js):
// {user}, {username}, {server} and {channel}. tests/variables.test.js checks them.

export const TAG_TEMPLATES = Object.freeze([
  { id: "rules", icon: "📜" },
  { id: "help", icon: "❓" },
  { id: "report", icon: "🚩" },
  { id: "roles", icon: "🎭" },
  { id: "invite", icon: "📨" },
  { id: "links", icon: "🔗" },
]);

// `match` is one of community/autoResponders.js Match values.
export const RESPONDER_TEMPLATES = Object.freeze([
  { id: "hello", icon: "👋", match: "word" },
  { id: "roles", icon: "🎭", match: "contains" },
  { id: "rules", icon: "📜", match: "contains" },
  { id: "invite", icon: "📨", match: "contains" },
  { id: "report", icon: "🚩", match: "contains" },
  { id: "quiet", icon: "💬", match: "contains" },
]);

// A template as the page's rows want it, in the dashboard's language.
export const tagFromTemplate = (template, t) => ({
  name: t(`tagTpl_${template.id}_name`),
  content: t(`tagTpl_${template.id}_content`),
});

export const responderFromTemplate = (template, t) => ({
  trigger: t(`respTpl_${template.id}_trigger`),
  match: template.match,
  reply: t(`respTpl_${template.id}_reply`),
  channelId: null,
});
