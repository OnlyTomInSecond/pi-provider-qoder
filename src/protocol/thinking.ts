import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";

export const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
  // Qoder/Qwen streams can use a summary wrapper for hidden reasoning. The
  // opener may arrive in reasoning_content while the closer arrives in
  // delta.content, so the closer must also be treated as an orphan boundary.
  { open: "<summary>", close: "</summary>" },
];

/** Every opener/closer string that can appear in the text channel. */
const ALL_TAG_STRINGS: readonly string[] = THINKING_TAG_VARIANTS.flatMap((variant) => [variant.open, variant.close]);

/**
 * Longest suffix of `text` that could be the *start* of a longer tag. Used to
 * hold back a tag that a later chunk may still complete, instead of leaking it
 * into the visible text.
 */
function partialTagSuffixLength(text: string, tags: readonly string[]): number {
  let longest = 0;
  for (const tag of tags) {
    // A complete tag would already have been consumed; only proper prefixes
    // (shorter than the tag) need to be held back.
    const maxLength = Math.min(text.length, tag.length - 1);
    for (let length = maxLength; length > longest; length--) {
      if (text.endsWith(tag.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

interface FoundTag {
  /** Index of the tag inside the scanned text. */
  index: number;
  /** The variant whose open/close tag matched. */
  variant: (typeof THINKING_TAG_VARIANTS)[number];
  kind: "open" | "close";
}

/**
 * Earliest complete thinking tag in `text`, if any. Openers and closers of
 * every variant compete by position; the earliest one wins.
 */
function findEarliestTag(text: string): FoundTag | null {
  let best: FoundTag | null = null;
  for (const variant of THINKING_TAG_VARIANTS) {
    for (const kind of ["open", "close"] as const) {
      const tag = variant[kind];
      const index = text.indexOf(tag);
      if (index !== -1 && (best === null || index < best.index)) {
        best = { index, variant, kind };
      }
    }
  }
  return best;
}

/** Drop a single leading newline pair, or a lone newline, after a tag. */
function stripFollowingNewline(text: string): string {
  if (text.startsWith("\n\n")) return text.slice(2);
  if (text.startsWith("\n")) return text.slice(1);
  return text;
}

/**
 * Remove every thinking/reasoning tag variant (open and close) from `text`.
 *
 * Qoder's backend sometimes routes a literal `<thinking>` opener into the
 * `reasoning_content` channel (and the matching `</thinking>` closer into the
 * `content` channel). Stripping these artifacts keeps the thinking block clean,
 * matching the SDK's `ContentBlock` model. Best-effort per chunk: a tag split
 * across stream deltas is not caught here (the ThinkingTagParser handles the
 * content-channel side with cross-delta buffering).
 */
export function stripThinkingTags(text: string): string {
  let out = text;
  for (const { open, close } of THINKING_TAG_VARIANTS) {
    if (out.includes(open)) out = out.split(open).join("");
    if (out.includes(close)) out = out.split(close).join("");
  }
  return out;
}

type Phase = "text" | "thinking";

/**
 * Incremental parser for thinking tags carried in the content stream.
 *
 * Text outside a tag streams out immediately as `text_*` events; text between
 * an opener and its closer is routed into a `thinking` block. Content blocks
 * are append-only so the `contentIndex` carried by every emitted event stays
 * valid — a later block is never spliced in front of an earlier one.
 */
export class ThinkingTagParser {
  private buffer = "";
  private phase: Phase = "text";
  private activeEndTag: string = THINKING_TAG_VARIANTS[0].close;
  // Set once at least one thinking block has been completed. Used only to end
  // the current text block before a *later* thinking block starts, so the
  // thinking block does not reuse that block's index.
  private sawThinkingBlock = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private lastTextBlockIndex: number | null = null;
  private readonly emitEvent: (event: AssistantMessageEvent) => void;

  constructor(
    private readonly output: AssistantMessage,
    stream: AssistantMessageEventStream,
    emitEvent?: (event: AssistantMessageEvent) => void,
  ) {
    this.emitEvent = emitEvent ?? ((event) => stream.push(event));
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex;
  }

  processChunk(chunk: string): void {
    this.buffer += chunk;
    this.scan();
  }

  /**
   * Flush content before an out-of-band tool-call boundary. Unlike finalize(),
   * this keeps the parser reusable for text that arrives after the tool call.
   * Any unclosed thinking text (including a held partial tag) is emitted as
   * thinking content before the block is closed.
   */
  flushAtBoundary(): void {
    if (this.phase === "thinking") {
      this.closeThinking(true);
      return;
    }
    if (this.buffer) this.emitText(this.buffer);
    this.buffer = "";
    // Remember the text block so the next content starts a fresh block after
    // whatever came out-of-band (an API thinking block or a tool call).
    this.lastTextBlockIndex = this.textBlockIndex;
    this.textBlockIndex = null;
  }

  finalize(): void {
    if (!this.buffer) return;
    if (this.phase === "thinking" && this.thinkingBlockIndex !== null) {
      this.emitThinking(this.buffer);
      this.emitThinkingEnd();
    } else {
      this.emitText(this.buffer);
    }
    this.buffer = "";
  }

  /** Consume as much of `buffer` as the current phase allows. */
  private scan(): void {
    while (this.buffer) {
      if (this.phase === "text") {
        const tag = findEarliestTag(this.buffer);

        // A real thinking block starts here: hand the preceding text over,
        // then switch into thinking mode.
        if (tag?.kind === "open") {
          if (tag.index > 0) this.emitText(this.buffer.slice(0, tag.index));
          this.buffer = this.buffer.slice(tag.index + tag.variant.open.length);
          // Never insert a thinking block in front of text that has already
          // emitted events: end text tracking so the thinking block gets its
          // own fresh index.
          if (this.sawThinkingBlock && this.textBlockIndex !== null) {
            this.lastTextBlockIndex = this.textBlockIndex;
            this.textBlockIndex = null;
          }
          this.activeEndTag = tag.variant.close;
          this.phase = "thinking";
          continue;
        }

        // An orphan closer with no opener: its matching opener was delivered
        // via the separate `reasoning_content` channel (see stream.ts), so
        // there is no thinking block to close here. Drop the tag — and the
        // separator whitespace the model emits right after it — instead of
        // leaking it into visible text.
        if (tag?.kind === "close") {
          if (tag.index > 0) this.emitText(this.buffer.slice(0, tag.index));
          this.buffer = this.buffer.slice(tag.index + tag.variant.close.length);
          this.buffer = stripFollowingNewline(this.buffer);
          continue;
        }

        // No complete tag yet. Emit everything except a trailing prefix that a
        // later chunk could still turn into a tag.
        const hold = partialTagSuffixLength(this.buffer, ALL_TAG_STRINGS);
        const safeLength = this.buffer.length - hold;
        if (safeLength <= 0) break;
        this.emitText(this.buffer.slice(0, safeLength));
        this.buffer = this.buffer.slice(safeLength);
        continue;
      }

      // Thinking phase: look for the closer of the active variant.
      const end = this.buffer.indexOf(this.activeEndTag);
      if (end !== -1) {
        if (end > 0) this.emitThinking(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + this.activeEndTag.length);
        // Models often follow the closer with a blank line; drop it.
        if (this.buffer.startsWith("\n\n")) this.buffer = this.buffer.slice(2);
        this.closeThinking(false);
        continue;
      }
      const hold = partialTagSuffixLength(this.buffer, [this.activeEndTag]);
      const safeLength = this.buffer.length - hold;
      if (safeLength <= 0) break;
      this.emitThinking(this.buffer.slice(0, safeLength));
      this.buffer = this.buffer.slice(safeLength);
    }
  }

  /**
   * Leave the thinking phase. When `flushPending` is set, whatever is still in
   * the buffer (e.g. a partial closer held back while waiting for more chunks)
   * is emitted as thinking content first. The block is always ended and the
   * text-tracking state reset for the following content.
   */
  private closeThinking(flushPending: boolean): void {
    if (flushPending && this.buffer) {
      this.emitThinking(this.buffer);
      this.buffer = "";
    }
    if (this.thinkingBlockIndex !== null) this.emitThinkingEnd();
    this.phase = "text";
    this.sawThinkingBlock = true;
    this.thinkingBlockIndex = null;
    this.lastTextBlockIndex = this.textBlockIndex;
    this.textBlockIndex = null;
  }

  private emitThinkingEnd(): void {
    const block = this.output.content[this.thinkingBlockIndex as number] as ThinkingContent;
    this.emitEvent({
      type: "thinking_end",
      contentIndex: this.thinkingBlockIndex as number,
      content: block.thinking,
      partial: this.output,
    });
  }

  private emitText(text: string): void {
    if (!text) return;
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.emitEvent({ type: "text_start", contentIndex: this.textBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.textBlockIndex] as TextContent;
    block.text += text;
    this.emitEvent({
      type: "text_delta",
      contentIndex: this.textBlockIndex,
      delta: text,
      partial: this.output,
    });
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    if (this.thinkingBlockIndex === null) {
      this.thinkingBlockIndex = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "" });
      this.emitEvent({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    block.thinking += thinking;
    this.emitEvent({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: thinking,
      partial: this.output,
    });
  }
}
