// The AI model behind the ticket assistant (ai/ticketAssistant.js): Claude,
// through Anthropic's official SDK. Only made when ANTHROPIC_API_KEY is set;
// without it every AI feature says it's off on this bot.
//
// The model never gets tools: it reads text and writes text (or JSON for
// triage), so it can't act on Discord whatever a ticket says.

import Anthropic from "@anthropic-ai/sdk";

// Small and fast: summaries and triage don't need more, and it keeps the cost low.
export const DEFAULT_AI_MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;

export const AiErrorCode = Object.freeze({
  OFF: "off", // no API key on this bot
  LIMIT: "limit", // the server used its AI requests for the month
  REFUSED: "refused", // the model declined
  RATE_LIMITED: "rateLimited", // the provider said slow down
  BAD_OUTPUT: "badOutput", // cut off, empty, or not the JSON asked for
  FAILED: "failed", // anything else (network, provider down, bad key)
});

export class AiError extends Error {
  name = "AiError";
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.code = code;
  }
}

function errorCode(error) {
  if (error instanceof Anthropic.RateLimitError) {
    return AiErrorCode.RATE_LIMITED;
  }
  return AiErrorCode.FAILED;
}

// Options:
//   apiKey   ANTHROPIC_API_KEY; without one the client is unavailable
//   model    the model ID (AI_MODEL), Claude Haiku 5.5 by default
//   sdk      stands in for the Anthropic client in tests ({ messages: { create } })
export function createAiClient({ apiKey, model = DEFAULT_AI_MODEL, sdk } = {}) {
  const client = sdk ?? (apiKey ? new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES }) : null);
  const available = Boolean(client);

  // One request. `schema` asks for JSON in that shape (structured outputs)
  // and returns it parsed as `json`. Throws AiError.
  async function ask({ system, prompt, maxTokens = 1024, schema = null, effort = "low" }) {
    if (!client) {
      throw new AiError(AiErrorCode.OFF, "AI is off on this bot: ANTHROPIC_API_KEY isn't set.");
    }
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort, ...(schema ? { format: { type: "json_schema", schema } } : {}) },
      });
    } catch (error) {
      throw new AiError(errorCode(error), error?.message ?? "The AI request failed.", { cause: error });
    }
    const usage = { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
    if (response.stop_reason === "refusal") {
      throw Object.assign(new AiError(AiErrorCode.REFUSED, "The AI declined this ticket."), { usage });
    }
    const text = (response.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text || response.stop_reason === "max_tokens") {
      throw Object.assign(new AiError(AiErrorCode.BAD_OUTPUT, "The AI's answer was empty or cut off."), { usage });
    }
    if (!schema) {
      return { text, usage };
    }
    try {
      return { text, json: JSON.parse(text), usage };
    } catch (error) {
      throw Object.assign(new AiError(AiErrorCode.BAD_OUTPUT, "The AI's answer wasn't valid JSON.", { cause: error }), { usage });
    }
  }

  return { available, model, ask };
}

export const noAiClient = createAiClient();
