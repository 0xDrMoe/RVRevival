// /guide [topic]: the dashboard's Guide (dashboard/public/guide.js) in Discord,
// as a private message you page through with buttons and menus. The text is
// the same English as on the dashboard; only the buttons are translated.
//
// Pages, in reading order: the contents, then each part's page followed by its
// topics. A topic too long for one message is split over several pages.
// Every button and menu carries the page it leads to, so they keep working
// after a restart.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { GUIDE } from "../dashboard/public/guide.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { withDescription } from "./moderation.js";

const COMMAND_NAME = "guide";
const PREFIX = "guide:";
const PART_MENU = `${PREFIX}part`;
const TOPIC_MENU = `${PREFIX}topic`;
const HOME = "home";

// Discord's limits, with room to spare for the footer.
const FIELD_LIMIT = 1024;
const DESCRIPTION_LIMIT = 4096;
const EMBED_BUDGET = 5500;
const MAX_FIELDS = 25;
const MAX_CHOICES = 25;

const EMOJI = {
  alert: "⚠️",
  archive: "🗄️",
  bell: "🔔",
  book: "📖",
  bot: "🤖",
  cake: "🎂",
  calendar: "📅",
  chart: "📊",
  check: "✅",
  clock: "⏰",
  edit: "✏️",
  eye: "👁️",
  folder: "📁",
  gavel: "🔨",
  gift: "🎁",
  globe: "🌍",
  home: "🏠",
  image: "🖼️",
  inbox: "📥",
  key: "🔑",
  layers: "🗂️",
  list: "📋",
  lock: "🔒",
  message: "💬",
  pin: "📌",
  repeat: "🔁",
  rss: "📰",
  shield: "🛡️",
  sliders: "🎛️",
  sparkles: "✨",
  star: "⭐",
  tag: "🏷️",
  ticket: "🎫",
  trophy: "🏆",
  users: "👥",
  volume: "🔊",
};
const emojiOf = (icon) => EMOJI[icon] ?? "📘";

const COLORS = {
  amber: 0xf59e0b,
  blue: 0x3b82f6,
  cyan: 0x06b6d4,
  green: 0x22c55e,
  pink: 0xec4899,
  purple: 0x8b5cf6,
  red: 0xef4444,
};
const colorOf = (tone) => COLORS[tone] ?? COLORS.green;

const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

// Lines packed into as few fields as fit. A field's name gets "(2)" and so on
// when its lines spill over.
function packFields(name, lines) {
  const fields = [];
  let value = "";
  for (const line of lines.map((entry) => clip(entry, FIELD_LIMIT))) {
    if (value && value.length + 1 + line.length > FIELD_LIMIT) {
      fields.push(value);
      value = "";
    }
    value = value ? `${value}\n${line}` : line;
  }
  if (value) {
    fields.push(value);
  }
  return fields.map((text, index) => ({ name: index === 0 ? name : `${name} (${index + 1})`, value: text }));
}

function tableFields(table) {
  return packFields(
    // A table without headings still needs a field name: a zero-width space.
    table.head.filter(Boolean).join(" · ") || "\u200b",
    table.rows.map((row) => `• ${row.join(" · ")}`),
  );
}

// A topic's text as an intro and fields, in the dashboard's order.
function topicContent(topic, text) {
  const intro = [
    topic.summary,
    topic.who ? `**${text("guideWho")}** ${topic.who}` : null,
    topic.native ? `✨ **${text("guideNative")}** ${topic.native}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const fields = [
    ...(topic.steps?.length ? packFields(text("guideSteps"), topic.steps.map((step, index) => `${index + 1}. ${step}`)) : []),
    ...(topic.table ? tableFields(topic.table) : []),
    ...(topic.commands?.length ? packFields(text("guideCommands"), topic.commands.map(([usage, what]) => `\`${usage}\`\n${what}`)) : []),
    ...(topic.legend ? tableFields(topic.legend) : []),
    // Code blocks can't be split, so each example line is its own code line.
    ...(topic.example?.length ? packFields(text("guideExample"), topic.example.map((line) => `\`${line.replaceAll("`", "'")}\``)) : []),
    ...(topic.tips?.length ? packFields(text("guideGoodToKnow"), topic.tips.map((tip) => `• ${tip}`)) : []),
  ];
  return { intro: clip(intro, DESCRIPTION_LIMIT), fields };
}

// The fields split into pages that each fit in one message.
function splitFields(intro, fields) {
  const pages = [[]];
  let size = intro.length;
  for (const field of fields) {
    const fieldSize = field.name.length + field.value.length;
    const current = pages.at(-1);
    if (current.length > 0 && (size + fieldSize > EMBED_BUDGET || current.length === MAX_FIELDS)) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1).push(field);
    size += fieldSize;
  }
  return pages;
}

