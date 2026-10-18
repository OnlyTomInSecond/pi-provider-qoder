import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { stripThinkingTags, ThinkingTagParser } from "./thinking.js";

/** False only when the host explicitly disabled thinking for this request. */
export function isThinkingRequested(reasoning: unknown): boolean {
  return reasoning !== false && reasoning !== "off";
}

export interface ThinkingSinkOptions {
  /**
   * When false the content stream is plain text: tag detection is skipped and
   * every chunk is appended to the current text block.
   */
  parseTags?: boolean;
}

/**
 * Single owner of the assistant message's thinking/text blocks across Qoder's
 * two reasoning channels.
 *
 * Qoder can deliver reasoning either as an explicit `reasoning_content` field
 * (the *reasoning channel*) or as `<thinking>` markup embedded in `content`
 * (the *content channel*). Both write into the same `output.content` list, so
 * their block lifecycle has to be coordinated:
 *   - opening a reasoning block flushes a half-parsed content-tag buffer,
 *   - pushing content ends an open reasoning block,
 *   - a tool-call boundary or finalize ends both.
 *
 * Keeping this state in one place replaces the previous manual
 * `flushAtBoundary()` / `endApiThinking()` pairing at every call site.
 */
export class ThinkingSink {
  private reasoningBlockIndex: number | null = null;
  private readonly emit: (event: AssistantMessageEvent) => void;
  private readonly tagParser: ThinkingTagParser;

  constructor(
    private readonly output: AssistantMessage,
    stream: AssistantMessageEventStream,
    emit: (event: AssistantMessageEvent) => void,
    options: ThinkingSinkOptions = {},
  ) {
    this.emit = emit;
    this.tagParser = new ThinkingTagParser(output, stream, emit, { parseTags: options.parseTags });
  }

  /**
   * Reasoning-channel text. Tag artifacts are stripped (Qoder sometimes routes
   * a literal `<thinking>` opener into `reasoning_content`) and the rest is
   * appended to a dedicated thinking block.
   */
  pushReasoning(text: string): void {
    const cleaned = stripThinkingTags(text);
    if (!cleaned) return;
    this.openReasoning();
    const block = this.output.content[this.reasoningBlockIndex as number] as ThinkingContent;
    block.thinking += cleaned;
    this.emit({
      type: "thinking_delta",
      contentIndex: this.reasoningBlockIndex as number,
      delta: cleaned,
      partial: this.output,
    });
  }

  /** Content-channel text, tag-parsed into text or thinking blocks. */
  pushContent(text: string): void {
    // Any open reasoning block ends before content blocks start.
    this.endReasoning();
    this.tagParser.processChunk(text);
  }

  /**
   * Out-of-band tool-call boundary: flush both channels so the tool call gets a
   * fresh content index, while keeping the sink reusable for later text.
   */
  boundary(): void {
    this.tagParser.flushAtBoundary();
    this.endReasoning();
  }

  /** Flush buffers and close any open block at end of stream. */
  finalize(): void {
    this.tagParser.finalize();
    this.endReasoning();
  }

  private openReasoning(): void {
    if (this.reasoningBlockIndex !== null) return;
    // Flush a pending content-channel tag buffer first so the new reasoning
    // block does not interleave with a content block that is still open.
    this.tagParser.flushAtBoundary();
    this.reasoningBlockIndex = this.output.content.length;
    this.output.content.push({ type: "thinking", thinking: "" });
    this.emit({ type: "thinking_start", contentIndex: this.reasoningBlockIndex, partial: this.output });
  }

  private endReasoning(): void {
    if (this.reasoningBlockIndex === null) return;
    const block = this.output.content[this.reasoningBlockIndex] as ThinkingContent;
    this.emit({
      type: "thinking_end",
      contentIndex: this.reasoningBlockIndex,
      content: block.thinking,
      partial: this.output,
    });
    this.reasoningBlockIndex = null;
  }
}
