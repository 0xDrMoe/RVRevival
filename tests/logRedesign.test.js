import { ApplicationCommandOptionType, Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createCommands } from "../src/commands/index.js";
import { buildDashboardLogEmbed } from "../src/dashboard/logEmbed.js";
import { describeChange } from "../src/dashboard/settingsRules.js";
import { describeCommand, isLoggedElsewhere, LOGGED_ELSEWHERE, result, Status } from "../src/logs/actionLog.js";
import { changeLines, diffValues, MAX_CHANGE_LINES } from "../src/logs/changeDiff.js";
import { createLogChannelPoster } from "../src/logs/logChannel.js";
import { capList, splitSummary } from "../src/logs/logEntry.js";
import { memberChangeKey, RecentIds } from "../src/logs/recentIds.js";
import { createServerLog } from "../src/logs/serverLog.js";
import { GuildSettings, Setting } from "../src/settings/guildSettings.js";
import { renderMarkdown, renderTranscriptPage, safeUrl } from "../src/transcripts/render.js";
import { buildTranscriptData, MAX_TRANSCRIPT_DATA, parseTranscriptData } from "../src/transcripts/snapshot.js";
import { fakeLogger } from "./helpers/fakes.js";

const GUILD_ID = "900000000000000001";
const CHANNEL_A = "800000000000000001";
const CHANNEL_B = "800000000000000002";
const ROLE_ID = "700000000000000001";
const USER_ID = "300000000000000001";

const server = { channels: [{ id: CHANNEL_A }, { id: CHANNEL_B }], roles: [{ id: ROLE_ID }] };

describe("setting change lines", () => {
  it("names only the log routes that changed, as channels", () => {
    const before = { caseBan: CHANNEL_A, messageDelete: CHANNEL_A, memberJoin: CHANNEL_A, voiceJoin: CHANNEL_A };
    const after = { ...before, caseBan: CHANNEL_B, memberLeave: CHANNEL_B };
    expect(describeChange(Setting.LOG_ROUTES, before, after, server)).toEqual([
      `**Case ban:** <#${CHANNEL_A}> → <#${CHANNEL_B}>`,
      `**Member leave:** none → <#${CHANNEL_B}>`,
    ]);
  });

  it("keeps a big change short", () => {
    const before = Object.fromEntries(["caseBan", "caseKick", "caseWarn", "caseNote", "purge", "slowmode", "quarantine", "automod"].map((route) => [route, CHANNEL_A]));
    const after = Object.fromEntries(Object.keys(before).map((route) => [route, CHANNEL_B]));
    const lines = describeChange(Setting.LOG_ROUTES, before, after, server);
    expect(lines).toHaveLength(MAX_CHANGE_LINES);
    expect(lines.at(-1)).toBe("and 3 more changes");
    expect(lines.join("\n").length).toBeLessThan(400);
  });

  it("shows a one-value setting as before and after", () => {
    expect(describeChange(Setting.MOD_ROLE, null, ROLE_ID, server)).toEqual([`*none* → <@&${ROLE_ID}>`]);
    expect(describeChange(Setting.DEHOIST, null, true, server)).toEqual(["off → on"]);
  });

  it("lists what was added to and removed from a list", () => {
    expect(describeChange(Setting.AUTOROLES, [], [ROLE_ID], server)).toEqual([`added <@&${ROLE_ID}>`]);
    expect(describeChange(Setting.LOG_IGNORED_CHANNELS, [CHANNEL_A], [CHANNEL_B], server)).toEqual([`added <#${CHANNEL_B}>, removed <#${CHANNEL_A}>`]);
  });

  it("names the entry that changed in a list of entries", () => {
    const tags = (content) => [
      { name: "rules", content },
      { name: "faq", content: "Read the FAQ" },
    ];
    expect(describeChange(Setting.TAGS, tags("Be nice"), tags("Be kind"), server)).toEqual(['**rules › Content:** "Be nice" → "Be kind"']);
    expect(describeChange(Setting.TAGS, tags("x"), [...tags("x"), { name: "new", content: "y" }], server)).toEqual(["added `new`"]);
  });

  it("names commands and automod rules by what they're called", () => {
    const lines = describeChange(Setting.COMMAND_RULES, {}, { ban: { roleIds: [ROLE_ID] } }, server);
    expect(lines).toEqual([`**/ban › Role:** added <@&${ROLE_ID}>`]);
  });

  it("says when nothing it can show changed", () => {
    expect(describeChange(Setting.AUTOMOD, null, null, server)).toEqual(["updated"]);
  });

  it("matches list entries by position when they have no name", () => {
    const changes = diffValues([{ a: 1 }], [{ a: 2 }]);
    expect(changeLines(changes)).toEqual(["**#1 › A:** 1 → 2"]);
  });
});