const topicKey = (topic, chunk) => `t.${topic.id}.${chunk}`;
const partKey = (part) => `p.${part.id}`;

// Every page in reading order: { key, part?, topic?, chunk, chunks }.
export function buildGuidePages(guide = GUIDE) {
  const pages = [{ key: HOME, chunk: 0, chunks: 1 }];
  for (const part of guide) {
    pages.push({ key: partKey(part), part, chunk: 0, chunks: 1 });
    for (const topic of part.sections) {
      // Measured without translation: the labels are short in every language.
      const { intro, fields } = topicContent(topic, (key) => key);
      const chunks = splitFields(intro, fields).length;
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        pages.push({ key: topicKey(topic, chunk), part, topic, chunk, chunks });
      }
    }
  }
  return pages;
}

const PAGES = buildGuidePages();
const INDEX = new Map(PAGES.map((page, index) => [page.key, index]));

// The page index for a key, a topic id or a part id; the contents otherwise.
export function findGuidePage(value) {
  const wanted = String(value ?? "").trim().toLowerCase();
  if (INDEX.has(wanted)) {
    return INDEX.get(wanted);
  }
  const topic = PAGES.findIndex((page) => page.topic?.id === wanted && page.chunk === 0);
  if (topic !== -1) {
    return topic;
  }
  const part = PAGES.findIndex((page) => page.part?.id === wanted && !page.topic);
  if (part !== -1) {
    return part;
  }
  // Typed words instead of a pick: the first title that contains them.
  const match = wanted ? PAGES.findIndex((page) => page.chunk === 0 && pageTitle(page).toLowerCase().includes(wanted)) : -1;
  return match === -1 ? 0 : match;
}

function pageTitle(page) {
  if (page.topic) {
    return page.topic.title;
  }
  return page.part ? page.part.part : "";
}

function embedFor(page, text) {
  const embed = new EmbedBuilder();
  if (page.topic) {
    const { intro, fields } = topicContent(page.topic, text);
    const chunks = splitFields(intro, fields);
    const suffix = page.chunks > 1 ? ` (${page.chunk + 1}/${page.chunks})` : "";
    embed
      .setColor(colorOf(page.topic.tone))
      .setAuthor({ name: `${emojiOf(page.part.icon)} ${page.part.part}` })
      .setTitle(clip(`${emojiOf(page.topic.icon)} ${page.topic.title}${suffix}`, 256))
      .addFields(chunks[Math.min(page.chunk, chunks.length - 1)]);
    if (page.chunk === 0) {
      embed.setDescription(intro);
    }
  } else if (page.part) {
    const topics = page.part.sections.map((topic) => `${emojiOf(topic.icon)} **${topic.title}**\n${topic.summary}`);
    embed
      .setColor(colorOf(page.part.tone))
      .setTitle(`${emojiOf(page.part.icon)} ${page.part.part}`)
      .setDescription(clip(page.part.about, DESCRIPTION_LIMIT))
      .addFields(packFields(text("guideTopics"), topics));
  } else {
    embed
      .setColor(colorOf("green"))
      .setTitle(`📖 ${text("guideTitle")}`)
      .setDescription(text("guideHomeIntro"))
      .addFields(
        GUIDE.map((part) => ({
          name: `${emojiOf(part.icon)} ${part.part}`,
          value: clip(`${part.about}\n*${text("guideTopicCount", { count: part.sections.length })}*`, FIELD_LIMIT),
        })),
      );
  }
  return embed;
}

