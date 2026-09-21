import { afterEach, describe, expect, it, vi } from "vitest";
import { interactiveLogin } from "../auth/login.js";
import { refreshQoderTokenForMode } from "../auth/oauth.js";
import { exchangeJobToken, fetchUserInfo } from "../auth/pat.js";
import { fetchQoderUsageForMode } from "../auth/usage.js";
import { updateQoderModelsCache } from "../catalog.js";
import { fetchQoderJson, withRequestTimeout } from "../http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stalledFetch() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

const credentials = { access: "old", refresh: "refresh|user|machine", expires: 100 };

describe("request deadlines and cancellation", () => {
  it("bounds an uncooperative request and clears its deadline", async () => {
    vi.useFakeTimers();
    const task = withRequestTimeout(() => new Promise(() => {}), undefined, 50);
    const assertion = expect(task).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a body that stalls after successful headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const task = fetchQoderJson("https://example.test", {}, { timeoutMs: 50 });
    const assertion = expect(task).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pat", "profile", "refresh", "usage", "catalog"])("propagates cancellation through %s", async (kind) => {
    const controller = new AbortController();
    const fetch = stalledFetch();
    vi.stubGlobal("fetch", fetch);
    const task =
      kind === "pat"
        ? exchangeJobToken("pat", "global", { signal: controller.signal })
        : kind === "profile"
          ? fetchUserInfo("token", "global", { signal: controller.signal })
          : kind === "refresh"
            ? refreshQoderTokenForMode(credentials, "global", controller.signal)
            : kind === "usage"
              ? fetchQoderUsageForMode(credentials, "global", { signal: controller.signal })
              : updateQoderModelsCache("token", "user", "Name", "email", "global", controller.signal);
    const assertion = expect(task).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await assertion;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("cancels a PAT entered in the login dialog", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", stalledFetch());
    const progress = vi.fn();
    const task = interactiveLogin(
      { onPrompt: async () => "pt-test", onProgress: progress, signal: controller.signal } as never,
      "global",
    );
    const assertion = expect(task).rejects.toThrow("cancelled");
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await assertion;
    expect(progress).not.toHaveBeenCalledWith("Login successful!");
  });

  it("bounds browser login by wall-clock time and cleans up polling", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 })),
    );
    const task = interactiveLogin({ onPrompt: async () => "", onAuth: vi.fn() } as never, "global");
    const assertion = expect(task).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps profile lookup cancellation from reporting browser login success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = stalledFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "new", user_id: "user", refresh_token: "refresh" })),
    );
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    const task = interactiveLogin(
      { onPrompt: async () => "", onAuth: vi.fn(), onProgress: progress, signal: controller.signal } as never,
      "global",
    );
    const assertion = expect(task).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(2000);
    controller.abort(new Error("cancelled"));
    await assertion;
    expect(progress).not.toHaveBeenCalledWith("Login successful!");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves refresh credentials and identity on successful refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "new", expires_in: 86400000 })))
        .mockResolvedValue(new Response(JSON.stringify({ chat: [] }))),
    );
    const result = await refreshQoderTokenForMode(credentials, "global");
    expect(result).toMatchObject({
      access: "new",
      refresh: "refresh|user|machine",
      userID: "user",
      machineID: "machine",
    });
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  it.each([401, 403, 503])("never extends an old token after HTTP %s", async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(refreshQoderTokenForMode(credentials, "global")).rejects.toThrow(`HTTP ${status}`);
    expect(credentials.expires).toBe(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects PAT refresh failure and malformed refresh responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(refreshQoderTokenForMode({ ...credentials, refresh: "pat|pt-test|||" }, "global")).rejects.toThrow(
      "401",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    await expect(refreshQoderTokenForMode(credentials, "global")).rejects.toThrow("no access token");
  });
});
