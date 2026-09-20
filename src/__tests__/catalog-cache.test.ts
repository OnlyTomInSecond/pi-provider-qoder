import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQoderModelsMemCache,
  getCachedModelConfig,
  getCachedModels,
  isCacheStale,
  updateQoderModelsCache,
} from "../catalog.js";
import { loadLiveFixture, responseFromFixture } from "./live-fixture.js";

function testHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

const CACHE_PATHS = {
  global: join(testHome(), ".pi", "agent", "qoder-models-cache.json"),
  cn: join(testHome(), ".pi", "agent", "qoder-cn-models-cache.json"),
};
let originalCaches: Record<keyof typeof CACHE_PATHS, string | undefined>;

beforeEach(() => {
  clearQoderModelsMemCache();
  originalCaches = {
    global: existsSync(CACHE_PATHS.global) ? readFileSync(CACHE_PATHS.global, "utf8") : undefined,
    cn: existsSync(CACHE_PATHS.cn) ? readFileSync(CACHE_PATHS.cn, "utf8") : undefined,
  };
  for (const path of Object.values(CACHE_PATHS)) rmSync(path, { force: true });
  clearQoderModelsMemCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const region of Object.keys(CACHE_PATHS) as Array<keyof typeof CACHE_PATHS>) {
    const path = CACHE_PATHS[region];
    const original = originalCaches[region];
    if (original === undefined) rmSync(path, { force: true });
    else writeFileSync(path, original, "utf8");
  }
  clearQoderModelsMemCache();
});

