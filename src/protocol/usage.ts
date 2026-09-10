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
