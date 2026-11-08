// Quick embeds from Discord, for when the dashboard's Embed builder is too far:
//
//   /embed post [channel]   opens a form (title, description, colour, image,
//                           footer) and posts the embed as the bot
//   /embed edit message     opens the same form filled in with an embed the bot
//                           posted (paste its link or ID) and saves the changes
//
// Needs Manage Messages or the mod role, and the member must be able to post
// in the channel themselves. Posts are added to the dashboard's list of sent
// messages, so they can be edited there later with every option (author,
// fields, thumbnail, text above the embed). Editing here keeps those parts.

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
import { accentColor } from "../branding/branding.js";
import { BRAND_COLOR } from "../guilds/guildJoin.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { checkMessage, InvalidMessage, LIMITS, messageSummary, parseMessageLink } from "../messages/embedMessage.js";
import { isModerator } from "../moderation/checks.js";
import { isPermissionError } from "../utils/discordErrors.js";
import { withDescription } from "./moderation.js";

const FORM_PREFIX = "embedform:";
const FIELDS = ["title", "description", "color", "image", "footer"];
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
const MEMBER_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
// Discord refuses longer text inputs.
const TEXT_INPUT_MAX = 4000;
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export function buildEmbedCommandData() {
  return withDescription(
    new SlashCommandBuilder()
      .setName("embed")
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    "embedCommandDescription",
  )
    .addSubcommand((sub) =>
      withDescription(sub.setName("post"), "embedPostDescription").addChannelOption((option) =>
        withDescription(option.setName("channel"), "embedChannelOptionDescription").addChannelTypes(...CHANNEL_TYPES),
      ),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("edit"), "embedEditDescription").addStringOption((option) =>
        withDescription(option.setName("message"), "embedMessageOptionDescription").setRequired(true).setMaxLength(200),
      ),
    )
    .toJSON();
}