describe("dashboard log entry", () => {
  const session = { userId: USER_ID, username: "Moe", avatar: "abc" };

  it("puts each setting in its own field under a linked title", () => {
    const embed = buildDashboardLogEmbed({
      session,
      summary: "**Settings changed**",
      sections: [{ label: "Log channels per log type", lines: [`**Bans:** none → <#${CHANNEL_A}>`] }],
      notes: ["The ticket panel couldn't be updated."],
      activityUrl: "https://dash.example.com/g/1/activity",
    });
    expect(embed).toMatchObject({
      title: "Settings changed",
      url: "https://dash.example.com/g/1/activity",
      author: { name: "Moe · on the dashboard", icon_url: `https://cdn.discordapp.com/avatars/${USER_ID}/abc.png?size=64` },
      description: "The ticket panel couldn't be updated.",
      fields: [{ name: "Log channels per log type", value: `**Bans:** none → <#${CHANNEL_A}>` }],
      footer: { text: `User ID ${USER_ID}` },
    });
  });

  it("keeps mentions out of the title and stays within Discord's limits", () => {
    const embed = buildDashboardLogEmbed({ session, summary: `**Sticky message removed** from <#${CHANNEL_A}>`, lines: ["x"] });
    expect(embed.title).toBe("Sticky message removed");
    expect(embed.description).toBe(`From <#${CHANNEL_A}>\nx`);
    const huge = buildDashboardLogEmbed({
      session,
      summary: "**Settings changed**",
      sections: Array.from({ length: 30 }, (_, index) => ({ label: `Setting ${index}`, lines: ["y".repeat(1500)] })),
    });
    expect(huge.fields.length).toBeLessThanOrEqual(13);
    const total = [huge.title, huge.author.name, huge.footer.text, ...huge.fields.flatMap((field) => [field.name, field.value])].join("").length;
    expect(total).toBeLessThanOrEqual(6000);
    expect(huge.fields.every((field) => field.value.length <= 1024)).toBe(true);
  });

  it("splits summaries", () => {
    expect(splitSummary("**Feed edited:** News")).toEqual({ title: "Feed edited", rest: "News" });
    expect(splitSummary("no bold")).toEqual({ title: "Dashboard change", rest: "no bold" });
    expect(capList(["a", "b", "c"], { max: 2 })).toBe("a, b and 1 more");
  });
});

describe("no double logging", () => {
  const commands = createCommands({ logger: fakeLogger(), guildSettings: new GuildSettings() });

  it("only lists commands that exist", () => {
    for (const name of [...LOGGED_ELSEWHERE].filter((entry) => entry.startsWith("/"))) {
      const [command, sub] = name.slice(1).split(" ");
      const data = commands.get(command)?.data;
      expect(data, name).toBeDefined();
      if (sub) {
        expect(data.options.map((option) => option.name), name).toContain(sub);
      }
    }
  });

  it("leaves out the command entry for a successful ban, but logs refusals", () => {
    const ban = { commandName: "ban", options: { data: [{ name: "user", type: ApplicationCommandOptionType.User, value: USER_ID }] } };
    expect(describeCommand(ban).command).toBe("/ban");
    expect(isLoggedElsewhere(ban, result(Status.SUCCESS))).toBe(true);
    expect(isLoggedElsewhere(ban, result(Status.REFUSED, "x"))).toBe(false);
    const close = { commandName: "tickets", options: { data: [{ name: "close", type: ApplicationCommandOptionType.Subcommand, options: [] }] } };
    expect(isLoggedElsewhere(close, result(Status.SUCCESS))).toBe(true);
    expect(isLoggedElsewhere({}, { status: Status.SUCCESS, action: { label: "Close ticket button" } })).toBe(true);
    expect(isLoggedElsewhere({ commandName: "remind", options: { data: [] } }, result(Status.SUCCESS))).toBe(false);
  });

  function serverLogWith(loggedMemberChanges) {
    const logChannel = { isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: vi.fn(async () => ({})) };
    const guild = { id: GUILD_ID, members: { me: { id: "100000000000000001" } }, channels: { cache: new Map([[CHANNEL_A, logChannel]]) } };
    const settings = new GuildSettings();
    settings.set(GUILD_ID, Setting.SERVER_LOG_CHANNEL, CHANNEL_A);
    const serverLog = createServerLog({
      poster: createLogChannelPoster({ guildSettings: settings, logger: fakeLogger() }),
      botDeletions: new RecentIds(),
      guildSettings: settings,
      loggedMemberChanges,
    });
    return { serverLog, guild, logChannel };
  }
  const roles = (...ids) => ({ cache: new Collection(ids.map((id) => [id, { id }])) });
  const author = { id: USER_ID, tag: "member", bot: false, displayAvatarURL: () => undefined };

  it("doesn't post member changes and leaves the bot already logged", async () => {
    const marks = new RecentIds();
    const { serverLog, guild, logChannel } = serverLogWith(marks);
    const before = { id: USER_ID, guild, user: author, partial: false, nickname: null, roles: roles("1") };
    marks.add(memberChangeKey(GUILD_ID, USER_ID));
    await serverLog.memberUpdated(before, { ...before, nickname: "Muted", roles: roles("1", "2") });
    await serverLog.memberLeft({ ...before, joinedTimestamp: 0 });
    expect(logChannel.send).not.toHaveBeenCalled();

    // Someone else's change to another member is still logged.
    const other = { ...before, id: "300000000000000002" };
    await serverLog.memberUpdated(other, { ...other, nickname: "New" });
    expect(logChannel.send).toHaveBeenCalledTimes(1);
  });

  it("doesn't post the bot's own new nickname (the dashboard logs it)", async () => {
    const { serverLog, guild, logChannel } = serverLogWith(new RecentIds());
    const bot = { id: "100000000000000001", guild, user: { ...author, id: "100000000000000001", bot: true }, partial: false, nickname: null, roles: roles("1") };
    await serverLog.memberUpdated(bot, { ...bot, nickname: "Rabble" });
    expect(logChannel.send).not.toHaveBeenCalled();
  });
});

