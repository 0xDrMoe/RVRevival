import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  anchorFor,
  blockPositions,
  cleanColorName,
  colorChoices,
  findColor,
  hexToHsl,
  MAX_COLORS,
  nameTaken,
  normalizeColors,
  parseColor,
  randomColor,
  reorderPositions,
  SortKind,
  sortColors,
} from "../src/colors/colors.js";
import { ColorError, colorRoleProblem, createColorService, LIST_FILE, PICK_PREFIX, REMOVE_ID } from "../src/colors/colorService.js";
import { readFontMetrics } from "../src/colors/fontMetrics.js";
import { buildListSvg, columnsFor, fitLabel, LAYOUT, listFontMetrics, renderColorList } from "../src/colors/listImage.js";
import { checkColorOptions, describeColorOptions, InvalidColorOptions, normalizeColorOptions } from "../src/colors/options.js";
import { PACK_NAMES, PACKS } from "../src/colors/packs.js";
import { buildColorCommandData, createColorCommand, nearestName } from "../src/commands/color.js";
import { checkSettingChanges, describeChange, InvalidSetting } from "../src/dashboard/settingsRules.js";
import { Status } from "../src/logs/actionLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const OWNER_ID = "300000000000000000";
const USER_ID = "300000000000000020";
const ADMIN_ID = "300000000000000030";
const CHANNEL_ID = "800000000000000001";
const OTHER_CHANNEL_ID = "800000000000000002";
const BOT_ROLE = "700000000000000099";
const RED = "700000000000000001";
const BLUE = "700000000000000002";
const OLD_ROLE = "700000000000000003";
const VIP = "700000000000000004";
const MOD = "700000000000000005";
const MANAGER = "700000000000000006";

const color = (roleId, name, hex, extra = {}) => ({ roleId, name, hex, hex2: null, made: true, addedAt: 1, ...extra });

describe("reading colours and names", () => {
  it("reads hex codes, short hex and RGB", () => {
    expect(parseColor("#FF8800")).toBe("#ff8800");
    expect(parseColor("ff8800")).toBe("#ff8800");
    expect(parseColor("#f80")).toBe("#ff8800");
    expect(parseColor("rgb(255, 136, 0)")).toBe("#ff8800");
    expect(parseColor("255,136,0")).toBe("#ff8800");
    expect(parseColor("255 136 0")).toBe("#ff8800");
    for (const bad of ["", "red", "#ff88", "256,0,0", "#gggggg", null]) {
      expect(parseColor(bad), String(bad)).toBeUndefined();
    }
  });

  it("cleans names to one short line", () => {
    expect(cleanColorName("  Sky\n  Blue ")).toBe("Sky Blue");
    expect(cleanColorName("x".repeat(50))).toHaveLength(32);
    expect(cleanColorName("   ")).toBe("");
  });

  it("finds a color by number, name or role, ignoring case", () => {
    const list = [color(RED, "Red", "#ff0000"), color(BLUE, "Sky Blue", "#29b6f6")];
    expect(findColor(list, "2")).toBe(list[1]);
    expect(findColor(list, "#1")).toBe(list[0]);
    expect(findColor(list, "sky blue")).toBe(list[1]);
    expect(findColor(list, `<@&${RED}>`)).toBe(list[0]);
    expect(findColor(list, "3")).toBeUndefined();
    expect(findColor(list, "Green")).toBeUndefined();
    expect(nameTaken(list, "RED")).toBe(true);
    expect(nameTaken(list, "Red", RED)).toBe(false);
  });

  it("suggests colors with their number as the value", () => {
    const list = [color(RED, "Red", "#ff0000"), color(BLUE, "Sky Blue", "#29b6f6", { hex2: "#ffffff" })];
    expect(colorChoices(list, "sky")).toEqual([{ name: "2. Sky Blue (#29b6f6 → #ffffff)", value: "2" }]);
    expect(colorChoices(list, "")).toHaveLength(2);
  });

  it("drops broken entries and duplicate roles from the saved list", () => {
    const saved = [color(RED, "Red", "#ff0000"), color(RED, "Again", "#00ff00"), { roleId: "x", name: "Bad", hex: "#000000" }, color(BLUE, "", "#000000"), color(BLUE, "Blue", "blue")];
    expect(normalizeColors(saved)).toEqual([color(RED, "Red", "#ff0000")]);
    expect(normalizeColors("nope")).toEqual([]);
  });

  it("makes readable random colours", () => {
    let seed = 0.1;
    const random = () => (seed = (seed * 9301 + 0.49297) % 1);
    for (let index = 0; index < 50; index += 1) {
      const hsl = hexToHsl(randomColor(random));
      expect(hsl.l).toBeGreaterThan(0.4);
      expect(hsl.l).toBeLessThan(0.75);
    }
  });
});

