export type DsmlParserEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_arguments"; id: string; arguments: string };

// Qoder has emitted both the full-width marker used by Qwen and the ASCII
// spelling used by some gateway/model combinations. Both spellings are valid
// anywhere a marker appears.
const DSML_TOKENS = ["｜DSML｜", "|DSML|"] as const;

const WRAPPER_STARTS = DSML_TOKENS.flatMap((token) => [`<${token}tool_calls>`, `<${token}function_calls>`]);
const WRAPPER_ENDS = DSML_TOKENS.flatMap((token) => [`</${token}tool_calls>`, `</${token}function_calls>`]);

export const MAX_DSML_BUFFER_LENGTH = 8 * 1024 * 1024;

/**
 * Incrementally converts DeepSeek-style DSML tool calls to provider-neutral
 * events. The gateway normally converts these to OpenAI `delta.tool_calls`,
 * but some model/gateway combinations leak the raw markup through
 * `delta.content` instead.
 *
 * Structure: plain text, until a `<｜DSML｜tool_calls>` wrapper opens; inside
 * the wrapper sit one or more `<｜DSML｜invoke name="tool">` calls whose
 * parameters are `<｜DSML｜parameter name="key" string="true|false">…`
 * values. The wrapper is buffered whole (its bytes are never user-visible —
 * they become tool events, or the entire wrapper falls back to text when it
 * is malformed), so only the open text and the wrapper *boundaries* need
 * incremental handling.
 */
export class DsmlToolCallParser {
  /** Text-phase bytes not yet emitted (only a split wrapper start is held). */
  private buffer = "";
  /** Raw bytes since the wrapper start tag, or null while in the text phase. */
  private block: string | null = null;
  private callNumber = 0;

  processChunk(chunk: string): DsmlParserEvent[] {
    if (!chunk) return [];
    const pending = (this.block?.length ?? this.buffer.length) + chunk.length;
    if (pending > MAX_DSML_BUFFER_LENGTH) {
      throw new Error(`Qoder DSML buffer exceeded ${MAX_DSML_BUFFER_LENGTH} characters`);
    }

    // Most reasoning/content chunks are ordinary text. Avoid concatenating and
    // draining the parser when there is no complete or split wrapper marker;
    // the bounded suffix check still preserves wrapper boundaries split across
    // chunks and channels.
    if (
      this.block === null &&
      this.buffer.length === 0 &&
      !WRAPPER_STARTS.some((candidate) => chunk.includes(candidate)) &&
      longestMarkerSuffix(chunk, WRAPPER_STARTS) === 0
    ) {
      return [{ type: "text", text: chunk }];
    }

    this.buffer += chunk;
    return this.drain();
  }

  finalize(): DsmlParserEvent[] {
    const events: DsmlParserEvent[] = [];
    // An unterminated wrapper at end of stream is not a tool call: show it
    // verbatim like the malformed-wrapper fallback.
    if (this.block !== null) {
      events.push({ type: "text", text: this.block });
      this.block = null;
    }
    if (this.buffer) {
      events.push({ type: "text", text: this.buffer });
      this.buffer = "";
    }
    return events;
  }

  /** Emit text and/or close the wrapper until neither can make progress. */
  private drain(): DsmlParserEvent[] {
    const events: DsmlParserEvent[] = [];
    while (true) {
      if (this.block !== null) {
        // Fold anything buffered while waiting for the wrapper end into the
        // block, then try to close it.
        if (this.buffer) {
          this.block += this.buffer;
          this.buffer = "";
        }
        if (!this.tryCloseWrapper(events)) break;
        continue;
      }
      if (!this.tryEmitText(events)) break;
    }
    return events;
  }

  /**
   * Emit the text before the next wrapper start. Returns false when the rest
   * of the buffer is only a partial wrapper start that later chunks may still
   * complete (or the buffer is empty).
   */
  private tryEmitText(events: DsmlParserEvent[]): boolean {
    const start = findFirst(this.buffer, WRAPPER_STARTS);
    if (start.index !== -1) {
      if (start.index > 0) events.push({ type: "text", text: this.buffer.slice(0, start.index) });
      // Move everything from the wrapper start into the block buffer: the
      // opener, the inner markup, and any later text in this chunk.
      this.block = this.buffer.slice(start.index);
      this.buffer = "";
      return true;
    }
    const keep = longestMarkerSuffix(this.buffer, WRAPPER_STARTS);
    const safeLength = this.buffer.length - keep;
    if (safeLength > 0) {
      events.push({ type: "text", text: this.buffer.slice(0, safeLength) });
      this.buffer = this.buffer.slice(safeLength);
    }
    return false;
  }

