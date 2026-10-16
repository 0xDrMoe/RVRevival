// Ban appeal settings: whether banned members may appeal on the dashboard,
// where staff hear about new appeals, the questions asked, and how long
// someone must wait after a denied appeal.

export const MAX_QUESTIONS = 5;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_ANSWER_LENGTH = 1000;
export const MAX_COOLDOWN_DAYS = 365;
export const DEFAULT_COOLDOWN_DAYS = 30;

export const DEFAULT_APPEALS = Object.freeze({ enabled: false, channelId: null, questions: [], cooldownDays: DEFAULT_COOLDOWN_DAYS });

const cleanQuestion = (text) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");

export function normalizeAppeals(saved) {
  const value = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const cooldown = value.cooldownDays;
  return {
    enabled: value.enabled === true,
    channelId: typeof value.channelId === "string" ? value.channelId : null,
    questions: Array.isArray(value.questions)
      ? value.questions.map(cleanQuestion).filter((text) => text && text.length <= MAX_QUESTION_LENGTH).slice(0, MAX_QUESTIONS)
      : [],
    cooldownDays: Number.isInteger(cooldown) && cooldown >= 0 && cooldown <= MAX_COOLDOWN_DAYS ? cooldown : DEFAULT_COOLDOWN_DAYS,
  };
}

export class InvalidAppeals extends Error {
  name = "InvalidAppeals";
}

// Checks dashboard input; `isChannel(id)` says whether staff can be told there.
export function checkAppeals(value, { isChannel }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.enabled !== "boolean") {
    throw new InvalidAppeals("Say whether appeals are open.");
  }
  if (value.channelId !== null && !isChannel(value.channelId)) {
    throw new InvalidAppeals("Pick a text channel for new appeals.");
  }
  if (!Array.isArray(value.questions) || value.questions.length > MAX_QUESTIONS) {
    throw new InvalidAppeals(`Ask at most ${MAX_QUESTIONS} questions.`);
  }
  if (value.questions.some((text) => !cleanQuestion(text) || cleanQuestion(text).length > MAX_QUESTION_LENGTH)) {
    throw new InvalidAppeals(`Each question needs 1 to ${MAX_QUESTION_LENGTH} characters.`);
  }
  if (!Number.isInteger(value.cooldownDays) || value.cooldownDays < 0 || value.cooldownDays > MAX_COOLDOWN_DAYS) {
    throw new InvalidAppeals(`The wait after a denied appeal is 0 to ${MAX_COOLDOWN_DAYS} days.`);
  }
  const config = normalizeAppeals(value);
  return config.enabled || config.channelId || config.questions.length > 0 ? config : null;
}

// The questions shown to someone appealing: the server's, or one general one.
export const appealQuestions = (config) => (config.questions.length > 0 ? config.questions : [null]);
