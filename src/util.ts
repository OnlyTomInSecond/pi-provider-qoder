/**
 * Small shared helpers used across the protocol and auth layers.
 */

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Per-stream buffer ceiling. Shared by the SSE line reader and the DSML parser
 * so both bounded-buffer guards use the same limit.
 */
export const MAX_STREAM_BUFFER_LENGTH = 8 * 1024 * 1024;

/**
 * Read a numeric option, preferring the host-provided `env` over `process.env`.
 * Returns `fallback` when the value is unset or fails `isValid`. Centralizes the
 * "options.env overrides process.env" convention and the finite/in-range checks.
 */
export function readNumericOption(
  name: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  const raw = env?.[name] ?? process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return isValid(value) ? value : fallback;
}
