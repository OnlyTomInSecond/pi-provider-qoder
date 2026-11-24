import type { AssistantMessage } from "@earendil-works/pi-ai";
import { applyQoderCredits, creditNumber, type QoderProvider, type QoderUsage } from "../credits.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Merge one Qoder `usage` payload into pi's `Usage` contract.
 *
 * pi-core computes `promptTokens = input + cacheRead + cacheWrite` (Anthropic
 * convention: `input` EXCLUDES cached/written tokens). Qoder follows OpenAI
 * semantics where `prompt_tokens` INCLUDES `cached_tokens`, so subtract
 * cacheRead (and cache_write_tokens when reported) to match the contract
 * pi-ai's own OpenAI provider uses. `cacheable_tokens` is a capacity metric,
 * not a write count (it is 0 even on first-turn writes), so it is NOT mapped to
 * cacheWrite. Qoder Credits have no native Usage field, so they stay optional
 * runtime metadata on the same object (missing fields remain absent, not zero).
 */
export function applyQoderUsage(target: AssistantMessage["usage"], value: unknown, provider?: QoderProvider): void {
  const usage = asRecord(value);
  if (!usage) return;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);

  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const cacheReadTokens = typeof promptDetails?.cached_tokens === "number" ? promptDetails.cached_tokens : 0;
  const cacheWriteTokens = typeof promptDetails?.cache_write_tokens === "number" ? promptDetails.cache_write_tokens : 0;

  target.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  target.output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  target.totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + target.output;
  target.cacheRead = cacheReadTokens;
  target.cacheWrite = cacheWriteTokens;
  if (typeof completionDetails?.reasoning_tokens === "number") {
    target.reasoning = completionDetails.reasoning_tokens;
  }

  // Qoder Credits have no native Usage field, so they ride along as optional
  // runtime metadata on the same object. `applyQoderCredits` sets
  // `credits`/`original_credits`/`billable`, derives the actually charged amount
  // (non-billable requests cost zero) and its reference USD value, and records
  // which provider served the request.
  applyQoderCredits(target as QoderUsage, usage, provider);
}

/** Parse the relative Credit multiplier (`price_factor`) from a catalog entry. */
export function parseQoderPriceFactor(value: unknown): number | undefined {
  return creditNumber(value);
}