function componentsFor(index, text, { dashboardUrl, guildId }) {
  const page = PAGES[index];
  const partMenu = new StringSelectMenuBuilder()
    .setCustomId(PART_MENU)
    .setPlaceholder(text("guidePickPart"))
    .addOptions(
      { label: text("guideContents"), value: HOME, emoji: "📖", default: !page.part },
      ...GUIDE.map((part) => ({
        label: clip(part.part, 100),
        description: clip(part.about, 100),
        value: partKey(part),
        emoji: emojiOf(part.icon),
        default: page.part?.id === part.id && !page.topic,
      })),
    );
  const rows = [new ActionRowBuilder().addComponents(partMenu)];

  if (page.part) {
    const topicMenu = new StringSelectMenuBuilder()
      .setCustomId(TOPIC_MENU)
      .setPlaceholder(text("guidePickTopic"))
      .addOptions(
        page.part.sections.slice(0, MAX_CHOICES).map((topic) => ({
          label: clip(topic.title, 100),
          description: clip(topic.summary.replace(/[`*]/g, ""), 100),
          value: topicKey(topic, 0),
          emoji: emojiOf(topic.icon),
          default: page.topic?.id === topic.id,
        })),
      );
    rows.push(new ActionRowBuilder().addComponents(topicMenu));
  }

  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];
  const buttons = [
    new ButtonBuilder()
      .setCustomId(previous ? `${PREFIX}go:${previous.key}:prev` : `${PREFIX}first`)
      .setLabel(text("guidePrevious"))
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!previous),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}go:${HOME}:home`)
      .setLabel(text("guideContents"))
      .setEmoji("📖")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index === 0),
    new ButtonBuilder()
      .setCustomId(next ? `${PREFIX}go:${next.key}:next` : `${PREFIX}last`)
      .setLabel(text("guideNext"))
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!next),
  ];
  if (dashboardUrl && guildId) {
    const target = page.topic ? `?topic=${page.topic.id}` : page.part ? `?part=${page.part.id}` : "";
    buttons.push(
      new ButtonBuilder().setURL(`${dashboardUrl}/#/g/${guildId}/guide${target}`).setLabel(text("guideOpenDashboard")).setStyle(ButtonStyle.Link),
    );
  }
  rows.push(new ActionRowBuilder().addComponents(buttons));
  return rows;
}

// The message for one page: { embeds, components }.
export function renderGuidePage(index, { language = "en", dashboardUrl, guildId } = {}) {
  const safeIndex = Number.isInteger(index) && PAGES[index] ? index : 0;
  const text = (key, values) => translate(language, key, values);
  const footer = [text("guidePage", { page: safeIndex + 1, pages: PAGES.length })];
  if (language !== "en") {
    footer.push(text("guideEnglishNote"));
  }
  const embed = embedFor(PAGES[safeIndex], text).setFooter({ text: footer.join(" · ") });
  return { embeds: [embed], components: componentsFor(safeIndex, text, { dashboardUrl, guildId }) };
}

// "guide:go:<key>:<which>" from a button, the picked value from a menu.
function targetOf(interaction) {
  if (interaction.isStringSelectMenu?.()) {
    return interaction.values?.[0];
  }
  return interaction.customId.slice(`${PREFIX}go:`.length).split(":")[0];
}

const searchText = (page) =>
  [pageTitle(page), page.topic?.summary, page.part?.part, ...(page.topic?.commands ?? []).map(([usage]) => usage)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export function buildGuideCommandData() {
  return withDescription(new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild), "guideCommandDescription")
    .addStringOption((option) => withDescription(option.setName("topic"), "guideTopicOptionDescription").setAutocomplete(true).setMaxLength(100))
    .toJSON();
}

// Options: forcedLanguage, dashboardUrl (adds a link to the same page on the dashboard)
export function createGuideCommand({ forcedLanguage, dashboardUrl } = {}) {
  const render = (interaction, index) =>
    renderGuidePage(index, {
      language: pickLanguage(interaction.locale, forcedLanguage),
      dashboardUrl,
      guildId: interaction.guildId,
    });

  async function execute(interaction) {
    const index = findGuidePage(interaction.options.getString("topic"));
    await interaction.reply({ ...render(interaction, index), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return result(Status.SUCCESS);
  }

  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").trim().toLowerCase();
    const choices = PAGES.filter((page) => page.chunk === 0 && page.key !== HOME)
      .filter((page) => !typed || searchText(page).includes(typed))
      .slice(0, MAX_CHOICES)
      .map((page) => ({
        name: clip(page.topic ? `${page.part.part}: ${page.topic.title}` : page.part.part, 100),
        value: page.key,
      }));
    await interaction.respond(choices);
  }

  // Moving around the guide: not worth a line in the logs channel.
  async function handle(interaction) {
    await interaction.update(render(interaction, findGuidePage(targetOf(interaction))));
    return null;
  }

  return {
    name: COMMAND_NAME,
    data: buildGuideCommandData(),
    execute,
    autocomplete,
    componentPrefixes: { [PREFIX]: { label: "Guide page", handle } },
  };
}
