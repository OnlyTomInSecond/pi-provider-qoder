export type DsmlParserEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_arguments"; id: string; arguments: string };

// Qoder has emitted both the full-width marker used by Qwen and the ASCII
// spelling used by some gateway/model combinations. Keep both forms in the
// state machine so a marker split at any character boundary is still held.
const DSML_TOKENS = ["｜DSML｜", "|DSML|"] as const;
const WRAPPER_STARTS = DSML_TOKENS.flatMap((token) => [`<${token}tool_calls>`, `<${token}function_calls>`]);
const WRAPPER_ENDS = DSML_TOKENS.flatMap((token) => [`</${token}tool_calls>`, `</${token}function_calls>`]);
const INVOKE_PREFIXES = DSML_TOKENS.map((token) => `<${token}invoke`);
const FUNCTION_PREFIXES = DSML_TOKENS.map((token) => `<${token}function`);
const CALL_PREFIXES = [...INVOKE_PREFIXES, ...FUNCTION_PREFIXES];
const PARAMETER_PREFIXES = DSML_TOKENS.map((token) => `<${token}parameter`);

export const MAX_DSML_BUFFER_LENGTH = 8 * 1024 * 1024;

interface CurrentCall {
  id: string;
  name: string;
  endTag: string;
  parameters: Map<string, string>;
}

type ParserState = "text" | "wrapper" | "call";

/**
 * Incrementally converts DeepSeek-style DSML tool calls to provider-neutral
 * events. The gateway normally converts these to OpenAI `delta.tool_calls`,
 * but some model/gateway combinations leak the raw markup through
 * `delta.content` instead.
 */
export class DsmlToolCallParser {
  private state: ParserState = "text";
  private buffer = "";
  private rawStart = "";
  private currentCall: CurrentCall | undefined;
  private callNumber = 0;

  processChunk(chunk: string): DsmlParserEvent[] {
    if (!chunk) return [];
    if (this.rawStart.length + this.buffer.length + chunk.length > MAX_DSML_BUFFER_LENGTH) {
      throw new Error(`Qoder DSML buffer exceeded ${MAX_DSML_BUFFER_LENGTH} characters`);
    }
    this.buffer += chunk;
    return this.drain();
  }

  finalize(): DsmlParserEvent[] {
    const events = this.drain(true);
    if (this.buffer) {
      events.push({ type: "text", text: this.rawStart + this.buffer });
    } else if (this.rawStart) {
      events.push({ type: "text", text: this.rawStart });
    }
    this.buffer = "";
    this.rawStart = "";
    this.currentCall = undefined;
    this.state = "text";
    return events;
  }

  private drain(final = false): DsmlParserEvent[] {
    const events: DsmlParserEvent[] = [];

    while (this.buffer) {
      if (this.state === "text") {
        const start = findFirst(this.buffer, WRAPPER_STARTS);
        if (start.index === -1) {
          const keep = final ? 0 : longestMarkerSuffix(this.buffer, WRAPPER_STARTS);
          const textLength = this.buffer.length - keep;
          if (textLength > 0) {
            events.push({ type: "text", text: this.buffer.slice(0, textLength) });
            this.buffer = this.buffer.slice(textLength);
          }
          break;
        }

        if (start.index > 0) {
          events.push({ type: "text", text: this.buffer.slice(0, start.index) });
        }
        this.rawStart = start.value;
        this.buffer = this.buffer.slice(start.index + start.value.length);
        this.state = "wrapper";
        continue;
      }

      if (this.state === "wrapper") {
        this.consumeWhitespace();
        const wrapperEnd = findFirst(this.buffer, WRAPPER_ENDS);
        if (wrapperEnd.index === 0) {
          this.buffer = this.buffer.slice(wrapperEnd.value.length);
          this.state = "text";
          this.rawStart = "";
          continue;
        }

        const prefix = startsWithAny(this.buffer, CALL_PREFIXES);
        if (prefix) {
          const close = this.buffer.indexOf(">");
          if (close === -1) break;

          const header = this.buffer.slice(0, close + 1);
          const match = parseCallHeader(header);
          if (!match) {
            this.fallback(events);
            continue;
          }

          const id = `dsml_call_${this.callNumber++}`;
          this.currentCall = {
            id,
            name: match.name,
            endTag: `</${match.token}${match.kind}>`,
            parameters: new Map(),
          };
          this.buffer = this.buffer.slice(header.length);
          this.state = "call";
          events.push({ type: "tool_start", id, name: match.name });
          continue;
        }

        if (!final && isPartialPrefix(this.buffer, [...WRAPPER_ENDS, ...CALL_PREFIXES])) break;
        this.fallback(events);
        continue;
      }

      const call = this.currentCall;
      if (!call) {
        this.fallback(events);
        continue;
      }

      this.consumeWhitespace();
      if (this.buffer.startsWith(call.endTag)) {
        this.buffer = this.buffer.slice(call.endTag.length);
        const args = serializeParameters(call.parameters);
        events.push({ type: "tool_arguments", id: call.id, arguments: args });
        this.currentCall = undefined;
        this.state = "wrapper";
        continue;
      }

      if (startsWithAny(this.buffer, PARAMETER_PREFIXES)) {
        const openingEnd = this.buffer.indexOf(">");
        if (openingEnd === -1) break;
        const opening = this.buffer.slice(0, openingEnd + 1);
        const match = parseParameterHeader(opening);
        if (!match) {
          this.fallback(events);
          continue;
        }

        const parameterEnd = `</${match.token}parameter>`;
        const closing = this.buffer.indexOf(parameterEnd, opening.length);
        if (closing === -1) break;
        const value = this.buffer.slice(opening.length, closing);
        if (call.parameters.has(match.name)) {
          this.fallback(events);
          continue;
        }

        const encoded = encodeParameterValue(value, match.isString);
        if (encoded === undefined) {
          this.fallback(events);
          continue;
        }
        call.parameters.set(match.name, encoded);
        this.buffer = this.buffer.slice(closing + parameterEnd.length);
        continue;
      }

      if (!final && isPartialPrefix(this.buffer, [call.endTag, ...PARAMETER_PREFIXES])) break;
      this.fallback(events);
    }

    return events;
  }

