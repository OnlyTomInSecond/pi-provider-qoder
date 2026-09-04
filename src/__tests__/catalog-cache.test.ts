import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModelConfig, getCachedModels, updateQoderModelsCache } from "../catalog.js";
import { loadLiveFixture, responseFromFixture } from "./live-fixture.js";

const CACHE_PATHS = {
  global: join(homedir(), ".pi", "agent", "qoder-models-cache.json"),
  cn: join(homedir(), ".pi", "agent", "qoder-cn-models-cache.json"),
};
let originalCaches: Record<keyof typeof CACHE_PATHS, string | undefined>;

beforeEach(() => {
  originalCaches = {
    global: existsSync(CACHE_PATHS.global) ? readFileSync(CACHE_PATHS.global, "utf8") : undefined,
    cn: existsSync(CACHE_PATHS.cn) ? readFileSync(CACHE_PATHS.cn, "utf8") : undefined,
  };
  for (const path of Object.values(CACHE_PATHS)) rmSync(path, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const region of Object.keys(CACHE_PATHS) as Array<keyof typeof CACHE_PATHS>) {
    const path = CACHE_PATHS[region];
    const original = originalCaches[region];
    if (original === undefined) rmSync(path, { force: true });
    else writeFileSync(path, original, "utf8");
  }
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

  it("preserves Qoder Credit rate metadata from the live catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              {
                key: "qmodel_preview",
                enable: true,
                display_name: "Qwen3.8-Max",
                price_factor: 0.5,
                original_price_factor: 1,
              },
              {
                key: "lite",
                enable: true,
                display_name: "Lite",
              },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const models = getCachedModels("global");
    expect(models[0].priceFactor).toBe(0.5);
    expect(models[0].originalPriceFactor).toBe(1);
    expect(models[1].priceFactor).toBeUndefined();
    expect(models[1].originalPriceFactor).toBeUndefined();
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

  it("maps Qoder max effort while keeping the largest context as default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              {
                key: "dfmodel",
                enable: true,
                display_name: "DeepSeek V4 Flash",
                context_config: {
                  "200K": { token_count: 200000 },
                  "400K": { token_count: 400000 },
                  "1M": { token_count: 1000000, is_default: true },
                },
                is_reasoning: true,
                thinking_config: {
                  disabled: {},
                  enabled: {
                    efforts: {
                      low: {},
                      medium: {},
                      high: {},
                      max: {},
                    },
                  },
                },
              },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const model = getCachedModels("global")[0];
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.thinkingLevelMap).toMatchObject({
      off: "disabled",
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    });

    const config = getCachedModelConfig("DeepSeekV4Flash", "global");
    expect(config?.context_config?.["200K"]?.is_default).toBe(false);
    expect(config?.context_config?.["400K"]?.is_default).toBe(false);
    expect(config?.context_config?.["1M"]?.is_default).toBe(true);
  });
});
