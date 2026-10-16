// Custom commands: /tag posts a saved answer, /tags lets staff manage them.
//
//   /tag name:<tag> [user:@member]   post the tag in the channel, optionally pinging someone
//   /tags add name:<name>            write a new tag (opens a form, so it can have several lines)
//   /tags edit name:<tag>            change a tag's text (opens a form with the current text)
//   /tags remove name:<tag>
//   /tags list
//
// Anyone can use /tag. /tags needs Manage Messages or the mod role, like the
// moderation commands. The same tags are on the dashboard's Custom commands page.

import {
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
  cleanTagContent,
  cleanTagName,
  MAX_TAG_LENGTH,
  MAX_TAG_NAME_LENGTH,
  MAX_TAGS,
  sortTags,
  tagsOf,
} from "../community/tags.js";
import { discordLocalizations, pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { isModerator } from "../moderation/checks.js";
import { Setting } from "../settings/guildSettings.js";
import { KeyedLock } from "../utils/keyedLock.js";

const FORM_PREFIX = "tagform:";
const FORM_INPUT = "content";
// One /tag per member every few seconds, so it can't be used to flood a channel.
const TAG_COOLDOWN_MS = 5000;

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const tagOption = (option, key = "tagNameOptionDescription") =>
  withDescription(option.setName("name"), key).setRequired(true).setAutocomplete(true).setMaxLength(MAX_TAG_NAME_LENGTH);

export function buildTagCommandData() {
  const command = new SlashCommandBuilder().setName("tag").setContexts(InteractionContextType.Guild);
  return withDescription(command, "tagCommandDescription")
    .addStringOption((option) => tagOption(option))
    .addUserOption((option) => withDescription(option.setName("user"), "tagUserOptionDescription"))
    .toJSON();
}

export function buildTagsCommandData() {
  const command = new SlashCommandBuilder()
    .setName("tags")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);
  return withDescription(command, "tagsCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "tagsAddDescription").addStringOption((option) =>
        withDescription(option.setName("name"), "tagsNewNameOptionDescription").setRequired(true).setMaxLength(MAX_TAG_NAME_LENGTH),
      ),
    )
    .addSubcommand((sub) => withDescription(sub.setName("edit"), "tagsEditDescription").addStringOption((option) => tagOption(option)))
    .addSubcommand((sub) => withDescription(sub.setName("remove"), "tagsRemoveDescription").addStringOption((option) => tagOption(option)))
    .addSubcommand((sub) => withDescription(sub.setName("list"), "tagsListDescription"))
    .toJSON();
}

// The form for writing a tag. `mode` is "add" or "edit".
export function buildTagForm(language, mode, name, content = "") {
  const input = new TextInputBuilder()
    .setCustomId(FORM_INPUT)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_TAG_LENGTH);
  if (content) {
    input.setValue(content);
  }
  return new ModalBuilder()
    .setCustomId(`${FORM_PREFIX}${mode}:${name}`)
    .setTitle(translate(language, "tagsFormTitle", { name }).slice(0, 45))
    .addLabelComponents(new LabelBuilder().setLabel(translate(language, "tagsFormLabel")).setTextInputComponent(input));
}

