/**
 * Request-scoped cancellation and deadlines, shared by the streamed chat path.
 *
 * Combines three independent abort sources into one controller:
 *   - the host's external `AbortSignal`,
 *   - an overall request deadline (headers + body),
 *   - an idle timeout that resets on every received chunk.
 *
 * Also normalizes `throwIfAborted()` so a non-Error abort reason (or none) still
 * surfaces as an Error, and owns listener/timer cleanup.
 */
export interface RequestAbortScopeOptions {
  /** Host-provided cancellation signal. */
  externalSignal?: AbortSignal;
  /** Overall request deadline in ms; values <= 0 disable it. */
  timeoutMs?: number;
}

export class RequestAbortScope {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private removeExternalListener: (() => void) | undefined;
  private idleTimeoutMs = 0;

  constructor(options: RequestAbortScopeOptions = {}) {
    this.signal = this.controller.signal;

    if (options.timeoutMs && options.timeoutMs > 0) {
      this.requestTimer = setTimeout(
        () => this.controller.abort(new Error("Qoder request timeout")),
        options.timeoutMs,
      );
    }

    const external = options.externalSignal;
    if (external) {
      const abortFromExternal = (): void => this.controller.abort(external.reason);
      if (external.aborted) {
        this.controller.abort(external.reason);
      } else {
        external.addEventListener("abort", abortFromExternal, { once: true });
        this.removeExternalListener = () => external.removeEventListener("abort", abortFromExternal);
      }
    }
  }

  /** Throw the abort reason (as an Error) when the request has been cancelled. */
  throwIfAborted(): void {
    if (!this.signal.aborted) return;
    const reason = this.signal.reason;
    throw reason instanceof Error ? reason : new Error("Qoder request aborted");
  }

  /**
   * Start the idle deadline. The timer aborts the request when no chunk arrives
   * for `timeoutMs`, covering a silently stalled SSE body.
   */
  startIdleWatch(timeoutMs: number): void {
    this.idleTimeoutMs = timeoutMs;
    this.resetIdle();
  }

  /** Restart the idle deadline after a chunk; a no-op before `startIdleWatch`. */
  resetIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.controller.abort(new Error("Qoder stream idle timeout"));
    }, this.idleTimeoutMs);
  }

  /** Cancel every timer and external listener. */
  dispose(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.removeExternalListener?.();
    this.removeExternalListener = undefined;
  }
}
