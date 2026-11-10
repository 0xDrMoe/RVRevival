import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { guardAcknowledgement } from "../src/utils/ackWatchdog.js";

// A fake interaction and a timer the test fires by hand.
function setup({ component = false } = {}) {
  const interaction = {
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isMessageComponent: () => component,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => ({ id: "edited" })),
    followUp: vi.fn(async () => ({ id: "follow-up" })),
    deleteReply: vi.fn(async () => {}),
  };
  const originals = { ...interaction };
  let fire;
  const stop = guardAcknowledgement(interaction, { setTimer: (callback) => (fire = callback), clearTimer: () => {} });
  return { interaction, originals, fire: () => fire(), stop };
}

describe("acknowledging slow interactions", () => {
  it("leaves a quick answer alone", async () => {
    const { interaction, originals, fire, stop } = setup();
    await interaction.reply({ content: "hi", flags: MessageFlags.Ephemeral });
    fire();
    stop();
    expect(originals.reply).toHaveBeenCalledWith({ content: "hi", flags: MessageFlags.Ephemeral });
    expect(originals.deferReply).not.toHaveBeenCalled();
    // The object's own methods are back.
    expect(interaction.reply).toBe(originals.reply);
  });

  it("acknowledges a slow command privately, then turns its private reply into an edit", async () => {
    const { interaction, originals, fire } = setup();
    fire();
    expect(originals.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    await interaction.reply({ content: "done", flags: MessageFlags.Ephemeral });
    expect(originals.reply).not.toHaveBeenCalled();
    expect(originals.editReply).toHaveBeenCalledWith({ content: "done" });
    // Its own defer is no longer needed.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    expect(originals.deferReply).toHaveBeenCalledTimes(1);
  });

  it("posts a slow command's public reply and removes the private placeholder", async () => {
    const { interaction, originals, fire } = setup();
    fire();
    await interaction.reply({ content: "Everyone look" });
    expect(originals.followUp).toHaveBeenCalledWith({ content: "Everyone look" });
    expect(originals.deleteReply).toHaveBeenCalledWith();
    await interaction.editReply({ content: "Edited" });
    expect(originals.editReply).toHaveBeenCalledWith({ content: "Edited", message: { id: "follow-up" } });
  });

  it("acknowledges a slow button silently: update edits its message, a reply becomes a private follow-up", async () => {
    const { interaction, originals, fire } = setup({ component: true });
    fire();
    expect(originals.deferUpdate).toHaveBeenCalled();
    await interaction.update({ content: "new panel" });
    expect(originals.editReply).toHaveBeenCalledWith({ content: "new panel" });

    await interaction.reply({ content: "Role added", flags: MessageFlags.Ephemeral });
    expect(originals.followUp).toHaveBeenCalledWith({ content: "Role added", flags: MessageFlags.Ephemeral });
  });

  it("keeps a slow button's deferred private answer off the button's message", async () => {
    const { interaction, originals, fire } = setup({ component: true });
    fire();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ content: "Working…" });
    await interaction.editReply({ content: "Done" });
    expect(originals.followUp).toHaveBeenCalledWith({ content: "Working…", flags: MessageFlags.Ephemeral });
    expect(originals.editReply).toHaveBeenCalledWith({ content: "Done", message: { id: "follow-up" } });
    expect(originals.editReply).not.toHaveBeenCalledWith({ content: "Working…" });
  });
});
