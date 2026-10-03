import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaCoalescer } from "../protocol/delta-coalescer.js";

const partial = { role: "assistant", content: [] } as unknown as AssistantMessage;

function textDelta(contentIndex: number, delta: string): AssistantMessageEvent {
  return { type: "text_delta", contentIndex, delta, partial };
}

function textEnd(contentIndex: number, content: string): AssistantMessageEvent {
  return { type: "text_end", contentIndex, content, partial };
}

describe("DeltaCoalescer", () => {
  let emitted: AssistantMessageEvent[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    emitted = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function coalescer(intervalMs = 50) {
    return new DeltaCoalescer(intervalMs, (event) => emitted.push(event));
  }

  it("merges same-block deltas and flushes them at the next ordering boundary", () => {
    const c = coalescer();
    c.push(textDelta(0, "a"));
    c.push(textDelta(0, "b"));
    expect(emitted).toEqual([]);
    c.push(textEnd(0, "ab"));
    expect(emitted.map((e) => e.type)).toEqual(["text_delta", "text_end"]);
    expect((emitted[0] as { delta: string }).delta).toBe("ab");
  });

  it("flushes a pending delta before a delta for a different block", () => {
    const c = coalescer();
    c.push(textDelta(0, "a"));
    c.push(textDelta(1, "b"));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "text_delta", contentIndex: 0, delta: "a" });
  });

  it("flushes a trailing delta on the throttle timer", () => {
    const c = coalescer();
    c.push(textDelta(0, "a"));
    vi.advanceTimersByTime(50);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ delta: "a" });
  });

  it("does not emit within the throttle window without a boundary", () => {
    const c = coalescer();
    c.push(textDelta(0, "a"));
    vi.advanceTimersByTime(49);
    expect(emitted).toEqual([]);
  });

  it("flush(true) forces the pending delta out", () => {
    const c = coalescer();
    c.push(textDelta(0, "a"));
    c.flush(true);
    expect(emitted).toHaveLength(1);
  });

  it("dispose cancels the pending timer without emitting", () => {
    const c = coalescer();
    c.push(textDelta(0, "a"));
    c.dispose();
    vi.advanceTimersByTime(500);
    expect(emitted).toEqual([]);
  });
});
