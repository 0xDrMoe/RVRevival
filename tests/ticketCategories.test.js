import { describe, expect, it } from "vitest";
import { checkCategories, InvalidCategories, isButtonEmoji, normalizeCategories, subjectFromAnswers } from "../src/tickets/categories.js";

const ROLE_ID = "700000000000000001";
const isRole = (id) => id === ROLE_ID;
const bug = { id: "bugs", label: " Bug   report ", emoji: "🐞", description: "Broken things", staffRoleId: ROLE_ID, questions: ["What happened?"] };

describe("ticket categories", () => {
  it("accepts one emoji or a server emoji", () => {
    expect(["🐞", "👍🏽", "<:rv:123456789012345678>", "<a:spin:123456789012345678>"].every(isButtonEmoji)).toBe(true);
    expect(["", "a", ":bug:", "🐞 bug", "1"].some(isButtonEmoji)).toBe(false);
  });

  it("checks and cleans dashboard input", () => {
    expect(checkCategories([bug], { isRole })).toEqual([{ ...bug, label: "Bug report" }]);
    expect(checkCategories([], { isRole })).toBeNull();
    const bad = [
      [bug, { ...bug }],
      [{ ...bug, id: "Not OK" }],
      [{ ...bug, label: "" }],
      [{ ...bug, emoji: "bug" }],
      [{ ...bug, staffRoleId: "700000000000000002" }],
      [{ ...bug, questions: ["x".repeat(46)] }],
      [{ ...bug, questions: ["a", "b", "c", "d", "e", "f"] }],
      Array.from({ length: 6 }, (_, index) => ({ ...bug, id: `c${index}` })),
    ];
    for (const value of bad) {
      expect(() => checkCategories(value, { isRole })).toThrow(InvalidCategories);
    }
  });

  it("drops broken saved categories instead of failing", () => {
    expect(normalizeCategories([bug, { id: "bugs", label: "Duplicate" }, { id: "x", label: "" }, null])).toEqual([{ ...bug, label: "Bug report" }]);
    expect(normalizeCategories("nope")).toEqual([]);
  });

  it("turns answers into the ticket's subject", () => {
    expect(subjectFromAnswers([{ question: null, answer: "Help" }])).toBe("Help");
    expect(subjectFromAnswers([{ question: "A?", answer: "1" }, { question: "B?", answer: "2" }])).toBe("**A?**\n1\n\n**B?**\n2");
  });
});
