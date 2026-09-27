import { type Api, type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import { resolveProtocol, streamQoderRouter } from "../protocol/router.js";
import {
  clearQoderFallbackCache,
  clearQoderRoutingMemCache,
  isMarkedLegacyOnly,
  markLegacyOnly,
} from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function modelNamed(id: string): Model<Api> {
  const found = staticModels.find((model) => model.id === id);
  if (!found) throw new Error(`fixture model missing from static seed: ${id}`);
  return found as Model<Api>;
}

function envelope(inner: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}
const legacySuccess = `${envelope({ choices: [{ delta: { content: "OK" } }] })}data: [DONE]\n\n`;
const v2Success = [
  `data: ${JSON.stringify({ id: "x", model: "qmodel", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
  `data: ${JSON.stringify({ id: "x", model: "qmodel", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]",
].join("\n\n");

beforeEach(() => {
  cacheQoderIdentityForTest("qoder:fake", {
    access: "fake",
    refresh: "",
    expires: 0,
    userID: "user",
    name: "Test",
    email: "test@example.com",
    machineID: "machine",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected global fetch");
    }),
  );
});

afterEach(() => {
  clearQoderAuthMemCache();
  clearQoderFallbackCache();
  clearQoderRoutingMemCache();
  clearQoderFilterMemCache();
  clearQoderModelsMemCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveProtocol", () => {
  it("routes by routing data: v2-confirmed key to v2, legacy-only and unknown keys to legacy", () => {
    expect(resolveProtocol("qmodel", "global")).toEqual({ protocol: "v2", source: "routing-data" });
    expect(resolveProtocol("dfmodel", "global")).toEqual({ protocol: "legacy", source: "routing-data" });
    expect(resolveProtocol("lite", "global")).toEqual({ protocol: "legacy", source: "default" });
  });

  it("honors QODER_PROTOCOL over everything", () => {
    expect(resolveProtocol("qmodel", "global", { env: { QODER_PROTOCOL: "legacy" } } as SimpleStreamOptions)).toEqual({
      protocol: "legacy",
      source: "env",
    });
  });

  it("keeps cn on legacy unless a v2 host override is set", () => {
    expect(resolveProtocol("qmodel", "cn")).toEqual({ protocol: "legacy", source: "env" });
    expect(
      resolveProtocol("qmodel", "cn", {
        env: { QODER_MODEL_SERVER_HOST: "https://api2-v2.qoder.sh" },
      } as SimpleStreamOptions),
    ).toEqual({
      protocol: "v2",
      source: "routing-data",
    });
  });

  it("reads the self-heal session cache before the table", () => {
    markLegacyOnly("qmodel");
    expect(resolveProtocol("qmodel", "global")).toEqual({ protocol: "legacy", source: "fallback-cache" });
  });
});

describe("streamQoderRouter", () => {
  it("sends a legacy-only key to the COSY gateway", async () => {
    let url: unknown;
    const fetch = vi.fn(async (input: unknown) => {
      url = input;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("DeepSeek-V4-Flash"), context, {
      apiKey: "fake",
      fetch,
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toContain("agent_chat_generation");
  });

  it("sends a v2-eligible key to the model-server and drops rejected sampling keys", async () => {
    let url: unknown;
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      url = input;
      body = JSON.parse(String(init?.body));
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      samplingParams: { presence_penalty: 0.5, temperature: 0.7 },
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toBe("https://api2-v2.qoder.sh/model/v1/chat/completions");
    expect(body).toBeDefined();
    expect("presence_penalty" in (body as object)).toBe(false);
    expect(body?.temperature).toBe(0.7);
  });

  it("forces legacy via QODER_PROTOCOL even for a v2-eligible key", async () => {
    let url: unknown;
    const fetch = vi.fn(async (input: unknown) => {
      url = input;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_PROTOCOL: "legacy" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toContain("agent_chat_generation");
  });

  it("routes a key marked legacy-only by the self-heal straight to legacy", async () => {
    markLegacyOnly("ultimate");
    let url: unknown;
    const fetch = vi.fn(async (input: unknown) => {
      url = input;
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    expect(String(url)).toContain("agent_chat_generation");
    expect(isMarkedLegacyOnly("ultimate")).toBe(true);
  });
});