describe("packs", () => {
  it("have unique names and real colours", () => {
    expect(PACK_NAMES).toEqual(["classic", "pastel", "neon", "earth", "jewel", "mono", "spring", "summer", "autumn", "winter"]);
    const all = Object.values(PACKS).flat();
    for (const [name, hex] of all) {
      expect(cleanColorName(name)).toBe(name);
      expect(parseColor(hex)).toBe(hex);
    }
    for (const pack of Object.values(PACKS)) {
      expect(new Set(pack.map(([name]) => name.toLowerCase())).size).toBe(pack.length);
    }
    expect(PACKS.classic).toHaveLength(41);
  });

  it("names a suggestion after the closest pack colour", () => {
    expect(nearestName("#e53935")).toBe("Red");
    expect(nearestName("#000000")).toBe("Black");
  });
});

describe("sorting", () => {
  const list = [
    color("700000000000000011", "Blue", "#0000ff", { addedAt: 3 }),
    color("700000000000000012", "grey", "#808080", { addedAt: 1 }),
    color("700000000000000013", "Red", "#ff0000", { addedAt: 2 }),
    color("700000000000000014", "Dark Red", "#550000", { addedAt: 4 }),
    color("700000000000000015", "Pale Red", "#ff9999", { addedAt: 5 }),
  ];
  const names = (sorted) => sorted.map((entry) => entry.name);

  it("sorts by rainbow, with greys last", () => {
    expect(names(sortColors(list, SortKind.HUE))).toEqual(["Dark Red", "Red", "Pale Red", "Blue", "grey"]);
  });

  it("sorts by shades, dark to light within a hue", () => {
    expect(names(sortColors(list, SortKind.SHADE))).toEqual(["Dark Red", "Red", "Pale Red", "Blue", "grey"]);
  });

  it("sorts by lightness, vividness, name and date", () => {
    expect(names(sortColors(list, SortKind.LUMINANCE))[0]).toBe("Dark Red");
    expect(names(sortColors(list, SortKind.SATURATION))[0]).toBe("grey");
    expect(names(sortColors(list, SortKind.NAME))).toEqual(["Blue", "Dark Red", "grey", "Pale Red", "Red"]);
    expect(names(sortColors(list, SortKind.ADDED))).toEqual(["grey", "Red", "Blue", "Dark Red", "Pale Red"]);
    expect(() => sortColors(list, "nope")).toThrow();
  });

  it("doesn't change the list it was given", () => {
    const copy = [...list];
    sortColors(list, SortKind.NAME);
    expect(list).toEqual(copy);
  });
});

describe("role positions", () => {
  // Bottom to top: @everyone 0, A 1, red 2, B 3, blue 4, bot 5, admin 6.
  const roles = [
    { id: GUILD_ID, position: 0 },
    { id: "700000000000000081", position: 1 },
    { id: RED, position: 2 },
    { id: "700000000000000082", position: 3 },
    { id: BLUE, position: 4 },
    { id: BOT_ROLE, position: 5 },
    { id: "700000000000000083", position: 6 },
  ];

  it("puts the block under the role above the highest color role", () => {
    expect(anchorFor(roles, [RED, BLUE], BOT_ROLE)).toBe(BOT_ROLE);
    expect(anchorFor(roles, [RED], BOT_ROLE)).toBe("700000000000000082");
    expect(anchorFor(roles, [], BOT_ROLE)).toBe(BOT_ROLE);
  });

  it("never puts the block above the bot", () => {
    const high = [...roles.filter((role) => role.id !== BLUE), { id: BLUE, position: 7 }];
    expect(anchorFor(high, [BLUE], BOT_ROLE)).toBe(BOT_ROLE);
  });

  it("gathers the color roles into one block in list order", () => {
    const changes = blockPositions(roles, [RED, BLUE], BOT_ROLE, GUILD_ID);
    const after = new Map(roles.map((role) => [role.id, role.position]));
    for (const change of changes) {
      after.set(change.id, change.position);
    }
    const order = [...after].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    expect(order).toEqual([GUILD_ID, "700000000000000081", "700000000000000082", BLUE, RED, BOT_ROLE, "700000000000000083"]);
    expect(changes.some((change) => change.id === GUILD_ID)).toBe(false);
    expect(changes.some((change) => change.id === "700000000000000083")).toBe(false);
  });

  it("moves nothing when the anchor is unknown or the block is empty", () => {
    expect(blockPositions(roles, [RED], "700000000000000000", GUILD_ID)).toEqual([]);
    expect(blockPositions(roles, [], BOT_ROLE, GUILD_ID)).toEqual([]);
  });

  it("reorders roles within the positions they already hold", () => {
    expect(reorderPositions(roles, [RED, BLUE])).toEqual([
      { id: RED, position: 4 },
      { id: BLUE, position: 2 },
    ]);
    expect(reorderPositions(roles, [BLUE, RED])).toEqual([]);
  });
});

