// The quote book (quotes/quotes.js):
//
//   Make it a quote (right-click a message > Apps)  turn the message into a quote card
//   /quote random [user] [private]     a random quote (of one member)
//   /quote get number:<n> [private]    one quote by its number
//   /quote search text:<words> [user] [page]
//   /quote list [user] [page]
//   /quote top                         the most quoted members
//   /quote add user:<member> text:<words>   something they said, typed in
//   /quote delete number:<n>
//   /quote opt-out / opt-in            stop (or let) others quote you, on every server
//
// Who may make, show and manage quotes is set on the dashboard's Quotes page.

import { ApplicationCommandType, ContextMenuCommandBuilder, InteractionContextType, SlashCommandBuilder } from "discord.js";
import { discordLocalizations, translate } from "../i18n/i18n.js";
import { Status } from "../logs/actionLog.js";
import { MAX_QUOTE_LENGTH } from "../quotes/quoteStore.js";
import { QUOTE_PREFIX } from "../quotes/quotes.js";

export const COMMAND_NAME = "quote";
export const MAKE_QUOTE_COMMAND = "Make it a quote";
const MAX_TYPED_QUOTE = 1000;

function withDescription(builder, key) {
  return builder.setDescription(translate("en", key)).setDescriptionLocalizations(discordLocalizations(key));
}

const numberOption = (option) => withDescription(option.setName("number"), "quoteNumberOption").setRequired(true).setMinValue(1).setMaxValue(999_999_999);
const privateOption = (option) => withDescription(option.setName("private"), "quotePrivateOption");
const pageOption = (option) => withDescription(option.setName("page"), "quotePageOption").setMinValue(1).setMaxValue(10_000);

export function buildQuoteCommandData() {
  const command = new SlashCommandBuilder().setName(COMMAND_NAME).setContexts(InteractionContextType.Guild);
  return withDescription(command, "quoteCommandDescription")
    .addSubcommand((sub) =>
      withDescription(sub.setName("random"), "quoteRandomDescription")
        .addUserOption((option) => withDescription(option.setName("user"), "quoteUserOption"))
        .addBooleanOption(privateOption),
    )
    .addSubcommand((sub) => withDescription(sub.setName("get"), "quoteGetDescription").addIntegerOption(numberOption).addBooleanOption(privateOption))
    .addSubcommand((sub) =>
      withDescription(sub.setName("search"), "quoteSearchDescription")
        .addStringOption((option) => withDescription(option.setName("text"), "quoteSearchTextOption").setRequired(true).setMinLength(2).setMaxLength(100))
        .addUserOption((option) => withDescription(option.setName("user"), "quoteUserOption"))
        .addIntegerOption(pageOption),
    )
    .addSubcommand((sub) =>
      withDescription(sub.setName("list"), "quoteListDescription")
        .addUserOption((option) => withDescription(option.setName("user"), "quoteUserOption"))
        .addIntegerOption(pageOption),
    )
    .addSubcommand((sub) => withDescription(sub.setName("top"), "quoteTopDescription"))
    .addSubcommand((sub) =>
      withDescription(sub.setName("add"), "quoteAddDescription")
        .addUserOption((option) => withDescription(option.setName("user"), "quoteAddUserOption").setRequired(true))
        .addStringOption((option) => withDescription(option.setName("text"), "quoteAddTextOption").setRequired(true).setMaxLength(Math.min(MAX_TYPED_QUOTE, MAX_QUOTE_LENGTH))),
    )
    .addSubcommand((sub) => withDescription(sub.setName("delete"), "quoteDeleteDescription").addIntegerOption(numberOption))
    .addSubcommand((sub) => withDescription(sub.setName("opt-out"), "quoteOptOutDescription"))
    .addSubcommand((sub) => withDescription(sub.setName("opt-in"), "quoteOptInDescription"))
    .toJSON();
}

export function buildMakeQuoteMenuData() {
  return new ContextMenuCommandBuilder()
    .setName(MAKE_QUOTE_COMMAND)
    .setNameLocalizations(discordLocalizations("contextMakeQuote"))
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild)
    .toJSON();
}

// Options: quotes (quotes/quotes.js). Without it (registering) only the data is used.
export function createQuoteCommands({ quotes }) {
  async function execute(interaction) {
    const options = interaction.options;
    const privately = options.getBoolean("private") ?? false;
    switch (options.getSubcommand()) {
      case "random":
        return quotes.showRandom(interaction, { user: options.getUser("user"), privately });
      case "get":
        return quotes.showNumber(interaction, options.getInteger("number", true), { privately });
      case "search":
        return quotes.listPage(interaction, { text: options.getString("text", true).trim(), user: options.getUser("user"), page: options.getInteger("page") ?? 1 });
      case "list":
        return quotes.listPage(interaction, { user: options.getUser("user"), page: options.getInteger("page") ?? 1 });
      case "top":
        return quotes.topAuthors(interaction);
      case "add":
        return quotes.addTyped(interaction, { user: options.getUser("user", true), text: options.getString("text", true) });
      case "delete":
        return quotes.removeNumber(interaction, options.getInteger("number", true));
      case "opt-out":
        return quotes.setOptOut(interaction, true);
      case "opt-in":
        return quotes.setOptOut(interaction, false);
    }
    return { status: Status.FAILED, note: "Unknown /quote subcommand." };
  }

  return [
    {
      name: COMMAND_NAME,
      data: buildQuoteCommandData(),
      execute,
      componentPrefixes: { [QUOTE_PREFIX]: { label: "Quote card", handle: (interaction) => quotes.handleComponent(interaction) } },
    },
    { name: MAKE_QUOTE_COMMAND, data: buildMakeQuoteMenuData(), execute: (interaction) => quotes.makeFromMessage(interaction) },
  ];
}
