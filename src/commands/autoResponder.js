// Auto-responders: the bot answers messages that match a trigger.
//
//   /autoresponder set trigger:<text> [match] [channel]   add one, or change the one with this trigger (opens a form for the reply)
//   /autoresponder remove trigger:<text>
//   /autoresponder list
//
// Needs Manage Server. The same list is on the dashboard's Custom commands page.
// See community/autoResponders.js.

import {
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  cleanReply,
  cleanTrigger,
  Match,
  MAX_REPLY_LENGTH,
  MAX_RESPONDERS,
  MAX_TRIGGER_LENGTH,
  respondersOf,
  sortResponders,
} from "../community/autoResponders.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { KeyedLock } from "../utils/keyedLock.js";

const COMMAND_NAME = "autoresponder";
const FORM_PREFIX = "arform:";
const FORM_INPUT = "reply";
// One letter per match type in the form's custom ID; "-" = keep what's saved.
const MATCH_CODES = { c: Match.CONTAINS, w: Match.WORD, e: Match.EXACT, s: Match.STARTS };
const codeOf = (match) => Object.keys(MATCH_CODES).find((code) => MATCH_CODES[code] === match) ?? "-";
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildCategory];

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const triggerOption = (option, autocomplete) =>
  withDescription(option.setName("trigger"), "autoresponderTriggerOptionDescription")
    .setRequired(true)
    .setMaxLength(MAX_TRIGGER_LENGTH)
    .setAutocomplete(autocomplete);

export function buildAutoResponderCommandData() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return withDescription(command, "autoresponderCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("set"), "autoresponderSetDescription")
        .addStringOption((option) => triggerOption(option, true))
        .addStringOption((option) =>
          withDescription(option.setName("match"), "autoresponderMatchOptionDescription").addChoices(
            ...Object.values(Match).map((match) => ({
              name: translate("en", `autoresponderMatch_${match}`),
              name_localizations: discordLocalizations(`autoresponderMatch_${match}`),
              value: match,
            })),
          ),
        )
        .addChannelOption((option) =>
          withDescription(option.setName("channel"), "autoresponderChannelOptionDescription").addChannelTypes(...CHANNEL_TYPES),
        ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("remove"), "autoresponderRemoveDescription").addStringOption((option) => triggerOption(option, true)),
    )
    .addSubcommand((sub) => withDescription(sub.setName("list"), "autoresponderListDescription"))
    .toJSON();
}

// The form for the reply. Undefined when the custom ID wouldn't fit Discord's 100 characters.
export function buildAutoResponderForm(language, { trigger, matchCode, channelId, reply = "" }) {
  const customId = `${FORM_PREFIX}${matchCode}:${channelId ?? "-"}:${trigger}`;
  if (customId.length > 100) {
    return undefined;
  }
  const input = new TextInputBuilder()
    .setCustomId(FORM_INPUT)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_REPLY_LENGTH);
  if (reply) {
    input.setValue(reply);
  }
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(translate(language, "autoresponderFormTitle", { trigger }).slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(translate(language, "autoresponderFormLabel"))
        .setDescription(translate(language, "autoresponderFormHelp").slice(0, 100))
        .setTextInputComponent(input),
    );
}

const describe = (text, responder) =>
  `\`${responder.trigger}\` · ${text(`autoresponderMatch_${responder.match}`)}${responder.channelId ? ` · <#${responder.channelId}>` : ""}`;

