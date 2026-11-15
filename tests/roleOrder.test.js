import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { byRolePosition } from "../src/dashboard/app.js";

// Role lists on the dashboard follow Server Settings > Roles: highest first.
describe("role order", () => {
  it("sorts by position, highest first, with the older role first on a tie", () => {
    const roles = [
      { id: "300", position: 1 },
      { id: "900000000000000002", position: 5 },
      { id: "900000000000000001", position: 5 },
      { id: "100", position: 9 },
    ];
    expect(roles.sort(byRolePosition).map((role) => role.id)).toEqual(["100", "900000000000000001", "900000000000000002", "300"]);
  });

  it("orders picked roles and keeps bot roles in place in the dashboard pages", () => {
    const page = readFileSync(new URL("../src/dashboard/public/app.js", import.meta.url), "utf8");
    const source = page.match(/function inRoleOrder\(ids, roles\) \{[\s\S]*?\n\}/)[0];
    const inRoleOrder = new Function(`${source}; return inRoleOrder;`)();
    const roles = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(inRoleOrder(["gone", "c", "a"], roles)).toEqual(["a", "c", "gone"]);
    // Bot roles are no longer pulled out under their own heading.
    expect(page).not.toMatch(/role\.managed \? t\("roleKind_bot"\)/);
    // Role choosers draw their chips in server order.
    expect(page).toMatch(/inRoleOrder\(chosen, roles\)/);
  });
});