  private consumeWhitespace(): void {
    const trimmed = this.buffer.trimStart();
    this.buffer = trimmed;
  }

  private fallback(events: DsmlParserEvent[]): void {
    events.push({ type: "text", text: this.rawStart + this.buffer });
    this.buffer = "";
    this.rawStart = "";
    this.currentCall = undefined;
    this.state = "text";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Header patterns are rebuilt on every chunk that contains a DSML tool call or
// parameter. Precompile them once per marker token at module load.
const CALL_HEADER_PATTERNS = DSML_TOKENS.map(
  (token) => new RegExp(`^<${escapeRegExp(token)}(invoke|function)\\s+name="([^"]*)">$`),
);
const PARAMETER_HEADER_PATTERNS = DSML_TOKENS.map(
  (token) => new RegExp(`^<${escapeRegExp(token)}parameter\\s+name="([^"]+)"\\s+string="(true|false)">$`),
);

function parseCallHeader(header: string): { token: string; kind: "invoke" | "function"; name: string } | undefined {
  for (let index = 0; index < DSML_TOKENS.length; index++) {
    const match = CALL_HEADER_PATTERNS[index].exec(header);
    if (match) return { token: DSML_TOKENS[index], kind: match[1] as "invoke" | "function", name: match[2] };
  }
  return undefined;
}

function parseParameterHeader(header: string): { token: string; name: string; isString: boolean } | undefined {
  for (let index = 0; index < DSML_TOKENS.length; index++) {
    const match = PARAMETER_HEADER_PATTERNS[index].exec(header);
    if (match) return { token: DSML_TOKENS[index], name: match[1], isString: match[2] === "true" };
  }
  return undefined;
}

function encodeParameterValue(value: string, isString: boolean): string | undefined {
  if (isString) return JSON.stringify(value);
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function serializeParameters(parameters: Map<string, string>): string {
  const entries = [...parameters].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
  return `{${entries.join(",")}}`;
}

function findFirst<T extends string>(value: string, candidates: readonly T[]): { index: number; value: T } {
  let bestIndex = -1;
  let bestValue = candidates[0];
  for (const candidate of candidates) {
    const index = value.indexOf(candidate);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestValue = candidate;
    }
  }
  return { index: bestIndex, value: bestValue };
}

function startsWithAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.startsWith(candidate));
}

function isPartialPrefix(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => candidate.startsWith(value));
}

function longestMarkerSuffix(value: string, candidates: readonly string[]): number {
  let longest = 0;
  for (let length = 1; length <= value.length; length++) {
    const suffix = value.slice(-length);
    if (candidates.some((candidate) => candidate.startsWith(suffix))) longest = length;
  }
  return longest;
}
