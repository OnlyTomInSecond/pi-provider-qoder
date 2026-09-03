import { beforeEach, describe, expect, it } from "vitest";
import {
  clearQoderRunRegistry,
  getQoderRunIdentity,
  isToolRoundContinuation,
  type QoderRunBusiness,
  type QoderRunMessage,
} from "../protocol/run-state.js";

const SESSION = "session-1";

function user(text: string): QoderRunMessage {
  return { role: "user", content: text };
}

function assistantWithTools(ids: string[]): QoderRunMessage {
  return { role: "assistant", content: " ", tool_calls: ids.map((id) => ({ id, type: "function" })) };
}

function toolResult(id: string): QoderRunMessage {
  return { role: "tool", tool_call_id: id, content: "result" };
}

function request(
  messages: QoderRunMessage[],
  lastUserText = "Refactor the build script",
): ReturnType<typeof getQoderRunIdentity> {
  return getQoderRunIdentity({
    mode: "global",
    model: "lite",
    sessionId: SESSION,
    messages,
    lastUserText,
    product: "cli",
  });
}

function businessStage(business: QoderRunBusiness): string {
  return business.stage;
}

describe("isToolRoundContinuation", () => {
  it("is false for a plain user prompt", () => {
    expect(isToolRoundContinuation([user("do it")])).toBe(false);
  });

  it("is true when tool results follow the assistant tool calls that declared them", () => {
    const messages = [user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")];
    expect(isToolRoundContinuation(messages)).toBe(true);
  });

  it("is true across multiple completed tool rounds in one run", () => {
    const messages = [
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ];
    expect(isToolRoundContinuation(messages)).toBe(true);
  });

  it("is false when the conversation tail is a fresh user message", () => {
    const messages = [
      user("first task"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools([]), // final answer without tool calls
      user("next task"),
    ];
    expect(isToolRoundContinuation(messages)).toBe(false);
  });
});

describe("getQoderRunIdentity", () => {
  beforeEach(() => {
    clearQoderRunRegistry();
  });

  it("keeps request_set_id and business.id stable across tool rounds of one run", () => {
    const first = request([user("do it")]);
    const second = request([user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")]);
    const third = request([
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ]);

    expect(second.requestSetId).toBe(first.requestSetId);
    expect(third.requestSetId).toBe(first.requestSetId);
    expect(second.business.id).toBe(first.business.id);
    expect(third.business.id).toBe(first.business.id);
    expect(second.business.begin_at).toBe(first.business.begin_at);
    expect(second.business.name).toBe(first.business.name);
  });

  it("rotates request_set_id and business.id when a new user prompt starts a run", () => {
    const first = request([user("first task")]);
    // Same session but the tail is a fresh user prompt -> new run.
    const next = request([
      user("first task"),
      assistantWithTools([]), // completed run
      user("second task"),
    ]);

    expect(next.requestSetId).not.toBe(first.requestSetId);
    expect(next.business.id).not.toBe(first.business.id);
  });

  it("advances the business stage like qodercli: start, then processing", () => {
    const first = request([user("do it")]);
    expect(businessStage(first.business)).toBe("start");

    const second = request([user("do it"), assistantWithTools(["call-1"]), toolResult("call-1")]);
    expect(businessStage(second.business)).toBe("processing");

    const third = request([
      user("do it"),
      assistantWithTools(["call-1"]),
      toolResult("call-1"),
      assistantWithTools(["call-2"]),
      toolResult("call-2"),
    ]);
    expect(businessStage(third.business)).toBe("processing");
  });

  it("truncates the business display name to 10 characters like qodercli", () => {
    const longPrompt = "This is a very long prompt text for a run name";
    const identity = request([user(longPrompt)], longPrompt);
    expect(identity.business.name).toBe("This is a ");
  });

  it("keeps separate sessions independent", () => {
    const otherSession = getQoderRunIdentity({
      mode: "global",
      model: "lite",
      sessionId: "session-2",
      messages: [user("do it")],
      lastUserText: "do it",
      product: "cli",
    });
    const first = request([user("do it")]);
    const otherContinuation = getQoderRunIdentity({
      mode: "global",
      model: "lite",
      sessionId: "session-2",
      messages: [user("do it"), assistantWithTools(["call-9"]), toolResult("call-9")],
      lastUserText: "do it",
      product: "cli",
    });
    expect(otherContinuation.requestSetId).toBe(otherSession.requestSetId);
    expect(otherContinuation.requestSetId).not.toBe(first.requestSetId);
  });
});
