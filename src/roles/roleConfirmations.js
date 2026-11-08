// Role pick confirmations: before a role panel button or the country picker
// changes a member's roles, the bot asks "Add X?" with Confirm and Cancel.
//
// The server picks the default on the dashboard (Setting.ROLE_CONFIRM, on unless
// set to false). Each member can turn it on or off for themselves with the
// button under the bot's reply; that choice is saved in data/bot.db, table
// role_confirm_prefs, and forgotten when they leave the server.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { Setting } from "../settings/guildSettings.js";
import { openDatabase } from "../storage/database.js";

export const ConfirmId = Object.freeze({
  TURN_ON: "rcf:on",
  TURN_OFF: "rcf:off",
  CANCEL: "rcf:cancel",
});

export class RoleConfirmStore {
  #statements;

  constructor(database = ":memory:") {
    const db = typeof database === "string" ? openDatabase(database) : database;
    this.#statements = {
      get: db.prepare("SELECT enabled FROM role_confirm_prefs WHERE guild_id = ? AND user_id = ?"),
      set: db.prepare(`
        INSERT INTO role_confirm_prefs (guild_id, user_id, enabled) VALUES (?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET enabled = excluded.enabled`),
      delete: db.prepare("DELETE FROM role_confirm_prefs WHERE guild_id = ? AND user_id = ?"),
    };
  }

  // true or false if the member chose, undefined if they never did.
  get(guildId, userId) {
    const row = this.#statements.get.get(guildId, userId);
    return row ? row.enabled === 1 : undefined;
  }

  set(guildId, userId, enabled) {
    this.#statements.set.run(guildId, userId, enabled ? 1 : 0);
  }

  delete(guildId, userId) {
    return this.#statements.delete.run(guildId, userId).changes > 0;
  }
}

// Whether the server asks for confirmation by default (on unless switched off).
export const serverDefaultOn = (guildSettings, guildId) => guildSettings?.get(guildId, Setting.ROLE_CONFIRM) !== false;

// Options:
//   guildSettings, store (RoleConfirmStore), forcedLanguage
export function createRoleConfirmations({ guildSettings, store, forcedLanguage }) {
  // The member's own choice, else the server's default.
  const isOn = (guildId, userId) => store.get(guildId, userId) ?? serverDefaultOn(guildSettings, guildId);

  // "Turn off confirmations" while they're on, "Turn on confirmations" while they're off.
  function toggleButton(language, on) {
    return new ButtonBuilder()
      .setCustomId(on ? ConfirmId.TURN_OFF : ConfirmId.TURN_ON)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(translate(language, on ? "roleConfirmTurnOff" : "roleConfirmTurnOn"));
  }

  // Confirm, Cancel and "Turn off confirmations", under a "Add X?" question.
  // `danger` colours Confirm red (for taking a role away).
  function promptRow(language, confirmId, { danger = false } = {}) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmId)
        .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success)
        .setLabel(translate(language, "roleConfirmButton")),
      new ButtonBuilder().setCustomId(ConfirmId.CANCEL).setStyle(ButtonStyle.Secondary).setLabel(translate(language, "roleConfirmCancelButton")),
      toggleButton(language, true),
    );
  }

  // Just the toggle, under a "You now have X" reply.
  const toggleRow = (language, on) => new ActionRowBuilder().addComponents(toggleButton(language, on));

  async function setOwn(interaction, enabled) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    if (!interaction.inGuild()) {
      await interaction.reply({ content: translate(language, "guildOnly"), flags: MessageFlags.Ephemeral });
      return result(Status.REFUSED, "guildOnly");
    }
    store.set(interaction.guildId, interaction.user.id, enabled);
    const key = enabled ? "roleConfirmNowOn" : "roleConfirmNowOff";
    // The toggle is only ever on the bot's private replies, so the reply is changed in place.
    await interaction.update({ content: translate(language, key), components: [toggleRow(language, enabled)], allowedMentions: { parse: [] } });
    return result(Status.SUCCESS, key);
  }

  async function cancel(interaction) {
    const language = pickLanguage(interaction.locale, forcedLanguage);
    await interaction.update({ content: translate(language, "roleConfirmCancelled"), components: [], allowedMentions: { parse: [] } });
    return null;
  }

  return {
    isOn,
    promptRow,
    toggleRow,
    components: {
      [ConfirmId.TURN_ON]: { label: "Role confirmations", handle: (interaction) => setOwn(interaction, true) },
      [ConfirmId.TURN_OFF]: { label: "Role confirmations", handle: (interaction) => setOwn(interaction, false) },
      [ConfirmId.CANCEL]: { label: "Role confirmations", handle: cancel },
    },
    memberLeft(member) {
      store.delete(member.guild.id, member.id);
    },
  };
}
