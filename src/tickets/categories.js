// Ticket categories: several kinds of ticket on one panel ("Report a player",
// "Bug report", "Billing"…), each a button or a dropdown option with its own
// form questions, staff role, intro message, thread name and staff ping.
// With no categories the panel has the single "Open a ticket" button.
// Saved as Setting.TICKET_CATEGORIES and edited on the dashboard's Tickets page.
//
// A category's intro, thread name and ping left empty (null) follow the
// panel's (tickets/panel.js).

export const MAX_CATEGORIES = 25; // five rows of five buttons, or one dropdown
export const MAX_CATEGORY_QUESTIONS = 5; // Discord forms hold five inputs
export const MAX_LABEL_LENGTH = 80; // Discord button labels
export const MAX_QUESTION_LENGTH = 45; // Discord form labels
export const MAX_PLACEHOLDER_LENGTH = 100; // Discord form placeholders
export const MAX_ANSWER_LENGTH = 1000;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_INTRO_LENGTH = 1500;
export const MAX_NAME_FORMAT_LENGTH = 90;

export const BUTTON_STYLES = ["primary", "secondary", "success", "danger"];
export const QUESTION_STYLES = ["short", "paragraph"];

const ID = /^[a-z0-9]{1,12}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;

const clean = (text) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
const cleanText = (text) => (typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "");
const isLength = (value, min) => Number.isInteger(value) && value >= min && value <= MAX_ANSWER_LENGTH;

// A Unicode emoji (one, maybe with skin tone or joiners) or a custom one like <:name:id>.
export function isButtonEmoji(text) {
  if (typeof text !== "string" || text === "") {
    return false;
  }
  return CUSTOM_EMOJI.test(text) || (text.length <= 16 && /^\p{Extended_Pictographic}/u.test(text) && !/[\s\w]/.test(text));
}

// One form question. Saved questions used to be plain text: a required
// paragraph, which is still what a bare string means.
function readQuestion(value, problem, where) {
  const question = typeof value === "string" ? { label: value } : value;
  if (!question || typeof question !== "object") {
    problem(`${where}: each question needs a label.`);
    return null;
  }
  const label = clean(question.label);
  if (!label || label.length > MAX_QUESTION_LENGTH) {
    problem(`${where}: each question is 1 to ${MAX_QUESTION_LENGTH} characters (Discord's limit).`);
    return null;
  }
  const placeholder = clean(question.placeholder);
  if (placeholder.length > MAX_PLACEHOLDER_LENGTH) {
    problem(`${where}: "${label}" has a hint over ${MAX_PLACEHOLDER_LENGTH} characters.`);
  }
  const style = QUESTION_STYLES.includes(question.style) ? question.style : "paragraph";
  if (question.style !== undefined && question.style !== null && !QUESTION_STYLES.includes(question.style)) {
    problem(`${where}: "${label}" has an unknown answer size.`);
  }
  const minLength = question.minLength === undefined || question.minLength === null ? null : question.minLength;
  const maxLength = question.maxLength === undefined || question.maxLength === null ? null : question.maxLength;
  if ((minLength !== null && !isLength(minLength, 0)) || (maxLength !== null && !isLength(maxLength, 1))) {
    problem(`${where}: "${label}" answer lengths go from 0 to ${MAX_ANSWER_LENGTH}.`);
    return null;
  }
  if (minLength !== null && maxLength !== null && minLength > maxLength) {
    problem(`${where}: "${label}" has a shortest answer longer than its longest.`);
    return null;
  }
  return {
    label,
    placeholder: placeholder && placeholder.length <= MAX_PLACEHOLDER_LENGTH ? placeholder : null,
    style,
    required: question.required !== false,
    minLength: minLength || null,
    maxLength,
  };
}

