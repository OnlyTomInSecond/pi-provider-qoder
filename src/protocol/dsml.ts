export type DsmlParserEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_arguments"; id: string; arguments: string };

const DSML_TOKEN = "｜DSML｜";
const WRAPPER_STARTS = [`<${DSML_TOKEN}tool_calls>`, `<${DSML_TOKEN}function_calls>`] as const;
const WRAPPER_ENDS = [`</${DSML_TOKEN}tool_calls>`, `</${DSML_TOKEN}function_calls>`] as const;
const INVOKE_PREFIX = `<${DSML_TOKEN}invoke`;
const FUNCTION_PREFIX = `<${DSML_TOKEN}function`;
const PARAMETER_PREFIX = `<${DSML_TOKEN}parameter`;
const INVOKE_END = `</${DSML_TOKEN}invoke>`;
const FUNCTION_END = `</${DSML_TOKEN}function>`;
const PARAMETER_END = `</${DSML_TOKEN}parameter>`;

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

        const prefix = startsWithAny(this.buffer, [INVOKE_PREFIX, FUNCTION_PREFIX]);
        if (prefix) {
          const close = this.buffer.indexOf(">");
          if (close === -1) break;

          const header = this.buffer.slice(0, close + 1);
          const match = header.match(new RegExp(`^<${DSML_TOKEN}(invoke|function)\\s+name="([^"]*)">$`));
          if (!match) {
            this.fallback(events);
            continue;
          }

          const id = `dsml_call_${this.callNumber++}`;
          this.currentCall = {
            id,
            name: match[2],
            endTag: match[1] === "function" ? FUNCTION_END : INVOKE_END,
            parameters: new Map(),
          };
          this.buffer = this.buffer.slice(header.length);
          this.state = "call";
          events.push({ type: "tool_start", id, name: match[2] });
          continue;
        }

        if (!final && isPartialPrefix(this.buffer, [...WRAPPER_ENDS, INVOKE_PREFIX, FUNCTION_PREFIX])) break;
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

      if (this.buffer.startsWith(PARAMETER_PREFIX)) {
        const openingEnd = this.buffer.indexOf(">");
        if (openingEnd === -1) break;
        const opening = this.buffer.slice(0, openingEnd + 1);
        const match = opening.match(
          new RegExp(`^<${DSML_TOKEN}parameter\\s+name="([^"]+)"\\s+string="(true|false)">$`),
        );
        if (!match) {
          this.fallback(events);
          continue;
        }

        const closing = this.buffer.indexOf(PARAMETER_END, opening.length);
        if (closing === -1) break;
        const value = this.buffer.slice(opening.length, closing);
        if (call.parameters.has(match[1])) {
          this.fallback(events);
          continue;
        }

        const encoded = encodeParameterValue(value, match[2] === "true");
        if (encoded === undefined) {
          this.fallback(events);
          continue;
        }
        call.parameters.set(match[1], encoded);
        this.buffer = this.buffer.slice(closing + PARAMETER_END.length);
        continue;
      }

      if (!final && isPartialPrefix(this.buffer, [call.endTag, PARAMETER_PREFIX])) break;
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
