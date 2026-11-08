// Small games anyone can play, posted in the channel:
//
//   /coinflip               heads or tails
//   /roll [dice]            dice like 1d20, 2d6+3 or just 20 (default 1d6)
//   /choose options         picks one of the options, split by commas or |
//   /8ball question         the magic 8-ball answers a yes-or-no question
//
// Answers are random with crypto.randomInt, so they're fair. Nothing is saved,
// and nothing the member typed can ping anyone.

import { randomInt as cryptoRandomInt } from "node:crypto";
import { escapeMarkdown, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { withDescription } from "./moderation.js";

export const DICE_LIMITS = Object.freeze({ count: 100, sides: 1000, modifier: 1000 });
export const CHOOSE_LIMITS = Object.freeze({ min: 2, max: 25 });
// How many single rolls are listed before the total alone is shown.
const ROLLS_SHOWN = 50;
// The classic answers: eightBall_1..eightBall_<n> in the translations.
export const EIGHT_BALL_ANSWERS = 20;

const contexts = [InteractionContextType.Guild];

export function buildCoinflipCommandData() {
  return withDescription(new SlashCommandBuilder().setName("coinflip"), "coinflipCommandDescription").setContexts(...contexts).toJSON();
}

export function buildRollCommandData() {
  return withDescription(new SlashCommandBuilder().setName("roll"), "rollCommandDescription")
    .setContexts(...contexts)
    .addStringOption((option) => withDescription(option.setName("dice"), "rollDiceOptionDescription").setMaxLength(20))
    .toJSON();
}

export function buildChooseCommandData() {
  return withDescription(new SlashCommandBuilder().setName("choose"), "chooseCommandDescription")
    .setContexts(...contexts)
    .addStringOption((option) => withDescription(option.setName("options"), "chooseOptionsOptionDescription").setRequired(true).setMaxLength(1000))
    .toJSON();
}

export function buildEightBallCommandData() {
  return withDescription(new SlashCommandBuilder().setName("8ball"), "eightBallCommandDescription")
    .setContexts(...contexts)
    .addStringOption((option) => withDescription(option.setName("question"), "eightBallQuestionOptionDescription").setRequired(true).setMaxLength(300))
    .toJSON();
}

// "2d6+3" → { count: 2, sides: 6, modifier: 3 }; "20" and "d20" mean 1d20.
// Returns null for anything else or anything over DICE_LIMITS.
export function parseDice(input) {
  const cleaned = String(input ?? "").replace(/\s+/g, "").toLowerCase();
  const match = /^(?:(\d{1,3})?d)?(\d{1,4})([+-]\d{1,4})?$/.exec(cleaned || "1d6");
  if (!match) {
    return null;
  }
  const count = match[1] === undefined ? 1 : Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  if (count < 1 || count > DICE_LIMITS.count || sides < 2 || sides > DICE_LIMITS.sides || Math.abs(modifier) > DICE_LIMITS.modifier) {
    return null;
  }
  return { count, sides, modifier };
}

// The dice written the usual way: "2d6+3".
export const diceLabel = ({ count, sides, modifier }) => `${count}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ""}`;

// "pizza, tacos | sushi" → ["pizza", "tacos", "sushi"]: split by commas or |,
// blanks and repeats dropped (ignoring case).
export function splitChoices(input) {
  const seen = new Set();
  const choices = [];
  for (const part of String(input ?? "").split(/[,|]/)) {
    const choice = part.replace(/\s+/g, " ").trim();
    if (choice && !seen.has(choice.toLowerCase())) {
      seen.add(choice.toLowerCase());
      choices.push(choice);
    }
  }
  return choices;
}

// Text a member typed, safe to show: no markdown tricks, no pings, one line.
const quoted = (value, max) => escapeMarkdown(value.replace(/\s+/g, " ").trim().slice(0, max));

// Options: forcedLanguage, randomInt(min, max) (max excluded; for tests)
export function createFunCommands({ forcedLanguage, randomInt = cryptoRandomInt } = {}) {
  const helpers = (interaction) => {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    const text = (key, values) => translate(language, key, values);
    const post = async (key, values) => {
      await interaction.reply({ content: text(key, values), allowedMentions: { parse: [] } });
      return result(Status.SUCCESS);
    };
    const refuse = async (key, values) => {
      await interaction.reply({ content: text(key, values), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return result(Status.REFUSED, key, values);
    };
    return { language, text, post, refuse };
  };

  async function coinflip(interaction) {
    const { text, post } = helpers(interaction);
    return post("coinflipResult", { side: text(randomInt(0, 2) === 0 ? "coinflipHeads" : "coinflipTails") });
  }

  async function roll(interaction) {
    const { language, post, refuse } = helpers(interaction);
    const dice = parseDice(interaction.options.getString("dice"));
    if (!dice) {
      return refuse("rollBadDice", { count: DICE_LIMITS.count, sides: DICE_LIMITS.sides });
    }
    const rolls = Array.from({ length: dice.count }, () => randomInt(1, dice.sides + 1));
    const total = rolls.reduce((sum, value) => sum + value, 0) + dice.modifier;
    const number = (value) => new Intl.NumberFormat(language).format(value);
    const shown = dice.count === 1 && dice.modifier === 0 ? "" : rolls.length <= ROLLS_SHOWN ? `[${rolls.join(", ")}]${dice.modifier ? ` ${dice.modifier > 0 ? "+" : "−"} ${Math.abs(dice.modifier)}` : ""}` : "";
    return post(shown ? "rollResultDetailed" : "rollResult", { dice: diceLabel(dice), total: number(total), rolls: shown });
  }

  async function choose(interaction) {
    const { post, refuse } = helpers(interaction);
    const choices = splitChoices(interaction.options.getString("options", true));
    if (choices.length < CHOOSE_LIMITS.min || choices.length > CHOOSE_LIMITS.max) {
      return refuse("chooseBadOptions", { min: CHOOSE_LIMITS.min, max: CHOOSE_LIMITS.max });
    }
    return post("chooseResult", { choice: quoted(choices[randomInt(0, choices.length)], 200) });
  }

  async function eightBall(interaction) {
    const { text, post } = helpers(interaction);
    const question = quoted(interaction.options.getString("question", true), 300);
    return post("eightBallResult", { question, answer: text(`eightBall_${randomInt(1, EIGHT_BALL_ANSWERS + 1)}`) });
  }

  return [
    { name: "coinflip", data: buildCoinflipCommandData(), execute: coinflip },
    { name: "roll", data: buildRollCommandData(), execute: roll },
    { name: "choose", data: buildChooseCommandData(), execute: choose },
    { name: "8ball", data: buildEightBallCommandData(), execute: eightBall },
  ];
}
