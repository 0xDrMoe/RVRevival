// Message variables: the {words} in a message that the bot fills in when it
// posts, like {user} in "Welcome {user}!". One list for every feature, so a
// variable means the same thing on every dashboard page and in every command.
//
// Shared by the bot (to fill and check messages) and the dashboard (for the
// picker under each message box, the warnings and the Guide), so it's plain
// JavaScript with no imports.
//
// A variable is {name}: lowercase letters only, in curly brackets, no spaces.
// Each place that takes a message (a context) uses some of them. Anything in
// curly brackets that isn't one of that place's variables is refused when
// it's saved, with a message saying what it can use instead, so a typo never
// reaches Discord as "{usr}". Old spellings (aliases) still work but aren't
// offered.

export const VARIABLES = Object.freeze({
  user: { about: "A mention of the member, like @Moe. Mentions in these messages don't ping.", example: "@Moe" },
  username: { about: "The member's display name, as plain text.", example: "Moe" },
  server: { about: "The server's name.", example: "Rabble Lounge" },
  members: { about: "How many members the server has, bots included.", example: "1,234" },
  channel: { about: "A link to the channel the message was sent in.", example: "#general" },
  level: { about: "The level the member just reached.", example: "5" },
  number: { about: "The ticket's number.", example: "42" },
  staff: { about: "A mention of the staff role, or the word staff when there's none.", example: "@Staff" },
  category: { about: "The ticket type the member picked.", example: "Bug report" },
  title: { about: "The post's title (for Bluesky and Mastodon, the start of the post).", example: "My new video" },
  link: { about: "The link to the post.", example: "https://youtu.be/dQw4w9WgXcQ" },
  author: { about: "Who posted it (the feed's name when the post doesn't say).", example: "Rabble" },
  feed: { about: "The feed's name.", example: "Rabble news" },
  game: { about: "What the stream is playing (Twitch and Kick only).", example: "Rumbleverse" },
  humans: { about: "Members who aren't bots.", example: "1,200" },
  bots: { about: "How many bots the server has.", example: "34" },
  boosts: { about: "How many boosts the server has.", example: "14" },
  tier: { about: "The server's boost level, 0 to 3.", example: "2" },
  channels: { about: "How many channels the server has.", example: "48" },
  roles: { about: "How many roles the server has.", example: "25" },
});

// Where messages are written, and which variables each one can use.
// `notes` change a variable's description for that place only.
export const VARIABLE_CONTEXTS = Object.freeze({
  welcome: {
    where: "welcome and leave messages and the welcome DM",
    variables: ["user", "username", "server", "members"],
    aliases: { count: "members" },
  },
  levelUp: { where: "level-up messages", variables: ["user", "username", "level", "server"] },
  birthday: {
    where: "birthday messages",
    variables: ["user", "server"],
    notes: { user: "Mentions of everyone with a birthday that day, like @Moe and @Sam." },
  },
  responder: { where: "auto-responder replies", variables: ["user", "username", "server", "channel"] },
  ticket: {
    where: "ticket intros and thread names",
    variables: ["user", "username", "number", "staff", "category", "server"],
    notes: { user: "A mention of the member who opened the ticket.", username: "The display name of the member who opened the ticket." },
  },
  feed: { where: "feed messages", variables: ["title", "link", "author", "feed", "game"] },
  counter: { where: "stats counter names", variables: ["members", "humans", "bots", "boosts", "tier", "channels", "roles"] },
  voice: {
    where: "voice channel names",
    variables: ["username"],
    aliases: { name: "username" },
    notes: { username: "The display name of the member who made the channel." },
  },
});

export const VARIABLE_CONTEXT_NAMES = Object.keys(VARIABLE_CONTEXTS);

// A word in curly brackets, like {user}, {User} or { user }. Other brackets,
// like {1,2} or a JSON snippet, are left alone.
const TOKEN = /\{(\s*[A-Za-z_][A-Za-z0-9_]{0,31}\s*)\}/g;

const contextOf = (name) => {
  const context = VARIABLE_CONTEXTS[name];
  if (!context) {
    throw new Error(`Unknown variable context "${name}".`);
  }
  return context;
};

