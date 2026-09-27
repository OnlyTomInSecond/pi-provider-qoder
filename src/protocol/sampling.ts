// shape: none — dispatch object does not apply: straight-line filter over a key
//   list; the log-once Set is membership state, not a discriminator.
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { debugLog } from "../debug.js";

const droppedKeysThisSession = new Set<string>();

/**
 * F2 sampling-parameter guard. pi-ai applies `Object.assign(params,
 * options.samplingParams)` LAST, so anything configured reaches the wire —
 * and Qoder's validator hard-errors on the rejected keys. Drop them here,
 * before dispatch, on both transports. Absent/empty samplingParams is a no-op:
 * the request body stays byte-identical to unfiltered.
 */
export function filterSamplingParams(options: SimpleStreamOptions | undefined, rejectedKeys: readonly string[]): void {
  const params = options?.samplingParams;
  if (!params) return;
  for (const key of rejectedKeys) {
    if (!(key in params)) continue;
    delete (params as Record<string, unknown>)[key];
    if (!droppedKeysThisSession.has(key)) {
      droppedKeysThisSession.add(key);
      debugLog(
        `provider.filter_drop key=${key} (rejected by Qoder; dropped from samplingParams for the rest of this session)`,
      );
    }
  }
}

/** Test-only resetter, alongside the fork's existing resetter pattern. */
export function clearQoderFilterMemCache(): void {
  droppedKeysThisSession.clear();
}
