// /dehoist: names that start with symbols ("!aaa") sort above everyone in the
// member list. See moderation/dehoist.js.
//
//   /dehoist run              fix everyone here now (up to 100 at a time)
//   /dehoist auto enabled     fix new members and renames automatically
//
// Needs Manage Nicknames, for the member and the bot.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { createDehoist } from "../moderation/dehoist.js";
import { Setting } from "../settings/guildSettings.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "dehoist";

export function buildDehoistCommandData() {
  return withDescription(
    new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames),
    "dehoistCommandDescription",
  )
    .addSubcommand((sub) => withDescription(sub.setName("run"), "dehoistRunDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("auto"), "dehoistAutoDescription").addBooleanOption((option) =>
        withDescription(option.setName("enabled"), "dehoistAutoOption").setRequired(true),
      ),
    )
    .toJSON();
}

// Options: guildSettings, dehoist (moderation/dehoist.js), forcedLanguage, logger
export function createDehoistCommand({ guildSettings, logger, dehoist = createDehoist({ guildSettings, logger }), forcedLanguage }) {
  async function execute(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}, edit = false) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      await (edit ? interaction.editReply(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }));
      return result(status, key, values);
    };
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageNicknames)) {
      return answer(Status.REFUSED, "dehoistNoPermission");
    }
    const guild = interaction.guild;
    const botCan = Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageNicknames));

    if (interaction.options.getSubcommand() === "auto") {
      const enabled = interaction.options.getBoolean("enabled", true);
      if (enabled) {
        await guildSettings.set(guild.id, Setting.DEHOIST, true);
      } else {
        await guildSettings.clear(guild.id, Setting.DEHOIST);
      }
      if (enabled && !botCan) {
        return answer(Status.SUCCESS, "dehoistAutoOnNoPermission");
      }
      return answer(Status.SUCCESS, enabled ? "dehoistAutoOn" : "dehoistAutoOff");
    }

    if (!botCan) {
      return answer(Status.REFUSED, "dehoistBotNoPermission");
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await dehoist.run(guild);
    if (!outcome) {
      return answer(Status.REFUSED, "dehoistBusy", {}, true);
    }
    const key = outcome.more > 0 ? "dehoistDoneMore" : "dehoistDone";
    return answer(Status.SUCCESS, key, outcome, true);
  }

  return { name: COMMAND_NAME, data: buildDehoistCommandData(), execute };
}
