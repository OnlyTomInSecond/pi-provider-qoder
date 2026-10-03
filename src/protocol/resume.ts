import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
  TranscriptContext,
} from "@earendil-works/pi-ai";

const QODER_CONTINUATION_PROMPT =
  "Continue the original task from exactly where the previous response stopped. Do not repeat any reasoning or text already generated; continue and finish the response.";

/** True when a failure is a transient deadline that a continuation can recover. */
export function isResumableTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "Qoder stream idle timeout" || error.message === "Qoder request timeout")
  );
}

/** True when the partial message already contains user-visible text or reasoning. */
export function hasGeneratedContent(message: AssistantMessage): boolean {
  return message.content.some(
    (block) =>
      (block.type === "text" && block.text.length > 0) || (block.type === "thinking" && block.thinking.length > 0),
  );
}

/**
 * Assemble the context for the one continuation attempt after a timeout: replay
 * the partial reply as an assistant turn, then ask the model to continue it.
 */
export function buildContinuationContext(context: TranscriptContext, output: AssistantMessage): TranscriptContext {
  const resumeAssistant = {
    ...output,
    content: output.content.map((block) => ({ ...block })),
    stopReason: "stop" as const,
    errorMessage: undefined,
  } as AssistantMessage;
  return {
    ...context,
    messages: [
      ...context.messages,
      resumeAssistant,
      { role: "user", content: QODER_CONTINUATION_PROMPT, timestamp: Date.now() },
    ],
  } as TranscriptContext;
}

/**
 * Replay a continuation attempt's events into the original `output`, remapping
 * the continuation's content indices to the appended blocks so consumers keep
 * seeing a single monotonically growing message. Tool calls are rejected: a
 * continuation must not introduce a new executable call.
 */
export async function relayContinuation(
  output: AssistantMessage,
  continuation: AssistantMessageEventStream,
  emit: (event: AssistantMessageEvent) => void,
): Promise<void> {
  const contentIndices = new Map<number, number>();
  const indexFor = (nestedIndex: number): number => {
    const index = contentIndices.get(nestedIndex);
    if (index === undefined) throw new Error("Qoder continuation returned an invalid content index");
    return index;
  };
  const textBlock = (contentIndex: number): TextContent => {
    const block = output.content[contentIndex];
    if (block?.type !== "text") throw new Error("Qoder continuation returned an invalid text block");
    return block;
  };
  const thinkingBlock = (contentIndex: number): ThinkingContent => {
    const block = output.content[contentIndex];
    if (block?.type !== "thinking") throw new Error("Qoder continuation returned an invalid thinking block");
    return block;
  };

  for await (const event of continuation) {
    switch (event.type) {
      case "start":
        break;
      case "text_start":
        contentIndices.set(event.contentIndex, output.content.length);
        output.content.push({ type: "text", text: "" });
        emit({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
        break;
      case "text_delta": {
        const contentIndex = indexFor(event.contentIndex);
        textBlock(contentIndex).text += event.delta;
        emit({ type: "text_delta", contentIndex, delta: event.delta, partial: output });
        break;
      }
      case "text_end": {
        const contentIndex = indexFor(event.contentIndex);
        const block = textBlock(contentIndex);
        block.text = event.content;
        emit({ type: "text_end", contentIndex, content: block.text, partial: output });
        break;
      }
      case "thinking_start":
        contentIndices.set(event.contentIndex, output.content.length);
        output.content.push({ type: "thinking", thinking: "" });
        emit({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
        break;
      case "thinking_delta": {
        const contentIndex = indexFor(event.contentIndex);
        thinkingBlock(contentIndex).thinking += event.delta;
        emit({ type: "thinking_delta", contentIndex, delta: event.delta, partial: output });
        break;
      }
      case "thinking_end": {
        const contentIndex = indexFor(event.contentIndex);
        const block = thinkingBlock(contentIndex);
        block.thinking = event.content;
        emit({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
        break;
      }
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        throw new Error("Qoder continuation returned a tool call after a timeout");
      case "done":
        output.stopReason = event.reason;
        output.rawStopReason = event.message.rawStopReason;
        output.responseId = event.message.responseId;
        output.responseModel = event.message.responseModel;
        output.errorMessage = undefined;
        {
          // Continuation usage is additive on top of what the timed-out attempt
          // already billed.
          const previousOutput = output.usage.output;
          const previousReasoning = output.usage.reasoning ?? 0;
          Object.assign(output.usage, event.message.usage);
          output.usage.output += previousOutput;
          if (output.usage.reasoning !== undefined) output.usage.reasoning += previousReasoning;
          output.usage.totalTokens += previousOutput;
        }
        break;
      case "error":
        throw new Error(event.error.errorMessage || "Qoder continuation failed");
    }
  }

  const result = await continuation.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage || "Qoder continuation failed");
  }
}
