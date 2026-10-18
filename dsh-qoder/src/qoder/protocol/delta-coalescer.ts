import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * Minimum wall-clock interval between coalesced delta pushes. Hosts rebuild and
 * re-layout the whole text/thinking block on every `message_update`, so
 * emitting one delta per SSE line makes rendering quadratic in the response
 * length. Coalescing deltas to ~20 pushes/second keeps the UI smooth while
 * bounding that render work. Override with QODER_STREAM_DELTA_INTERVAL_MS.
 */
export const DELTA_FLUSH_INTERVAL_MS = 50;

/** The delta events that may be merged with an immediately following same-block delta. */
export type CoalescableDelta = Extract<
  AssistantMessageEvent,
  { type: "text_delta" | "thinking_delta" | "toolcall_delta" }
>;

function isCoalescable(event: AssistantMessageEvent): event is CoalescableDelta {
  return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
}

/**
 * Throttles streaming delta events.
 *
 * Same-type, same-`contentIndex` deltas are merged into one pending event and
 * flushed at most once per `intervalMs`. Any non-delta event (start/end/done/
 * error) is an ordering boundary: the pending delta is flushed first so event
 * order is preserved. A trailing delta is pushed by a bounded timer even if no
 * further event arrives.
 */
export class DeltaCoalescer {
  private pending: CoalescableDelta | null = null;
  private lastFlushAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (event: AssistantMessageEvent) => void,
    /** Injectable clock so the throttle can be unit-tested deterministically. */
    private readonly now: () => number = Date.now,
  ) {}

  push(event: AssistantMessageEvent): void {
    if (isCoalescable(event)) {
      if (this.pending && this.pending.type === event.type && this.pending.contentIndex === event.contentIndex) {
        // Mutate in place rather than spreading a new object on every merged
        // delta: coalescing is the hottest path in a streamed response and the
        // object has no other references consumers rely on.
        this.pending.delta += event.delta;
        this.schedule();
        return;
      }
      // A different block/type must keep its ordering, so flush unconditionally.
      this.flush(true);
      this.pending = event;
      this.schedule();
      return;
    }
    // Any non-delta event is an ordering boundary (start/end/done/error).
    this.flush(true);
    this.emit(event);
  }

  /** Push the pending delta, unless we pushed one within the throttle window. */
  flush(force = false): void {
    if (!this.pending) return;
    const now = this.now();
    if (!force && now - this.lastFlushAt < this.intervalMs) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.emit(this.pending);
    this.pending = null;
    this.lastFlushAt = now;
  }

  /** Cancel the pending timer. Does not flush. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.flush();
    if (!this.pending || this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.flush(true);
      },
      Math.max(0, this.intervalMs - (this.now() - this.lastFlushAt)),
    );
  }
}
