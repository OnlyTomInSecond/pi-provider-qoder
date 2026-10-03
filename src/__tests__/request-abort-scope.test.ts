import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestAbortScope } from "../protocol/request-abort-scope.js";

describe("RequestAbortScope", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirrors an external abort onto the scope signal", () => {
    const external = new AbortController();
    const scope = new RequestAbortScope({ externalSignal: external.signal });
    expect(scope.signal.aborted).toBe(false);
    external.abort(new Error("cancelled"));
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.throwIfAborted()).toThrow("cancelled");
    scope.dispose();
  });

  it("honors an already-aborted external signal", () => {
    const external = new AbortController();
    external.abort(new Error("already"));
    const scope = new RequestAbortScope({ externalSignal: external.signal });
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.throwIfAborted()).toThrow("already");
    scope.dispose();
  });

  it("aborts on the overall request timeout", () => {
    const scope = new RequestAbortScope({ timeoutMs: 100 });
    vi.advanceTimersByTime(99);
    expect(scope.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.throwIfAborted()).toThrow("Qoder request timeout");
    scope.dispose();
  });

  it("aborts when the idle deadline elapses and resets on activity", () => {
    const scope = new RequestAbortScope();
    scope.startIdleWatch(50);
    vi.advanceTimersByTime(30);
    scope.resetIdle();
    vi.advanceTimersByTime(30);
    expect(scope.signal.aborted).toBe(false);
    vi.advanceTimersByTime(20);
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.throwIfAborted()).toThrow("Qoder stream idle timeout");
    scope.dispose();
  });

  it("does not arm an idle deadline before startIdleWatch", () => {
    const scope = new RequestAbortScope();
    scope.resetIdle();
    vi.advanceTimersByTime(10_000);
    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it("dispose cancels pending timers", () => {
    const scope = new RequestAbortScope({ timeoutMs: 10 });
    scope.startIdleWatch(10);
    scope.dispose();
    vi.advanceTimersByTime(1000);
    expect(scope.signal.aborted).toBe(false);
  });
});
