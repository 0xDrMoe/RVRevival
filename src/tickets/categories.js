// Ticket categories: several buttons on one ticket panel ("Report a player",
// "Bug report", "Billing"…), each with its own form questions and staff role.
// With no categories the panel has the single "Open a ticket" button.
// Saved as Setting.TICKET_CATEGORIES and edited on the dashboard's Tickets page.

export const MAX_CATEGORIES = 5; // one row of buttons
export const MAX_CATEGORY_QUESTIONS = 5; // Discord forms hold five inputs
export const MAX_LABEL_LENGTH = 80; // Discord button labels
export const MAX_QUESTION_LENGTH = 45; // Discord form labels
export const MAX_DESCRIPTION_LENGTH = 200;

const ID = /^[a-z0-9]{1,12}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;

const clean = (text) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");

// A Unicode emoji (one, maybe with skin tone or joiners) or a custom one like <:name:id>.
export function isButtonEmoji(text) {
  if (typeof text !== "string" || text === "") {
    return false;
  }
  return CUSTOM_EMOJI.test(text) || (text.length <= 16 && /^\p{Extended_Pictographic}/u.test(text) && !/[\s\w]/.test(text));
}

function normalizeCategory(value) {
  if (!value || typeof value !== "object" || !ID.test(value.id ?? "")) {
    return null;
  }
  const label = clean(value.label);
  if (!label || label.length > MAX_LABEL_LENGTH) {
    return null;
  }
  const description = clean(value.description);
  return {
    id: value.id,
    label,
    emoji: isButtonEmoji(value.emoji) ? value.emoji : null,
    description: description && description.length <= MAX_DESCRIPTION_LENGTH ? description : null,
    staffRoleId: typeof value.staffRoleId === "string" && SNOWFLAKE.test(value.staffRoleId) ? value.staffRoleId : null,
    questions: Array.isArray(value.questions)
      ? value.questions.map(clean).filter((text) => text && text.length <= MAX_QUESTION_LENGTH).slice(0, MAX_CATEGORY_QUESTIONS)
      : [],
  };
}

// The saved categories with anything broken left out. Never throws.
export function normalizeCategories(saved) {
  if (!Array.isArray(saved)) {
    return [];
  }
  const seen = new Set();
  return saved
    .map(normalizeCategory)
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
  const ids = new Set();
  for (const category of value) {
    if (!category || typeof category !== "object" || !ID.test(category.id ?? "") || ids.has(category.id)) {
      throw new InvalidCategories("Each category needs its own ID.");
    }
    ids.add(category.id);
    const label = clean(category.label);
    if (!label || label.length > MAX_LABEL_LENGTH) {
      throw new InvalidCategories(`Each category needs a button label of 1 to ${MAX_LABEL_LENGTH} characters.`);
    }
    if (category.emoji !== null && category.emoji !== undefined && category.emoji !== "" && !isButtonEmoji(category.emoji)) {
      throw new InvalidCategories(`"${label}": the emoji must be one emoji, like 🐞, or a server emoji like <:name:123…>.`);
    }
    if (category.description != null && clean(category.description).length > MAX_DESCRIPTION_LENGTH) {
      throw new InvalidCategories(`"${label}": the description is at most ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    if (category.staffRoleId != null && !isRole(category.staffRoleId)) {
      throw new InvalidCategories(`"${label}": pick a staff role that exists and isn't @everyone or a bot's role.`);
    }
    const questions = category.questions ?? [];
    if (!Array.isArray(questions) || questions.length > MAX_CATEGORY_QUESTIONS) {
      throw new InvalidCategories(`"${label}": ask at most ${MAX_CATEGORY_QUESTIONS} questions.`);
    }
    if (questions.some((text) => !clean(text) || clean(text).length > MAX_QUESTION_LENGTH)) {
      throw new InvalidCategories(`"${label}": each question is 1 to ${MAX_QUESTION_LENGTH} characters (Discord's limit).`);
    }
  }
  const categories = normalizeCategories(value);
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