// Options:
//   guildSettings, forcedLanguage, now
export function createTagCommands({ guildSettings, forcedLanguage, now = Date.now }) {
  // One change at a time per server, so two mods can't overwrite each other's tags.
  const locks = new KeyedLock();
  // "<server>:<member>" -> when they last used /tag
  const lastUsed = new Map();

  const helpers = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const answer = async (status, key, values = {}) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(status, key, values);
    };
    return { language, text, answer };
  };
  const findTag = (guildId, name) => tagsOf(guildSettings, guildId).find((tag) => tag.name === cleanTagName(name));
  const save = (guildId, tags) =>
    tags.length > 0 ? guildSettings.set(guildId, Setting.TAGS, sortTags(tags)) : guildSettings.clear(guildId, Setting.TAGS);
  const canManage = (interaction) => isModerator(interaction, PermissionFlagsBits.ManageMessages, guildSettings);

  async function executeTag(interaction) {
    const { answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    const tag = findTag(interaction.guildId, interaction.options.getString("name", true));
    if (!tag) {
      return answer(Status.REFUSED, "tagNotFound");
    }
    const key = `${interaction.guildId}:${interaction.user.id}`;
    const last = lastUsed.get(key) ?? 0;
    if (now() - last < TAG_COOLDOWN_MS) {
      return answer(Status.REFUSED, "tagCooldown");
    }
    lastUsed.set(key, now());
    for (const [entry, at] of lastUsed) {
      if (now() - at >= TAG_COOLDOWN_MS) {
        lastUsed.delete(entry);
      }
    }

    // Only the member picked in `user` is pinged; the tag's own text can't ping anyone.
    const user = interaction.options.getUser("user");
    const content = user ? `<@${user.id}>\n${tag.content}` : tag.content;
    await interaction.reply({ content: content.slice(0, 2000), allowedMentions: { users: user ? [user.id] : [] } });
    return { status: Status.SUCCESS, note: `Posted the "${tag.name}" tag${user ? ` for <@${user.id}>` : ""}.` };
  }

  async function executeTags(interaction) {
    const { language, text, answer } = helpers(interaction);
    if (!interaction.inCachedGuild()) {
      return answer(Status.REFUSED, "guildOnly");
    }
    if (!canManage(interaction)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageMessages") });
    }
    const guildId = interaction.guildId;
    const tags = tagsOf(guildSettings, guildId);

    switch (interaction.options.getSubcommand()) {
      case "add": {
        const name = cleanTagName(interaction.options.getString("name", true));
        if (!name) {
          return answer(Status.REFUSED, "tagsBadName", { max: MAX_TAG_NAME_LENGTH });
        }
        if (tags.some((tag) => tag.name === name)) {
          return answer(Status.REFUSED, "tagsExists", { name });
        }
        if (tags.length >= MAX_TAGS) {
          return answer(Status.REFUSED, "tagsFull", { max: MAX_TAGS });
        }
        await interaction.showModal(buildTagForm(language, "add", name));
        return null;
      }
      case "edit": {
        const tag = findTag(guildId, interaction.options.getString("name", true));
        if (!tag) {
          return answer(Status.REFUSED, "tagNotFound");
        }
        await interaction.showModal(buildTagForm(language, "edit", tag.name, tag.content));
        return null;
      }
      case "remove": {
        return locks.run(guildId, async () => {
          const current = tagsOf(guildSettings, guildId);
          const tag = current.find((entry) => entry.name === cleanTagName(interaction.options.getString("name", true)));
          if (!tag) {
            return answer(Status.REFUSED, "tagNotFound");
          }
          await save(guildId, current.filter((entry) => entry !== tag));
          return answer(Status.SUCCESS, "tagsRemoved", { name: tag.name });
        });
      }
      case "list": {
        if (tags.length === 0) {
          return answer(Status.SUCCESS, "tagsListEmpty");
        }
        const names = tags.map((tag) => `\`${tag.name}\``).join(", ");
        await interaction.reply({
          content: `${text("tagsListTitle", { count: tags.length, max: MAX_TAGS })}\n${names}`.slice(0, 2000),
          flags: MessageFlags.Ephemeral,
        });
        return result(Status.SUCCESS);
      }
    }
    return answer(Status.FAILED, "unexpected");
  }

  // The add or edit form, sent.
  async function readForm(interaction) {
    const { answer, text } = helpers(interaction);
    const match = /^tagform:(add|edit):(.+)$/.exec(interaction.customId);
    const name = cleanTagName(match?.[2]);
    if (!interaction.inCachedGuild() || !match || !name) {
      return answer(Status.REFUSED, "unexpected");
    }
    if (!canManage(interaction)) {
      return answer(Status.REFUSED, "modNoPermission", { permission: text("permManageMessages") });
    }
    const content = cleanTagContent(interaction.fields.getTextInputValue(FORM_INPUT));
    if (!content) {
      return answer(Status.REFUSED, "tagsEmpty");
    }
    const guildId = interaction.guildId;
    return locks.run(guildId, async () => {
      const current = tagsOf(guildSettings, guildId);
      const exists = current.some((tag) => tag.name === name);
      if (match[1] === "add") {
        // Checked again: someone may have added it while the form was open.
        if (exists) {
          return answer(Status.REFUSED, "tagsExists", { name });
        }
        if (current.length >= MAX_TAGS) {
          return answer(Status.REFUSED, "tagsFull", { max: MAX_TAGS });
        }
        await save(guildId, [...current, { name, content }]);
        return answer(Status.SUCCESS, "tagsAdded", { name });
      }
      if (!exists) {
        return answer(Status.REFUSED, "tagNotFound");
      }
      await save(guildId, current.map((tag) => (tag.name === name ? { name, content } : tag)));
      return answer(Status.SUCCESS, "tagsEdited", { name });
    });
  }

  // Suggests the server's tags by name.
  async function autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").trim().toLowerCase();
    const choices = tagsOf(guildSettings, interaction.guildId)
      .filter((tag) => tag.name.includes(typed.replace(/\s+/g, "-")))
      .slice(0, 25)
      .map((tag) => ({ name: tag.name, value: tag.name }));
    await interaction.respond(choices);
  }

  return [
    { name: "tag", data: buildTagCommandData(), execute: executeTag, autocomplete },
    {
      name: "tags",
      data: buildTagsCommandData(),
      execute: executeTags,
      autocomplete,
      componentPrefixes: { [FORM_PREFIX]: { label: "Custom command form", handle: readForm } },
    },
  ];
}
