import { afterEach, describe, expect, it, vi } from "vitest";
import { model } from "../opencode.js";

const { fetchUserInfo, exchangeJobToken } = vi.hoisted(() => ({
  fetchUserInfo: vi
    .fn()
    .mockResolvedValue({ userID: "opencode-user", email: "user@example.com", name: "OpenCode User" }),
  exchangeJobToken: vi
    .fn()
    .mockResolvedValue({ jobToken: "jt-exchanged", jobRefreshToken: "", expiresAt: Date.now() + 3600_000 }),
}));

vi.mock("../auth/pat.js", () => ({ fetchUserInfo, exchangeJobToken }));

function envelope(body: object, statusCodeValue = 200): string {
  return `data:${JSON.stringify({ body: JSON.stringify(body), statusCodeValue })}\n\n`;
}

const done = `data:${JSON.stringify({ body: "[DONE]", statusCodeValue: 200 })}\n\n`;

function chunk(delta: object, finish_reason?: string): object {
  return {
    choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }],
    id: "opencode-test-id",
    model: "lite",
  };
}

function mockChat(body: string): void {
  globalThis.fetch = vi.fn(
    async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  ) as unknown as typeof fetch;
}

async function consume(stream: ReadableStream<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenCode Qoder provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchUserInfo.mockClear();
    exchangeJobToken.mockClear();
    vi.restoreAllMocks();
  });

  it("streams text, tagged thinking, and native tool calls", async () => {
    mockChat(
      envelope(chunk({ reasoning_content: "checking" })) +
        envelope(chunk({ content: "<thinking>details</thinking>answer" })) +
        envelope(
          chunk(
            { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } }] },
            "tool_calls",
          ),
        ) +
        done,
    );

    const language = model("Lite", { apiKey: "jt-token", region: "global" });
    const result = await language.doStream({
      prompt: [
        { role: "system", content: "You are an agent." },
        { role: "user", content: [{ type: "text", text: "inspect a" }] },
      ],
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
    });
    const events = await consume(result.stream as ReadableStream<Record<string, unknown>>);

    expect(events[0]?.type).toBe("stream-start");
    expect(events.some((event) => event.type === "reasoning-start")).toBe(true);
    expect(events.filter((event) => event.type === "reasoning-delta").map((event) => event.delta)).toEqual([
      "checking",
      "details",
    ]);
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.delta)).toEqual(["answer"]);
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      toolCallId: "call_1",
      toolName: "read",
      input: '{"path":"a"}',
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual(expect.objectContaining({ "X-Model-Key": "lite", "Cosy-User": "opencode-user" }));
  });

  it("converts leaked DSML tool calls to OpenCode tool events", async () => {
    const dsml =
      `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n` +
      `<｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>\n` +
      `</｜DSML｜invoke>\n</｜DSML｜tool_calls>`;
    mockChat(envelope(chunk({ content: dsml }, "stop")) + done);

    const language = model("Lite", { apiKey: "jt-token-dsml", region: "global" });
    const result = await language.doStream({ prompt: [{ role: "user", content: "list files" }] });
    const events = await consume(result.stream as ReadableStream<Record<string, unknown>>);

    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      toolCallId: "dsml_call_0",
      toolName: "bash",
      input: '{"command":"ls"}',
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("exchanges a PAT before sending the Qoder request", async () => {
    mockChat(envelope(chunk({ content: "ok" }, "stop")) + done);

    const language = model("Lite", { apiKey: "pt-personal-token", region: "global" });
    const result = await language.doStream({ prompt: [{ role: "user", content: "hello" }] });
    await consume(result.stream as ReadableStream<Record<string, unknown>>);

    expect(exchangeJobToken).toHaveBeenCalledWith("pt-personal-token", "global");
    expect(fetchUserInfo).toHaveBeenCalledWith("jt-exchanged", "global");
  });
});