describe("options", () => {
  const isRole = (id) => [VIP, MOD, MANAGER].includes(id);
  const isChannel = (id) => id === CHANNEL_ID;

  it("fills in the defaults", () => {
    expect(normalizeColorOptions(undefined)).toEqual({ image: true, channelId: null, managerRoleIds: [], allowRoleIds: [], denyRoleIds: [], joinColor: null, overlapWarning: true });
    expect(normalizeColorOptions({ image: false, joinColor: "random" })).toMatchObject({ image: false, joinColor: "random" });
  });

  it("checks what the dashboard sends, saving nothing for the defaults", () => {
    expect(checkColorOptions({ image: true }, { isRole, isChannel })).toBeNull();
    expect(checkColorOptions({ image: false, channelId: CHANNEL_ID, managerRoleIds: [MANAGER] }, { isRole, isChannel })).toMatchObject({ image: false, channelId: CHANNEL_ID, managerRoleIds: [MANAGER] });
    expect(() => checkColorOptions({ image: "yes" }, { isRole, isChannel })).toThrow(InvalidColorOptions);
    expect(() => checkColorOptions({ channelId: OTHER_CHANNEL_ID }, { isRole, isChannel })).toThrow(InvalidColorOptions);
    expect(() => checkColorOptions({ allowRoleIds: [GUILD_ID] }, { isRole, isChannel })).toThrow(InvalidColorOptions);
    expect(() => checkColorOptions({ joinColor: RED }, { isRole, isChannel, isColor: () => false })).toThrow(InvalidColorOptions);
    expect(() => checkColorOptions({ surprise: 1 }, { isRole, isChannel })).toThrow(InvalidColorOptions);
    expect(checkColorOptions({ joinColor: RED }, { isRole, isChannel, isColor: (id) => id === RED })).toMatchObject({ joinColor: RED });
  });

  it("describes them for the logs", () => {
    expect(describeColorOptions({ image: false, joinColor: "random", denyRoleIds: [MOD] })).toBe(
      "text list · any channel · managed with Manage Roles · not <@&700000000000000005> · random join color · overlap warning on",
    );
  });

  it("goes through the dashboard's settings check, joining colors from the list", () => {
    const server = { guildId: GUILD_ID, channels: [{ id: CHANNEL_ID, type: 0 }], roles: [{ id: VIP }], colors: [color(RED, "Red", "#ff0000")] };
    expect(checkSettingChanges({ [Setting.COLOR_OPTIONS]: { joinColor: RED, image: false } }, server)[Setting.COLOR_OPTIONS]).toMatchObject({ joinColor: RED, image: false });
    expect(() => checkSettingChanges({ [Setting.COLOR_OPTIONS]: { joinColor: BLUE } }, server)).toThrow(InvalidSetting);
    expect(describeChange(Setting.COLOR_OPTIONS, null, { image: false }).join("\n")).toContain("Image");
  });
});

