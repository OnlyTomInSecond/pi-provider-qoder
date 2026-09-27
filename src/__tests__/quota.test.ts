import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQoderQuotaCache, handleQuotaCommand } from "../commands/quota.js";

const quotaPayload = {
  userQuota: { total: 100, used: 25, remaining: 75, percentage: 25, unit: "credits" },
  orgResourcePackage: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
  totalUsagePercentage: 25,
  isQuotaExceeded: false,
  expiresAt: Date.parse("2026-10-01T00:00:00Z"),
};

function fakeCtx(notify: ReturnType<typeof vi.fn>, token?: string): ExtensionCommandContext {
  return {
    modelRegistry: {
      getApiKeyForProvider: async (providerID: string) => (providerID === "qoder" ? token : undefined),
    },
    ui: { notify },
  } as never;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected global fetch");
    }),
  );
});

afterEach(() => {
  clearQoderQuotaCache();
  vi.unstubAllGlobals();
});

describe("qoder-quota command (F4)", () => {
  it("renders remaining quota and reset date, and serves the second call from cache", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(quotaPayload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const notify = vi.fn();
    await handleQuotaCommand("", fakeCtx(notify, "fake-token"));
    const first = String(notify.mock.calls[0]?.[0]);
    expect(first).toContain("User Quota");
    expect(first).toContain("25.00");
    expect(first).toContain("2026-10-01");

    await handleQuotaCommand("", fakeCtx(notify, "fake-token"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const second = String(notify.mock.calls[1]?.[0]);
    expect(second).toContain("cached");
  });

  it("prints quota unavailable with the reason and invents no numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const notify = vi.fn();
    await handleQuotaCommand("", fakeCtx(notify, "fake-token"));
    const output = String(notify.mock.calls[0]?.[0]);
    expect(output).toContain("quota unavailable");
    expect(output).not.toContain("75.00");
  });

  it("warns when no credentials are configured", async () => {
    const notify = vi.fn();
    await handleQuotaCommand("", fakeCtx(notify));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no Qoder credentials"), "warning");
  });
});
