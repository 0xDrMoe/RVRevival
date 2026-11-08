import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import { checkSettingChanges, InvalidSetting } from "../src/dashboard/settingsRules.js";
import { isModeratorRole } from "../src/permissions/moderatorPermissions.js";
import { Setting } from "../src/settings/guildSettings.js";

const GUILD_ID = "900000000000000001";
const MEMBER_ID = "700000000000000001";
const BAN_ID = "700000000000000002";
const roles = [
  { id: GUILD_ID, name: "@everyone", position: 0, managed: false, permissions: "0" },
  { id: MEMBER_ID, name: "Member", position: 1, managed: false, permissions: String(PermissionFlagsBits.SendMessages) },
  { id: BAN_ID, name: "Bouncer", position: 2, managed: false, permissions: String(PermissionFlagsBits.BanMembers) },
];
const server = { guildId: GUILD_ID, channels: [], roles };

describe("moderator roles", () => {
  it("spots moderator permissions on API roles and discord.js roles", () => {
    expect(isModeratorRole(roles[1])).toBe(false);
    expect(isModeratorRole(roles[2])).toBe(true);
    expect(isModeratorRole({ permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) })).toBe(true);
    expect(isModeratorRole({ permissions: new PermissionsBitField(PermissionFlagsBits.SendMessages) })).toBe(false);
    expect(isModeratorRole(undefined)).toBe(false);
  });

  it("keeps them out of autoroles and level rewards on the dashboard", () => {
    expect(checkSettingChanges({ [Setting.AUTOROLES]: [MEMBER_ID] }, server)).toEqual({ [Setting.AUTOROLES]: [MEMBER_ID] });
    expect(() => checkSettingChanges({ [Setting.AUTOROLES]: [BAN_ID] }, server)).toThrow(InvalidSetting);
    expect(() => checkSettingChanges({ [Setting.LEVELING]: { enabled: true, rewards: [{ level: 5, roleId: BAN_ID }] } }, server)).toThrow(InvalidSetting);
  });
});
