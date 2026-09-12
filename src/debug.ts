/**
 * Diagnostic logging for best-effort paths.
 *
 * Several code paths intentionally swallow errors (catalog refresh, env PAT
 * exchange fallthrough, token refresh, userinfo lookup). Reporting only when
 * `QODER_DEBUG` is set keeps normal runs quiet while making those failures
 * diagnosable without changing control flow.
 */
export function debugLog(message: string, error?: unknown): void {
  if (!process.env.QODER_DEBUG) return;
  if (error === undefined) console.error(`[pi-provider-qoder] ${message}`);
  else console.error(`[pi-provider-qoder] ${message}`, error);
}
