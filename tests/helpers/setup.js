// Runs before every test file: shared bot-wide state starts fresh for each test.
import { beforeEach } from "vitest";
import { resetDms } from "../../src/utils/dms.js";

beforeEach(() => {
  resetDms();
});
