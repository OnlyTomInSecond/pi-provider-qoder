import crypto from "node:crypto";
import * as PiAi from "@earendil-works/pi-ai";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  clampThinkingLevel,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
} from "@earendil-works/pi-ai";
import { resolveQoderIdentity } from "../auth/oauth.js";
import { getCachedModelConfig, MAX_OUTPUT_TOKENS } from "../catalog.js";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import { getQoderChatURL, getQoderRegionConfig } from "../region.js";
import { type DsmlParserEvent, DsmlToolCallParser } from "./dsml.js";
import { qoderEncodeBodyAsync } from "./encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking.js";
import { ToolCallAccumulator } from "./tool-calls.js";
import { contentToText, transformMessagesForQoder, transformTools } from "./transform.js";
import { parseQoderCreditsUsage, type QoderCreditsUsage } from "./usage.js";

type QoderAssistantUsage = AssistantMessage["usage"] & QoderCreditsUsage;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const SSE_LINES_PER_YIELD = 32;

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

export interface StableRecordIDInput {
  mode: string;
  model: string;
  systemText: string;
  messages: Array<{ role?: string; content?: unknown }>;
  tools: unknown;
  parameters: Record<string, unknown>;
}

function updateHashField(hash: ReturnType<typeof crypto.createHash>, name: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(name);
  hash.update(":");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
}

export function stableChatRecordID(input: StableRecordIDInput): string {
  const hash = crypto.createHash("sha256");
  updateHashField(hash, "schema", "qoder-record-v2");
  updateHashField(hash, "mode", input.mode);
  updateHashField(hash, "model", input.model);
  updateHashField(hash, "system", input.systemText);
  updateHashField(hash, "messages", JSON.stringify(input.messages));
  updateHashField(hash, "tools", JSON.stringify(input.tools ?? []));
  updateHashField(hash, "parameters", JSON.stringify(input.parameters));
  return hash.digest("hex").slice(0, 16);
}

type QoderStreamEvent = Parameters<AssistantMessageEventStream["push"]>[0];
type QoderDeltaEvent = Extract<QoderStreamEvent, { type: "text_delta" | "thinking_delta" | "toolcall_delta" }>;