// The variable a {name} stands for in a context (following aliases), or null.
function resolve(context, name) {
  if (context.variables.includes(name)) {
    return name;
  }
  return context.aliases?.[name] ?? null;
}

export const token = (name) => `{${name}}`;

// "{a}, {b} and {c}"
export function listTokens(names) {
  const tokens = names.map(token);
  return tokens.length <= 1 ? tokens.join("") : `${tokens.slice(0, -1).join(", ")} and ${tokens.at(-1)}`;
}

// The variables a place offers, in order: [{ name, token, about, example }].
export function variablesFor(contextName) {
  const context = contextOf(contextName);
  return context.variables.map((name) => ({
    name,
    token: token(name),
    about: context.notes?.[name] ?? VARIABLES[name].about,
    example: VARIABLES[name].example,
  }));
}

// The places a variable works in.
export const contextsUsing = (name) => VARIABLE_CONTEXT_NAMES.filter((contextName) => VARIABLE_CONTEXTS[contextName].variables.includes(name));

// Fills the variables in a template. `values` maps a variable's name to its
// text. Variables this place doesn't have, or without a value, stay as typed.
export function fillVariables(template, contextName, values) {
  const context = contextOf(contextName);
  return String(template ?? "").replace(TOKEN, (whole, inner) => {
    const name = resolve(context, inner);
    const value = name ? values[name] : undefined;
    return value === undefined || value === null ? whole : String(value);
  });
}

// The variables a template uses (each once, after aliases).
export function usedVariables(template, contextName) {
  const context = contextOf(contextName);
  const used = new Set();
  for (const [, inner] of String(template ?? "").matchAll(TOKEN)) {
    const name = resolve(context, inner);
    if (name) {
      used.add(name);
    }
  }
  return [...used];
}

// What's wrong with the variables in a template, each problem once:
//   { token: "{usr}", kind: "unknown" }
//   { token: "{User}", kind: "case", suggestion: "{user}" }        wrong capitals or spaces
//   { token: "{level}", kind: "elsewhere", where: ["level-up messages"] }   works elsewhere only
export function findVariableProblems(template, contextName) {
  const context = contextOf(contextName);
  const problems = [];
  const seen = new Set();
  for (const [whole, inner] of String(template ?? "").matchAll(TOKEN)) {
    if (seen.has(whole) || resolve(context, inner)) {
      continue;
    }
    seen.add(whole);
    const tidy = inner.trim().toLowerCase();
    if (resolve(context, tidy)) {
      problems.push({ token: whole, kind: "case", suggestion: token(resolve(context, tidy)) });
    } else if (VARIABLES[tidy]) {
      problems.push({ token: whole, kind: "elsewhere", name: tidy, where: contextsUsing(tidy).map((other) => VARIABLE_CONTEXTS[other].where) });
    } else {
      problems.push({ token: whole, kind: "unknown" });
    }
  }
  return problems;
}

// One English sentence about the template's variables, or null when they're
// all fine. Used for the errors the bot and the dashboard's API send back.
export function variableError(template, contextName) {
  const problems = findVariableProblems(template, contextName);
  if (problems.length === 0) {
    return null;
  }
  const context = contextOf(contextName);
  const first = problems[0];
  const offer = `${capitalize(context.where)} can use ${listTokens(context.variables)}.`;
  if (first.kind === "case") {
    return `${first.token} isn't a variable: did you mean ${first.suggestion}? ${offer}`;
  }
  if (first.kind === "elsewhere") {
    return `${first.token} only works in ${first.where.join(" and ")}. ${offer}`;
  }
  const unknown = problems.filter((problem) => problem.kind === "unknown").map((problem) => problem.token);
  return `${unknown.join(", ")} ${unknown.length === 1 ? "isn't a variable" : "aren't variables"}. ${offer}`;
}

// Example text for each variable, for previews.
export function exampleValues(contextName) {
  return Object.fromEntries(variablesFor(contextName).map(({ name, example }) => [name, example]));
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