describe("transcript pages", () => {
  it("only links to web addresses", () => {
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
  });

  it("escapes what members wrote and keeps formatting", () => {
    const names = { users: { [USER_ID]: { name: "Moe" } }, roles: { [ROLE_ID]: { name: "Mods", color: "#ff0000" } }, channels: { [CHANNEL_A]: "general" } };
    const html = renderMarkdown(
      `<img src=x onerror=alert(1)> **bold** <@${USER_ID}> <@&${ROLE_ID}> <#${CHANNEL_A}> [x](javascript:alert(1)) https://example.com/a_b_c\n\`\`\`\n<b>code</b>\n\`\`\``,
      names,
    );
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<span class="mention">@Moe</span>');
    expect(html).toContain('style="--role:#ff0000">@Mods</span>');
    expect(html).toContain('<span class="mention">#general</span>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://example.com/a_b_c"');
    expect(html).toContain("&lt;b&gt;code&lt;/b&gt;");
  });

  it("groups messages and draws embeds and files", () => {
    const at = Date.UTC(2026, 10, 13, 12, 0);
    const message = (id, minutes, extra = {}) => ({
      id,
      author: { id: USER_ID, username: "moe", globalName: "Moe", displayAvatarURL: () => "https://cdn.discordapp.com/avatars/1/a.png" },
      member: { displayName: "Moe", displayColor: 0xff00aa },
      createdTimestamp: at + minutes * 60_000,
      content: `message ${id}`,
      embeds: [],
      attachments: new Map(),
      ...extra,
    });
    const data = buildTranscriptData({
      guild: { id: GUILD_ID, name: "Server", iconURL: () => null },
      channel: { id: CHANNEL_A, name: "ticket-1" },
      messages: [
        message("3", 30, { embeds: [{ data: { title: "Embed title", color: 0x00ff00, fields: [{ name: "F", value: "V", inline: true }] } }] }),
        message("1", 0),
        message("2", 1, { attachments: new Map([["a", { name: "log.txt", url: "https://cdn.discordapp.com/x/log.txt", size: 2048 }]]) }),
      ],
    });
    expect(data.messages.map((entry) => entry.id)).toEqual(["1", "2", "3"]);
    expect(parseTranscriptData(JSON.stringify(data))).toEqual(data);
    expect(parseTranscriptData("{")).toBeUndefined();
    const page = renderTranscriptPage({ title: "Ticket #1", data, facts: [{ label: "Opened by", value: "Moe" }] });
    expect(page).toContain("13 Nov 2026");
    expect(page).toContain('style="--name:#ff00aa"');
    // Message 2 follows message 1 (same person, a minute later): no second name line.
    expect(page.match(/class="name"/g)).toHaveLength(2);
    expect(page).toContain('style="--embed:#00ff00"');
    expect(page).toContain("log.txt");
    expect(page).toContain("2 KB");
    expect(page).toContain('content="width=device-width, initial-scale=1"');
  });

  it("drops the oldest messages when a transcript is too big", () => {
    const messages = Array.from({ length: 700 }, (_, index) => ({ id: String(index), author: { id: USER_ID }, createdTimestamp: index, content: "x".repeat(3900), attachments: new Map() }));
    const data = buildTranscriptData({ messages });
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(MAX_TRANSCRIPT_DATA);
    expect(data.truncated).toBe(true);
    expect(data.messages.at(-1).id).toBe("699");
    expect(renderTranscriptPage({ title: "x", data })).toContain("oldest messages were left out");
  });
});
