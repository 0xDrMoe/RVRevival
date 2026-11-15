import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/dashboard/public/style.css", import.meta.url), "utf8");

// The phone drawer is position: fixed. Browsers apply align-self to fixed boxes,
// so the desktop align-self: start would size the drawer to all its links and
// leave nothing to scroll. The phone rule must stretch it back.
describe("dashboard sidebar on phones", () => {
  it("stretches the fixed drawer so it can scroll", () => {
    const block = css.slice(css.indexOf("@media (max-width: 900px)"));
    const rule = block.match(/\n {2}\.sidebar \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("position: fixed");
    expect(rule).toMatch(/align-self:\s*stretch/);
    expect(rule).toMatch(/overscroll-behavior:\s*contain/);
  });
});