const QODER_STREAM_IDLE_TIMEOUT_MS = 120_000;
const MAX_SSE_BUFFER_LENGTH = 8 * 1024 * 1024;

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  let pendingDelta: QoderDeltaEvent | null = null;
  const flushPendingDelta = (): void => {
    if (pendingDelta) {
      stream.push(pendingDelta);
      pendingDelta = null;
    }
  };
  const pushEvent = (event: QoderStreamEvent): void => {
    if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
      if (pendingDelta && pendingDelta.type === event.type && pendingDelta.contentIndex === event.contentIndex) {
        pendingDelta = { ...pendingDelta, delta: pendingDelta.delta + event.delta };
        return;
      }
      flushPendingDelta();
      pendingDelta = event;
      return;
    }
    flushPendingDelta();
    stream.push(event);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const requestController = new AbortController();
  const externalSignal = options?.signal;
  let removeExternalAbortListener: (() => void) | undefined;
  if (externalSignal) {
    const abortFromExternal = (): void => requestController.abort(externalSignal.reason);
    if (externalSignal.aborted) requestController.abort(externalSignal.reason);
    else {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
      removeExternalAbortListener = () => externalSignal.removeEventListener("abort", abortFromExternal);
    }
  }
  const throwIfAborted = (): void => {
    if (!requestController.signal.aborted) return;
    const reason = requestController.signal.reason;
    throw reason instanceof Error ? reason : new Error("Qoder request aborted");
  };

  (async () => {
    try {
      throwIfAborted();
      const providerMode = model.provider === "qoder-cn" ? "cn" : "global";
      const region = getQoderRegionConfig(providerMode);
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error(
          providerMode === "cn"
            ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN."
            : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
        );
      }

      // Resolve the real Qoder identity from the job token. OMP keeps login
      // credentials in its own agent.db, not in ~/.pi/agent/auth.json, so a
      // cache miss would otherwise send uid "qoder-user" and Qoder CN rejects
      // it with "Login expired" (105).
      const ident = await resolveQoderIdentity(accessToken, model.provider, providerMode);
      throwIfAborted();
      const userID = ident.userID || "qoder-user";
      const name = ident.name || region.userNameFallback;
      const email = ident.email || region.userEmailFallback;
      const machineID = ident.machineID || getMachineId();

      // Both providers expose the upstream display_name (whitespace stripped)
      // as the pi id. Read the original key from cached/static config so the
      // gateway still receives identifiers such as `lite` or `qmodel`.
      const modelConfig = getCachedModelConfig(model.id, providerMode);
      if (!modelConfig?.key) {
        throw new Error(`Unknown Qoder model id: ${model.id}`);
      }
      const qoderModel = modelConfig.key;

      const isReasoning = !!modelConfig.is_reasoning;

      await yieldToEventLoop();
      throwIfAborted();
      const normalizedMessages = transformMessagesForQoder(context.messages);
      // OMP may supply the system prompt as a single-element content array;
      // Qoder MessagesInputDto#content is a String and rejects an array with
      // "Execution failed: set property ... MessagesInputDto#content". Normalize.
      const systemText = contentToText(context.systemPrompt || "", "\n");

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          lastUserText = contentToText(normalizedMessages[i].content);
          break;
        }
      }

      // Use a stable session id when pi provides one (per agent session) so
      // the Qoder server can maintain prompt cache affinity across consecutive
      // requests. Fall back to a random id only when no sessionId is available.
      const stablePart = stableHash("qoder-session", userID, qoderModel);
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : `${stablePart}-${crypto.randomUUID()}`;

      // Qoder's catalog exposes no per-model output cap, so we use the
      // documented upstream ceiling (MAX_OUTPUT_TOKENS = 131072, see models.ts)
      // and let pi cap it lower when the caller sets options.maxTokens (e.g.
      // compaction at 40K). This avoids truncating reasoning chains / long
      // generations that the 32K default would cut off.
      let maxTokens = MAX_OUTPUT_TOKENS;
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
      // Map pi's thinking level (options.reasoning) to Qoder's request fields.
      // Confirmed from @qoder-ai/qodercli: the chat body carries `reasoning_effort`
      // ("none"|"low"|"medium"|"high"|"xhigh"|"max") and `enable_thinking` (bool)
      // inside `parameters`, alongside `max_tokens`.
      //
      // This mirrors the pattern the pi-ai OpenAI provider uses: clamp the
      // requested level to what the model advertises via thinkingLevelMap, then
      // map to the upstream effort name. clampThinkingLevel returns "off" when
      // the level is unsupported or the user disabled thinking.
      const requestedLevel = options?.reasoning;
      const clamped = requestedLevel ? clampThinkingLevel(model, requestedLevel) : undefined;
      const reasoningLevel = clamped === "off" ? undefined : clamped;
      const parameters: Record<string, unknown> = { max_tokens: maxTokens };
      if (reasoningLevel) {
        parameters.enable_thinking = true;
        // Effort-based models advertise concrete effort names in the map
        // (low/medium/xhigh/max). Toggle-only models map every level to
        // "enabled"/"disabled" and accept no effort value — only the on/off
        // switch matters, so we send enable_thinking alone.
        const mapped = model.thinkingLevelMap?.[reasoningLevel];
        const effort = mapped && mapped !== "enabled" && mapped !== "disabled" ? mapped : reasoningLevel;
        // Only send reasoning_effort when the upstream model actually exposes
        // effort levels (thinking_config.enabled.efforts).
        if (modelConfig?.thinking_config?.enabled?.efforts && typeof effort === "string") {
          parameters.reasoning_effort = effort;
        }
      } else {
        // No reasoning level selected (or clamped to off): explicitly disable
        // thinking so the model does not reason by default.
        parameters.enable_thinking = false;
      }

      const recordID = stableChatRecordID({
        mode: providerMode,
        model: qoderModel,
        systemText,
        messages: normalizedMessages,
        tools: toolsRaw || [],
        parameters,
      });

      const reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        // Qoder's server ignores the top-level `system` field (verified: the
        // model never sees it). Inject the system prompt as a leading
        // role:system message instead, which the server does honor.
        system: "",
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
        tools: toolsRaw || [],
        parameters,
        chat_context: {
          chatPrompt: "",
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: {
              key: qoderModel,
              is_reasoning: isReasoning,
            },
            originalContent: lastUserText,
          },
          features: [],
          text: lastUserText,
        },
        model_config: modelConfig,
        business: {
          product: "cli",
          version: "1.0.0",
          type: "agent",
          stage: "start",
          id: crypto.randomUUID(),
          name: lastUserText.substring(0, 30),
          begin_at: Date.now(),
        },
      };

      const bodyBytes = Buffer.from(JSON.stringify(reqBody));
      throwIfAborted();
      await yieldToEventLoop();
      const encodedBody = await qoderEncodeBodyAsync(bodyBytes);
      throwIfAborted();
      const encodedBytes = Buffer.from(encodedBody, "utf8");

      const chatURL = getQoderChatURL(providerMode);

      const headers = buildAuthHeaders(encodedBytes, chatURL, {
        userID,
        authToken: accessToken,
        name,
        email,
        machineID,
      });

      const modelSource = modelConfig.source || "system";
      const resetIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        const configuredIdleTimeout = Number(process.env.QODER_STREAM_IDLE_TIMEOUT_MS);
        const idleTimeout =
          Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout > 0
            ? configuredIdleTimeout
            : QODER_STREAM_IDLE_TIMEOUT_MS;
        idleTimer = setTimeout(() => {
          requestController.abort(new Error("Qoder stream idle timeout"));
        }, idleTimeout);
      };
      resetIdleTimer();

      const response = await fetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": qoderModel,
          "X-Model-Source": modelSource,
          ...headers,
        },
        body: encodedBytes,
        signal: requestController.signal,
      });
      resetIdleTimer();

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
      }

      reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCalls = new ToolCallAccumulator(output, pushEvent);

      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream, pushEvent) : null;
      const dsmlParser = new DsmlToolCallParser();

      const endApiThinking = (): void => {
        if (thinkingBlockIndex === -1) return;
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        pushEvent({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
        thinkingBlockIndex = -1;
      };

      const processTextChunk = (text: string): void => {
        if (!text) return;
        if (thinkingParser) {
          thinkingParser.processChunk(text);
          return;
        }
        if (contentBlockIndex === -1) {
          contentBlockIndex = output.content.length;
          output.content.push({ type: "text", text: "" });
          pushEvent({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
        }
        const block = output.content[contentBlockIndex] as TextContent;
        block.text += text;
        pushEvent({
          type: "text_delta",
          contentIndex: contentBlockIndex,
          delta: text,
          partial: output,
        });
      };

      const processDsmlEvent = (event: DsmlParserEvent): void => {
        if (event.type === "text") {
          processTextChunk(event.text);
          return;
        }

        thinkingParser?.flushAtBoundary();
        endApiThinking();
        if (event.type === "tool_start") {
          toolCalls.startDsmlCall(event.id, event.name);
          return;
        }

        toolCalls.appendDsmlArguments(event.id, event.arguments);
      };

      const processDsmlChunk = (content: string): void => {
        for (const event of dsmlParser.processChunk(content)) processDsmlEvent(event);
      };

      pushEvent({ type: "start", partial: output });

      // `data: [DONE]` is the end of the response. Break the read loop too, not
      // just the line loop: Qoder's gateway keeps the HTTP body open after the
      // sentinel, so waiting for `done` from reader.read() hung until the
      // server or the OS eventually closed the socket. The full reply had
      // already been streamed by then, so the agent looked stuck with no error.
      let sawDone = false;
      let linesSinceYield = 0;

      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimer();

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_LENGTH && !buffer.includes("\n")) {
          throw new Error(`Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without a complete line`);
        }

        while (true) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd === -1) {
            if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
              throw new Error(`Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without a complete line`);
            }
            break;
          }

          const line = buffer.substring(0, lineEnd).trim();
          buffer = buffer.substring(lineEnd + 1);

          if (++linesSinceYield >= SSE_LINES_PER_YIELD) {
            linesSinceYield = 0;
            flushPendingDelta();
            await yieldToEventLoop();
          }

          if (!line.startsWith("data:")) continue;

          const dataStr = line.substring(5).trim();
          if (dataStr === "[DONE]") {
            sawDone = true;
            break;
          }

          try {
            const envelope = JSON.parse(dataStr);
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
            }

            const innerStr = envelope.body;
            // The gateway sends the sentinel wrapped in an envelope
            // (`body: "[DONE]"`) as well as bare, and both mean the reply is
            // over, so both have to end the read loop.
            if (innerStr === "[DONE]") {
              sawDone = true;
              break;
            }
            if (!innerStr) continue;

            const inner = JSON.parse(innerStr);
            if (inner.id) output.responseId = inner.id as string;
            if (inner.model) output.responseModel = inner.model as string;
            if (inner.usage) {
              const u = inner.usage as {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                completion_tokens_details?: { reasoning_tokens?: number };
                prompt_tokens_details?: {
                  cacheable_tokens?: number;
                  cached_tokens?: number;
                  cache_write_tokens?: number;
                };
              };
              // pi-core computes `promptTokens = input + cacheRead + cacheWrite`
              // (Anthropic convention: `input` EXCLUDES cached/written tokens).
              // Qoder follows OpenAI semantics where `prompt_tokens` INCLUDES
              // `cached_tokens`, so subtract cacheRead (and cache_write_tokens
              // when reported) to match the contract pi-ai's own OpenAI
              // provider uses. `cacheable_tokens` is a capacity metric, not a
              // write count (it is 0 even on first-turn writes), so it is NOT
              // mapped to cacheWrite.
              const promptTokens = u.prompt_tokens ?? 0;
              const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
              const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
              output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
              output.usage.output = u.completion_tokens ?? 0;
              output.usage.totalTokens = u.total_tokens ?? 0;
              output.usage.cacheRead = cacheReadTokens;
              output.usage.cacheWrite = cacheWriteTokens;
              if (typeof u.completion_tokens_details?.reasoning_tokens === "number") {
                output.usage.reasoning = u.completion_tokens_details.reasoning_tokens;
              }

              // Qoder Credits are not USD and pi-ai 0.80 has no native Credits
              // field. Preserve the official optional names on the runtime
              // usage object so hosts can read them without corrupting
              // usage.cost. Missing fields remain absent, not zero.
              Object.assign(output.usage as QoderAssistantUsage, parseQoderCreditsUsage(inner.usage));
            }
            if (inner.choices && inner.choices.length > 0) {
              const choice = inner.choices[0];
              const delta = choice.delta;

              if (delta) {
                // 1. Process reasoning/thinking content (API reasoning)
                if (delta.reasoning_content) {
                  // Qoder's backend sometimes routes a literal `<thinking>`
                  // opener into reasoning_content (with the matching
                  // `</thinking>` closer landing in the content stream). Strip
                  // tag artifacts so the thinking block stays clean, matching
                  // the SDK's ContentBlock model.
                  const reasoningChunk = stripThinkingTags(delta.reasoning_content);
                  if (reasoningChunk) {
                    if (thinkingBlockIndex === -1) {
                      thinkingParser?.flushAtBoundary();
                      thinkingBlockIndex = output.content.length;
                      output.content.push({ type: "thinking", thinking: "" });
                      pushEvent({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                    }
                    const block = output.content[thinkingBlockIndex] as ThinkingContent;
                    block.thinking += reasoningChunk;
                    pushEvent({
                      type: "thinking_delta",
                      contentIndex: thinkingBlockIndex,
                      delta: reasoningChunk,
                      partial: output,
                    });
                  }
                }

                // 2. Process text content. DSML tool calls may be embedded in
                // delta.content when the gateway fails to expose tool_calls.
                if (delta.content) {
                  // End API thinking block if active before switching to text or
                  // a tool call embedded in the content stream.
                  endApiThinking();
                  processDsmlChunk(delta.content);
                }
                // 3. Process native structured tool calls.
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) toolCalls.processNativeDelta(tc);
                }
              }

              if (choice.finish_reason) {
                // Preserve the real upstream finish_reason (e.g. "length",
                // "content_filter") instead of forcing "stop" later.
                output.stopReason = choice.finish_reason as AssistantMessage["stopReason"];
              }
            }
          } catch (e) {
            // A single malformed SSE line shouldn't kill the stream — skip it.
            // But a genuine upstream error (thrown below) must propagate to the
            // outer catch and surface as stopReason="error", not be swallowed.
            if (e instanceof SyntaxError) {
              if (process.env.QODER_DEBUG) {
                console.error("[pi-provider-qoder] skipping malformed SSE line:", dataStr.slice(0, 200));
              }
              continue;
            }
            throw e;
          }
        }
      }

      // The reader is cancelled in finally so normal completion, parsing errors,
      // idle timeouts, and external aborts all release the connection.

      // Flush any text or DSML markup split across the final content delta.
      for (const event of dsmlParser.finalize()) processDsmlEvent(event);

      if (thinkingParser) {
        thinkingParser.finalize();
      }

      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        pushEvent({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }

      const hasToolCalls = toolCalls.finalize();
      if (hasToolCalls) {
        output.stopReason = "toolUse";
      }
      // Otherwise keep whatever finish_reason set upstream (defaults to "stop").
      // Never overwrite a meaningful finish_reason ("length", "content_filter",
      // ...) with "stop".
      pushEvent({
        type: "done",
        reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
        message: output,
      });
      stream.end();
    } catch (e: unknown) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      pushEvent({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      removeExternalAbortListener?.();
      if (reader) await reader.cancel().catch(() => {});
    }
  })();

  return stream;
}
