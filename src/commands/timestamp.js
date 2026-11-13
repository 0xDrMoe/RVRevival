// /timestamp when [timezone]: turns a date, time or "in 2h" into Discord
// timestamps that show in everyone's own time zone, with the code to copy for
// each style. Anyone can use it; the reply is private. See utils/timestamps.js.

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { isValidTimeZone } from "../birthdays/birthdays.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { discordTimestamp, parseMoment, TIMESTAMP_STYLES } from "../utils/timestamps.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "timestamp";
const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];

export function buildTimestampCommandData() {
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "timestampCommandDescription")
    .addStringOption((option) => withDescription(option.setName("when"), "timestampWhenOption").setRequired(true).setMaxLength(60))
    .addStringOption((option) => withDescription(option.setName("timezone"), "timestampTimezoneOption").setAutocomplete(true).setMaxLength(64))
    .toJSON();
}

// Options: forcedLanguage, now
export function createTimestampCommand({ forcedLanguage, now = Date.now }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const answer = async (status, key, values = {}, content) => {
      await interaction.reply({ content: content ?? translate(language, key, values), allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
      return result(status, key, values);
    };
    const timeZone = interaction.options.getString("timezone")?.trim() || "UTC";
    if (!isValidTimeZone(timeZone)) {
      return answer(Status.REFUSED, "timestampBadZone", { zone: timeZone.slice(0, 64) });
    }
    const moment = parseMoment(interaction.options.getString("when", true), { timeZone, now: now() });
    if (moment === undefined) {
      return answer(Status.REFUSED, "timestampBadWhen");
    }
    const lines = [
      translate(language, "timestampTitle", { zone: timeZone }),
      ...TIMESTAMP_STYLES.map((style) => `${discordTimestamp(moment, style)}  \`${discordTimestamp(moment, style)}\``),
      `-# ${translate(language, "timestampHint")}`,
    ];
    return answer(Status.SUCCESS, "timestampTitle", { zone: timeZone }, lines.join("\n"));
  }

  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    await interaction.respond(
      TIME_ZONES.filter((zone) => zone.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((zone) => ({ name: zone, value: zone })),
    );
  }

  return { name: COMMAND_NAME, data: buildTimestampCommandData(), execute, autocomplete };
}
