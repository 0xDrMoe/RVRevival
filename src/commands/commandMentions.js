// Clickable slash commands. Discord turns </name:id> (and </name sub:id>)
// into a mention members can click to start typing the command. The IDs only
// exist once the commands are registered, so they're fetched when the bot
// starts; until then (or for a command Discord doesn't know) the text stays
// as it was.

import { ApplicationCommandOptionType } from "discord.js";

// "name" or "name sub" or "name group sub" -> command ID, for every path
// Discord can mention: a command without subcommands, or each subcommand.
const paths = new Map();

const isSub = (option) => option.type === ApplicationCommandOptionType.Subcommand;
const isGroup = (option) => option.type === ApplicationCommandOptionType.SubcommandGroup;

// Remembers the IDs of registered commands (the list Discord returns).
export function rememberCommands(commands) {
  paths.clear();
  for (const command of commands) {
    if (command.type !== undefined && command.type !== 1) {
      continue;
    }
    const options = command.options ?? [];
    const subs = options.flatMap((option) => {
      if (isSub(option)) {
        return [option.name];
      }
      return isGroup(option) ? (option.options ?? []).filter(isSub).map((sub) => `${option.name} ${sub.name}`) : [];
    });
    if (subs.length === 0) {
      paths.set(command.name, command.id);
    }
    for (const sub of subs) {
      paths.set(`${command.name} ${sub}`, command.id);
    }
  }
}

// Fetches the bot's global commands. Never throws.
export async function loadCommandMentions(client, logger) {
  try {
    const commands = await client.application.commands.fetch();
    rememberCommands(commands.values());
    logger?.debug?.("Loaded command IDs for mentions", { commands: paths.size });
  } catch (error) {
    logger?.warn("Couldn't load the command list; commands show as plain text", { error });
  }
}

// "</ban:123>" for a known path, else undefined.
export function commandMention(path) {
  const id = paths.get(path);
  return id ? `</${path}:${id}>` : undefined;
}

// Turns each `/command` code span in `text` that is exactly a command (no
// options) into a clickable mention.
export function linkCommands(text) {
  if (paths.size === 0 || typeof text !== "string") {
    return text;
  }
  return text.replace(/`\/([a-z0-9_-]+(?: [a-z0-9_-]+){0,2})`/g, (whole, path) => commandMention(path) ?? whole);
}
