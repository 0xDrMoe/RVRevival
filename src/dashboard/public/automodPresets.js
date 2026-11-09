// Ready-made automod setups for the Automod page's Simple view. A preset sets
// which rules are on, what they do, their numbers, the timeout length and
// warning escalation, and resets each rule's advanced extras. It never touches
// the banned words, allowed websites, exempt roles or channels, or the main switch.
//
// Plain data with no page code, so tests check every preset is a valid
// automod setting (tests/automodPresets.test.js).

export const AUTOMOD_PRESETS = ["light", "balanced", "strict"];
export const RECOMMENDED_PRESET = "balanced";
// Shown when the settings don't match any preset.
export const CUSTOM_PRESET = "custom";

const rule = (enabled, action, numbers = {}) => ({ enabled, action, ...numbers });

const PRESETS = {
  // Only the obvious: other servers' invites, ping floods and fast spam. Nothing is punished.
  light: {
    rules: {
      bannedWords: rule(true, "delete"),
      invites: rule(true, "delete"),
      links: rule(false, "delete"),
      mentions: rule(true, "delete", { limit: 8 }),
      spam: rule(true, "delete", { messages: 8, seconds: 5 }),
      duplicates: rule(false, "delete", { count: 4 }),
      caps: rule(false, "delete", { percent: 80, minLength: 20 }),
    },
    timeoutMinutes: 10,
    escalation: { warnings: 0, action: "timeout", timeoutMinutes: 60 },
  },
  // Most servers: warns for invites and banned words, short timeouts for floods.
  balanced: {
    rules: {
      bannedWords: rule(true, "warn"),
      invites: rule(true, "warn"),
      links: rule(false, "delete"),
      mentions: rule(true, "timeout", { limit: 5 }),
      spam: rule(true, "timeout", { messages: 6, seconds: 5 }),
      duplicates: rule(true, "delete", { count: 3 }),
      caps: rule(false, "delete", { percent: 70, minLength: 15 }),
    },
    timeoutMinutes: 10,
    escalation: { warnings: 3, action: "timeout", timeoutMinutes: 60 },
  },
  // Big or public servers: every rule on, links only to allowed websites, longer timeouts.
  strict: {
    rules: {
      bannedWords: rule(true, "warn"),
      invites: rule(true, "warn"),
      links: rule(true, "delete"),
      mentions: rule(true, "timeout", { limit: 4 }),
      spam: rule(true, "timeout", { messages: 5, seconds: 5 }),
      duplicates: rule(true, "warn", { count: 2 }),
      caps: rule(true, "delete", { percent: 70, minLength: 12 }),
    },
    timeoutMinutes: 30,
    escalation: { warnings: 3, action: "timeout", timeoutMinutes: 1440 },
  },
};

// What a preset resets on every rule, so the result is exactly the preset.
const RULE_EXTRAS = { notify: true, timeoutMinutes: null, exemptRoleIds: [], exemptChannelIds: [] };

// A copy of `config` set up like `preset`.
export function applyPreset(config, preset) {
  const values = PRESETS[preset];
  if (!values) {
    throw new Error(`Unknown automod preset ${preset}`);
  }
  const next = structuredClone(config);
  for (const [name, settings] of Object.entries(values.rules)) {
    next.rules[name] = { ...next.rules[name], ...structuredClone(RULE_EXTRAS), ...settings };
  }
  next.timeoutMinutes = values.timeoutMinutes;
  next.escalation = { ...values.escalation };
  return next;
}

const sameList = (list) => !Array.isArray(list) || list.length === 0;

// Which preset `config` is set up as, or CUSTOM_PRESET.
export function matchingPreset(config) {
  return (
    AUTOMOD_PRESETS.find((preset) => {
      const values = PRESETS[preset];
      const rulesMatch = Object.entries(values.rules).every(([name, settings]) => {
        const current = config.rules?.[name];
        return (
          current &&
          Object.entries(settings).every(([key, value]) => current[key] === value) &&
          current.notify !== false &&
          (current.timeoutMinutes ?? null) === null &&
          sameList(current.exemptRoleIds) &&
          sameList(current.exemptChannelIds)
        );
      });
      return (
        rulesMatch &&
        config.timeoutMinutes === values.timeoutMinutes &&
        Object.entries(values.escalation).every(([key, value]) => config.escalation?.[key] === value)
      );
    }) ?? CUSTOM_PRESET
  );
}
