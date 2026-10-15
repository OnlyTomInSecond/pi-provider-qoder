import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type FinishedToolCallArguments, ToolCallAccumulator } from "../protocol/tool-calls.js";

function makeOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as AssistantMessage["api"],
    provider: "qoder" as AssistantMessage["provider"],
    model: "auto",
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

const malformed = (): FinishedToolCallArguments => ({ arguments: {}, argumentsError: "Unexpected end of JSON input" });

describe("ToolCallAccumulator finished arguments", () => {
  it("carries the host argumentsError on both the block and the toolcall_end event", () => {
    const output = makeOutput();
    const events: AssistantMessageEvent[] = [];
    const toolCalls = new ToolCallAccumulator(output, (event) => events.push(event), malformed);

    toolCalls.processNativeDelta({
      index: 0,
      id: "call-1",
      function: { name: "bash", arguments: '{"command":' },
    });
    expect(toolCalls.finalize()).toBe(true);

    expect(output.content[0]).toMatchObject({
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: {},
      argumentsError: "Unexpected end of JSON input",
    });

    const end = events.find((event) => event.type === "toolcall_end");
    expect(end).toMatchObject({
      toolCall: {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: {},
        argumentsError: "Unexpected end of JSON input",
      },
    });
  });

  it("omits argumentsError when the finished arguments parse cleanly", () => {
    const output = makeOutput();
    const events: AssistantMessageEvent[] = [];
    const parse = vi.fn((value: string): FinishedToolCallArguments => ({ arguments: JSON.parse(value) }));
    const toolCalls = new ToolCallAccumulator(output, (event) => events.push(event), parse);

    toolCalls.processNativeDelta({
      index: 0,
      id: "call-1",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    });
    expect(toolCalls.finalize()).toBe(true);

    expect(output.content[0]).not.toHaveProperty("argumentsError");
    const end = events.find(
      (event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
    );
    expect(end?.toolCall).toMatchObject({ arguments: { command: "ls" } });
    expect(end?.toolCall).not.toHaveProperty("argumentsError");
  });

  it("keeps the strict fallback failing on malformed arguments when the host cannot report them", () => {
    const output = makeOutput();
    const toolCalls = new ToolCallAccumulator(
      output,
      () => {},
      () => {
        throw new Error("Invalid or truncated Qoder tool call arguments");
      },
    );

    toolCalls.processNativeDelta({
      index: 0,
      id: "call-1",
      function: { name: "bash", arguments: '{"command":' },
    });
    expect(() => toolCalls.finalize()).toThrow("Invalid or truncated Qoder tool call arguments");
  });
});
