import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamQoder } from "../protocol/stream.js";
import { loadLiveFixture } from "./live-fixture.js";

// Pin the identity so the mocked fetch below only ever serves the chat request.
// Without a resolved identity, streamQoder fetches /userinfo first and consumes
// the mock response, leaving the chat read to fail on a locked stream.
vi.mock("../auth/oauth.js", () => ({
  resolveQoderIdentity: vi.fn().mockResolvedValue({
    access: "fake",
    userID: "test-user",
    email: "test@example.com",
    name: "Test User",
    machineID: "test-machine",
    refresh: "",
    expires: 0,
  }),
}));

/**
 * Build a single SSE `data:` line carrying a Qoder envelope:
 *   { headers, body: <JSON string>, statusCodeValue, statusCode }
 * The server wraps the OpenAI-style chunk inside `body` as a JSON string.
 */
function sseEnvelope(body: object, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const DONE_SSE =
  "data:" +
  JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
    statusCode: "OK",
  }) +
  "\n\n";

function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

const SUCCESS_SSE = loadLiveFixture("global").interactions.chat.response.body as string;

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

function mockFetch(body: string): typeof fetch {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function makeModel(provider = "qoder", id = "Lite"): Model<Api> {
  return { id, api: "qoder-api" as Api, provider } as Model<Api>;
}

function makeContext(): TranscriptContext {
  // 0.86.0+ providers receive a normalized TranscriptContext where the system
  // prompt and tools live in a leading system message. normalizeContext folds
  // the legacy Context shape into that form, matching what pi passes at runtime.
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context);
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("streamQoder", () => {
  const originalFetch = globalThis.fetch;
  const originalCnPat = process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCnPat === undefined) delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    else process.env.QODERCN_PERSONAL_ACCESS_TOKEN = originalCnPat;
    vi.restoreAllMocks();
  });

  it("replays a recorded-format SSE fixture into text + stop", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("forwards tools and system prompt folded into the normalized transcript", async () => {
    // Regression for the 0.86.0 TranscriptContext migration: the system prompt
    // and tool declarations no longer arrive as top-level Context fields but as
    // a leading system message. The provider must read them back with
    // getCurrentSystemPrompt/getCurrentTools, or the model gets no tools and
    // cannot read files or run commands.
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const context = normalizeContext({
      systemPrompt: "you are helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    } as unknown as Context);

    await consume(streamQoder(makeModel("qoder", "Lite"), context, { apiKey: "fake" }));

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const encoded = Buffer.from(init?.body as Uint8Array).toString("utf8");
    const rearranged = [...encoded]
      .map((character) => (character === "$" ? "=" : standard[custom.indexOf(character)] || character))
      .join("");
    const third = Math.floor(rearranged.length / 3);
    const base64 =
      rearranged.slice(rearranged.length - third) +
      rearranged.slice(third, rearranged.length - third) +
      rearranged.slice(0, third);
    const body = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type: string; function: { name: string } }>;
    };

    expect(body.messages[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("read");
  });

  it("sends the internal upstream key for a friendly model id", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), { apiKey: "fake" }));

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    expect(init?.headers).toEqual(expect.objectContaining({ "X-Model-Key": "lite" }));

    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const encoded = Buffer.from(init?.body as Uint8Array).toString("utf8");
    const rearranged = [...encoded]
      .map((character) => (character === "$" ? "=" : standard[custom.indexOf(character)] || character))
      .join("");
    const third = Math.floor(rearranged.length / 3);
    const base64 =
      rearranged.slice(rearranged.length - third) +
      rearranged.slice(third, rearranged.length - third) +
      rearranged.slice(0, third);
    const body = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
      chat_context: { extra: { modelConfig: { key: string } } };
      model_config: { key: string };
    };
    expect(body.chat_context.extra.modelConfig.key).toBe("lite");
    expect(body.model_config.key).toBe("lite");
  });

  it("bounds long session ids to the upstream prompt cache key limit", async () => {
    const sessionId = `session-${"x".repeat(80)}`;
    const options = { apiKey: "fake", sessionId };

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), options));
    const firstInit = vi.mocked(globalThis.fetch).mock.calls[0][1];

    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const decodeBody = (init: RequestInit | undefined): { session_id: string } => {
      const encoded = Buffer.from(init?.body as Uint8Array).toString("utf8");
      const rearranged = [...encoded]
        .map((character) => (character === "$" ? "=" : standard[custom.indexOf(character)] || character))
        .join("");
      const third = Math.floor(rearranged.length / 3);
      const base64 =
        rearranged.slice(rearranged.length - third) +
        rearranged.slice(third, rearranged.length - third) +
        rearranged.slice(0, third);
      return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as { session_id: string };
    };
    const firstBody = decodeBody(firstInit);

    expect(firstBody.session_id.length).toBeLessThanOrEqual(64);
    expect(firstBody.session_id).toMatch(/^qoder-session-[0-9a-f]{16}$/);

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder", "Lite"), makeContext(), options));
    const secondInit = vi.mocked(globalThis.fetch).mock.calls[0][1];
    expect(decodeBody(secondInit).session_id).toBe(firstBody.session_id);
  });

  it("binds chat hosts to provider ids even when only a CN PAT is set", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-only";

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder"), makeContext(), { apiKey: "fake" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api3\.qoder\.sh\//),
      expect.any(Object),
    );

    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("qoder-cn", "Qwen3.7-Plus"), makeContext(), { apiKey: "fake" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/gateway\.qoder\.com\.cn\//),
      expect.any(Object),
    );
  });

  it("surfaces an upstream 406 'Session blocked' as an error event, not a silent stop", async () => {
    globalThis.fetch = mockFetch(BLOCKED_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    // Must NOT emit a silent done/stop.
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("preserves finish_reason=length instead of overwriting to stop", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("length");
  });

  it("captures usage, responseId and responseModel from the finish chunk", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          id: "chatcmpl-abc123",
          model: "qmodel_latest",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            completion_tokens_details: { reasoning_tokens: 3 },
            credits: 2.75,
            original_credits: 3.5,
            billable: true,
            // prompt_tokens (42) INCLUDES cached_tokens (5) per OpenAI
            // semantics; pi-core expects `input` to exclude them
            // (promptTokens = input + cacheRead + cacheWrite), so input =
            // 42 - 5 - 10 = 27. cacheable_tokens is a capacity metric, not a
            // write count, and must not be mapped to cacheWrite.
            prompt_tokens_details: { cacheable_tokens: 99, cache_write_tokens: 10, cached_tokens: 5 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.responseId).toBe("chatcmpl-abc123");
    expect(msg.responseModel).toBe("qmodel_latest");
    expect(msg.usage.input).toBe(27);
    expect(msg.usage.output).toBe(7);
    expect(msg.usage.totalTokens).toBe(49);
    expect(msg.usage.cacheRead).toBe(5);
    expect(msg.usage.cacheWrite).toBe(10);
    expect(msg.usage.reasoning).toBe(3);
    const qoderUsage = msg.usage as typeof msg.usage & {
      credits?: number;
      original_credits?: number;
      billable?: boolean;
    };
    expect(qoderUsage.credits).toBe(2.75);
    expect(qoderUsage.original_credits).toBe(3.5);
    expect(qoderUsage.billable).toBe(true);
  });

  it("does not invent zero Credits when usage omits Qoder billing fields", async () => {
    const sse = sseEnvelope(finishChunk("stop")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect("credits" in msg.usage).toBe(false);
    expect("original_credits" in msg.usage).toBe(false);
    expect("billable" in msg.usage).toBe(false);
  });

  it("coalesces consecutive text deltas without changing the final content", async () => {
    const sse =
      sseEnvelope(chunk({ content: "a", role: "assistant" })) +
      sseEnvelope(chunk({ content: "b" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const textDeltas = events.filter((event) => event.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0] && "delta" in textDeltas[0] ? textDeltas[0].delta : "").toBe("ab");
  });

  it("keeps many ordinary reasoning chunks intact without DSML markup", async () => {
    const reasoning = Array.from({ length: 200 }, (_, index) => `thought-${index} `).join("");
    const sse =
      Array.from({ length: 200 }, (_, index) => sseEnvelope(chunk({ reasoning_content: `thought-${index} ` }))).join(
        "",
      ) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([{ type: "thinking", thinking: reasoning }]);
  });

  it("coalesces a fast burst of reasoning deltas into a single event", async () => {
    // A huge throttle window makes the coalescing deterministic: all consecutive
    // reasoning deltas must merge until the next ordering boundary (thinking_end).
    process.env.QODER_STREAM_DELTA_INTERVAL_MS = "100000";
    try {
      const reasoning = Array.from({ length: 200 }, (_, index) => `thought-${index} `).join("");
      const sse =
        Array.from({ length: 200 }, (_, index) => sseEnvelope(chunk({ reasoning_content: `thought-${index} ` }))).join(
          "",
        ) +
        sseEnvelope(finishChunk("stop")) +
        DONE_SSE;
      globalThis.fetch = mockFetch(sse);

      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
      const deltas = events.filter((event) => event.type === "thinking_delta");
      const streamed = deltas.reduce((acc, event) => acc + ("delta" in event ? event.delta.length : 0), 0);

      // The host re-renders the whole block per delta, so the burst must not
      // produce one event per chunk.
      expect(deltas.length).toBeLessThanOrEqual(2);
      expect(streamed).toBe(reasoning.length);

      const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
      expect(done.message.content).toEqual([{ type: "thinking", thinking: reasoning }]);
    } finally {
      delete process.env.QODER_STREAM_DELTA_INTERVAL_MS;
    }
  });

  it("finishes a large buffered SSE response without a parser loop", async () => {
    const sse =
      Array.from({ length: 100 }, () => sseEnvelope(chunk({ content: "x", role: "assistant" }))).join("") + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const text = msg.content.find((content) => content.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("x".repeat(100));
  });

  it("emits a done event with reason=length when finish_reason is length", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    expect((done as { reason: string }).reason).toBe("length");
  });

  it("reports a tool_use stop reason when the stream emits tool calls", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("toolUse");
    const toolCall = msg.content.find((c) => c.type === "toolCall");
    expect(toolCall).toBeDefined();
  });

  it("assembles reasoning chunks before the final answer", async () => {
    const sse =
      sseEnvelope(chunk({ reasoning_content: "check " })) +
      sseEnvelope(chunk({ reasoning_content: "twice" })) +
      sseEnvelope(chunk({ content: "done" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "check twice" },
      { type: "text", text: "done" },
    ]);
    expect(events.map((event) => event.type)).toContain("thinking_delta");
  });

  it("keeps summary reasoning and leaked DSML calls out of visible text", async () => {
    const thought = "And checkSignalValByByte in the new code... let me look at what it actually is.";
    const answer = "好，这是 CS 路由，涉及信号值的验证，流程更复杂。";
    const token = "｜DSML｜";
    const dsml =
      `<${token}tool_calls>\n<${token}invoke name="read">\n` +
      `<${token}parameter name="limit" string="false">20</${token}parameter>\n` +
      `<${token}parameter name="offset" string="false">238</${token}parameter>\n` +
      `<${token}parameter name="path"\n string="true">/home/whh/src/capl_platform/capl/test/test_canroute/canroute_fun.cin</${token}parameter>\n` +
      `</${token}invoke>\n</${token}tool_calls>`;
    const split = Math.floor(dsml.length / 2);
    const sse =
      sseEnvelope(chunk({ reasoning_content: `<summary>${thought}` })) +
      sseEnvelope(chunk({ content: `</summary>\n\n${answer}\n\n${dsml.slice(0, split)}` })) +
      sseEnvelope(chunk({ content: dsml.slice(split) })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: thought },
      { type: "text", text: `${answer}\n\n` },
      {
        type: "toolCall",
        id: "dsml_call_0",
        name: "read",
        arguments: {
          limit: 20,
          offset: 238,
          path: "/home/whh/src/capl_platform/capl/test/test_canroute/canroute_fun.cin",
        },
      },
    ]);
    const visibleText = done.message.content
      .filter(
        (content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text",
      )
      .map((content) => content.text)
      .join("");
    expect(visibleText).not.toContain("</summary>");
    expect(visibleText).not.toContain("DSML");
    expect(done.message.stopReason).toBe("toolUse");
  });

  it("assembles parallel tool calls by their stream indexes", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", function: { name: "read", arguments: '{"path":' } },
            { index: 1, id: "call_b", function: { name: "search", arguments: '{"query":' } },
          ],
        }),
      ) +
      sseEnvelope(
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: '"/a"}' } },
            { index: 1, function: { arguments: '"needle"}' } },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const calls = done.message.content.filter((block): block is ToolCall => block.type === "toolCall");

    expect(calls).toEqual([
      { type: "toolCall", id: "call_a", name: "read", arguments: { path: "/a" } },
      { type: "toolCall", id: "call_b", name: "search", arguments: { query: "needle" } },
    ]);
  });

  it("keeps tagged thinking event indexes stable after streamed text", async () => {
    const sse =
      sseEnvelope(chunk({ content: "prefix <thinking>reason</thinking> answer" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const textDelta = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
        event.type === "text_delta" && event.delta.includes("prefix"),
    );
    const thinkingDelta = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
        event.type === "thinking_delta" && event.delta === "reason",
    );

    expect(done.message.content).toEqual([
      { type: "text", text: "prefix " },
      { type: "thinking", thinking: "reason" },
      { type: "text", text: " answer" },
    ]);
    expect(textDelta?.contentIndex).toBe(0);
    expect(thinkingDelta?.contentIndex).toBe(1);
    expect(done.message.content[textDelta?.contentIndex ?? -1]?.type).toBe("text");
    expect(done.message.content[thinkingDelta?.contentIndex ?? -1]?.type).toBe("thinking");
  });

  it("recovers thinking after content when the upstream switches channels", async () => {
    const sse =
      sseEnvelope(chunk({ reasoning_content: "first thought" })) +
      sseEnvelope(chunk({ content: "answer" })) +
      sseEnvelope(chunk({ reasoning_content: "second thought" })) +
      sseEnvelope(chunk({ content: " more" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "first thought" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "second thought" },
      { type: "text", text: " more" },
    ]);
  });

  it("preserves text emitted before and after a tool call", async () => {
    const sse =
      sseEnvelope(chunk({ content: "before" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] })) +
      sseEnvelope(chunk({ content: " after" })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "text", text: "before after" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
  });

  it("emits a tool call that arrives with no arguments", async () => {
    // A no-argument tool, or a model that sends id+name and stops. The block
    // used to be created only inside `if (tc.function?.arguments)`, so this
    // produced a toolCallsState entry and NO content block — and the finalizer
    // then set stopReason "toolUse" on a message with no tool call in it. pi's
    // agent loop had nothing to execute and the turn ended silently, mid-task.
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "advisor", arguments: "" } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall, "a named tool call must reach the message even with no arguments").toBeDefined();
    expect(toolCall?.name).toBe("advisor");
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.arguments).toEqual({});
    expect(msg.stopReason).toBe("toolUse");
  });

  it("picks up an id and name that arrive after the block is open", async () => {
    // Streamed the other way round: arguments first, identity later.
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: 'and":"ls"}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.id).toBe("call_9");
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
  });

  it("does not claim toolUse when no tool call reached the message", async () => {
    // A malformed stream: a tool_calls delta with neither id nor name. Better a
    // clean "stop" than a message that says toolUse and carries nothing, which
    // the agent loop cannot act on and cannot report.
    const sse =
      sseEnvelope(chunk({ content: "thinking about it", role: "assistant" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: {} }] })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.content.find((c) => c.type === "toolCall")).toBeUndefined();
    expect(msg.stopReason).toBe("stop");
  });
  it("finishes when the gateway sends [DONE] but keeps the body open", async () => {
    // Qoder's gateway does not always close the HTTP body after the sentinel.
    // The read loop used to keep awaiting reader.read() until the socket went
    // away, so a fully streamed reply never produced a done event and the
    // agent appeared to hang with no error.
    const sse = sseEnvelope(chunk({ content: "OK", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        // Deliberately never call controller.close().
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event even though the body stayed open").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
    // The reader is released rather than left holding the connection.
    expect(cancelled).toBe(true);
  });

  it("finishes on a bare 'data: [DONE]' line with the body left open", async () => {
    // Same sentinel, unwrapped.
    const sse = `${sseEnvelope(chunk({ content: "hi", role: "assistant" }))}data: [DONE]\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event for the bare sentinel").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("hi");
  });

  it("rejects an unbounded SSE line and cancels its reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(8 * 1024 * 1024)}`));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.errorMessage).toMatch(/SSE buffer exceeded/);
    expect(cancelled).toBe(true);
  });

  it("does not start request construction after a pre-abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before request"));
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const events = await consume(
      streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }),
    );
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };

    expect(error.error.stopReason).toBe("aborted");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports aborted when the request is cancelled before streaming starts", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    const eventsPromise = consume(
      streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }),
    );
    controller.abort();
    const events = await eventsPromise;

    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.stopReason).toBe("aborted");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("aborts an idle SSE response and releases its reader", async () => {
    const originalTimeout = process.env.QODER_STREAM_IDLE_TIMEOUT_MS;
    process.env.QODER_STREAM_IDLE_TIMEOUT_MS = "10";
    try {
      let cancelled = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          cancelled = true;
        },
      });
      globalThis.fetch = vi.fn(async (_input, init) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            cancelled = true;
            bodyController?.error(init.signal?.reason);
          },
          { once: true },
        );
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch;

      const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
      expect(error.error.errorMessage).toMatch(/idle timeout/);
      expect(cancelled).toBe(true);
    } finally {
      if (originalTimeout === undefined) delete process.env.QODER_STREAM_IDLE_TIMEOUT_MS;
      else process.env.QODER_STREAM_IDLE_TIMEOUT_MS = originalTimeout;
    }
  });

  it("converts leaked DSML content into a tool call", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const sse =
      sseEnvelope(chunk({ content: dsml.slice(0, 19) })) +
      sseEnvelope(chunk({ content: dsml.slice(19) })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const toolCall = done.message.content.find((content): content is ToolCall => content.type === "toolCall");

    expect(toolCall).toEqual({
      type: "toolCall",
      id: "dsml_call_0",
      name: "bash",
      arguments: { command: "ls" },
    });
    expect(done.message.content.find((content) => content.type === "text")).toBeUndefined();
    expect(done.message.stopReason).toBe("toolUse");
  });

  it("parses DSML tool markup leaked through reasoning_content", async () => {
    // Some Qoder models dump the whole tool call into the reasoning_content
    // channel. It must become a real tool call, not literal tags inside the
    // thinking block (and any real reasoning ahead of it still shows up).
    const thought = "I should list the files.";
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const split = Math.floor(dsml.length / 2);
    const sse =
      sseEnvelope(chunk({ reasoning_content: `${thought}\n\n${dsml.slice(0, split)}` })) +
      sseEnvelope(chunk({ reasoning_content: dsml.slice(split) })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: `${thought}\n\n` },
      { type: "toolCall", id: "dsml_call_0", name: "bash", arguments: { command: "ls" } },
    ]);
    expect(done.message.stopReason).toBe("toolUse");
  });

  it("flushes content thinking before a DSML tool call", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const sse =
      sseEnvelope(chunk({ content: "<thinking>reason<" })) +
      sseEnvelope(chunk({ content: dsml })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };

    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "reason<" },
      { type: "toolCall", id: "dsml_call_0", name: "bash", arguments: { command: "ls" } },
    ]);
  });

  it("keeps DSML and native tool-call state isolated", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    const sse =
      sseEnvelope(chunk({ content: dsml })) +
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "native_1", function: { name: "search", arguments: '{"q":"x"}' } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const toolCalls = done.message.content.filter((content): content is ToolCall => content.type === "toolCall");

    expect(toolCalls).toEqual([
      { type: "toolCall", id: "dsml_call_0", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "native_1", name: "search", arguments: { q: "x" } },
    ]);
    expect(done.message.stopReason).toBe("toolUse");
  });
});
