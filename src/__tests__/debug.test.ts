import { afterEach, describe, expect, it, vi } from "vitest";
import { debugLog } from "../debug.js";

afterEach(() => {
  delete process.env.QODER_DEBUG;
  vi.restoreAllMocks();
});

describe("debugLog", () => {
  it("is silent unless QODER_DEBUG is set", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugLog("quiet");
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs the message and error when QODER_DEBUG is set", () => {
    process.env.QODER_DEBUG = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");
    debugLog("something failed", error);
    expect(spy).toHaveBeenCalledWith("[pi-provider-qoder] something failed", error);
  });

  it("logs without an error argument", () => {
    process.env.QODER_DEBUG = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugLog("note");
    expect(spy).toHaveBeenCalledWith("[pi-provider-qoder] note");
  });
});
