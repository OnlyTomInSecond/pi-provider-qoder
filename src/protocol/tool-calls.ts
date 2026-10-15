import type { AssistantMessage, AssistantMessageEventStream, JsonObject, ToolCall } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

export type ToolCallStreamEvent = Parameters<AssistantMessageEventStream["push"]>[0];

/**
 * A finished tool call's parsed arguments, plus pi's post-1.2.0 diagnostic.
 * `argumentsError` is set (with empty `arguments`) when the model's complete
 * arguments text was not a JSON object, so pi's `validateToolArguments` can
 * report the raw text back to the model instead of running a partial call.
 */
export type FinishedToolCallArguments = { arguments: JsonObject; argumentsError?: string };

/**
 * `argumentsError` and `parseToolCallArguments()` were added to pi-ai after
 * 1.2.0 (#10897). Probe the package entrypoint instead of importing it by name:
 * a named import of an export missing from a published 1.2.0 host throws at
 * module link time, while a namespace property read is simply `undefined`.
 *
 * When the host cannot carry the diagnostic, a finished call with `{}` would be
 * silently executed (only schema-required fields would fail), so the fallback
 * keeps failing the stream instead.
 */
function resolveHostParseFinishedArguments(): ((value: string) => FinishedToolCallArguments) | undefined {
  const candidate = (piAi as Record<string, unknown>).parseToolCallArguments;
  if (typeof candidate !== "function") return undefined;
  const parse = candidate as (json: string | undefined) => FinishedToolCallArguments;
  return (value) => parse(value);
}

/** Strict parse used when the host predates `argumentsError`; throws on bad text. */
function parseFinishedArgumentsStrictly(value: string): FinishedToolCallArguments {
  return { arguments: parseArguments(value) };
}

export type ToolCallDelta = {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart: boolean;
  emittedEnd: boolean;
  contentIndex: number;
}

/**
 * Reduces native OpenAI tool-call deltas and leaked DSML calls into the same
 * pi tool-call event sequence. Native indexes and DSML ids stay in separate
 * namespaces, while `ordered` preserves the order in which blocks appeared.
 */
export class ToolCallAccumulator {
  private readonly native = new Map<number, ToolCallState>();
  private readonly dsml = new Map<string, ToolCallState>();
  private readonly ordered: ToolCallState[] = [];

  constructor(
    private readonly output: AssistantMessage,
    private readonly emitEvent: (event: ToolCallStreamEvent) => void,
    /** Overridable for tests; defaults to the host's pi `parseToolCallArguments` when present. */
    private readonly parseFinished: (value: string) => FinishedToolCallArguments = defaultParseFinishedArguments,
  ) {}

  processNativeDelta(delta: ToolCallDelta): void {
    const index = delta.index ?? 0;
    let state = this.native.get(index);
    if (!state) {
      state = this.createState();
      this.native.set(index, state);
    }

    if (delta.id) state.id = delta.id;
    if (delta.function?.name) state.name = delta.function.name;
    this.openIfIdentifiable(state);
    if (state.emittedStart) {
      const block = this.output.content[state.contentIndex] as ToolCall;
      block.id = state.id;
      block.name = state.name;
    }

    if (delta.function?.arguments) {
      this.appendArguments(state, delta.function.arguments);
    }
  }

  startDsmlCall(id: string, name: string): void {
    const state = this.createState();
    state.id = id;
    state.name = name;
    this.dsml.set(id, state);
    this.openIfIdentifiable(state);
  }

  appendDsmlArguments(id: string, argumentsDelta: string): void {
    const state = this.dsml.get(id);
    if (state) this.appendArguments(state, argumentsDelta);
  }

  finalize(): boolean {
    // Validate the entire batch before exposing any completed executable call.
    const parsed = new Map<ToolCallState, FinishedToolCallArguments>();
    for (const state of this.ordered) {
      if (!state.emittedStart && !state.arguments) continue;
      if (!state.id || !state.name) throw new Error("Incomplete Qoder tool call identity");
      parsed.set(state, this.parseFinished(state.arguments));
    }
    for (const state of this.ordered) {
      if (!state.emittedStart || state.emittedEnd) continue;
      state.emittedEnd = true;
      const finished = parsed.get(state) ?? { arguments: {} };
      const block = this.output.content[state.contentIndex] as ToolCallWithArgumentsError;
      block.arguments = finished.arguments;
      if (finished.argumentsError) block.argumentsError = finished.argumentsError;
      const toolCall: ToolCallWithArgumentsError = {
        type: "toolCall",
        id: state.id,
        name: state.name,
        arguments: finished.arguments,
      };
      if (finished.argumentsError) toolCall.argumentsError = finished.argumentsError;
      this.emitEvent({
        type: "toolcall_end",
        contentIndex: state.contentIndex,
        toolCall,
        partial: this.output,
      });
    }
    return this.ordered.some((state) => state.emittedStart);
  }

  private createState(): ToolCallState {
    const state: ToolCallState = {
      arguments: "",
      id: "",
      name: "",
      emittedStart: false,
      emittedEnd: false,
      contentIndex: 0,
    };
    this.ordered.push(state);
    return state;
  }

  private openIfIdentifiable(state: ToolCallState): void {
    if (state.emittedStart || (!state.id && !state.name)) return;
    state.emittedStart = true;
    state.contentIndex = this.output.content.length;
    this.output.content.push({
      type: "toolCall",
      id: state.id,
      name: state.name,
      arguments: {},
    } satisfies ToolCall);
    this.emitEvent({ type: "toolcall_start", contentIndex: state.contentIndex, partial: this.output });

    // Native streams can send arguments before the id/name. Once the call is
    // identifiable, expose the accumulated prefix before accepting new bytes.
    if (state.arguments) {
      this.emitEvent({
        type: "toolcall_delta",
        contentIndex: state.contentIndex,
        delta: state.arguments,
        partial: this.output,
      });
    }
  }

  private appendArguments(state: ToolCallState, argumentsDelta: string): void {
    state.arguments += argumentsDelta;
    if (!state.emittedStart) return;
    this.emitEvent({
      type: "toolcall_delta",
      contentIndex: state.contentIndex,
      delta: argumentsDelta,
      partial: this.output,
    });
  }
}

/**
 * Local view of pi's ToolCall that also carries the post-1.2.0 `argumentsError`
 * field. The published 1.2.0 types do not declare it yet, and it is optional,
 * so widening here keeps the extension compiling against either host while
 * still emitting the field for hosts that understand it.
 */
type ToolCallWithArgumentsError = ToolCall & { argumentsError?: string };

const defaultParseFinishedArguments = resolveHostParseFinishedArguments() ?? parseFinishedArgumentsStrictly;

function parseArguments(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {}
  throw new Error("Invalid or truncated Qoder tool call arguments");
}