// Options: guildSettings, forcedLanguage
export function createAutoResponderCommand({ guildSettings, forcedLanguage }) {
  // One change at a time per server.
  const locks = new KeyedLock();

  const helpers = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(status, key, values);
    };
    return { language, text, answer };
  };
  const save = (guildId, responders) =>
    responders.length > 0
      ? guildSettings.set(guildId, Setting.AUTO_RESPONDERS, sortResponders(responders))
      : guildSettings.clear(guildId, Setting.AUTO_RESPONDERS);
  const canManage = (interaction) => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

  async function execute(interaction) {
    const { language, text, answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!canManage(interaction)) {
      return answer(Status.REFUSED, "autoresponderNeedsManageGuild");
    }
    const guildId = interaction.guildId;
    const responders = respondersOf(guildSettings, guildId);

    switch (interaction.options.getSubcommand()) {
      case "set": {
        const trigger = cleanTrigger(interaction.options.getString("trigger", true));
        if (!trigger || trigger.length > MAX_TRIGGER_LENGTH) {
          return answer(Status.REFUSED, "autoresponderBadTrigger", { max: MAX_TRIGGER_LENGTH });
        }
        const existing = responders.find((responder) => responder.trigger === trigger);
        if (!existing && responders.length >= MAX_RESPONDERS) {
          return answer(Status.REFUSED, "autoresponderFull", { max: MAX_RESPONDERS });
        }
        const match = interaction.options.getString("match");
        const form = buildAutoResponderForm(language, {
          trigger,
          matchCode: match ? codeOf(match) : "-",
          channelId: interaction.options.getChannel("channel")?.id,
          reply: existing?.reply,
        });
        if (!form) {
          return answer(Status.REFUSED, "autoresponderBadTrigger", { max: MAX_TRIGGER_LENGTH });
        }
        await interaction.showModal(form);
        return null;
      }
      case "remove": {
        const trigger = cleanTrigger(interaction.options.getString("trigger", true));
        return locks.run(guildId, async () => {
          const current = respondersOf(guildSettings, guildId);
          if (!current.some((responder) => responder.trigger === trigger)) {
            return answer(Status.REFUSED, "autoresponderNotFound");
          }
          await save(guildId, current.filter((responder) => responder.trigger !== trigger));
          return answer(Status.SUCCESS, "autoresponderRemoved", { trigger });
        });
      }
      case "list": {
        if (responders.length === 0) {
          return answer(Status.SUCCESS, "autoresponderListEmpty");
        }
        const lines = responders.map((responder) => `• ${describe(text, responder)}`);
        await interaction.reply({
          content: `${text("autoresponderListTitle", { count: responders.length, max: MAX_RESPONDERS })}\n${lines.join("\n")}`.slice(0, 2000),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return result(Status.SUCCESS);
      }
    }
    return answer(Status.FAILED, "unexpected");
  }

  // The reply form, sent.
  async function readForm(interaction) {
    const { answer, text } = helpers(interaction);
    const parsed = /^arform:([cwes-]):(\d+|-):(.+)$/s.exec(interaction.customId);
    const trigger = cleanTrigger(parsed?.[3]);
    if (!interaction.inCachedGuild() || !parsed || !trigger) {
      return answer(Status.REFUSED, "unexpected");
    }
    if (!canManage(interaction)) {
      return answer(Status.REFUSED, "autoresponderNeedsManageGuild");
    }
    const reply = cleanReply(interaction.fields.getTextInputValue(FORM_INPUT));
    if (!reply) {
      return answer(Status.REFUSED, "autoresponderEmpty");
    }
    const guildId = interaction.guildId;
    return locks.run(guildId, async () => {
      const current = respondersOf(guildSettings, guildId);
      const existing = current.find((responder) => responder.trigger === trigger);
      // Checked again: someone may have added one while the form was open.
      if (!existing && current.length >= MAX_RESPONDERS) {
        return answer(Status.REFUSED, "autoresponderFull", { max: MAX_RESPONDERS });
      }
      const responder = {
        trigger,
        match: MATCH_CODES[parsed[1]] ?? existing?.match ?? Match.CONTAINS,
        reply,
        channelId: parsed[2] !== "-" ? parsed[2] : (existing?.channelId ?? null),
      };
      await save(guildId, [...current.filter((entry) => entry !== existing), responder]);
      return answer(Status.SUCCESS, existing ? "autoresponderEdited" : "autoresponderAdded", { summary: describe(text, responder) });
    });
  }

  // Suggests the server's triggers.
  async function autocomplete(interaction) {
    const typed = cleanTrigger(interaction.options.getFocused());
    const choices = respondersOf(guildSettings, interaction.guildId)
      .filter((responder) => responder.trigger.includes(typed))
      .slice(0, 25)
      .map((responder) => ({ name: responder.trigger, value: responder.trigger }));
    await interaction.respond(choices);
  }

  return {
    name: COMMAND_NAME,
    data: buildAutoResponderCommandData(),
    execute,
    autocomplete,
    componentPrefixes: { [FORM_PREFIX]: { label: "Auto-responder form", handle: readForm } },
  };
}