  /**
   * Close the buffered wrapper once its end tag arrived, parsing the inner
   * markup into tool events. Returns false while the wrapper is incomplete;
   * on a parse failure the whole wrapper (raw bytes included) is replayed as
   * plain text, like the malformed-wrapper fallback.
   */
  private tryCloseWrapper(events: DsmlParserEvent[]): boolean {
    const block = this.block as string;
    // Everything before the first ">" is the wrapper start tag itself.
    const innerStart = block.indexOf(">") + 1;
    const end = findFirst(block.slice(innerStart), WRAPPER_ENDS);
    if (end.index === -1) return false;

    const inner = block.slice(innerStart, innerStart + end.index);
    const parsed = parseToolCalls(inner, this.callNumber);
    if (parsed) {
      this.callNumber = parsed.callNumber;
      events.push(...parsed.events);
    } else {
      // Malformed: surface the raw wrapper so the user still sees the model's
      // intent instead of silently dropping the block.
      events.push({ type: "text", text: block.slice(0, innerStart + end.index + end.value.length) });
    }

    this.block = null;
    this.buffer = block.slice(innerStart + end.index + end.value.length);
    return true;
  }
}

interface ParsedCallStart {
  token: string;
  kind: "invoke" | "function";
  name: string;
}

interface ParsedParameter {
  token: string;
  name: string;
  isString: boolean;
  value: string;
}

interface ParsedToolBlock {
  events: DsmlParserEvent[];
  callNumber: number;
}

/**
 * Parse a complete wrapper body (everything between the wrapper start and end
 * tags) into ordered tool events. Returns null when the body is malformed —
 * junk between calls, a duplicated parameter, an unterminated call — in which
 * case the caller falls back to replaying the raw wrapper as text.
 */
function parseToolCalls(inner: string, callNumber: number): ParsedToolBlock | null {
  const events: DsmlParserEvent[] = [];
  let position = 0;
  const remaining = () => inner.length - position;

  while (true) {
    position += leadingWhitespaceLength(inner, position);
    if (remaining() === 0) return { events, callNumber };

    const start = parseCallStart(inner, position);
    if (!start) return null;
    position = start.position;
    const id = `dsml_call_${callNumber++}`;
    events.push({ type: "tool_start", id, name: start.name });

    const parameters = new Map<string, string>();
    let closed = false;
    while (true) {
      position += leadingWhitespaceLength(inner, position);
      if (remaining() === 0) return null; // call never closed

      if (inner.startsWith(`</${start.token}${start.kind}>`, position)) {
        position += start.token.length + start.kind.length + 3;
        closed = true;
        break;
      }

      const parameter = parseParameter(inner, position);
      if (!parameter || parameters.has(parameter.name)) return null;
      position = parameter.position;
      const encoded = encodeParameterValue(parameter.value, parameter.isString);
      if (encoded === undefined) return null;
      parameters.set(parameter.name, encoded);
    }
    if (!closed) return null;

    events.push({
      type: "tool_arguments",
      id,
      arguments: serializeParameters(parameters),
    });
  }
}

function parseCallStart(inner: string, position: number): (ParsedCallStart & { position: number }) | null {
  const end = inner.indexOf(">", position);
  if (end === -1) return null;
  const header = inner.slice(position, end + 1);
  for (let index = 0; index < DSML_TOKENS.length; index++) {
    const match = CALL_HEADER_PATTERNS[index].exec(header);
    if (match) {
      return {
        token: DSML_TOKENS[index],
        kind: match[1] as "invoke" | "function",
        name: match[2],
        position: end + 1,
      };
    }
  }
  return null;
}

function parseParameter(inner: string, position: number): (ParsedParameter & { position: number }) | null {
  const end = inner.indexOf(">", position);
  if (end === -1) return null;
  const header = inner.slice(position, end + 1);
  let token = "";
  let matched: RegExpExecArray | null = null;
  for (let index = 0; index < DSML_TOKENS.length; index++) {
    const match = PARAMETER_HEADER_PATTERNS[index].exec(header);
    if (match) {
      token = DSML_TOKENS[index];
      matched = match;
      break;
    }
  }
  if (!matched) return null;

  const close = `</${token}parameter>`;
  const closeAt = inner.indexOf(close, end + 1);
  if (closeAt === -1) return null;
  return {
    token,
    name: matched[1],
    isString: matched[2] === "true",
    value: inner.slice(end + 1, closeAt),
    position: closeAt + close.length,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Header patterns are precompiled once per marker token at module load.
const CALL_HEADER_PATTERNS = DSML_TOKENS.map(
  (token) => new RegExp(`^<${escapeRegExp(token)}(invoke|function)\\s+name="([^"]*)">$`),
);
const PARAMETER_HEADER_PATTERNS = DSML_TOKENS.map(
  (token) => new RegExp(`^<${escapeRegExp(token)}parameter\\s+name="([^"]+)"\\s+string="(true|false)">$`),
);

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

function leadingWhitespaceLength(value: string, from: number): number {
  let length = 0;
  while (from + length < value.length && /\s/u.test(value[from + length])) length++;
  return length;
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

/** Length of the longest suffix of `value` that begins one of the candidates. */
function longestMarkerSuffix(value: string, candidates: readonly string[]): number {
  // Every DSML wrapper start begins with '<'. A valid partial suffix must
  // therefore start at the final '<' in the value; checking only that suffix
  // avoids scanning every possible length of a large ordinary text chunk.
  const markerStart = value.lastIndexOf("<");
  if (markerStart === -1) return 0;

  const suffix = value.slice(markerStart);
  for (const candidate of candidates) {
    if (suffix.length < candidate.length && candidate.startsWith(suffix)) return suffix.length;
  }
  return 0;
}
