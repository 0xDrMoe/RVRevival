import { describe, expect, it } from "vitest";
import { foldEscalationInto, moveAutomodEscalation } from "../src/moderation/warnStepsMigration.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";

const GUILD_A = "900000000000000001";
const GUILD_B = "900000000000000002";
const GUILD_C = "900000000000000003";

describe("moving automod's escalation into the warning steps", () => {
  it("adds a 1-day step, drops the escalation and does nothing the second time", async () => {
    const settings = new GuildSettings();
    await settings.set(GUILD_A, Setting.AUTOMOD, { enabled: true, escalation: { warnings: 3, action: "timeout", timeoutMinutes: 120 } });
    await settings.set(GUILD_B, Setting.AUTOMOD, { enabled: true, escalation: { warnings: 0, action: "timeout", timeoutMinutes: 60 } });
    await settings.set(GUILD_C, Setting.AUTOMOD, { enabled: true, escalation: { warnings: 2, action: "ban" } });
    await settings.set(GUILD_C, Setting.WARN_THRESHOLDS, [{ count: 2, days: 30, action: "kick" }, { count: 5, days: 30, action: "ban" }]);

    expect(await moveAutomodEscalation(settings)).toBe(3);
    expect(settings.get(GUILD_A, Setting.WARN_THRESHOLDS)).toEqual([{ count: 3, days: 1, action: "timeout", minutes: 120 }]);
    expect(settings.get(GUILD_A, Setting.AUTOMOD)).toEqual({ enabled: true });
    // Off: nothing added, but the old field still goes.
    expect(settings.get(GUILD_B, Setting.WARN_THRESHOLDS)).toBeUndefined();
    expect(settings.get(GUILD_B, Setting.AUTOMOD)).toEqual({ enabled: true });
    // The server's own step for the same count wins.
    expect(settings.get(GUILD_C, Setting.WARN_THRESHOLDS)).toEqual([{ count: 2, days: 30, action: "kick" }, { count: 5, days: 30, action: "ban" }]);

    expect(await moveAutomodEscalation(settings)).toBe(0);
  });

  it("folds an older backup's escalation into its steps", () => {
    const backup = { automod: { enabled: true, escalation: { warnings: 4, action: "kick" } }, staffRoleId: "1" };
    expect(foldEscalationInto(backup)).toEqual({
      automod: { enabled: true },
      staffRoleId: "1",
      warnThresholds: [{ count: 4, days: 1, action: "kick" }],
    });
    const plain = { automod: { enabled: true } };
    expect(foldEscalationInto(plain)).toBe(plain);
  });
});
