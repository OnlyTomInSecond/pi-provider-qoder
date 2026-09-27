// shape: none — dispatch object does not apply: the protocol choice is 2-way,
//   below the ≥3 dispatch threshold, and the precedence is a guard cascade.
//   Map for the session fallback cache (trigger #6, ad-hoc key→value store).
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getCachedModelConfig } from "../catalog.js";
import { debugLog } from "../debug.js";
import type { QoderMode } from "../region.js";
import { getRoutingData, isMarkedLegacyOnly, PROTOCOL, type Protocol } from "./routing.js";
import { filterSamplingParams } from "./sampling.js";
import { streamQoder } from "./stream.js";
import { streamQoderV2 } from "./v2.js";

export interface RouteDecision {
  protocol: Protocol;
  source: "env" | "fallback-cache" | "routing-data" | "default";
}

function envValue(options: SimpleStreamOptions | undefined, name: string): string | undefined {
  return options?.env?.[name] ?? process.env[name];
}

/**
 * Protocol per request, from data rather than a compiled constant. Precedence:
 * QODER_PROTOCOL override → self-heal session cache → routing table → default
 * v2. cn mode has no verified v2 host, so it stays legacy unless
 * QODER_MODEL_SERVER_HOST points at one.
 */
export function resolveProtocol(upstreamKey: string, mode: QoderMode, options?: SimpleStreamOptions): RouteDecision {
  const forced = envValue(options, "QODER_PROTOCOL");
  if (forced === PROTOCOL.V2 || forced === PROTOCOL.LEGACY) return { protocol: forced, source: "env" };
  if (mode === "cn" && !envValue(options, "QODER_MODEL_SERVER_HOST"))
    return { protocol: PROTOCOL.LEGACY, source: "env" };
  if (isMarkedLegacyOnly(upstreamKey)) return { protocol: PROTOCOL.LEGACY, source: "fallback-cache" };
  const routing = getRoutingData((message) => debugLog(message));
  if (routing.v2Eligible.includes(upstreamKey)) return { protocol: PROTOCOL.V2, source: "routing-data" };
  // Only a proven-v2 key takes the v2 path. New Qoder models launch
  // legacy-only, and the legacy gateway serves every key today — so the
  // default can never produce a failed turn on a launch-day model.
  return { protocol: PROTOCOL.LEGACY, source: routing.legacyOnly.includes(upstreamKey) ? "routing-data" : "default" };
}

/**
 * Registered entry for the qoder-api provider: shared upstream (mode, catalog
 * config, filter), then one of two peer transports. Legacy keeps the fork's
 * streamQoder untouched; v2 delegates to pi-ai behind the field injector.
 */
export function streamQoderRouter(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const mode: QoderMode = model.provider === "qoder-cn" ? "cn" : "global";
  const modelConfig = getCachedModelConfig(model.id, mode);
  if (!modelConfig?.key) {
    // Mirror the legacy path's fail-fast: unknown model ids error before any
    // network call, on either transport.
    return streamQoder(model, context, options);
  }
  const upstreamKey = modelConfig.key;
  const decision = resolveProtocol(upstreamKey, mode, options);
  debugLog(`provider.request model_key=${upstreamKey} protocol=${decision.protocol} source=${decision.source}`);

  const routing = getRoutingData();
  filterSamplingParams(options, routing.rejectedSamplingKeys);

  if (decision.protocol === PROTOCOL.V2) {
    return streamQoderV2(model, context, options, { mode, modelConfig, upstreamKey });
  }
  return streamQoder(model, context, options);
}
