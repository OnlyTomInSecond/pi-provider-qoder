import type { AssistantMessage, AssistantMessageEventStream, JsonObject, ToolCall } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { repairJsonEscapes } from "./json-repair.js";

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
 * repairs escape damage and still fails the stream when the text is not
 * recoverable (see {@link parseFinishedArguments}).
 */
function resolveHostParseFinishedArguments(): ((value: string) => FinishedToolCallArguments) | undefined {
  const candidate = (piAi as Record<string, unknown>).parseToolCallArguments;
  if (typeof candidate !== "function") return undefined;
  const parse = candidate as (json: string | undefined) => FinishedToolCallArguments;
  return (value) => parse(value);
}

/**
 * Parse used when the host predates `argumentsError`; throws on bad text.
 *
 * Illegal escapes and raw control characters inside string literals are
 * re-escaped first, because those describe a *complete* argument object that
 * `JSON.parse` alone cannot read (see `json-repair.ts`). Structure is never
 * repaired: a call cut off by the output limit still throws.
 */
export function parseFinishedArguments(value: string): FinishedToolCallArguments {
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
  /**
   * Native deltas identify a call by `index`, by `id`, or (for argument-only
   * continuations) by neither. Keying only on `index` merged two parallel calls
   * whose adapter omitted the index and let a reused index overwrite another
   * call's identity, so keep an index and an id index and reconcile them.
   */
  private readonly byIndex = new Map<number, ToolCallState>();
  private readonly byId = new Map<string, ToolCallState>();
  private readonly dsml = new Map<string, ToolCallState>();
  private readonly ordered: ToolCallState[] = [];

  constructor(
    private readonly output: AssistantMessage,
    private readonly emitEvent: (event: ToolCallStreamEvent) => void,
    /** Overridable for tests; defaults to the host's pi `parseToolCallArguments` when present. */
    private readonly parseFinished: (value: string) => FinishedToolCallArguments = defaultParseFinishedArguments,
  ) {}

  processNativeDelta(delta: ToolCallDelta): void {
    const index = typeof delta.index === "number" ? delta.index : undefined;
    const id = typeof delta.id === "string" ? delta.id : "";
    const name = typeof delta.function?.name === "string" ? delta.function.name : "";
    const argumentsDelta = argumentsText(delta.function?.arguments);

    let state = id ? this.byId.get(id) : undefined;

    if (index !== undefined) {
      const indexed = this.byIndex.get(index);
      // An explicit ID always wins over the index. A *different* identified
      // state already holding this index means the adapter reused it, so rebind
      // instead of merging two calls' arguments.
      if (!state) state = indexed;
      if (state && indexed && indexed !== state && indexed.id && !state.id) {
        state = indexed;
      }
    } else if (!state) {
      // Argument-only continuation without index or id: only an unambiguous
      // single open call can own it.
      const open = this.ordered.filter((candidate) => !candidate.emittedEnd);
      if (open.length > 1) {
        throw new Error(`Ambiguous tool-call continuation (candidates=${open.length})`);
      }
      state = open[0];
    }

    if (!state) state = this.createState();

    if (id && state.id && state.id !== id) {
      // A new explicit identity on an already-identified state: only a fresh
      // block may take it (the previous call keeps its own id).
      state = this.createState();
    }
    if (name && state.name && state.name !== name) {
      throw new Error("Tool-call identity conflict: inconsistent name");
    }

    if (id) {
      state.id = id;
      this.byId.set(id, state);
    }
    if (index !== undefined && this.byIndex.get(index) !== state) {
      this.byIndex.set(index, state);
    }
    if (name) state.name = name;
    this.openIfIdentifiable(state);
    if (state.emittedStart) {
      const block = this.output.content[state.contentIndex] as ToolCall;
      block.id = state.id;
      block.name = state.name;
    }

    if (argumentsDelta) this.appendArguments(state, argumentsDelta);
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
      if (!state.id || !state.name)
        throw new Error(`Unresolved Qoder tool-call identity (characters=${state.arguments.length})`);
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

const defaultParseFinishedArguments = resolveHostParseFinishedArguments() ?? parseFinishedArguments;

/**
 * Normalize a streamed argument fragment to text.
 *
 * `function.arguments` is typed as a string, but the gateway occasionally
 * delivers an already-parsed JSON value. Concatenating that would accumulate
 * "[object Object]" and fail with the same "truncated" diagnostic as a real
 * cut-off, so serialize objects instead of stringifying them by accident.
 */
function argumentsText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return String(value);
}

function parseArguments(value: string): JsonObject {
  const parsed = parseJsonObject(value);
  if (parsed) return parsed;

  // Only pay for a second parse when the repair actually changed something.
  const repaired = repairJsonEscapes(value);
  if (repaired !== value) {
    const repairedObject = parseJsonObject(repaired);
    if (repairedObject) return repairedObject;
  }

  throw new Error("Invalid or truncated Qoder tool call arguments");
}

/** Parse finished argument text as a JSON object, or return null. */
function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {}
  return null;
}
