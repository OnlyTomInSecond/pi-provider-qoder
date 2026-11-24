import { resolveDebugEnabled } from "./qoder-settings.js";

/**
 * Diagnostic logging for best-effort paths.
 *
 * Several code paths intentionally swallow errors (catalog refresh, env PAT
 * exchange fallthrough, token refresh, userinfo lookup). Reporting only when
 * diagnostics are enabled keeps normal runs quiet while making those failures
 * diagnosable without changing control flow. Diagnostics come from
 * `QODER_DEBUG` or the `debug` flag in `/qoder-settings`.
 */
export function debugLog(message: string, error?: unknown): void {
  if (!resolveDebugEnabled()) return;
  if (error === undefined) console.error(`[pi-provider-qoder] ${message}`);
  else console.error(`[pi-provider-qoder] ${message}`, error);
}