// "#7c5cff", "7C5CFF" or "#abc" → a number; "" → null; anything else → undefined.
export function parseColor(value) {
  const cleaned = String(value ?? "").trim().replace(/^#/, "");
  if (!cleaned) {
    return null;
  }
  if (/^[0-9a-f]{3}$/i.test(cleaned)) {
    return Number.parseInt([...cleaned].map((digit) => digit + digit).join(""), 16);
  }
  return /^[0-9a-f]{6}$/i.test(cleaned) ? Number.parseInt(cleaned, 16) : undefined;
}

export const colorText = (color) => (Number.isInteger(color) ? `#${color.toString(16).padStart(6, "0")}` : "");

// The form. `values` fills it in: { title, description, color, image, footer }.
export function buildEmbedForm(language, customId, values = {}) {
  const text = (key) => translate(language, key);
  const input = (id, style, max, labelKey) => {
    const field = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(false).setMaxLength(max);
    if (values[id]) {
      field.setValue(String(values[id]).slice(0, max));
    }
    return new LabelBuilder().setLabel(text(labelKey)).setTextInputComponent(field);
  };
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(text(customId.includes(":edit:") ? "embedFormEditTitle" : "embedFormPostTitle").slice(0, 45))
    .addLabelComponents(
      input("title", TextInputStyle.Short, LIMITS.title, "embedFormTitle"),
      input("description", TextInputStyle.Paragraph, Math.min(LIMITS.description, TEXT_INPUT_MAX), "embedFormDescription"),
      input("color", TextInputStyle.Short, 7, "embedFormColor"),
      input("image", TextInputStyle.Short, LIMITS.url, "embedFormImage"),
      input("footer", TextInputStyle.Short, Math.min(LIMITS.footerText, TEXT_INPUT_MAX), "embedFormFooter"),
    );
}

// "embedform:post:<channel>" or "embedform:edit:<channel>:<message>".
export function parseFormId(customId) {
  const match = /^embedform:(post|edit):(\d{17,20})(?::(\d{17,20}))?$/.exec(customId);
  if (!match || (match[1] === "edit") !== Boolean(match[3])) {
    return null;
  }
  return { mode: match[1], channelId: match[2], messageId: match[3] ?? null };
}

// Where a message link or ID points, in this server: { channelId, messageId }
// or null. A bare ID means the channel the command was used in.
export function findMessage(input, { guildId, channelId }) {
  const trimmed = String(input ?? "").trim();
  if (/^\d{17,20}$/.test(trimmed)) {
    return { channelId, messageId: trimmed };
  }
  const link = parseMessageLink(trimmed);
  return link && link.guildId === guildId ? { channelId: link.channelId, messageId: link.messageId } : null;
}

// Options: guildSettings (mod role and Branding colour), forcedLanguage,
// sentMessages (messages/sentMessageStore.js, so the dashboard lists the posts)
export function createEmbedCommand({ guildSettings, forcedLanguage, sentMessages }) {
  const helpers = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      const payload = { content: text(key, values), allowedMentions: { parse: [] } };
      await (interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }));
      return result(status, key, values);
    };
    return { language, text, answer };
  };

  // Why this member can't post in `channel` as the bot, or null if they can.
  function channelProblem(interaction, channel) {
    if (!channel || !CHANNEL_TYPES.includes(channel.type) || channel.guildId !== interaction.guildId) {
      return "embedBadChannel";
    }
    if (!channel.permissionsFor?.(interaction.member)?.has(MEMBER_PERMISSIONS)) {
      return "embedYouCantPost";
    }
    const me = interaction.guild.members.me;
    if (!me || !channel.permissionsFor?.(me)?.has(POST_PERMISSIONS)) {
      return "embedBotCantPost";
    }
    return null;
  }

  // Fetches a message the bot posted with an embed, or returns a refusal key.
  async function botMessage(interaction, channel, messageId) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return { problem: "embedMessageNotFound" };
    }
    if (message.author?.id !== interaction.client.user.id) {
      return { problem: "embedNotMine" };
    }
    if (!message.embeds?.length) {
      return { problem: "embedNoEmbed" };
    }
    return { message };
  }

  async function execute(interaction) {
    const { language, text, answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!isModerator(interaction, PermissionFlagsBits.ManageMessages, guildSettings)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageMessages") });
    }

    if (interaction.options.getSubcommand() === "post") {
      const channel = interaction.options.getChannel("channel") ?? interaction.channel;
      const problem = channelProblem(interaction, channel);
      if (problem) {
        return answer(Status.REFUSED, problem, { channel: `<#${channel?.id ?? interaction.channelId}>` });
      }
      const color = colorText(accentColor(guildSettings, interaction.guildId, BRAND_COLOR));
      await interaction.showModal(buildEmbedForm(language, `${FORM_PREFIX}post:${channel.id}`, { color }));
      return null;
    }

    const where = findMessage(interaction.options.getString("message", true), { guildId: interaction.guildId, channelId: interaction.channelId });
    if (!where) {
      return answer(Status.REFUSED, "embedBadLink");
    }
    const channel = interaction.guild.channels.cache.get(where.channelId);
    const problem = channelProblem(interaction, channel);
    if (problem) {
      return answer(Status.REFUSED, problem, { channel: `<#${where.channelId}>` });
    }
    const found = await botMessage(interaction, channel, where.messageId);
    if (found.problem) {
      return answer(Status.REFUSED, found.problem);
    }
    const embed = found.message.embeds[0];
    await interaction.showModal(
      buildEmbedForm(language, `${FORM_PREFIX}edit:${channel.id}:${found.message.id}`, {
        title: embed.title,
        description: embed.description,
        color: colorText(embed.color),
        image: embed.image?.url,
        footer: embed.footer?.text,
      }),
    );
    return null;
  }

  // The form, sent: checks everything again, since the member's permissions or
  // the message may have changed while it was open.
  async function readForm(interaction) {
    const { text, answer } = helpers(interaction);
    const target = parseFormId(interaction.customId);
    if (!interaction.inCachedGuild() || !target) {
      return answer(Status.REFUSED, "unexpected");
    }
    if (!isModerator(interaction, PermissionFlagsBits.ManageMessages, guildSettings)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageMessages") });
    }
    const channel = interaction.guild.channels.cache.get(target.channelId);
    const problem = channelProblem(interaction, channel);
    if (problem) {
      return answer(Status.REFUSED, problem, { channel: `<#${target.channelId}>` });
    }

    const values = Object.fromEntries(FIELDS.map((id) => [id, interaction.fields.getTextInputValue(id)?.trim() ?? ""]));
    const color = parseColor(values.color);
    if (color === undefined) {
      return answer(Status.REFUSED, "embedBadColor", { color: values.color.slice(0, 20) });
    }
    if (!values.title && !values.description && !values.image) {
      return answer(Status.REFUSED, "embedEmpty");
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let existing = null;
    if (target.mode === "edit") {
      const found = await botMessage(interaction, channel, target.messageId);
      if (found.problem) {
        return answer(Status.REFUSED, found.problem);
      }
      existing = found.message;
    }
    // Editing keeps what the form doesn't show: author, fields, thumbnail,
    // title link and the text above the embed.
    const before = existing?.embeds[0]?.toJSON?.() ?? existing?.embeds[0]?.data ?? {};
    let body;
    try {
      body = checkMessage({
        content: existing?.content ?? "",
        embed: {
          ...before,
          title: values.title,
          url: values.title ? before.url : "",
          description: values.description,
          color,
          image: { url: values.image },
          footer: { text: values.footer, icon_url: before.footer?.icon_url },
        },
      });
    } catch (error) {
      if (error instanceof InvalidMessage) {
        return answer(Status.REFUSED, "embedInvalid", { problem: error.message });
      }
      throw error;
    }
    if (body.embeds.length === 0) {
      return answer(Status.REFUSED, "embedEmpty");
    }
    if (existing) {
      // Any other embeds on the message stay after the edited one.
      body.embeds.push(...existing.embeds.slice(1).map((other) => other.toJSON?.() ?? other.data));
    }

    let message;
    try {
      message = existing
        ? await existing.edit({ content: body.content || null, embeds: body.embeds, allowedMentions: { parse: [] } })
        : await channel.send({ content: body.content || undefined, embeds: body.embeds, allowedMentions: { parse: [] } });
    } catch (error) {
      if (isPermissionError(error)) {
        return answer(Status.FAILED, "embedBotCantPost", { channel: `<#${channel.id}>` });
      }
      throw error;
    }

    const summary = messageSummary(body);
    try {
      if (existing) {
        sentMessages?.edited(interaction.guildId, message.id, { summary, editedBy: interaction.user.id });
      } else {
        sentMessages?.add({ guildId: interaction.guildId, channelId: channel.id, messageId: message.id, summary, sentBy: interaction.user.id });
      }
    } catch {
      // The post is out; only the dashboard's list missed it.
    }
    return answer(Status.SUCCESS, existing ? "embedEdited" : "embedPosted", { channel: `<#${channel.id}>`, link: message.url });
  }

  return {
    name: "embed",
    data: buildEmbedCommandData(),
    execute,
    componentPrefixes: { [FORM_PREFIX]: { label: "Embed form", handle: readForm } },
  };
}
