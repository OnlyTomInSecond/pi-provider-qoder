import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildContinuationContext,
  hasGeneratedContent,
  isResumableTimeout,
  relayContinuation,
} from "../protocol/resume.js";

function makeMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api",
    provider: "qoder",
    model: "Lite",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 0,
  };
}

function replay(events: AssistantMessageEvent[]): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end();
  return stream;
}

describe("relayContinuation", () => {
  it("appends continuation blocks with remapped indices and merges usage", async () => {
    const output = makeMessage();
    output.content.push({ type: "text", text: "Hello" });
    output.usage.output = 10;
    output.usage.reasoning = 2;
    output.usage.totalTokens = 10;

    const doneMessage = makeMessage();
    doneMessage.content = [{ type: "thinking", thinking: "more" }];
    doneMessage.usage = {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      reasoning: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    doneMessage.stopReason = "stop";

    const emitted: AssistantMessageEvent[] = [];
    const continuation = replay([
      { type: "start", partial: output },
      { type: "text_start", contentIndex: 0, partial: output },
      { type: "text_delta", contentIndex: 0, delta: " world", partial: output },
      { type: "text_end", contentIndex: 0, content: " world", partial: output },
      { type: "thinking_start", contentIndex: 1, partial: output },
      { type: "thinking_delta", contentIndex: 1, delta: "more", partial: output },
      { type: "thinking_end", contentIndex: 1, content: "more", partial: output },
      { type: "done", reason: "stop", message: doneMessage },
    ]);

    await relayContinuation(output, continuation, (event) => emitted.push(event));

    expect(output.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "thinking", thinking: "more" },
    ]);
    expect(output.usage).toMatchObject({ input: 3, output: 15, totalTokens: 30, reasoning: 3 });
    expect(output.stopReason).toBe("stop");
    const deltaEvents = emitted.filter((event) => event.type === "text_delta" || event.type === "thinking_delta");
    expect(deltaEvents.map((event) => event.contentIndex)).toEqual([1, 2]);
  });

  it("rejects a tool call introduced by the continuation", async () => {
    const output = makeMessage();
    const continuation = replay([{ type: "toolcall_start", contentIndex: 0, partial: output }]);
    await expect(relayContinuation(output, continuation, () => {})).rejects.toThrow("tool call after a timeout");
  });

  it("surfaces an error event", async () => {
    const output = makeMessage();
    const errorMessage = makeMessage();
    errorMessage.stopReason = "error";
    errorMessage.errorMessage = "boom";
    const continuation = replay([{ type: "error", reason: "error", error: errorMessage }]);
    await expect(relayContinuation(output, continuation, () => {})).rejects.toThrow("boom");
  });
});

describe("resume helpers", () => {
  it("detects resumable timeout messages only", () => {
    expect(isResumableTimeout(new Error("Qoder stream idle timeout"))).toBe(true);
    expect(isResumableTimeout(new Error("Qoder request timeout"))).toBe(true);
    expect(isResumableTimeout(new Error("other"))).toBe(false);
    expect(isResumableTimeout("timeout")).toBe(false);
  });

  it("detects generated content", () => {
    const message = makeMessage();
    expect(hasGeneratedContent(message)).toBe(false);
    message.content.push({ type: "text", text: "hi" });
    expect(hasGeneratedContent(message)).toBe(true);
  });

  it("replays the partial reply and appends a continuation prompt", () => {
    const context = { messages: [{ role: "user", content: "hi" }] } as never;
    const output = makeMessage();
    output.content.push({ type: "text", text: "partial" });
    const next = buildContinuationContext(context, output);
    expect(next.messages).toHaveLength(3);
    expect(next.messages[1]).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(next.messages[2]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Continue the original task"),
    });
  });
});
