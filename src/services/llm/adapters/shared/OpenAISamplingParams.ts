/**
 * OpenAI models that reject `temperature` and `top_p` with a 400
 * ("Unsupported parameter: 'temperature' is not supported with this model").
 *
 * Matched as a family rather than by exact id: every GPT-6 release so far
 * (Astra, Sol, Luna — verified live against /v1/responses on 2026-09-22) has
 * rejected both, and an exact-id check silently breaks the next sibling the
 * moment a temperature setting is present. OpenRouter drops the parameters
 * instead of rejecting them, so its adapter does not need this.
 */
export function rejectsSamplingParams(model: string): boolean {
  return /^gpt-6(?:-|$)/.test(model);
}
