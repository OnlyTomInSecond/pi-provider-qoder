import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModels, updateQoderModelsCache } from "../models.js";

const CACHE_PATH = join(homedir(), ".pi", "agent", "qoder-models-cache.json");
let originalCache: string | undefined;

beforeEach(() => {
  originalCache = existsSync(CACHE_PATH) ? readFileSync(CACHE_PATH, "utf8") : undefined;
  rmSync(CACHE_PATH, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCache === undefined) rmSync(CACHE_PATH, { force: true });
  else writeFileSync(CACHE_PATH, originalCache, "utf8");
});

describe("Qoder model cache", () => {
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

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["ultimate", "lite"]);
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

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["cmodel"]);
  });

  it("filters auto from a legacy fallback cache when the service did not enable it", () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "auto" }, { id: "ultimate" }],
        configs: { ultimate: { key: "ultimate", enable: true } },
      }),
      "utf8",
    );

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["ultimate"]);
  });
});