describe("the list picture", () => {
  it("measures text with the bundled font", async () => {
    const metrics = await listFontMetrics();
    expect(metrics.has("A")).toBe(true);
    expect(metrics.has("Ж")).toBe(true);
    expect(metrics.has("😀")).toBe(false);
    expect(metrics.width("WWW", 36)).toBeGreaterThan(metrics.width("iii", 36));
    expect(() => readFontMetrics(new Uint8Array(64))).toThrow();
  });

  it("cuts long names with … and drops characters the font lacks", async () => {
    const metrics = await listFontMetrics();
    const long = fitLabel(46, "Ugly Yellow Formerly Known As Gold", metrics);
    expect(long.startsWith("46. Ugly Yellow")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(metrics.width(long, LAYOUT.fontSize)).toBeLessThanOrEqual(LAYOUT.maxColumnWidth);
    expect(fitLabel(2, "Sun 🌅 set", metrics)).toBe("2. Sun set");
    expect(fitLabel(3, "日本", metrics, LAYOUT, "#00ff00")).toBe("3. #00ff00");
  });

  it("lays out up to three columns, row by row, with gradients and escaped names", async () => {
    const metrics = await listFontMetrics();
    expect([columnsFor(3), columnsFor(10), columnsFor(46)]).toEqual([1, 2, 3]);
    const list = Array.from({ length: 20 }, (_, index) => ({ name: `Color ${index + 1}`, hex: "#123456", hex2: null }));
    list[0] = { name: "<Tom & Jerry>", hex: "#ff0000", hex2: "#0000ff" };
    const { svg, width, height } = buildListSvg(list, metrics);
    expect(svg).toContain("&#60;Tom &#38; Jerry&#62;");
    expect(svg).toContain('<linearGradient id="g0"');
    expect(svg).toContain('fill="url(#g0)"');
    expect(height).toBe(LAYOUT.padding * 2 + 7 * LAYOUT.rowHeight);
    expect(width).toBeLessThanOrEqual(LAYOUT.padding * 2 + 3 * LAYOUT.maxColumnWidth + 2 * LAYOUT.columnGap);
  });

  it("renders a transparent PNG", async () => {
    const png = await renderColorList([{ name: "Red", hex: "#ff0000", hex2: null }, { name: "Sunset", hex: "#ff5f6d", hex2: "#ffc371" }]);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // Colour type 6 (RGBA): the background stays see-through.
    expect(png[25]).toBe(6);
    await expect(renderColorList([])).rejects.toThrow();
  });
});

// --- Discord fakes -------------------------------------------------------------------

function fakeRole(id, name, position, extra = {}) {
  const role = { id, name, position, managed: false, permissions: { has: () => false }, colors: { primaryColor: 0, secondaryColor: null }, members: { size: 0 }, ...extra };
  role.edit = vi.fn(async (changes) => Object.assign(role, changes.name ? { name: changes.name } : {}));
  role.delete = vi.fn(async () => guildRoles.delete(id));
  return role;
}

let guildRoles;

function fakeGuild({ manageRoles = true, features = [] } = {}) {
  guildRoles = new Map(
    [
      fakeRole(GUILD_ID, "@everyone", 0),
      fakeRole(RED, "Red", 3, { colors: { primaryColor: 0xff0000, secondaryColor: null } }),
      fakeRole(BLUE, "Blue", 4, { colors: { primaryColor: 0x0000ff, secondaryColor: null } }),
      fakeRole(OLD_ROLE, "Old", 2, { colors: { primaryColor: 0x00ff00, secondaryColor: null } }),
      fakeRole(VIP, "VIP", 6, { colors: { primaryColor: 0xffd700, secondaryColor: null } }),
      fakeRole(MOD, "Mod", 7, { permissions: { has: (bit) => bit === PermissionFlagsBits.BanMembers } }),
      fakeRole(MANAGER, "Color manager", 1),
      fakeRole(BOT_ROLE, "Rabble", 10),
    ].map((role) => [role.id, role]),
  );
  let next = 50;
  const channel = { id: CHANNEL_ID, isTextBased: () => true, send: vi.fn(async (payload) => ({ id: "500000000000000001", url: "https://discord.com/channels/x/y/z", payload })), messages: { fetch: vi.fn() } };
  return {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    features,
    preferredLocale: "en-US",
    channel,
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    roles: {
      cache: guildRoles,
      create: vi.fn(async ({ name, colors }) => {
        const role = fakeRole(`7000000000000001${next++}`, name, 1, { colors: { primaryColor: colors.primaryColor, secondaryColor: colors.secondaryColor ?? null } });
        guildRoles.set(role.id, role);
        return role;
      }),
      setPositions: vi.fn(async () => {}),
    },
    members: {
      me: {
        roles: { highest: guildRoles.get(BOT_ROLE) },
        permissions: { has: (bit) => manageRoles || bit !== PermissionFlagsBits.ManageRoles },
      },
    },
  };
}

function fakeMember(id, roleIds = []) {
  const held = new Map(roleIds.map((roleId) => [roleId, guildRoles.get(roleId)]));
  return {
    id,
    user: { id, bot: false, username: `user${id.slice(-2)}` },
    pending: false,
    roles: {
      cache: held,
      add: vi.fn(async (roleId) => held.set(roleId, guildRoles.get(roleId))),
      remove: vi.fn(async (ids) => [ids].flat().forEach((roleId) => held.delete(roleId))),
    },
  };
}

async function setup({ colors = [color(RED, "Red", "#ff0000"), color(BLUE, "Blue", "#0000ff")], options, ...guildOptions } = {}) {
  const guildSettings = new GuildSettings();
  if (colors.length > 0) {
    await guildSettings.set(GUILD_ID, Setting.COLORS, colors);
  }
  if (options) {
    await guildSettings.set(GUILD_ID, Setting.COLOR_OPTIONS, options);
  }
  const guild = fakeGuild(guildOptions);
  const render = vi.fn(async () => Buffer.from("png"));
  const service = createColorService({ guildSettings, logger: fakeLogger(), render, now: () => 1000, random: () => 0 });
  return { guildSettings, guild, service, render };
}

describe("the color service", () => {
  it("swaps a member's color, keeping one at a time", async () => {
    const { guild, service } = await setup();
    const member = fakeMember(USER_ID, [RED, VIP]);
    const blue = service.colors(GUILD_ID)[1];
    expect(await service.applyColor(guild, member, blue)).toMatchObject({ changed: true, previous: { roleId: RED } });
    expect(member.roles.add).toHaveBeenCalledWith(BLUE, "Color roles");
    expect(member.roles.remove).toHaveBeenCalledWith([RED], "Color roles");
    expect(await service.applyColor(guild, member, blue)).toMatchObject({ changed: false });
    expect(await service.applyColor(guild, member, null)).toMatchObject({ changed: true });
    expect(member.roles.cache.has(BLUE)).toBe(false);
    expect(member.roles.cache.has(VIP)).toBe(true);
  });

  it("refuses without Manage Roles or when the role is gone", async () => {
    const { guild, service } = await setup({ manageRoles: false });
    await expect(service.applyColor(guild, fakeMember(USER_ID), service.colors(GUILD_ID)[0])).rejects.toMatchObject({ key: "colorBotNeedsManageRoles" });
    const other = await setup();
    other.guild.roles.cache.delete(RED);
    await expect(other.service.applyColor(other.guild, fakeMember(USER_ID), other.service.colors(GUILD_ID)[0])).rejects.toBeInstanceOf(ColorError);
  });

  it("finds a higher coloured role that hides the color", async () => {
    const { guild, service } = await setup();
    const member = fakeMember(USER_ID, [RED, VIP, MOD]);
    expect(service.hidingRole(guild, member, service.colors(GUILD_ID)[0])?.id).toBe(VIP);
    expect(service.hidingRole(guild, fakeMember(USER_ID, [RED]), service.colors(GUILD_ID)[0])).toBeUndefined();
  });

  it("lets managers manage: manager roles replace Manage Roles", async () => {
    const plain = await setup();
    const perms = (...bits) => ({ has: (bit) => bits.includes(bit) });
    expect(plain.service.canManage(plain.guild, fakeMember(USER_ID), perms(PermissionFlagsBits.ManageRoles))).toBe(true);
    expect(plain.service.canManage(plain.guild, fakeMember(USER_ID), perms())).toBe(false);
    const managed = await setup({ options: { managerRoleIds: [MANAGER] } });
    expect(managed.service.canManage(managed.guild, fakeMember(USER_ID), perms(PermissionFlagsBits.ManageRoles))).toBe(false);
    expect(managed.service.canManage(managed.guild, fakeMember(USER_ID, [MANAGER]), perms())).toBe(true);
    expect(managed.service.canManage(managed.guild, fakeMember(ADMIN_ID), perms(PermissionFlagsBits.Administrator))).toBe(true);
    expect(managed.service.canManage(managed.guild, fakeMember(OWNER_ID), perms())).toBe(true);
  });

  it("limits who picks: blocked roles win over allowed ones", async () => {
    const { guild, service } = await setup({ options: { allowRoleIds: [VIP], denyRoleIds: [MOD] } });
    expect(service.pickRefusal(guild, fakeMember(USER_ID))).toBe("colorNotAllowed");
    expect(service.pickRefusal(guild, fakeMember(USER_ID, [VIP]))).toBeUndefined();
    expect(service.pickRefusal(guild, fakeMember(USER_ID, [VIP, MOD]))).toBe("colorDenied");
  });

  it("makes roles for new colors, skips taken names and moves them together", async () => {
    const { guild, service } = await setup({ features: ["ENHANCED_ROLE_COLORS"] });
    const result = await service.addColors(guild, [
      { name: "Green", hex: "#00ff00", hex2: null },
      { name: "red", hex: "#ff0000", hex2: null },
      { name: "Sunset", hex: "#ff5f6d", hex2: "#ffc371" },
    ]);
    expect(result.added.map((entry) => entry.name)).toEqual(["Green", "Sunset"]);
    expect(result.skipped).toEqual(["red"]);
    expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Sunset", colors: { primaryColor: 0xff5f6d, secondaryColor: 0xffc371 } }));
    expect(service.colors(GUILD_ID).map((entry) => entry.name)).toEqual(["Red", "Blue", "Green", "Sunset"]);
    expect(guild.roles.setPositions).toHaveBeenCalled();
  });

  it("refuses gradients without enhanced role styles, and stops at the limit", async () => {
    const { guild, service } = await setup();
    await expect(service.addColors(guild, [{ name: "Sunset", hex: "#ff5f6d", hex2: "#ffc371" }])).rejects.toMatchObject({ key: "colorNoGradients" });
    const many = Array.from({ length: MAX_COLORS }, (_, index) => color(`70000000000000${String(1000 + index)}`, `C${index}`, "#000000"));
    const full = await setup({ colors: many });
    expect(await full.service.addColors(full.guild, [{ name: "One more", hex: "#ffffff" }])).toMatchObject({ added: [], full: true });
  });

  it("adds an existing role, keeping it when the color is deleted", async () => {
    const { guild, service } = await setup();
    const added = await service.addExisting(guild, guildRoles.get(OLD_ROLE), "Lime");
    expect(added).toMatchObject({ roleId: OLD_ROLE, name: "Lime", hex: "#00ff00", made: false });
    expect(guildRoles.get(OLD_ROLE).edit).toHaveBeenCalledWith({ name: "Lime", reason: "Color roles" });
    await expect(service.addExisting(guild, guildRoles.get(MOD))).rejects.toMatchObject({ key: "colorRoleDangerous" });
    await expect(service.addExisting(guild, guildRoles.get(RED))).rejects.toMatchObject({ key: "colorAlreadyListed" });
    await service.deleteColor(guild, OLD_ROLE);
    expect(guildRoles.has(OLD_ROLE)).toBe(true);
    await service.deleteColor(guild, RED);
    expect(guildRoles.has(RED)).toBe(false);
    expect(service.colors(GUILD_ID).map((entry) => entry.name)).toEqual(["Blue"]);
  });

  it("forgets the join color when its color is deleted", async () => {
    const { guild, service, guildSettings } = await setup({ options: { joinColor: RED, image: false } });
    await service.deleteColor(guild, RED);
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_OPTIONS)).toEqual({ image: false });
  });

  it("edits a color and its role", async () => {
    const { guild, service } = await setup({ features: ["ENHANCED_ROLE_COLORS"] });
    const { after } = await service.editColor(guild, RED, { name: "Crimson", hex: "#dc143c", hex2: "#000000" });
    expect(after).toMatchObject({ name: "Crimson", hex: "#dc143c", hex2: "#000000" });
    expect(guildRoles.get(RED).edit).toHaveBeenCalledWith({ reason: "Color roles", name: "Crimson", colors: { primaryColor: 0xdc143c, secondaryColor: 0 } });
    await service.editColor(guild, RED, { hex2: null });
    expect(guildRoles.get(RED).edit).toHaveBeenLastCalledWith({ reason: "Color roles", colors: { primaryColor: 0xdc143c, secondaryColor: null } });
    await expect(service.editColor(guild, RED, { name: "blue" })).rejects.toMatchObject({ key: "colorNameTaken" });
  });

  it("sorts the list and the roles", async () => {
    const { guild, service } = await setup();
    // Blue sits above Red, so sorting by hue (Red first) swaps the two roles.
    const sorted = await service.sortList(guild, SortKind.HUE);
    expect(sorted.map((entry) => entry.name)).toEqual(["Red", "Blue"]);
    expect(guild.roles.setPositions).toHaveBeenCalledTimes(1);
    expect(new Set(guild.roles.setPositions.mock.calls[0][0].map(JSON.stringify))).toEqual(
      new Set([{ role: RED, position: 4 }, { role: BLUE, position: 3 }].map(JSON.stringify)),
    );
    // Already in that order: nothing to move.
    await service.sortList(guild, SortKind.NAME);
    expect(guild.roles.setPositions).toHaveBeenCalledTimes(1);
  });

  it("syncs: remakes deleted roles and copies role edits", async () => {
    const { guild, service } = await setup();
    guildRoles.delete(RED);
    guildRoles.get(BLUE).name = "Navy";
    guildRoles.get(BLUE).colors = { primaryColor: 0x000080, secondaryColor: null };
    const result = await service.syncColors(guild);
    expect(result).toEqual({ remade: ["Red"], updated: ["Navy"] });
    const list = service.colors(GUILD_ID);
    expect(list[0].roleId).not.toBe(RED);
    expect(list[1]).toMatchObject({ name: "Navy", hex: "#000080" });
  });

  it("clears everything", async () => {
    const { guild, service } = await setup();
    expect(await service.clearColors(guild)).toBe(2);
    expect(service.colors(GUILD_ID)).toEqual([]);
  });

  it("sends the list as a picture, or as role mentions when the picture is off", async () => {
    const pictured = await setup();
    const payload = await pictured.service.listPayload(pictured.guild, "en");
    expect(payload.files[0].name).toBe(LIST_FILE);
    expect(payload.embeds[0].data.image.url).toBe(`attachment://${LIST_FILE}`);
    const text = await setup({ options: { image: false } });
    const listed = await text.service.listPayload(text.guild, "en");
    expect(listed.files).toEqual([]);
    expect(listed.embeds[0].data.description).toBe("` 1.` <@&700000000000000001>\n` 2.` <@&700000000000000002>");
    expect(text.render).not.toHaveBeenCalled();
  });

  it("falls back to text when the picture fails", async () => {
    const { guild, service, render } = await setup();
    render.mockRejectedValueOnce(new Error("wasm"));
    const payload = await service.listPayload(guild, "en");
    expect(payload.files).toEqual([]);
    expect(payload.embeds[0].data.description).toContain("<@&");
  });

  it("posts a panel with menus and a remove button, and remembers it", async () => {
    const { guild, service, guildSettings } = await setup();
    await service.postPanel(guild, guild.channel, "en");
    const sent = guild.channel.send.mock.calls[0][0];
    const ids = sent.components.flatMap((row) => row.components.map((component) => component.data.custom_id));
    expect(ids).toEqual([`${PICK_PREFIX}0`, REMOVE_ID]);
    expect(sent.components[0].components[0].options.map((option) => option.data.value)).toEqual([RED, BLUE]);
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_PANELS)).toEqual([{ channelId: CHANNEL_ID, messageId: "500000000000000001", key: expect.any(String) }]);
  });

  it("updates panels only when what they show changed", async () => {
    const { guild, service, guildSettings } = await setup();
    await service.postPanel(guild, guild.channel, "en");
    const message = { edit: vi.fn(async () => {}), delete: vi.fn() };
    guild.channel.messages.fetch.mockResolvedValue(message);
    await service.refreshPanels(guild);
    expect(message.edit).not.toHaveBeenCalled();
    await service.addColors(guild, [{ name: "Green", hex: "#00ff00" }]);
    await service.refreshPanels(guild);
    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(message.edit.mock.calls[0][0].components[0].components[0].options).toHaveLength(3);
    // A deleted panel message is forgotten.
    guild.channel.messages.fetch.mockRejectedValue(Object.assign(new Error("Unknown Message"), { code: 10008 }));
    await service.refreshPanels(guild, { force: true });
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_PANELS)).toBeUndefined();
  });

  it("gives new members the join color, after the rules if they're pending", async () => {
    const { guild, service } = await setup({ options: { joinColor: BLUE } });
    const member = { ...fakeMember(USER_ID), guild };
    await service.memberJoined(member);
    expect(member.roles.add).toHaveBeenCalledWith(BLUE, "Join color");
    const pending = { ...fakeMember(ADMIN_ID), guild, pending: true };
    await service.memberJoined(pending);
    expect(pending.roles.add).not.toHaveBeenCalled();
    await service.memberUpdated({ pending: true }, { ...pending, pending: false });
    expect(pending.roles.add).toHaveBeenCalledWith(BLUE, "Join color");
    const random = await setup({ options: { joinColor: "random" } });
    const someone = { ...fakeMember(USER_ID), guild: random.guild };
    await random.service.memberJoined(someone);
    expect(someone.roles.add).toHaveBeenCalledWith(RED, "Join color");
  });

  it("refuses roles that can't be colors", async () => {
    const { guild } = await setup();
    expect(colorRoleProblem(guildRoles.get(GUILD_ID), guild)).toBe("colorRoleEveryone");
    expect(colorRoleProblem({ ...guildRoles.get(OLD_ROLE), managed: true }, guild)).toBe("colorRoleManaged");
    expect(colorRoleProblem(guildRoles.get(MOD), guild)).toBe("colorRoleDangerous");
    expect(colorRoleProblem({ ...guildRoles.get(OLD_ROLE), position: 11 }, guild)).toBe("colorRoleAboveBot");
    expect(colorRoleProblem(guildRoles.get(OLD_ROLE), guild)).toBeUndefined();
  });
});

