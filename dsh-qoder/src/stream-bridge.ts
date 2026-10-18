/**
 * Mapping from pi-ai's assistant event protocol to the harness StreamChunk
 * vocabulary. The Qoder protocol layer emits pi events; this is the only place
 * that knows the harness wire shape.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface BridgeFailure {
  readonly message: string;
  readonly code: string;
}

/** Error carrying the harness-normalized failure facts. */
export class QoderStreamError extends Error {
  readonly code: string;
  readonly failure: BridgeFailure;

  constructor(message: string, code = "PROVIDER_ERROR") {
    super(message);
    this.name = "QoderStreamError";
    this.code = code;
    this.failure = { message, code };
  }
}

type Chunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: Record<string, unknown> }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "finish"; reason: Record<string, unknown> };

function usageOf(message: { usage?: unknown } | undefined): Record<string, number> {
  const usage = message?.usage && typeof message.usage === "object"
    ? (message.usage as Record<string, unknown>)
    : {};
  const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);
  return {
    inputTokens: number(usage.input),
    outputTokens: number(usage.output),
    totalTokens: number(usage.totalTokens ?? number(usage.input) + number(usage.output)),
    cacheReadTokens: number(usage.cacheRead),
    cacheWriteTokens: number(usage.cacheWrite),
    ...(typeof usage.reasoning === "number" && usage.reasoning >= 0 ? { reasoningTokens: usage.reasoning } : {}),
  };
}

function finishReason(reason: string): Record<string, unknown> {
  switch (reason) {
    case "length":
      return { kind: "max-tokens" };
    case "toolUse":
      return { kind: "tool-calls" };
    case "aborted":
      return { kind: "aborted", failure: { message: "Qoder request aborted", code: "ABORTED" } };
    case "error":
      return { kind: "error", failure: { message: "Qoder generation failed", code: "PROVIDER_ERROR" } };
    default:
      return { kind: "stop" };
  }
}

/**
 * Convert one pi assistant event stream into harness chunks.
 * @param events - events yielded by `streamQoder`.
 * @param signal - the caller's cancellation signal, used to classify an abort.
 * @returns the harness chunk stream.
 */
export async function* bridgeStream(
  events: AsyncIterable<AssistantMessageEvent>,
  signal?: AbortSignal,
): AsyncGenerator<Chunk> {
  const started = new Set<number>();
  const ended = new Set<number>();
  let terminal = false;

  for await (const event of events) {
    if (signal?.aborted) throw new QoderStreamError("Qoder request aborted", "ABORTED");
    switch (event.type) {
      case "start":
        break;
      case "text_start":
        if (!started.has(event.contentIndex)) {
          started.add(event.contentIndex);
          yield { type: "block-start", index: event.contentIndex, blockType: "text" };
        }
        break;
      case "text_delta":
        if (!started.has(event.contentIndex)) {
          started.add(event.contentIndex);
          yield { type: "block-start", index: event.contentIndex, blockType: "text" };
        }
        yield { type: "text-delta", index: event.contentIndex, text: event.delta };
        break;
      case "text_end":
        if (!ended.has(event.contentIndex)) {
          ended.add(event.contentIndex);
          yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
        }
        break;
      case "thinking_start":
        if (!started.has(event.contentIndex)) {
          started.add(event.contentIndex);
          yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
        }
        break;
      case "thinking_delta":
        if (!started.has(event.contentIndex)) {
          started.add(event.contentIndex);
          yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
        }
        yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
        break;
      case "thinking_end":
        if (!ended.has(event.contentIndex)) {
          ended.add(event.contentIndex);
          yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
        }
        break;
      case "toolcall_start": {
        if (!started.has(event.contentIndex)) {
          started.add(event.contentIndex);
          yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
        }
        break;
      }
      case "toolcall_delta": {
        const block = event.partial.content[event.contentIndex] as { id?: string; name?: string } | undefined;
        yield {
          type: "tool-call-delta",
          index: event.contentIndex,
          id: block?.id || "call_unknown",
          name: block?.name,
          argumentsDelta: event.delta,
        };
        break;
      }
      case "toolcall_end": {
        if (!ended.has(event.contentIndex)) {
          ended.add(event.contentIndex);
          const toolCall = event.toolCall;
          yield {
            type: "block-end",
            index: event.contentIndex,
            block: {
              type: "tool-call",
              id: toolCall.id,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments ?? {}),
            },
          };
        }
        break;
      }
      case "done": {
        terminal = true;
        yield { type: "usage", usage: usageOf(event.message) };
        yield { type: "finish", reason: finishReason(event.reason) };
        return;
      }
      case "error": {
        terminal = true;
        const message = event.error.errorMessage || "Qoder generation failed";
        if (event.reason === "aborted" || signal?.aborted) throw new QoderStreamError("Qoder request aborted", "ABORTED");
        throw new QoderStreamError(message, "PROVIDER_ERROR");
      }
      default:
        break;
    }
  }

  if (!terminal) throw new QoderStreamError("Qoder stream ended before a terminal event", "PROVIDER_ERROR");
}

