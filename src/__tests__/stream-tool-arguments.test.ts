import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Override the host parser so this integration test stays independent of the
// installed pi-ai version: whatever the host exposes, the plugin must forward
// the diagnostic it reports.
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    ...actual,
    parseToolCallArguments: (json: string | undefined) => ({
      arguments: {},
      argumentsError: `host reported: ${json ?? ""}`,
    }),
  };
});

// Pin identity so the mocked fetch only serves the chat request.
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

const { normalizeContext } = await import("@earendil-works/pi-ai");
const { streamQoder } = await import("../protocol/stream.js");

function sseEnvelope(body: object): string {
  return `data:${JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body: JSON.stringify(body), statusCodeValue: 200, statusCode: "OK" })}\n\n`;
}

const DONE_SSE = `data:${JSON.stringify({ body: "[DONE]", statusCodeValue: 200, statusCode: "OK" })}\n\n`;

function chunk(delta: object): object {
  return { choices: [{ delta, index: 0 }], created: 1, id: "id", model: "auto", object: "chat.completion.chunk" };
}

function finishChunk(finish_reason: string): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  };
}

function makeModel(): Model<Api> {
  return { id: "Lite", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Parameters<typeof normalizeContext>[0]);
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  return events;
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        sseEnvelope(
          chunk({ tool_calls: [{ index: 0, id: "call", function: { name: "bash", arguments: '{"command":' } }] }),
        ) +
          sseEnvelope(finishChunk("tool_calls")) +
          DONE_SSE,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("streamQoder finished tool arguments", () => {
  it("forwards the host's argumentsError instead of failing the turn", async () => {
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" } as SimpleStreamOptions));
    expect(events.at(-1)?.type).toBe("done");

    const end = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
    );
    expect(end?.toolCall).toMatchObject({
      type: "toolCall",
      id: "call",
      name: "bash",
      arguments: {},
      argumentsError: expect.stringContaining("host reported"),
    });

    const message = (events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message;
    expect(message.stopReason).toBe("toolUse");
    expect(message.content[0]).toMatchObject({ type: "toolCall", arguments: {}, argumentsError: expect.any(String) });
    // Never hand pi a partially parsed tool call.
    expect(message.content[0]).not.toHaveProperty("arguments.command");
  });
});
