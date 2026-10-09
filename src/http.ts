import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { RequestAbortScope } from "./abort.js";
import { fetchWithRetry } from "./retry.js";

const QODER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Stop waiting even if an injected transport ignores cancellation. Delegates to
 * pi's abort helper, which also normalizes a missing abort reason to an Error.
 */
export const withAbort = raceWithAbortSignal;

/** Deadline covers headers AND body consumption, and aborts underlying fetch I/O. */
export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = QODER_REQUEST_TIMEOUT_MS,
): Promise<T> {
  signal?.throwIfAborted();
  const scope = new RequestAbortScope({ externalSignal: signal, timeoutMs });
  try {
    return await withAbort(operation(scope.signal), scope.signal);
  } finally {
    scope.dispose();
  }
}

/** Read and release even a custom fetch body that ignores AbortSignal. */
export async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return withAbort(response.text(), signal);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export class QoderHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Qoder HTTP ${status}${status === 401 || status === 403 ? ": credentials rejected; run /login again" : ""}`);
  }
}

export interface QoderRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  attempts?: number;
  fetch?: typeof fetch;
}

export function fetchQoderJson<T>(url: string, init: RequestInit = {}, options: QoderRequestOptions = {}): Promise<T> {
  return withRequestTimeout(
    async (signal) => {
      const response = await fetchWithRetry(url, init, { ...options, signal });
      try {
        if (!response.ok) throw new QoderHttpError(response.status);
        // Prefer readResponseText (bounded even for transports that ignore
        // AbortSignal), but fall back to response.json() for injected fetch
        // implementations that only expose a duck-typed JSON response.
        const data = (
          response.body
            ? JSON.parse(await readResponseText(response, signal))
            : await withAbort(response.json(), signal)
        ) as T;
        signal.throwIfAborted();
        return data;
      } finally {
        // Also release non-OK and stalled bodies for injected transports.
        void response.body?.cancel().catch(() => {});
      }
    },
    options.signal ?? init.signal ?? undefined,
    options.timeoutMs,
  );
}
