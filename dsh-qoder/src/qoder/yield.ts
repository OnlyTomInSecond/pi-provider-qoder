/**
 * Yield to the event loop so a long synchronous pass (SSE line parsing, body
 * encoding) does not monopolize Node's single thread.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
