/**
 * Lightweight retry for idempotent GET requests.
 *
 * The catalog fetch is the highest-value caller: a single transient gateway
 * failure used to leave the plugin on the static fallback catalog for a whole
 * hour. Retries are limited to GETs so token-exchange/refresh POSTs keep their
 * single-attempt semantics (repeating them can mint extra tokens).
 */

/** HTTP statuses that are worth retrying: transient server/gateway failures. */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 || // Request Timeout
    status === 425 || // Too Early
    status === 429 || // Too Many Requests
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export interface FetchRetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms; doubles each attempt. Default 250. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff. Default 2000. */
  maxDelayMs?: number;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch` with bounded exponential backoff on network errors and retryable
 * statuses. Returns the final non-retryable response (including a retryable
 * status on the last attempt) so callers keep their existing status handling.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = (init.method ?? "GET").toUpperCase() === "GET" ? Math.max(1, options.attempts ?? 3) : 1;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const signal = options.signal ?? init.signal ?? undefined;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    try {
      const response = await (options.fetch ?? fetch)(input, { ...init, signal });
      if (signal?.aborted) {
        void response.body?.cancel().catch(() => {});
        throw signal.reason;
      }
      const retryable = isRetryableStatus(response.status);
      if (!retryable || attempt >= attempts - 1) return response;
      // Release the failed response body before the next attempt.
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (attempt >= attempts - 1 || signal?.aborted) throw error;
    }
    await delay(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt), signal);
  }
}
