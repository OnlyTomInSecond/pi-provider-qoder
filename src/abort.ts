import { combineAbortSignals } from "@earendil-works/pi-ai/utils/abort-signals";

/**
 * Request-scoped cancellation and deadlines, shared by the streamed chat path
 * and the JSON request helper.
 *
 * Combines three independent abort sources — the host's external
 * `AbortSignal`, an overall request deadline, and an idle timeout that resets
 * on every received chunk — through pi's `combineAbortSignals`. Cancellation is
 * surfaced with the native `AbortSignal.throwIfAborted`, and cleanup releases
 * every listener and timer.
 */
export interface RequestAbortScopeOptions {
  /** Host-provided cancellation signal. */
  externalSignal?: AbortSignal;
  /** Overall request deadline in ms; values <= 0 disable it. */
  timeoutMs?: number;
}

export class RequestAbortScope {
  readonly signal: AbortSignal;
  private readonly requestController = new AbortController();
  private readonly idleController = new AbortController();
  private readonly cleanupCombined: () => void;
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimeoutMs = 0;

  constructor(options: RequestAbortScopeOptions = {}) {
    const combined = combineAbortSignals([
      options.externalSignal,
      this.requestController.signal,
      this.idleController.signal,
    ]);
    this.signal = combined.signal ?? this.idleController.signal;
    this.cleanupCombined = combined.cleanup;

    if (options.timeoutMs && options.timeoutMs > 0) {
      this.requestTimer = setTimeout(
        () => this.requestController.abort(new Error("Qoder request timeout")),
        options.timeoutMs,
      );
    }
  }

  /** Throw the abort reason (as an Error) when the request has been cancelled. */
  throwIfAborted(): void {
    this.signal.throwIfAborted();
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
      this.idleController.abort(new Error("Qoder stream idle timeout"));
    }, this.idleTimeoutMs);
  }

  /** Cancel every timer and combined-signal listener. */
  dispose(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.cleanupCombined();
  }
}