// Reads one category, calling `problem(message)` for what's wrong. Returns
// null when it can't be used at all (no ID or label).
function readCategory(value, problem, { isRole = () => true } = {}) {
  if (!value || typeof value !== "object" || !ID.test(value.id ?? "")) {
    problem("Each category needs its own ID.");
    return null;
  }
  const label = clean(value.label);
  if (!label || label.length > MAX_LABEL_LENGTH) {
    problem(`Each category needs a button label of 1 to ${MAX_LABEL_LENGTH} characters.`);
    return null;
  }
  const where = `"${label}"`;
  let emoji = null;
  if (value.emoji !== null && value.emoji !== undefined && value.emoji !== "") {
    if (isButtonEmoji(value.emoji)) {
      emoji = value.emoji;
    } else {
      problem(`${where}: the emoji must be one emoji, like 🐞, or a server emoji like <:name:123…>.`);
    }
  }
  const description = clean(value.description);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problem(`${where}: the description is at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  let staffRoleId = null;
  if (value.staffRoleId !== null && value.staffRoleId !== undefined) {
    if (typeof value.staffRoleId === "string" && SNOWFLAKE.test(value.staffRoleId) && isRole(value.staffRoleId)) {
      staffRoleId = value.staffRoleId;
    } else {
      problem(`${where}: pick a staff role that exists and isn't @everyone or a bot's role.`);
    }
  }
  let style = "primary";
  if (value.style !== undefined && value.style !== null) {
    if (BUTTON_STYLES.includes(value.style)) {
      style = value.style;
    } else {
      problem(`${where}: unknown button colour.`);
    }
  }
  const intro = cleanText(value.intro);
  if (intro.length > MAX_INTRO_LENGTH) {
    problem(`${where}: the intro message is at most ${MAX_INTRO_LENGTH} characters.`);
  }
  const nameFormat = clean(value.nameFormat);
  if (nameFormat.length > MAX_NAME_FORMAT_LENGTH) {
    problem(`${where}: the thread name is at most ${MAX_NAME_FORMAT_LENGTH} characters.`);
  }
  let pingStaff = null;
  if (value.pingStaff !== undefined && value.pingStaff !== null) {
    if (typeof value.pingStaff === "boolean") {
      pingStaff = value.pingStaff;
    } else {
      problem(`${where}: ping staff must be on, off or the panel's setting.`);
    }
  }
  const questions = value.questions ?? [];
  if (!Array.isArray(questions) || questions.length > MAX_CATEGORY_QUESTIONS) {
    problem(`${where}: ask at most ${MAX_CATEGORY_QUESTIONS} questions.`);
  }
  return {
    id: value.id,
    label,
    emoji,
    description: description && description.length <= MAX_DESCRIPTION_LENGTH ? description : null,
    staffRoleId,
    style,
    intro: intro && intro.length <= MAX_INTRO_LENGTH ? intro : null,
    nameFormat: nameFormat && nameFormat.length <= MAX_NAME_FORMAT_LENGTH ? nameFormat : null,
    pingStaff,
    questions: Array.isArray(questions)
      ? questions
          .map((question) => readQuestion(question, problem, where))
          .filter(Boolean)
          .slice(0, MAX_CATEGORY_QUESTIONS)
      : [],
  };
}

const ignore = () => {};

// The saved categories with anything broken left out. Never throws.
export function normalizeCategories(saved) {
  if (!Array.isArray(saved)) {
    return [];
  }
  const seen = new Set();
  return saved
    .map((value) => readCategory(value, ignore))
    .filter((category) => category && !seen.has(category.id) && seen.add(category.id))
    .slice(0, MAX_CATEGORIES);
}

export class InvalidCategories extends Error {
  name = "InvalidCategories";
}

// Checks dashboard input; `isRole(id)` says whether a role can be a staff role.
// Returns what to save (null for none).
export function checkCategories(value, { isRole }) {
  if (!Array.isArray(value) || value.length > MAX_CATEGORIES) {
    throw new InvalidCategories(`Send at most ${MAX_CATEGORIES} categories.`);
  }
  const fail = (message) => {
    throw new InvalidCategories(message);
  };
  const ids = new Set();
  const categories = value.map((entry) => {
    const category = readCategory(entry, fail, { isRole });
    if (ids.has(category.id)) {
      fail("Each category needs its own ID.");
    }
    ids.add(category.id);
    return category;
  });
  return categories.length > 0 ? categories : null;
}

export const findCategory = (categories, id) => (id ? categories.find((category) => category.id === id) : undefined);

// "Bug report · 🐞, staff @QA, 2 questions", for log entries.
export function describeCategories(categories) {
  return normalizeCategories(categories)
    .map(
      (category) =>
        `${category.emoji ? `${category.emoji} ` : ""}${category.label}${category.staffRoleId ? ` (staff <@&${category.staffRoleId}>)` : ""} · ${category.questions.length || 1} question(s)`,
    )
    .join("; ") || "none (one Open a ticket button)";
}

// What a ticket's opener answered, as the ticket's subject: the answer alone
// for the single default question, else each question with its answer.
export function subjectFromAnswers(answers) {
  if (answers.length === 1 && answers[0].question === null) {
    return answers[0].answer;
  }
  return answers.map(({ question, answer }) => `**${question}**\n${answer}`).join("\n\n");
}
