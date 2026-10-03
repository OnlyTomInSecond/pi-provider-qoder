import {
  type Api,
  type Context,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type QoderModelEntry, staticModels } from "../catalog.js";
import { buildQoderChatRequest, isResumeAttempt, QODER_RESUME_ATTEMPT } from "../protocol/request-builder.js";
import { clearQoderRunRegistry } from "../protocol/run-state.js";

const lite = staticModels.find((model) => model.id === "Lite") as Model<Api>;
const identity = { userID: "user-1", name: "Test", email: "t@example.com", machineID: "machine-1" };

function makeContext(systemPrompt = "", tools: Context["tools"] = []): TranscriptContext {
  return normalizeContext({
    systemPrompt,
    messages: [{ role: "user", content: "hi" }],
    tools,
  } as unknown as Context);
}

function build(
  options?: SimpleStreamOptions,
  model: Model<Api> = lite,
  entry: QoderModelEntry = { key: "lite" },
  context: TranscriptContext = makeContext(),
) {
  return buildQoderChatRequest({
    model,
    context,
    options,
    providerMode: "global",
    modelConfig: entry,
    identity,
  });
}

afterEach(() => {
  clearQoderRunRegistry();
});

describe("buildQoderChatRequest", () => {
  it("injects the system prompt as a leading system message", () => {
    const request = build(undefined, lite, { key: "lite" }, makeContext("you are helpful"));
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "you are helpful" });
  });

  it("disables thinking when the model has no reasoning support", () => {
    const request = build();
    const parameters = request.body.parameters as Record<string, unknown>;
    expect(parameters.enable_thinking).toBe(false);
    expect(parameters.reasoning_effort).toBeUndefined();
    expect(parameters.max_tokens).toBe(131072);
  });

  it("maps an advertised effort level to reasoning_effort", () => {
    const model = {
      ...lite,
      reasoning: true,
      thinkingLevelMap: { off: null, low: "low", medium: "medium" },
    } as unknown as Model<Api>;
    const entry: QoderModelEntry = {
      key: "ultimate",
      thinking_config: { enabled: { efforts: { low: {}, medium: {} } } },
    };
    const request = build({ reasoning: "low" }, model, entry);
    const parameters = request.body.parameters as Record<string, unknown>;
    expect(parameters.enable_thinking).toBe(true);
    expect(parameters.reasoning_effort).toBe("low");
  });

  it("clamps max_tokens to the caller's limit", () => {
    const request = build({ maxTokens: 40_000 });
    expect((request.body.parameters as Record<string, unknown>).max_tokens).toBe(40_000);
  });

  it("rejects a non-positive max_tokens", () => {
    expect(() => build({ maxTokens: 0 })).toThrow("positive integer");
  });

  it("uses the upstream key returned by the model config", () => {
    const request = build({}, lite, { key: "qmodel" });
    expect(request.upstreamModel).toBe("qmodel");
    expect((request.body.chat_context as { extra: { modelConfig: { key: string } } }).extra.modelConfig.key).toBe(
      "qmodel",
    );
  });

  it("preserves the session id and marks is_retry on a resume attempt", () => {
    const options = { sessionId: "session-abc", [QODER_RESUME_ATTEMPT]: 1 } as SimpleStreamOptions;
    expect(isResumeAttempt(options)).toBe(true);
    const request = build(options);
    expect(request.sessionID).toBe("session-abc");
    expect(request.body.is_retry).toBe(true);
  });

  it("uses the host session id as the prompt cache key when it fits", () => {
    const request = build({ sessionId: "s1" });
    expect(request.sessionID).toBe("qoder-session-user-1-lite-s1");
  });
});
