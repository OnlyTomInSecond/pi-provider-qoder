import type { ToolCallDelta } from "./tool-calls.js";

/** OpenAI-shaped delta inside a Qoder chunk (reasoning + content + native tool calls). */
export interface QoderChatDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: ToolCallDelta[];
}

export interface QoderChatChoice {
  finish_reason?: string;
  delta?: QoderChatDelta;
}

/** OpenAI-shaped chat chunk that Qoder wraps in its SSE envelope. */
export interface QoderChatChunk {
  id?: string;
  model?: string;
  usage?: unknown;
  error?: unknown;
  code?: unknown;
  message?: unknown;
  choices?: QoderChatChoice[];
}

export type QoderSsePayload = { type: "done" } | { type: "empty" } | { type: "payload"; value: QoderChatChunk };

/**
 * Decode one `data:` line from Qoder's SSE gateway.
 *
 * The gateway wraps each OpenAI-shaped chunk in an outer envelope
 * (`{ statusCodeValue, body }`) where `body` is a JSON string. The `[DONE]`
 * sentinel arrives both bare and wrapped in an envelope, and both end the
 * reply. Throws on a non-200 envelope status or an error payload; a malformed
 * line surfaces as `SyntaxError` for the caller to translate.
 */
export function decodeQoderSseData(dataStr: string): QoderSsePayload {
  if (dataStr === "[DONE]") return { type: "done" };

  const envelope = JSON.parse(dataStr) as { statusCodeValue?: number; body?: string };
  if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
    throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
  }

  const innerStr = envelope.body;
  if (innerStr === "[DONE]") return { type: "done" };
  if (!innerStr) return { type: "empty" };

  const value = JSON.parse(innerStr) as QoderChatChunk;
  if (value.error || (value.code && value.message && !value.choices)) {
    const error = value.error ?? value;
    throw new Error(`Qoder upstream error: ${typeof error === "string" ? error : JSON.stringify(error)}`);
  }
  return { type: "payload", value };
}
