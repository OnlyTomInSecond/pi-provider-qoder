import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, isRetryableStatus } from "../retry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isRetryableStatus", () => {
  it("flags transient statuses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("does not flag success or client errors", () => {
    for (const status of [200, 201, 400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("fetchWithRetry", () => {
  it("returns a success response without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", {}, { attempts: 3 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the last retryable response after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", {}, { attempts: 2, baseDelayMs: 1 });
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", {}, { attempts: 3, baseDelayMs: 1 });
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and ultimately throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("https://example.test/x", {}, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow(
      "network down",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(fetchWithRetry("https://example.test/x", {}, { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
