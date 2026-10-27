import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * Qoder's scheduler reports a busy model as error code 10605. The official
 * client treats `isQueued:false` + `serviceAvailable:true` as "ready" and
 * re-sends the request after `retryAfterSeconds`; without that recovery one
 * transient rejection kills the whole turn. We mirror the bounded part of it.
 */
const MODEL_BUSY_CODE = "10605";
export const DEFAULT_MODEL_BUSY_RETRIES = 2;
export const MAX_MODEL_BUSY_RETRIES = 10;
export const MODEL_BUSY_MAX_WAIT_MS = 5_000;

/** A recovery-eligible "model busy" rejection from Qoder's queue scheduler. */
export class QoderModelBusyError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
    readonly sawModelOutput = false,
  ) {
    super(message);
    this.name = "QoderModelBusyError";
  }
}

export interface ModelBusyQueueSnapshot {
  retryAfterMs?: number;
}

/** Parse `unknown | JSON string` layers until an object is found (bounded). */
function parseJsonObject(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Recognize Qoder's model-busy envelope and extract the retry hint.
 *
 * Envelope body shape (three nested JSON layers):
 *   {code:"403",message:"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":false,...}\",\"subCode\":\"RESOURCE_LIMIT\"}"}
 *
 * Only the documented 10605 code and the observed ready combination
 * (`isQueued:false` + `serviceAvailable:true`) are eligible. A real queue
 * (`isQueued:true`), missing flags, or any other code keep the previous
 * failure behavior. `subCode` is diagnostic only — it is not a retry signal.
 */
export function parseModelBusyRejection(body: unknown): ModelBusyQueueSnapshot | undefined {
  const outer = parseJsonObject(body);
  const busy = parseJsonObject(outer?.message);
  if (busy?.code !== MODEL_BUSY_CODE) return undefined;
  const queue = parseJsonObject(busy.message);
  if (!queue) return undefined;
  if (queue.isQueued !== false || queue.serviceAvailable !== true) return undefined;
  const seconds = queue.retryAfterSeconds;
  const retryAfterMs =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  return { retryAfterMs };
}

/** Sleep that rejects as soon as the caller aborts. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve the model-busy retry budget from the host options.
 *
 * A caller-provided retry budget (including an explicit 0) wins; otherwise
 * retry twice, capped at qodercli's own recovery limit. Non-finite values fall
 * back to the default so the caps stay finite. `maxRetryDelayMs: 0` disables the
 * caller cap (pi's contract); the provider's own 5s cap still applies so a
 * positive retryAfterSeconds is never truncated to zero.
 */
export function resolveModelBusyLimits(options?: SimpleStreamOptions): {
  retries: number;
  maxWaitMs: number;
} {
  const requestedRetries = options?.maxRetries;
  const retries = Math.min(
    Math.max(
      0,
      typeof requestedRetries === "number" && Number.isFinite(requestedRetries)
        ? Math.floor(requestedRetries)
        : DEFAULT_MODEL_BUSY_RETRIES,
    ),
    MAX_MODEL_BUSY_RETRIES,
  );
  const requestedMaxWaitMs = options?.maxRetryDelayMs;
  const maxWaitMs =
    typeof requestedMaxWaitMs === "number" && Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs > 0
      ? Math.min(MODEL_BUSY_MAX_WAIT_MS, requestedMaxWaitMs)
      : MODEL_BUSY_MAX_WAIT_MS;
  return { retries, maxWaitMs };
}
