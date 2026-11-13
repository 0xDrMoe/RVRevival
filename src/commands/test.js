// /test: post a sample of a message that otherwise only appears after a real
// event, so staff can check it without waiting for someone to join or level up.
// The same tests are the "Send test" buttons on the dashboard.
//
//   /test welcome         the welcome message, in the welcome channel, with you as the new member
//   /test leave           the leave message, in the leave channel
//   /test welcome-dm      the welcome DM, sent to you
//   /test level-up        a level-up announcement (where level-ups are announced, or here)
//   /test birthday        the birthday message, in the birthday channel
//   /test starboard       a starboard post of a made-up message by you
//   /test logs            one entry in every log channel, listing what goes there
//   /test automod text:   which automod rules a message would break (nothing is posted)
//
// Every test message starts with a "Test sent by @you" line and pings nobody
// (testing/testMessages.js). Only members with Manage Server can use it, one
// test every few seconds.

import { escapeMarkdown, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import {
  buildTestMessages,
  checkAutomodText,
  createTestLimiter,
  MAX_AUTOMOD_TEST_LENGTH,
  MAX_LOG_TEST_CHANNELS,
  planLogTest,
  routeName,
  TestKind,
  TestUnavailable,
} from "../testing/testMessages.js";
import { sendDm } from "../utils/dms.js";
import { canPost } from "../utils/rateLimits.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "test";

// Subcommand -> test, with its description key.
const SUBCOMMANDS = [
  ["welcome", TestKind.WELCOME, "testWelcomeDescription"],
  ["leave", TestKind.LEAVE, "testLeaveDescription"],
  ["welcome-dm", TestKind.WELCOME_DM, "testWelcomeDmDescription"],
  ["level-up", TestKind.LEVEL_UP, "testLevelUpDescription"],
  ["birthday", TestKind.BIRTHDAY, "testBirthdayDescription"],
  ["starboard", TestKind.STARBOARD, "testStarboardDescription"],
  ["logs", TestKind.LOGS, "testLogsDescription"],
  ["bump", TestKind.BUMP, "testBumpDescription"],
];
const KIND_OF = Object.fromEntries(SUBCOMMANDS.map(([name, kind]) => [name, kind]));

// Discord says a DM can't be delivered (closed DMs, or remembered as closed by sendDm).
const CANNOT_DM = 50007;

export function buildTestCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  withDescription(command, "testCommandDescription");
  for (const [name, , key] of SUBCOMMANDS) {
    command.addSubcommand((sub) => withDescription(sub.setName(name), key));
  }
  command.addSubcommand((sub) =>
    withDescription(sub.setName("automod"), "testAutomodDescription").addStringOption((option) =>
      withDescription(option.setName("text"), "testAutomodTextOption").setRequired(true).setMaxLength(MAX_AUTOMOD_TEST_LENGTH),
    ),
  );
  return command.toJSON();
}

// "- Banned word: `darn` (deletes it)" lines for /test automod.
function automodLines(text, check) {
  const lines = [];
  if (!check.enabled) {
    lines.push(text("testAutomodOff"));
  }
  if (check.hits.length === 0) {
    lines.push(text("testAutomodClean"));
  }
  for (const hit of check.hits) {
    const values = { rule: text(`testAutomodRule_${hit.rule}`), detail: escapeMarkdown(hit.detail), action: text(`testAutomodAction_${hit.action}`) };
    const key =
      hit.rule === check.acted ? "testAutomodActs" : hit.on ? "testAutomodAlsoBreaks" : hit.ruleOn ? "testAutomodWouldBreak" : "testAutomodRuleOff";
    lines.push(`- ${text(key, values)}`);
    if (hit.maybeOwnServer) {
      lines.push(`  ${text("testAutomodOwnInvite")}`);
    }
  }
  if (check.untested.length > 0) {
    lines.push(text("testAutomodUntested", { rules: check.untested.map((rule) => text(`testAutomodRule_${rule}`)).join(", ") }));
  }
  return lines;
}

// Options: guildSettings, forcedLanguage, now (tests)
export function createTestCommand({ guildSettings, forcedLanguage, now = Date.now }) {
  const limiter = createTestLimiter({ now });

  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, content, key = null, values = {}) => {
      const payload = { content: content.slice(0, 2000), allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
      return key ? result(status, key, values) : result(status);
    };
    const reply = (status, key, values = {}) => answer(status, text(key, values), key, values);

    if (!interaction.inCachedGuild()) {
      return reply(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return reply(Status.REFUSED, "settingsNoPermission");
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "automod") {
      const check = checkAutomodText(guildSettings.get(interaction.guildId, Setting.AUTOMOD), interaction.options.getString("text", true));
      return answer(Status.SUCCESS, automodLines(text, check).join("\n"));
    }
    const kind = KIND_OF[subcommand];
    if (!kind) {
      return reply(Status.FAILED, "unexpected");
    }

    const guild = interaction.guild;
    let messages;
    try {
      messages = buildTestMessages(kind, {
        guildSettings,
        guild,
        member: interaction.member,
        language: pickLanguage(guild.preferredLocale, forcedLanguage),
        forcedLanguage,
        hereChannelId: interaction.channelId,
        now,
      });
    } catch (error) {
      if (error instanceof TestUnavailable) {
        return reply(Status.REFUSED, `testReason_${error.reason}`);
      }
      throw error;
    }
    // Only tests that would send count toward the cooldown.
    const waitMs = limiter.take(interaction.guildId, interaction.user.id);
    if (waitMs > 0) {
      return reply(Status.REFUSED, "testCooldown", { seconds: Math.ceil(waitMs / 1000) });
    }

    // Log tests can post in many channels; say we're on it first.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sent = [];
    const problems = [];
    for (const message of messages) {
      if (message.dm) {
        try {
          await sendDm(interaction.user, message.payload);
          sent.push(text("testYourDms"));
        } catch (error) {
          problems.push(text(error?.code === CANNOT_DM ? "testDmClosed" : "testDmFailed"));
        }
        continue;
      }
      const channel = guild.channels.cache.get(message.channelId);
      const where = `<#${message.channelId}>`;
      if (!channel?.isTextBased?.()) {
        problems.push(text("testChannelGone", { channel: where }));
        continue;
      }
      if (!canPost(channel, { embeds: Boolean(message.payload.embeds?.length) })) {
        problems.push(text("testCannotPost", { channel: where }));
        continue;
      }
      try {
        await channel.send(message.payload);
        sent.push(where);
      } catch {
        problems.push(text("testCannotPost", { channel: where }));
      }
    }

    const lines = [];
    if (sent.length > 0) {
      lines.push(text("testSent", { where: sent.join(", ") }));
    }
    lines.push(...problems);
    if (kind === TestKind.LOGS) {
      const { channels, nowhere } = planLogTest(guildSettings, interaction.guildId);
      if (channels.length > MAX_LOG_TEST_CHANNELS) {
        lines.push(text("testLogsTooMany", { max: MAX_LOG_TEST_CHANNELS }));
      }
      if (nowhere.length > 0) {
        lines.push(text("testLogsNowhere", { list: nowhere.map(routeName).join(", ") }));
      }
    }
    const status = sent.length > 0 ? Status.SUCCESS : Status.FAILED;
    return answer(status, lines.join("\n"), null);
  }

  return { name: COMMAND_NAME, data: buildTestCommandData(), execute };
}
