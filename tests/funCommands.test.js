import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createFunCommands, diceLabel, parseDice, splitChoices } from "../src/commands/fun.js";

function fakeInteraction(options = {}) {
  return {
    locale: "en-US",
    options: { getString: (name) => options[name] ?? null },
    reply: vi.fn(async () => {}),
  };
}

// randomInt that returns the given values in turn (each clamped to its range).
const sequence = (...values) => {
  let index = 0;
  return (min, max) => Math.min(max - 1, Math.max(min, values[index++ % values.length]));
};

const commandsWith = (randomInt) => new Map(createFunCommands({ randomInt }).map((command) => [command.name, command]));

describe("dice", () => {
  it("reads the usual notation", () => {
    expect(parseDice(null)).toEqual({ count: 1, sides: 6, modifier: 0 });
    expect(parseDice("20")).toEqual({ count: 1, sides: 20, modifier: 0 });
    expect(parseDice("d20")).toEqual({ count: 1, sides: 20, modifier: 0 });
    expect(parseDice(" 2D6 + 3 ")).toEqual({ count: 2, sides: 6, modifier: 3 });
    expect(parseDice("4d8-1")).toEqual({ count: 4, sides: 8, modifier: -1 });
  });

  it("refuses nonsense and huge rolls", () => {
    for (const bad of ["abc", "0d6", "101d6", "1d1", "1d1001", "1d6+1001", "2d", "d", "1.5d6"]) {
      expect(parseDice(bad), bad).toBeNull();
    }
  });

  it("writes dice back", () => {
    expect(diceLabel({ count: 2, sides: 6, modifier: 3 })).toBe("2d6+3");
    expect(diceLabel({ count: 1, sides: 20, modifier: -2 })).toBe("1d20-2");
    expect(diceLabel({ count: 1, sides: 6, modifier: 0 })).toBe("1d6");
  });
});

describe("choices", () => {
  it("splits by commas or pipes and drops blanks and repeats", () => {
    expect(splitChoices("pizza, tacos | sushi,, Pizza ,  ")).toEqual(["pizza", "tacos", "sushi"]);
  });
});

describe("fun commands", () => {
  it("flips a coin", async () => {
    const interaction = fakeInteraction();
    await commandsWith(sequence(1)).get("coinflip").execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: "🪙 The coin lands on **tails**!", allowedMentions: { parse: [] } });
  });

  it("rolls and adds up the dice", async () => {
    const interaction = fakeInteraction({ dice: "2d6+3" });
    await commandsWith(sequence(4, 5)).get("roll").execute(interaction);
    expect(interaction.reply.mock.calls[0][0].content).toBe("🎲 **2d6+3**: [4, 5] + 3 = **12**");
  });

  it("shows a single die as just the total", async () => {
    const interaction = fakeInteraction({ dice: "d20" });
    await commandsWith(sequence(17)).get("roll").execute(interaction);
    expect(interaction.reply.mock.calls[0][0].content).toBe("🎲 **1d20**: you rolled **17**");
  });

  it("explains bad dice privately", async () => {
    const interaction = fakeInteraction({ dice: "lots" });
    const outcome = await commandsWith(sequence(1)).get("roll").execute(interaction);
    expect(outcome.status).toBe("refused");
    expect(interaction.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
  });

  it("picks one option, without letting it ping or format", async () => {
    const interaction = fakeInteraction({ options: "@everyone **bold**, tacos" });
    await commandsWith(sequence(0)).get("choose").execute(interaction);
    const reply = interaction.reply.mock.calls[0][0];
    expect(reply.content).toBe("🤔 I pick **@everyone \\*\\*bold\\*\\***.");
    expect(reply.allowedMentions).toEqual({ parse: [] });
  });

  it("needs at least two options", async () => {
    const interaction = fakeInteraction({ options: "just one" });
    const outcome = await commandsWith(sequence(0)).get("choose").execute(interaction);
    expect(outcome.key).toBe("chooseBadOptions");
  });

  it("answers with the 8-ball", async () => {
    const interaction = fakeInteraction({ question: "Will we win?" });
    await commandsWith(sequence(1)).get("8ball").execute(interaction);
    expect(interaction.reply.mock.calls[0][0].content).toBe("❓ Will we win?\n🎱 **It is certain.**");
  });
});
