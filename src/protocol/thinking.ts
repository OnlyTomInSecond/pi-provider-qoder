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
];

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags) {
    maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
  }
  return maxLength;
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
    if (open.length > 0 && out.includes(open)) out = out.split(open).join("");
    if (close.length > 0 && out.includes(close)) out = out.split(close).join("");
  }
  return out;
}

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  // Whether a thinking block has already been completed. This is used only
  // to preserve the placement of the first block; it must not disable tag
  // detection because a streamed response can contain multiple blocks.
  private thinkingExtracted = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private lastTextBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_TAG_VARIANTS[0].close;
  private readonly emitEvent: (event: AssistantMessageEvent) => void;

  constructor(
    private output: AssistantMessage,
    stream: AssistantMessageEventStream,
    emitEvent?: (event: AssistantMessageEvent) => void,
  ) {
    this.emitEvent = emitEvent ?? ((event) => stream.push(event));
  }

  processChunk(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;
      if (!this.inThinking) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (this.textBuffer.length === 0) return;
    if (this.inThinking && this.thinkingBlockIndex !== null) {
      const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
      block.thinking += this.textBuffer;
      this.emitEvent({
        type: "thinking_delta",
        contentIndex: this.thinkingBlockIndex,
        delta: this.textBuffer,
        partial: this.output,
      });
      this.emitEvent({
        type: "thinking_end",
        contentIndex: this.thinkingBlockIndex,
        content: block.thinking,
        partial: this.output,
      });
    } else {
      this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
  }

  /**
   * Flush content before an out-of-band tool-call boundary. Unlike finalize(),
   * this keeps the parser reusable for text that arrives after the tool call.
   */
  flushAtBoundary(): void {
    if (this.inThinking) {
      if (this.textBuffer.length > 0) {
        this.emitThinking(this.textBuffer);
      }
      this.textBuffer = "";
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        this.emitEvent({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
      this.inThinking = false;
      this.thinkingExtracted = true;
      this.thinkingBlockIndex = null;
      this.lastTextBlockIndex = this.textBlockIndex;
      this.textBlockIndex = null;
      return;
    }

    if (this.textBuffer.length > 0) {
      this.emitText(this.textBuffer);
      this.textBuffer = "";
    }
    this.lastTextBlockIndex = this.textBlockIndex;
    this.textBlockIndex = null;
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex;
  }

  private processBeforeThinking(): void {
    // Find the first opener and first closer in the buffer.
    let bestOpenPos = -1;
    let bestOpenVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    let bestClosePos = -1;
    let bestCloseVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    for (const variant of THINKING_TAG_VARIANTS) {
      const openPos = this.textBuffer.indexOf(variant.open);
      if (openPos !== -1 && (bestOpenPos === -1 || openPos < bestOpenPos)) {
        bestOpenPos = openPos;
        bestOpenVariant = variant;
      }
      const closePos = this.textBuffer.indexOf(variant.close);
      if (closePos !== -1 && (bestClosePos === -1 || closePos < bestClosePos)) {
        bestClosePos = closePos;
        bestCloseVariant = variant;
      }
    }

    // Opener comes first (or is the only tag): a real thinking block carried
    // in the content stream. Enter thinking mode; processInsideThinking will
    // handle its closer.
    if (bestOpenVariant !== null && (bestCloseVariant === null || bestOpenPos < bestClosePos)) {
      if (bestOpenPos > 0) this.emitText(this.textBuffer.slice(0, bestOpenPos));
      this.textBuffer = this.textBuffer.slice(bestOpenPos + bestOpenVariant.open.length);
      if (this.thinkingExtracted && this.textBlockIndex !== null) {
        this.lastTextBlockIndex = this.textBlockIndex;
        this.textBlockIndex = null;
      }
      this.activeEndTag = bestOpenVariant.close;
      this.inThinking = true;
      return;
    }

    // Closer with no preceding opener: an orphan close tag. Its matching
    // opener was delivered via the separate `reasoning_content` channel (see
    // stream.ts), so there is no thinking block to close here. Drop it — and
    // the separator whitespace the model emits right after `</thinking>` — so
    // it does not leak into visible text.
    if (bestCloseVariant !== null) {
      if (bestClosePos > 0) this.emitText(this.textBuffer.slice(0, bestClosePos));
      this.textBuffer = this.textBuffer.slice(bestClosePos + bestCloseVariant.close.length);
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      else if (this.textBuffer.startsWith("\n")) this.textBuffer = this.textBuffer.slice(1);
      return;
    }

    // No complete tag yet. Hold back any trailing prefix that could be the
    // start of an opener OR a closer, so a tag split across stream deltas is
    // not partially emitted as text.
    const allTags = THINKING_TAG_VARIANTS.flatMap((variant) => [variant.open, variant.close]);
    const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(this.textBuffer, allTags);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      if (this.thinkingBlockIndex !== null) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        this.emitEvent({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      this.thinkingExtracted = true;
      this.thinkingBlockIndex = null;
      this.lastTextBlockIndex = this.textBlockIndex;
      this.textBlockIndex = null;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }

    const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
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
    this.emitEvent({ type: "text_delta", contentIndex: this.textBlockIndex, delta: text, partial: this.output });
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    if (this.thinkingBlockIndex === null) {
      // Never insert before a text block that has already emitted events.
      // contentIndex is part of the streaming protocol; splicing here would
      // shift the block while previously emitted text_start/text_delta events
      // still point at the old index, causing pi's UI to render thinking as
      // text. Keep blocks append-only so event indexes remain stable.
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
