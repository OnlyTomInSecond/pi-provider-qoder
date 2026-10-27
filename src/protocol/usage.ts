import type { AssistantMessage } from "@earendil-works/pi-ai";
import { applyQoderCredits, type QoderProvider, type QoderUsage } from "../credits.js";

/**
 * Qoder-specific request metering fields.
 *
 * pi-ai's Usage.cost is a monetary token-rate calculation and has no native
 * Credits field. Keep Qoder Credits as optional runtime metadata instead of
 * pretending that Credits are USD or defaulting missing values to zero.
 */
export interface QoderCreditsUsage {
  credits?: number;
  original_credits?: number;
  billable?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

type QoderAssistantUsage = AssistantMessage["usage"] & QoderCreditsUsage;

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
  // runtime metadata on the same object. `applyQoderCredits` also derives the
  // actually charged amount (non-billable requests cost zero) and its
  // reference USD value, and records which provider served the request.
  applyQoderCredits(target as QoderUsage, usage, provider);
  // Keep the pre-1.2.0 shape populated as well: older local callers/tests read
  // `credits` / `original_credits` / `billable` straight off the usage object.
  Object.assign(target as QoderAssistantUsage, parseQoderCreditsUsage(usage));
}

/** Parse the optional Qoder usage fields without inventing zero values. */
export function parseQoderCreditsUsage(value: unknown): QoderCreditsUsage {
  const usage = asRecord(value);
  if (!usage) return {};

  const result: QoderCreditsUsage = {};
  const credits = nonNegativeFiniteNumber(usage.credits);
  const originalCredits = nonNegativeFiniteNumber(usage.original_credits);
  if (credits !== undefined) result.credits = credits;
  if (originalCredits !== undefined) result.original_credits = originalCredits;
  if (typeof usage.billable === "boolean") result.billable = usage.billable;
  return result;
}

/** Parse the relative Credit multiplier (`price_factor`) from a catalog entry. */
export function parseQoderPriceFactor(value: unknown): number | undefined {
  return nonNegativeFiniteNumber(value);
}
