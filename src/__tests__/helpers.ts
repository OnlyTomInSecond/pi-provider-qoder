/**
 * Shared stream-test scaffolding: the Qoder SSE envelope, request-body decoding
 * and the small pi-ai fixtures every protocol suite used to redefine.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";

/**
 * One SSE `data:` line carrying a Qoder envelope:
 *   { headers, body: <JSON string>, statusCodeValue, statusCode }
 * The server wraps the OpenAI-style chunk inside `body` as a JSON string.
 */
export function sseEnvelope(body: unknown, statusCodeValue = 200, statusCode = "OK"): string {
  const inner = typeof body === "string" ? body : JSON.stringify(body);
  return `data:${JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: inner,
    statusCodeValue,
    statusCode,
  })}\n\n`;
}

export const DONE_SSE = sseEnvelope("[DONE]");

export function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

export function finishChunk(finishReason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason: finishReason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

export function makeModel(provider = "qoder", id = "Lite"): Model<Api> {
  return { id, api: "qoder-api" as Api, provider } as Model<Api>;
}

export function makeContext(): TranscriptContext {
  // Providers receive a normalized TranscriptContext where the system prompt and
  // tools live in a leading system message. normalizeContext folds the legacy
  // Context shape into that form, matching what pi passes at runtime.
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context);
}

export async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  return events;
}

/** Undo the gateway's custom base64 alphabet so a request body can be asserted. */
export function decodeQoderBody(init: RequestInit | undefined): Record<string, unknown> {
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
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as Record<string, unknown>;
}

export function doneOf(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.find((event) => event.type === "done");
  if (!done) throw new Error("expected a done event");
  return (done as Extract<AssistantMessageEvent, { type: "done" }>).message;
}

export function errorOf(events: AssistantMessageEvent[]): AssistantMessage {
  const error = events.find((event) => event.type === "error");
  if (!error) throw new Error("expected an error event");
  return (error as Extract<AssistantMessageEvent, { type: "error" }>).error;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Minimal assistant message: empty content, zero usage. */
export function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as AssistantMessage["api"],
    provider: "qoder",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 0,
    ...overrides,
  };
}

/** Drain background microtasks without sleeps or a live network. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
