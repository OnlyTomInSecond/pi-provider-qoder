import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessageEvent,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { clearQoderModelsMemCache, staticModels } from "../catalog.js";
import { streamQoderRouter } from "../protocol/router.js";
import { clearQoderFallbackCache, clearQoderRoutingMemCache, isMarkedLegacyOnly } from "../protocol/routing.js";
import { clearQoderFilterMemCache } from "../protocol/sampling.js";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const cachePath = () => join(process.env.HOME as string, ".pi", "agent", "qoder-models-cache.json");

function modelNamed(id: string): Model<Api> {
  const found = staticModels.find((model) => model.id === id);
  if (!found) throw new Error(`fixture model missing from static seed: ${id}`);
  return found as Model<Api>;
}

function seedCatalogWithTiers() {
  writeFileSync(
    cachePath(),
    JSON.stringify({
      updatedAt: Date.now(),
      models: [],
      configs: {
        Ultimate: {
          key: "ultimate",
          enable: true,
          display_name: "Ultimate",
          context_config: {
            "200K": { token_count: 200_000 },
            "400K": { token_count: 400_000 },
            "1M": { token_count: 1_000_000 },
          },
        },
      },
    }),
    "utf8",
  );
  clearQoderModelsMemCache();
}

function envelope(inner: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}
const legacySuccess = `${envelope({ choices: [{ delta: { content: "OK" } }] })}data: [DONE]\n\n`;
const v2Success = [
  `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
  `data: ${JSON.stringify({ id: "x", model: "ultimate", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]",
].join("\n\n");

function v2FetchCapture() {
  const calls: { url: unknown; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("chat/completions")) {
      calls.push({ url: input, body: JSON.parse(String(init?.body)) });
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }
    calls.push({ url: input });
    return new Response(legacySuccess);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

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

function bodyOf(calls: { url: unknown; body?: Record<string, unknown> }[], index = 0): Record<string, unknown> {
  const body = calls[index]?.body;
  if (!body) throw new Error(`expected a captured request body at calls[${index}]`);
  return body;
}

describe("v2 field injector", () => {
  it("injects metadata.context and the explicit-send set on every v2 request", async () => {
    seedCatalogWithTiers();
    const { calls, fetch } = v2FetchCapture();
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      reasoning: "high",
    }).result();
    expect(result.stopReason).toBe("stop");
    const body = bodyOf(calls);
    const metadata = body.metadata as { context: Record<string, unknown> };
    expect(metadata.context.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metadata.context.session_id).toBe("session-1");
    expect(metadata.context.os_type).toBe("macos");
    expect(metadata.context.task_id).toBe("common");
    expect(metadata.context.client_type).toBe("5");
    expect(body.enable_thinking).toBe(true);
    expect(body.context_length).toBe(1_000_000);
    expect(body.preserve_thinking).toBe(true);
    expect(body.parallel_tool_calls).toBe(true);
    expect("skipCacheWrite" in body).toBe(false);
  });

  it("sends enable_thinking:false when the level is unset or clamps to off", async () => {
    const { calls, fetch } = v2FetchCapture();
    // Efficient is reasoning:false in the static seed, so "high" clamps to off.
    await streamQoderRouter(modelNamed("Efficient"), context, { apiKey: "fake", fetch, reasoning: "high" }).result();
    expect(bodyOf(calls).enable_thinking).toBe(false);
    calls.length = 0;
    await streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch }).result();
    expect(bodyOf(calls).enable_thinking).toBe(false);
  });

  it("sets skipCacheWrite only when cacheRetention is none", async () => {
    const { calls, fetch } = v2FetchCapture();
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      cacheRetention: "none",
    } as SimpleStreamOptions).result();
    expect(bodyOf(calls).skipCacheWrite).toBe(true);
  });

  it("chains the caller onPayload after injecting, honoring its replacement", async () => {
    const { calls, fetch } = v2FetchCapture();
    const onPayload = vi.fn(async (payload: unknown) => {
      const body = payload as Record<string, unknown>;
      expect(body.metadata).toMatchObject({ context: { session_id: "session-1" } });
      return { ...body, custom_marker: "from-caller" };
    });
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      sessionId: "session-1",
      onPayload,
    }).result();
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(bodyOf(calls).custom_marker).toBe("from-caller");
  });

  it("honors the QODER_MODEL_SERVER_HOST override as the explicit escape hatch", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response(v2Success, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_MODEL_SERVER_HOST: "https://gateway.internal.example.com/v2" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(urls[0]).toBe("https://gateway.internal.example.com/v2/chat/completions");
  });

  it("errors naming protocol=v2 when credentials are missing", async () => {
    const fetchMock = v2FetchCapture().fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, { fetch: fetchMock });
    for await (const event of stream) events.push(event);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    expect(String((terminal as { error?: { errorMessage?: string } }).error?.errorMessage)).toContain("protocol=v2");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("self-heal", () => {
  const invalidModelResponse = () =>
    new Response(JSON.stringify({ error: { type: "invalid_model_error", message: "model not supported" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  it("retries once on legacy with QODER_FALLBACK=1 and caches the correction", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("chat/completions")) return invalidModelResponse();
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    const result = await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions).result();
    expect(result.stopReason).toBe("stop");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe("https://api2-v2.qoder.sh/model/v1/chat/completions");
    expect(urls[1]).toContain("agent_chat_generation");
    expect(isMarkedLegacyOnly("ultimate")).toBe(true);
  });

  it("makes zero v2 attempts on the next turn with the same key", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      if (String(input).includes("chat/completions")) return invalidModelResponse();
      return new Response(legacySuccess);
    }) as typeof globalThis.fetch;
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions).result();
    urls.length = 0;
    await streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions).result();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("agent_chat_generation");
  });

  it("surfaces an actionable error and makes zero legacy attempts when the flag is off", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return invalidModelResponse();
    }) as typeof globalThis.fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, { apiKey: "fake", fetch });
    for await (const event of stream) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(urls).toHaveLength(1);
    expect(isMarkedLegacyOnly("ultimate")).toBe(false);
  });

  it("never retries legacy on a 401, even with the flag on", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: { type: "invalid_model_error", message: "unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const events: AssistantMessageEvent[] = [];
    const stream = streamQoderRouter(modelNamed("Ultimate"), context, {
      apiKey: "fake",
      fetch,
      env: { QODER_FALLBACK: "1" },
    } as SimpleStreamOptions);
    for await (const event of stream) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(urls).toHaveLength(1);
    expect(isMarkedLegacyOnly("ultimate")).toBe(false);
  });
});
