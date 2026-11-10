// Discord cancels an interaction the bot hasn't answered within 3 seconds
// ("This interaction failed"). Most handlers answer at once, but some do
// Discord work first (give a role, make a thread, lock a channel), and when
// Discord's rate limits make that work wait, the 3 seconds run out.
//
// guardAcknowledgement watches the interaction. If the handler hasn't started
// answering after ACK_AFTER_MS, it acknowledges it for them: a private
// "thinking…" for commands, a silent acknowledgement for buttons and menus.
// The handler's own answer then lands where it would have:
//
//   reply        → edits the "thinking…" (or, for a public reply, posts it
//                  and removes the private placeholder); for a button, a
//                  private follow-up
//   deferReply / deferUpdate → nothing more to do
//   update       → edits the button's message
//
// So handlers wait for Discord instead of racing it, and nobody sees
// "This interaction failed". Forms (modals) are left alone: Discord only
// accepts a form as the first answer.

import { MessageFlags } from "discord.js";

export const ACK_AFTER_MS = 2000;

const isEphemeral = (options) =>
  typeof options === "object" && options !== null && (BigInt(options.flags ?? 0) & BigInt(MessageFlags.Ephemeral)) !== 0n;

// Options: after (ms), setTimer, clearTimer (tests), logger
// Returns stop(), to call when the handler is done.
export function guardAcknowledgement(interaction, { after = ACK_AFTER_MS, setTimer = setTimeout, clearTimer = clearTimeout, logger } = {}) {
  if (typeof interaction?.reply !== "function" || typeof interaction.isAutocomplete === "function" && interaction.isAutocomplete()) {
    return () => {};
  }
  // Buttons, menus and forms opened from a message are acknowledged silently, so update() still edits that message.
  const component = Boolean(interaction.isMessageComponent?.() || (interaction.isModalSubmit?.() && interaction.isFromMessage?.()));
  // The handler has started answering (or the watchdog has).
  let answered = false;
  // The watchdog's own acknowledgement, while it's on its way and after.
  let acked = null;

  const original = {};
  // What was on the object itself before (put back when the handler is done).
  const own = new Map();
  for (const name of ["reply", "deferReply", "deferUpdate", "update", "showModal", "editReply", "followUp", "deleteReply"]) {
    if (typeof interaction[name] === "function") {
      own.set(name, Object.hasOwn(interaction, name) ? interaction[name] : undefined);
      original[name] = interaction[name].bind(interaction);
    }
  }

  const wrap = (name, handle) => {
    if (!original[name]) {
      return;
    }
    interaction[name] = async (...args) => {
      if (!acked) {
        answered = true;
        return original[name](...args);
      }
      await acked.catch(() => {});
      return handle(...args);
    };
  };

  // After the watchdog answered, a handler's own answer may have to become a
  // separate message; its later editReply / deleteReply go to that message.
  let redirected = false;
  let target = null;
  const asOptions = (options) => (typeof options === "string" ? { content: options } : { ...options });
  async function sendSeparately(options) {
    target = await original.followUp(options);
    return target;
  }

  wrap("reply", async (options) => {
    if (component) {
      redirected = true;
      return sendSeparately({ ...asOptions(options), flags: MessageFlags.Ephemeral });
    }
    if (typeof options === "string" || isEphemeral(options)) {
      const { flags: _flags, ...rest } = asOptions(options);
      return original.editReply(rest);
    }
    // A public answer: post it, then remove the private placeholder.
    redirected = true;
    const sent = await sendSeparately(options);
    await original.deleteReply?.().catch(() => {});
    return sent;
  });
  wrap("deferReply", async () => {
    // A button's message was acknowledged silently; the handler's private
    // answer becomes a follow-up instead of replacing that message.
    if (component) {
      redirected = true;
    }
  });
  wrap("deferUpdate", async () => undefined);
  wrap("update", async (options) => original.editReply(options));
  // Too late for a form; the handler's own error handling takes it from here.
  wrap("showModal", async (...args) => original.showModal(...args));
  if (original.editReply) {
    interaction.editReply = async (options) => {
      if (!redirected) {
        return original.editReply(options);
      }
      if (!target) {
        return sendSeparately({ ...asOptions(options), flags: MessageFlags.Ephemeral });
      }
      return original.editReply({ ...asOptions(options), message: target });
    };
  }
  if (original.deleteReply) {
    interaction.deleteReply = async (message) => (redirected && target && !message ? original.deleteReply(target) : original.deleteReply(message));
  }

  const timer = setTimer(() => {
    if (answered || interaction.deferred || interaction.replied) {
      return;
    }
    const ack = component && original.deferUpdate ? original.deferUpdate() : original.deferReply?.({ flags: MessageFlags.Ephemeral });
    if (!ack) {
      return;
    }
    acked = Promise.resolve(ack);
    acked.catch((error) => logger?.debug?.("Couldn't acknowledge a slow interaction", { error }));
  }, after);
  timer?.unref?.();

  return () => {
    clearTimer(timer);
    for (const [name, value] of own) {
      if (value === undefined) {
        delete interaction[name];
      } else {
        interaction[name] = value;
      }
    }
  };
}
