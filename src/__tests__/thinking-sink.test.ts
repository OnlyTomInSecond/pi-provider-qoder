import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { ThinkingSink } from "../protocol/thinking-sink.js";

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as Api,
    provider: "qoder",
    model: "test",
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

const stream = { push: () => {}, end: () => {} } as unknown as AssistantMessageEventStream;

describe("ThinkingSink", () => {
  let output: AssistantMessage;
  let events: AssistantMessageEvent[];
  let sink: ThinkingSink;

  beforeEach(() => {
    output = createOutput();
    events = [];
    sink = new ThinkingSink(output, stream, (event) => events.push(event), { parseTags: true });
  });

  it("appends reasoning-channel text to one thinking block and strips tags", () => {
    sink.pushReasoning("<thinking>");
    sink.pushReasoning("step one");
    sink.finalize();
    expect(output.content).toEqual([{ type: "thinking", thinking: "step one" }]);
    expect(events.map((event) => event.type)).toEqual(["thinking_start", "thinking_delta", "thinking_end"]);
  });

  it("ends an open reasoning block before content text starts", () => {
    sink.pushReasoning("thought");
    sink.pushContent("answer");
    sink.finalize();
    expect(output.content).toEqual([
      { type: "thinking", thinking: "thought" },
      { type: "text", text: "answer" },
    ]);
    const types = events.map((event) => event.type);
    expect(types).toEqual(["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end"]);
    expect(types.indexOf("thinking_end")).toBeLessThan(types.indexOf("text_start"));
  });

  it("routes tag-delimited content into its own thinking block", () => {
    sink.pushContent("<thinking>abc</thinking>tail");
    sink.finalize();
    expect(output.content).toEqual([
      { type: "thinking", thinking: "abc" },
      { type: "text", text: "tail" },
    ]);
  });

  it("starts a fresh reasoning block after tool-call boundaries", () => {
    sink.pushReasoning("first");
    sink.boundary();
    sink.pushReasoning("second");
    sink.finalize();
    expect(output.content).toEqual([
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
    ]);
    const starts = events.filter((event) => event.type === "thinking_start");
    expect(starts.map((event) => event.contentIndex)).toEqual([0, 1]);
  });

  it("does not emit tag parsing when parseTags is disabled", () => {
    const plain = new ThinkingSink(output, stream, (event) => events.push(event), { parseTags: false });
    plain.pushContent("<thinking>abc</thinking>");
    plain.finalize();
    expect(output.content).toEqual([{ type: "text", text: "<thinking>abc</thinking>" }]);
  });
});