// --- The command ------------------------------------------------------------------

function fakeInteraction({ guild, member, subcommand, options = {}, permissions = [], channelId = CHANNEL_ID }) {
  const replies = [];
  const interaction = {
    guild,
    guildId: GUILD_ID,
    channelId,
    member,
    user: member.user,
    locale: "en-US",
    memberPermissions: { has: (bit) => permissions.includes(bit) },
    deferred: false,
    replied: false,
    replies,
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getMember: (name) => options[name] ?? null,
    },
    reply: vi.fn(async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (payload) => replies.push(payload)),
  };
  return interaction;
}

describe("/color", () => {
  it("has 18 subcommands with short descriptions", () => {
    const data = buildColorCommandData();
    expect(data.name).toBe("color");
    expect(data.options.map((option) => option.name)).toEqual([
      "list", "set", "random", "remove", "info", "give", "take", "add", "existing", "edit", "delete", "pack", "sort", "sync", "clear", "panel", "suggest", "settings",
    ]);
    expect(data.default_member_permissions).toBeUndefined();
  });

  async function command(setupOptions) {
    const context = await setup(setupOptions);
    return { ...context, command: createColorCommand({ guildSettings: context.guildSettings, logger: fakeLogger(), service: context.service }) };
  }

  it("sets a member's color and warns when a higher role hides it", async () => {
    const { guild, command: color } = await command();
    const member = fakeMember(USER_ID, [VIP]);
    const interaction = fakeInteraction({ guild, member, subcommand: "set", options: { color: "1" } });
    const outcome = await color.execute(interaction);
    expect(outcome.status).toBe(Status.SUCCESS);
    expect(interaction.replies[0].content).toContain("Your color is now <@&700000000000000001>.");
    expect(interaction.replies[0].content).toContain("<@&700000000000000004>");
    expect(interaction.replies[0].flags).toBe(MessageFlags.Ephemeral);
  });

  it("keeps members to the color channel, but not managers", async () => {
    const { guild, command: color } = await command({ options: { channelId: OTHER_CHANNEL_ID } });
    const member = fakeMember(USER_ID);
    const refused = await color.execute(fakeInteraction({ guild, member, subcommand: "random" }));
    expect(refused).toMatchObject({ status: Status.REFUSED, key: "colorWrongChannel" });
    const manager = await color.execute(fakeInteraction({ guild, member, subcommand: "random", permissions: [PermissionFlagsBits.ManageRoles] }));
    expect(manager.status).toBe(Status.SUCCESS);
  });

  it("refuses manager subcommands to members", async () => {
    const { guild, command: color } = await command();
    const outcome = await color.execute(fakeInteraction({ guild, member: fakeMember(USER_ID), subcommand: "add", options: { name: "Green", hex: "#00ff00" } }));
    expect(outcome).toMatchObject({ status: Status.REFUSED, key: "colorNotManager" });
  });

  it("adds a color for a manager and checks the hex", async () => {
    const { guild, command: color, service } = await command();
    const manager = fakeMember(ADMIN_ID);
    const bad = await color.execute(fakeInteraction({ guild, member: manager, subcommand: "add", options: { name: "Green", hex: "green" }, permissions: [PermissionFlagsBits.ManageRoles] }));
    expect(bad).toMatchObject({ key: "colorBadHex" });
    const good = await color.execute(fakeInteraction({ guild, member: manager, subcommand: "add", options: { name: "Green", hex: "0f0" }, permissions: [PermissionFlagsBits.ManageRoles] }));
    expect(good).toMatchObject({ status: Status.SUCCESS, key: "colorAdded" });
    expect(service.colors(GUILD_ID).at(-1)).toMatchObject({ name: "Green", hex: "#00ff00" });
  });

  it("lists the colors publicly with the picture", async () => {
    const { guild, command: color } = await command();
    const interaction = fakeInteraction({ guild, member: fakeMember(USER_ID), subcommand: "list" });
    await color.execute(interaction);
    expect(interaction.replies[0].files[0].name).toBe(LIST_FILE);
    expect(interaction.replies[0].flags).toBeUndefined();
  });

  it("changes settings with /color settings and shows them", async () => {
    const { guild, command: color, guildSettings } = await command();
    const manager = fakeMember(ADMIN_ID);
    await color.execute(fakeInteraction({ guild, member: manager, subcommand: "settings", options: { image: false, join: "Blue" }, permissions: [PermissionFlagsBits.Administrator] }));
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_OPTIONS)).toMatchObject({ image: false, joinColor: BLUE });
    const shown = fakeInteraction({ guild, member: manager, subcommand: "settings", permissions: [PermissionFlagsBits.Administrator] });
    await color.execute(shown);
    expect(shown.replies[0].content).toContain("List picture: off");
    await color.execute(fakeInteraction({ guild, member: manager, subcommand: "settings", options: { join: "off", image: true }, permissions: [PermissionFlagsBits.Administrator] }));
    expect(guildSettings.get(GUILD_ID, Setting.COLOR_OPTIONS)).toBeUndefined();
  });

  it("picks from a panel menu and removes with the button", async () => {
    const { guild, command: color } = await command();
    const member = fakeMember(USER_ID, [RED]);
    const pick = { ...fakeInteraction({ guild, member, subcommand: null }), values: [BLUE], customId: `${PICK_PREFIX}0` };
    await color.componentPrefixes[PICK_PREFIX].handle(pick);
    expect(member.roles.cache.has(BLUE)).toBe(true);
    expect(member.roles.cache.has(RED)).toBe(false);
    const remove = fakeInteraction({ guild, member, subcommand: null });
    const outcome = await color.components[REMOVE_ID].handle(remove);
    expect(outcome).toMatchObject({ key: "colorRemoved" });
    expect(member.roles.cache.has(BLUE)).toBe(false);
  });

  it("autocompletes colors, with off and random for the join option", async () => {
    const { command: color } = await command();
    const respond = vi.fn();
    await color.autocomplete({ guildId: GUILD_ID, locale: "en-US", options: { getFocused: () => ({ name: "join", value: "" }) }, respond });
    expect(respond.mock.calls[0][0].map((choice) => choice.value)).toEqual(["off", "random", "1", "2"]);
  });
});
