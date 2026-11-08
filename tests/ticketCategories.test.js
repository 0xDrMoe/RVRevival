import { describe, expect, it } from "vitest";
import { checkCategories, InvalidCategories, isButtonEmoji, MAX_CATEGORIES, normalizeCategories, subjectFromAnswers } from "../src/tickets/categories.js";

const ROLE_ID = "700000000000000001";
const isRole = (id) => id === ROLE_ID;
const bug = { id: "bugs", label: " Bug   report ", emoji: "🐞", description: "Broken things", staffRoleId: ROLE_ID, questions: ["What happened?"] };
// What a category looks like once checked: every option filled in.
const cleaned = {
  ...bug,
  label: "Bug report",
  style: "primary",
  intro: null,
  nameFormat: null,
  pingStaff: null,
  questions: [{ label: "What happened?", placeholder: null, style: "paragraph", required: true, minLength: null, maxLength: null }],
};

describe("ticket categories", () => {
  it("accepts one emoji or a server emoji", () => {
    expect(["🐞", "👍🏽", "<:rv:123456789012345678>", "<a:spin:123456789012345678>"].every(isButtonEmoji)).toBe(true);
    expect(["", "a", ":bug:", "🐞 bug", "1"].some(isButtonEmoji)).toBe(false);
  });

  it("checks and cleans dashboard input", () => {
    expect(checkCategories([bug], { isRole })).toEqual([cleaned]);
    expect(checkCategories([], { isRole })).toBeNull();
    const bad = [
      [bug, { ...bug }],
      [{ ...bug, id: "Not OK" }],
      [{ ...bug, label: "" }],
      [{ ...bug, emoji: "bug" }],
      [{ ...bug, staffRoleId: "700000000000000002" }],
      [{ ...bug, questions: ["x".repeat(46)] }],
      [{ ...bug, questions: ["a", "b", "c", "d", "e", "f"] }],
      [{ ...bug, style: "pink" }],
      [{ ...bug, intro: "x".repeat(1501) }],
      [{ ...bug, nameFormat: "x".repeat(91) }],
      [{ ...bug, pingStaff: "yes" }],
      [{ ...bug, questions: [{ label: "Age", style: "huge" }] }],
      [{ ...bug, questions: [{ label: "Age", minLength: 10, maxLength: 5 }] }],
      [{ ...bug, questions: [{ label: "Age", maxLength: 5000 }] }],
      [{ ...bug, questions: [{ label: "Age", placeholder: "x".repeat(101) }] }],
      Array.from({ length: MAX_CATEGORIES + 1 }, (_, index) => ({ ...bug, id: `c${index}` })),
    ];
    for (const value of bad) {
      expect(() => checkCategories(value, { isRole })).toThrow(InvalidCategories);
    }
  });

  it("keeps each category's own look, intro, thread name, ping and question settings", () => {
    const full = {
      ...bug,
      style: "danger",
      intro: "Hi {user}!\nTell us more.",
      nameFormat: " bug-{number} ",
      pingStaff: false,
      questions: [
        { label: "Your platform", placeholder: "PC, PlayStation…", style: "short", required: false, minLength: 2, maxLength: 40 },
        "What happened?",
      ],
    };
    expect(checkCategories([full], { isRole })).toEqual([
      {
        ...cleaned,
        style: "danger",
        intro: "Hi {user}!\nTell us more.",
        nameFormat: "bug-{number}",
        pingStaff: false,
        questions: [{ label: "Your platform", placeholder: "PC, PlayStation…", style: "short", required: false, minLength: 2, maxLength: 40 }, cleaned.questions[0]],
      },
    ]);
  });

  it("allows up to 25 categories, for five rows of buttons or one dropdown", () => {
    const many = Array.from({ length: MAX_CATEGORIES }, (_, index) => ({ id: `c${index}`, label: `Type ${index}` }));
    expect(checkCategories(many, { isRole })).toHaveLength(25);
  });

  it("drops broken saved categories instead of failing", () => {
    expect(normalizeCategories([bug, { id: "bugs", label: "Duplicate" }, { id: "x", label: "" }, null])).toEqual([cleaned]);
    expect(normalizeCategories([{ ...bug, style: "pink", questions: ["", { label: "Ok", minLength: 9, maxLength: 2 }, "Fine"] }])).toEqual([
      { ...cleaned, questions: [{ ...cleaned.questions[0], label: "Fine" }] },
    ]);
    expect(normalizeCategories("nope")).toEqual([]);
  });

  it("turns answers into the ticket's subject", () => {
    expect(subjectFromAnswers([{ question: null, answer: "Help" }])).toBe("Help");
    expect(subjectFromAnswers([{ question: "A?", answer: "1" }, { question: "B?", answer: "2" }])).toBe("**A?**\n1\n\n**B?**\n2");
  });
});
