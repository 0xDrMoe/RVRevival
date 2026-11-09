// The start every moderation-style command shares: pick the reply language,
// refuse outside servers and refuse members who may not use it.

import { MessageFlags } from "discord.js";
import { findVariableProblems, token, VARIABLE_CONTEXTS } from "../dashboard/public/variables.js";
import { pickLanguage, translate } from "../i18n/i18n.js";
import { result, Status } from "../logs/actionLog.js";
import { isModerator } from "../moderation/checks.js";


// Returns { language, text, answer, refusal }. `answer(status, key, values)`
// replies privately (or edits the deferred reply) and returns the log outcome.
// `refusal` is set when the command must stop; call it and return its result.
export function beginModerationCommand(interaction, { permission, permissionKey, guildSettings, forcedLanguage }) {
  const language = pickLanguage(interaction.locale, forcedLanguage);
  const text = (key, values) => translate(language, key, values);
  const answer = async (status, key, values = {}) => {
    const payload = { content: text(key, values), allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
    return result(status, key, values);
  };

  let refusal;
  if (!interaction.inCachedGuild()) {
    refusal = () => answer(Status.REFUSED, "guildOnly");
  } else if (!isModerator(interaction, permission, guildSettings)) {
    refusal = () => answer(Status.REFUSED, "modNoPermission", { permission: text(permissionKey) });
  }
  return { language, text, answer, refusal };
}

// When a message uses a variable its place doesn't have ({usr}, or {level} in
// a welcome message), the values for the "variablesRefused" reply; else null.
// Variables are listed in dashboard/public/variables.js.
export function variableRefusal(template, context) {
  const problems = findVariableProblems(template, context);
  if (problems.length === 0) {
    return null;
  }
  return {
    bad: problems.map((problem) => (problem.suggestion ? `${problem.token} (→ ${problem.suggestion})` : problem.token)).join(", "),
    allowed: VARIABLE_CONTEXTS[context].variables.map(token).join(" "),
  };
}
