/**
 * Token expiry resolution shared by every Qoder auth flow.
 *
 * Qoder reports `expires_in` in **milliseconds** (verified against recorded
 * responses: `86400000` == 24h), but the three call sites used to disagree:
 * `pat.ts` treated it as ms while `login.ts` and `oauth.ts` multiplied by 1000,
 * pushing the computed expiry ~3 years into the future and effectively
 * disabling refresh. Keeping the unit in one place makes the assumption
 * explicit and stops the flows from drifting apart.
 *
 * `expires_at` wins when it parses; it may be an ISO string, a numeric-string
 * epoch-ms value, or already a number.
 */

/** Fallback lifetime when a response carries neither `expires_at` nor `expires_in`. */
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Parse an absolute expiry (`expires_at`) into epoch ms, or undefined. */
export function parseExpiresAt(expiresAt: unknown): number | undefined {
  if (typeof expiresAt === "number") {
    return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
  }
  if (typeof expiresAt !== "string" || expiresAt.length === 0) return undefined;

  const iso = Date.parse(expiresAt);
  if (!Number.isNaN(iso)) return iso;

  const numeric = Number.parseInt(expiresAt, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

export interface TokenExpiryInput {
  expires_at?: unknown;
  /** Lifetime **in milliseconds**, as Qoder returns it. */
  expires_in?: unknown;
}

/**
 * Absolute epoch-ms expiry for a token response. Prefers `expires_at`, falls
 * back to `expires_in` (milliseconds) from now, then to `fallbackMs` from now.
 */
export function resolveTokenExpiry(input: TokenExpiryInput, fallbackMs = DEFAULT_TOKEN_TTL_MS): number {
  const at = parseExpiresAt(input.expires_at);
  if (at !== undefined) return at;

  const expiresIn = input.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn;
  }
  return Date.now() + fallbackMs;
}
