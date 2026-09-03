import { describe, expect, it } from "vitest";
import { type StableRecordIDInput, stableChatRecordID } from "../protocol/stream.js";

const baseInput: StableRecordIDInput = {
  mode: "global",
  model: "lite",
  systemText: "You are a coding assistant.",
  messages: [{ role: "user", content: "inspect this file" }],
  tools: [{ type: "function", function: { name: "read" } }],
  parameters: {
    max_tokens: 131072,
    enable_thinking: false,
  },
};

describe("stableChatRecordID", () => {
  it("is stable for the same request semantics", () => {
    expect(stableChatRecordID(baseInput)).toBe(stableChatRecordID({ ...baseInput }));
    expect(stableChatRecordID(baseInput)).toHaveLength(16);
  });

  it.each([
    ["region", { mode: "cn" }],
    ["model", { model: "qmodel" }],
    ["system prompt", { systemText: "Use concise answers." }],
    ["messages", { messages: [{ role: "user", content: "different request" }] }],
    ["tools", { tools: [] }],
    ["thinking parameters", { parameters: { max_tokens: 131072, enable_thinking: true, reasoning_effort: "high" } }],
  ])("changes when %s changes", (_label, change) => {
    expect(stableChatRecordID(baseInput)).not.toBe(stableChatRecordID({ ...baseInput, ...change }));
  });
});
