import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, parseLogLevel, redact, registerSecret } from "../src/utils/logger.js";

const FAKE_TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OQ", "GabcDE", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("."); // fake; split so secret scanners ignore it

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts token-shaped strings and registered secrets", () => {
    registerSecret("super-secret-value");
    expect(redact(`token=${FAKE_TOKEN}`)).toBe("token=[REDACTED]");
    expect(redact("x super-secret-value y")).toBe("x [REDACTED] y");
  });

  it("never writes tokens in messages or error context", () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = createLogger("debug");
    log.error(`bad ${FAKE_TOKEN}`, { error: new Error(`failed with ${FAKE_TOKEN}`) });
    const written = out.mock.calls.flat().join(" ");
    expect(written).not.toContain(FAKE_TOKEN);
    expect(written).toContain("[REDACTED]");
  });

  it("filters below the configured level", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = createLogger("info");
    log.debug("hidden");
    log.info("shown");
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("parses log levels with a safe default", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel("nonsense")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
  });
});
