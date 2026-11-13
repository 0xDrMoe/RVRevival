// /mydata: shows what the bot keeps about you, in every server, with a button
// to delete all of it (asked twice). Anyone can use it; only you see it.
// See members/personalData.js.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { createPersonalData } from "../members/personalData.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "mydata";
// mydata:<ask|yes|no>:<user ID>
const PREFIX = "mydata:";

export function buildMyDataCommandData() {
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "myDataCommandDescription").toJSON();
}

const button = (action, userId, style, label) => new ButtonBuilder().setCustomId(`${PREFIX}${action}:${userId}`).setStyle(style).setLabel(label);

// Options: personalData (members/personalData.js), forcedLanguage, privacyUrl
export function createMyDataCommand({ personalData = createPersonalData(), forcedLanguage, privacyUrl }) {
  const text = (interaction, key, values) => translate(pickLanguage(interaction.locale, forcedLanguage), key, values);

  function summaryPayload(interaction) {
    const userId = interaction.user.id;
    const rows = personalData.summary(userId);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const lines = [
      `**${text(interaction, "myDataTitle")}**`,
      ...rows.map((row) => `- ${text(interaction, `myData_${row.key}`)}: **${row.count}**`),
      "",
      text(interaction, "myDataNotListed"),
      ...(privacyUrl ? [text(interaction, "myDataPrivacy", { url: privacyUrl })] : []),
    ];
    const components = total > 0 ? [new ActionRowBuilder().addComponents(button("ask", userId, ButtonStyle.Danger, text(interaction, "myDataDelete")))] : [];
    return { content: lines.join("\n").slice(0, 2000), components, allowedMentions: { parse: [] } };
  }

  async function execute(interaction) {
    await interaction.reply({ ...summaryPayload(interaction), flags: MessageFlags.Ephemeral });
    return result(Status.SUCCESS, "myDataTitle");
  }

  async function pressed(interaction) {
    const [, action, ownerId] = interaction.customId.split(":");
    if (ownerId !== interaction.user.id) {
      await interaction.reply({ content: text(interaction, "myDataNotYours"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "myDataNotYours");
    }
    if (action === "ask") {
      await interaction.update({
        content: text(interaction, "myDataConfirm"),
        components: [
          new ActionRowBuilder().addComponents(
            button("yes", ownerId, ButtonStyle.Danger, text(interaction, "myDataConfirmYes")),
            button("no", ownerId, ButtonStyle.Secondary, text(interaction, "myDataConfirmNo")),
          ),
        ],
      });
      return undefined;
    }
    if (action === "yes") {
      const removed = personalData.deleteAll(ownerId);
      await interaction.update({ content: text(interaction, "myDataDeleted", { count: removed }), components: [] });
      return result(Status.SUCCESS, "myDataDeleted", { count: removed });
    }
    await interaction.update(summaryPayload(interaction));
    return undefined;
  }

  return {
    name: COMMAND_NAME,
    data: buildMyDataCommandData(),
    execute,
    componentPrefixes: { [PREFIX]: { label: "My data buttons", handle: pressed } },
  };
}
