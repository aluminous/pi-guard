/**
 * Known-good classifier models for "auto" mode, in preference order.
 *
 * Ordering rationale:
 * - Subscription providers (openai-codex, github-copilot) come first: reviews
 *   ride the user's existing plan instead of metering per token.
 * - Within a provider, models are ordered by eval results (eval/RESULTS.md):
 *   gpt-5.4-mini scored 26/26 with 0 critical misses; gpt-5-mini and
 *   deepseek-v4-flash scored 96% with 0 critical misses; claude-haiku-4.5 and
 *   gemini-2.5-flash were clean on the pre-subtle dataset.
 * - Models that approved authorization planting (qwen3-32b,
 *   gemini-2.5-flash-lite) are deliberately absent.
 *
 * Entries that do not exist in the running pi's model registry are skipped,
 * so ids from newer or older catalogs are harmless here.
 */
export interface AutoModelPreference {
  provider: string;
  id: string;
}

export const AUTO_CLASSIFIER_PREFERENCES: AutoModelPreference[] = [
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "github-copilot", id: "gpt-5.4-mini" },
  { provider: "github-copilot", id: "gpt-5-mini" },
  { provider: "openai", id: "gpt-5.4-mini" },
  { provider: "openai", id: "gpt-5-mini" },
  { provider: "openrouter", id: "openai/gpt-5.4-mini" },
  { provider: "openrouter", id: "openai/gpt-5-mini" },
  { provider: "openrouter", id: "deepseek/deepseek-v4-flash" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "google", id: "gemini-2.5-flash" },
];

/** Picks the highest-preference model present in `available` (models with configured auth). */
export function resolveAutoClassifierModel<M extends { provider: string; id: string }>(available: M[]): M | undefined {
  for (const pref of AUTO_CLASSIFIER_PREFERENCES) {
    const match = available.find((model) => model.provider === pref.provider && model.id === pref.id);
    if (match) return match;
  }
  return undefined;
}
