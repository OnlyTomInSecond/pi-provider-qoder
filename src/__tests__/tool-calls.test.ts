import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type FinishedToolCallArguments, parseFinishedArguments, ToolCallAccumulator } from "../protocol/tool-calls.js";

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

  it("serializes an already-parsed argument object instead of concatenating [object Object]", () => {
    const output = makeOutput();
    const toolCalls = new ToolCallAccumulator(output, () => {}, parseFinishedArguments);

    // The gateway can deliver `arguments` as a parsed value even though the
    // declared shape is a string.
    toolCalls.processNativeDelta({
      index: 0,
      id: "call-1",
      function: { name: "edit", arguments: { path: "/a/b.c" } as unknown as string },
    });
    expect(toolCalls.finalize()).toBe(true);
    expect(output.content[0]).toMatchObject({ type: "toolCall", arguments: { path: "/a/b.c" } });
  });
});

describe("parseFinishedArguments local repair fallback", () => {
  it("recovers raw newlines and tabs inside string values", () => {
    // A model writing kernel C sources emits the file's bytes verbatim.
    const raw = '{"path":"/k/cs_dsp.h","edits":[{"oldText":"int f(\n\tint x)","newText":"int f(int x)"}]}';
    expect(parseFinishedArguments(raw).arguments).toEqual({
      path: "/k/cs_dsp.h",
      edits: [{ oldText: "int f(\n\tint x)", newText: "int f(int x)" }],
    });
  });

  it("recovers illegal backslash escapes", () => {
    expect(parseFinishedArguments('{"command":"grep -P \\d src"}').arguments).toEqual({
      command: "grep -P \\d src",
    });
  });

  it("still rejects arguments truncated by the output limit", () => {
    expect(() => parseFinishedArguments('{"path":"/a","edits":[{"oldText":"foo')).toThrow(
      "Invalid or truncated Qoder tool call arguments",
    );
  });

  it("still rejects a non-object payload", () => {
    expect(() => parseFinishedArguments('["a","b"]')).toThrow("Invalid or truncated Qoder tool call arguments");
  });
});