describe("Qoder model cache", () => {
  it.each([
    ["global", ["Lite", "GLM5.2"]],
    ["cn", ["Qwen3.7Plus"]],
  ] as const)("maps the %s recorded-format catalog to friendly picker ids", async (region, expectedIds) => {
    const interaction = loadLiveFixture(region).interactions.modelList;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromFixture(interaction)));

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", region);

    const cache = JSON.parse(readFileSync(CACHE_PATHS[region], "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(expectedIds);
    const catalog = interaction.response.body as { chat: Array<{ key: string; display_name: string }> };
    for (const entry of catalog.chat) {
      const friendlyId = entry.display_name.replace(/\s+/g, "");
      expect(cache.configs[friendlyId]?.key).toBe(entry.key);
      expect(cache.configs[entry.key]).toBeUndefined();
      expect(getCachedModelConfig(friendlyId, region)?.key).toBe(entry.key);
      expect(getCachedModelConfig(entry.key, region)).toBeNull();
    }
  });

  it("treats a cache fetched for another account as stale", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "lite", enable: true, display_name: "Lite" }] }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-a", "A", "a@example.com", "global");

    expect(isCacheStale("global", "user-a")).toBe(false);
    expect(isCacheStale("global", "user-b")).toBe(true);
    // Without a userID the check keeps its legacy TTL-only behaviour.
    expect(isCacheStale("global")).toBe(false);
    expect(JSON.parse(readFileSync(CACHE_PATHS.global, "utf8")).userID).toBe("user-a");
  });

  it("coalesces concurrent refreshes for the same account", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = updateQoderModelsCache("token-a", "user-a", "A", "a@example.com", "global");
    const p2 = updateQoderModelsCache("token-a", "user-a", "A", "a@example.com", "global");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.stringify({ chat: [{ key: "lite", enable: true, display_name: "Lite" }] });
    for (const resolve of resolvers) resolve(new Response(body, { status: 200 }));
    await Promise.all([p1, p2]);
  });

  it("does not coalesce refreshes for different accounts", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = updateQoderModelsCache("token-a", "user-a", "A", "a@example.com", "global");
    const p2 = updateQoderModelsCache("token-b", "user-b", "B", "b@example.com", "global");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const body = JSON.stringify({ chat: [{ key: "lite", enable: true, display_name: "Lite" }] });
    for (const resolve of resolvers) resolve(new Response(body, { status: 200 }));
    await Promise.all([p1, p2]);
  });

  it("does not register raw live-catalog keys as public model ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "lite", enable: true, display_name: "Lite" },
              { key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["Lite", "Qwen3.8-Flash"]);
    expect(getCachedModelConfig("Lite", "global")?.key).toBe("lite");
    expect(getCachedModelConfig("Qwen3.8-Flash", "global")?.key).toBe("qfmodel");
    expect(getCachedModelConfig("lite", "global")).toBeNull();
    expect(getCachedModelConfig("qfmodel", "global")).toBeNull();
  });

  it("omits catalog entries without a friendly display name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "q37fmodel", enable: true },
              { key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["Qwen3.8-Flash"]);
    expect(getCachedModelConfig("q37fmodel", "global")).toBeNull();
  });

  it("keeps only enabled service models without adding auto as a fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "auto", enable: false, display_name: "Auto" },
              { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
              { key: "lite", enable: true, display_name: "Lite" },
              { key: "performance", enable: false, display_name: "Performance" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATHS.global, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["Ultimate", "Lite"]);
    expect(cache.models.some((model: { id: string }) => model.id === "auto")).toBe(false);
  });

  it("keeps the Cantus model returned by the current catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "cmodel", enable: true, display_name: "Cantus" }] }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATHS.global, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["Cantus"]);
  });

  it("filters auto from a legacy fallback cache when the service did not enable it", () => {
    writeFileSync(
      CACHE_PATHS.global,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "auto" }, { id: "ultimate" }],
        configs: { ultimate: { key: "ultimate", enable: true } },
      }),
      "utf8",
    );
    clearQoderModelsMemCache();

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["Ultimate"]);
  });

  it("records a 1M context window when the catalog omits context_config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [{ key: "lite", enable: true, display_name: "Lite", max_input_tokens: 180000 }],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATHS.global, "utf8"));
    expect(cache.models[0].contextWindow).toBe(1_000_000);
  });

  it("records the advertised context_config max, even when it is below 1M", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              {
                key: "gm51model",
                enable: true,
                display_name: "GLM 5.2",
                context_config: { default: { token_count: 200000, is_default: true } },
              },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATHS.global, "utf8"));
    expect(cache.models[0].contextWindow).toBe(200000);
  });

  it("resolves the largest context option as default through getCachedModelConfig", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              {
                key: "gm51model",
                enable: true,
                display_name: "GLM 5.2",
                context_config: {
                  small: { token_count: 200000, is_default: true },
                  large: { token_count: 400000, is_default: false },
                },
              },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    // The transform is memoized on the config index; assert it still applies.
    const config = getCachedModelConfig("GLM5.2", "global");
    expect(config?.context_config?.large?.is_default).toBe(true);
    expect(config?.context_config?.small?.is_default).toBe(false);
  });

  it("exposes the catalog price_factor as model metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "cmodel", enable: true, display_name: "Cantus", price_factor: 3.2 },
              { key: "lite", enable: true, display_name: "Lite", price_factor: 0 },
              { key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATHS.global, "utf8"));
    const byId: Record<string, { priceFactor?: number }> = Object.fromEntries(
      cache.models.map((model: { id: string }) => [model.id, model]),
    );
    expect(byId.Cantus.priceFactor).toBe(3.2);
    // 0 is a real multiplier, not a missing value.
    expect(byId.Lite.priceFactor).toBe(0);
    // Absent when the catalog does not report it (undefined is dropped by JSON).
    expect("priceFactor" in byId["Qwen3.8-Flash"]).toBe(false);
  });

  it("serves getCachedModelConfig from memory after the cache file is removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [{ key: "lite", enable: true, display_name: "Lite" }],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");
    expect(getCachedModelConfig("Lite", "global")?.key).toBe("lite");

    // Hot-path mem cache must keep serving without touching disk again.
    rmSync(CACHE_PATHS.global, { force: true });
    expect(existsSync(CACHE_PATHS.global)).toBe(false);
    expect(getCachedModelConfig("Lite", "global")?.key).toBe("lite");
    expect(getCachedModels("global").map((m) => m.id)).toEqual(["Lite"]);
  });

  it("resolves config by friendly id from a legacy raw-key cache shape", () => {
    // Older cache files keyed configs by the upstream key (e.g. `lite`) and
    // carried the display name inside each entry. The displayId index must fold
    // these in so requests resolve the config in O(1) without a full scan, and
    // still must not expose the raw upstream key as a public model id.
    writeFileSync(
      CACHE_PATHS.global,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "Lite", name: "Lite" }],
        configs: { lite: { key: "lite", display_name: "Lite", enable: true } },
      }),
      "utf8",
    );
    clearQoderModelsMemCache();

    expect(getCachedModelConfig("Lite", "global")?.key).toBe("lite");
    expect(getCachedModelConfig("lite", "global")).toBeNull();
  });

  it("coalesces concurrent model-list refreshes into a single request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          chat: [{ key: "lite", enable: true, display_name: "Lite" }],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // auto-login, session_start and a token refresh can all fire at startup.
    await Promise.all([
      updateQoderModelsCache("token-a", "user", "Name", "e@q.com", "global"),
      updateQoderModelsCache("token-b", "user", "Name", "e@q.com", "global"),
      updateQoderModelsCache("token-c", "user", "Name", "e@q.com", "global"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
