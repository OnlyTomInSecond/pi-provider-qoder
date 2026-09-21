import crypto from "node:crypto";
import { type Api, type Model, normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheQoderIdentityForTest, clearQoderAuthMemCache } from "../auth/oauth.js";
import { staticModels } from "../catalog.js";
import { streamQoder } from "../protocol/stream.js";

const model = staticModels.find((model) => model.id === "Lite") as Model<Api>;
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
function envelope(inner: unknown): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}
const text = (content: string) => envelope({ choices: [{ delta: { content } }] });
const success = `${text("OK")}data: [DONE]\n\n`;

function decodeBody(body: BodyInit | null | undefined): Record<string, unknown> {
  const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
  const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const encoded = Buffer.from(body as Uint8Array).toString("utf8");
  const rearranged = [...encoded].map((c) => (c === "$" ? "=" : standard[custom.indexOf(c)])).join("");
  const third = Math.floor(rearranged.length / 3);
  const base64 = rearranged.slice(-third) + rearranged.slice(third, -third) + rearranged.slice(0, third);
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function run(options: SimpleStreamOptions, selected = model) {
  return streamQoder(selected, context, { apiKey: "fake", ...options }).result();
}

describe("pi request contract", () => {
  it.each(["replace", "mutate"])("runs onPayload before signing (%s)", async (kind) => {
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_url, request) => {
      init = request;
      return new Response(success);
    }) as typeof globalThis.fetch;
    const onPayload = vi.fn(async (value: unknown) => {
      const payload = value as Record<string, unknown>;
      if (kind === "replace") return { ...payload, custom: "replacement" };
      payload.custom = "mutation";
      return undefined;
    });
    const result = await run({ fetch, onPayload });
    expect(result.stopReason).toBe("stop");
    expect(onPayload).toHaveBeenCalledWith(expect.any(Object), model);
    expect(decodeBody(init?.body).custom).toBe(kind === "replace" ? "replacement" : "mutation");
    const bytes = Buffer.from(init?.body as Uint8Array);
    const headers = new Headers(init?.headers);
    expect(headers.get("Cosy-Bodylength")).toBe(String(bytes.length));
    expect(headers.get("Cosy-Bodyhash")).toBe(crypto.createHash("md5").update(bytes).digest("hex"));
    const [, payload, signature] = (headers.get("Authorization") ?? "").split(".");
    const expected = crypto
      .createHash("md5")
      .update(`${payload}\n${headers.get("Cosy-Key")}\n${headers.get("Cosy-Date")}\n`)
      .update(bytes)
      .update(`\n${headers.get("Cosy-Sigpath")}`)
      .digest("hex");
    expect(signature).toBe(expected);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([200, 429])("invokes onResponse before consuming HTTP %s", async (status) => {
    const response = new Response(status === 200 ? success : "rate limited", {
      status,
      headers: { "X-Trace": "trace" },
    });
    let called = false;
    const result = await run({
      fetch: vi.fn(async () => response),
      onResponse: async (info, selected) => {
        expect(info).toMatchObject({ status, headers: { "x-trace": "trace" } });
        expect(selected).toBe(model);
        expect(response.bodyUsed).toBe(false);
        expect(response.body?.locked).toBe(false);
        called = true;
      },
    });
    expect(called).toBe(true);
    expect(result.stopReason).toBe(status === 200 ? "stop" : "error");
  });

  it("merges caller headers case-insensitively, supports deletion, and honors baseUrl", async () => {
    let url: unknown;
    let headers: Headers | undefined;
    const result = await run(
      {
        fetch: vi.fn(async (input, init) => {
          url = input;
          headers = new Headers(init?.headers);
          return new Response(success);
        }),
        headers: { "x-test": "caller", "cache-control": null, ACCEPT: "text/event-stream" },
      },
      { ...model, baseUrl: "https://proxy.example.test/qoder", headers: { "X-Test": "model" } },
    );
    expect(result.stopReason).toBe("stop");
    expect(String(url)).toMatch(/^https:\/\/proxy.example.test\/qoder\/algo\//);
    expect(headers?.get("x-test")).toBe("caller");
    expect(headers?.has("cache-control")).toBe(false);
    expect(headers?.get("accept")).toBe("text/event-stream");
    expect(headers?.get("Cosy-Sigpath")).toContain("/qoder/algo/");
  });

  it("uses injected fetch for identity as well as chat", async () => {
    clearQoderAuthMemCache();
    const fetch = vi.fn(async (input) =>
      String(input).includes("userinfo") ? new Response(JSON.stringify({ id: "user" })) : new Response(success),
    );
    expect((await run({ fetch })).stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("respects model maxTokens and zero temperature", async () => {
    let payload: Record<string, unknown> | undefined;
    await run(
      {
        fetch: vi.fn(async () => new Response(success)),
        maxTokens: 8000,
        temperature: 0,
        onPayload(value) {
          payload = value as Record<string, unknown>;
        },
      },
      { ...model, maxTokens: 4096 },
    );
    expect(payload?.parameters).toMatchObject({ max_tokens: 4096, temperature: 0 });
  });

  it("honors provider env over process env for delta coalescing", async () => {
    vi.stubEnv("QODER_STREAM_DELTA_INTERVAL_MS", "999999");
    const stream = streamQoder(model, context, {
      apiKey: "fake",
      fetch: vi.fn(async () => new Response(`${text("a")}${text("b")}data: [DONE]\n\n`)),
      env: { QODER_STREAM_DELTA_INTERVAL_MS: "0" },
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(2);
  });

  it("cleans up the response when onResponse throws", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const result = await run({
      fetch: vi.fn(async () => response),
      onResponse() {
        throw new Error("hook failure");
      },
    });
    expect(result.errorMessage).toBe("hook failure");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["onPayload", "onResponse"])("cancels a stalled %s hook", async (hook) => {
    const controller = new AbortController();
    const result = await run({
      signal: controller.signal,
      fetch: vi.fn(async () => new Response(success)),
      [hook]: () => {
        controller.abort(new Error("cancelled hook"));
        return new Promise(() => {});
      },
    });
    expect(result.stopReason).toBe("aborted");
  });

  it("does not send chat when onPayload rejects or returns an invalid payload", async () => {
    const fetch = vi.fn(async () => new Response(success));
    expect(
      (
        await run({
          fetch,
          onPayload() {
            throw new Error("payload hook failed");
          },
        })
      ).errorMessage,
    ).toBe("payload hook failed");
    expect((await run({ fetch, onPayload: () => null })).errorMessage).toContain("JSON object");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors provider-scoped idle timeout while an injected body stalls", async () => {
    vi.stubEnv("QODER_STREAM_IDLE_TIMEOUT_MS", "999999");
    const cancel = vi.fn();
    const result = await run({
      env: { QODER_STREAM_IDLE_TIMEOUT_MS: "10" },
      fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    });
    expect(result.errorMessage).toContain("idle timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("releases a stalled HTTP error body on timeout", async () => {
    const cancel = vi.fn();
    const result = await run({
      timeoutMs: 20,
      fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 500 })),
    });
    expect(result.errorMessage).toContain("timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not retry billable chat POSTs", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    expect((await run({ fetch, maxRetries: 3 })).stopReason).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds an injected fetch that ignores the abort signal", async () => {
    const result = await run({ timeoutMs: 10, fetch: vi.fn(() => new Promise<Response>(() => {})) });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("timeout");
  });

  it("cancels an open body and its pending delta timer", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = streamQoder(model, context, {
      apiKey: "fake",
      signal: controller.signal,
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(text("partial")));
              },
              cancel,
            }),
          ),
      ),
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text_start") controller.abort(new Error("cancelled"));
    }
    expect(events.at(-1)?.type).toBe("error");
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("derives totalTokens when upstream omits it", async () => {
    const result = await run({
      fetch: vi.fn(
        async () =>
          new Response(
            envelope({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) +
              "data: [DONE]\n\n",
          ),
      ),
    });
    expect(result.usage.totalTokens).toBe(12);
  });
});
