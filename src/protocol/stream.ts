import crypto from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getSystemMessageText,
  type Model,
  type SimpleStreamOptions,
  type ThinkingContent,
  type TranscriptContext,
  withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import { resolveQoderIdentity } from "../auth/oauth.js";
import { getCachedModelConfig, MAX_OUTPUT_TOKENS } from "../catalog.js";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import { readResponseText, withAbort } from "../http.js";
import { getQoderChatURL, getQoderRegionConfig } from "../region.js";
import { yieldToEventLoop } from "../yield.js";
import { type DsmlParserEvent, DsmlToolCallParser } from "./dsml.js";
import { qoderEncodeBodyAsync } from "./encoding.js";
import { mergeQoderHeaders } from "./request.js";
import { getQoderRunIdentity } from "./run-state.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking.js";
import { ToolCallAccumulator } from "./tool-calls.js";
import { contentToText, transformMessagesForQoder, transformTools } from "./transform.js";
import { parseQoderCreditsUsage, type QoderCreditsUsage } from "./usage.js";

type QoderAssistantUsage = AssistantMessage["usage"] & QoderCreditsUsage;

/** False only when the host explicitly disabled thinking for this request. */
function isThinkingRequested(reasoning: unknown): boolean {
  return reasoning !== false && reasoning !== "off";
}

const SSE_LINES_PER_YIELD = 32;
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

/**
 * Minimum wall-clock interval between coalesced delta pushes. Hosts (pi) rebuild
 * and re-layout the whole text/thinking block on every `message_update`, so
 * emitting one delta per SSE line makes rendering quadratic in the response
 * length. Coalescing deltas to ~20 pushes/second keeps the UI smooth while
 * bounding that render work. Override with QODER_STREAM_DELTA_INTERVAL_MS.
 */
const DELTA_FLUSH_INTERVAL_MS = 50;

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

type QoderStreamEvent = Parameters<AssistantMessageEventStream["push"]>[0];
type QoderDeltaEvent = Extract<QoderStreamEvent, { type: "text_delta" | "thinking_delta" | "toolcall_delta" }>;

const QODER_STREAM_IDLE_TIMEOUT_MS = 120_000;
const MAX_SSE_BUFFER_LENGTH = 8 * 1024 * 1024;

function mapFinishReason(reason: string): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    default:
      throw new Error(`Qoder generation ended with ${reason}`);
  }
}

export function streamQoder(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

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
    stopReason: "pending",
    timestamp: Date.now(),
  };

  let pendingDelta: QoderDeltaEvent | null = null;
  let lastDeltaFlushAt = Date.now();
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  const configuredDeltaInterval = Number(
    options?.env?.QODER_STREAM_DELTA_INTERVAL_MS ?? process.env.QODER_STREAM_DELTA_INTERVAL_MS,
  );
  const deltaIntervalMs =
    Number.isFinite(configuredDeltaInterval) && configuredDeltaInterval >= 0
      ? configuredDeltaInterval
      : DELTA_FLUSH_INTERVAL_MS;
  /** Push the coalesced delta, unless we pushed one within the throttle window. */
  const flushPendingDelta = (force = false): void => {
    if (!pendingDelta) return;
    const now = Date.now();
    if (!force && now - lastDeltaFlushAt < deltaIntervalMs) return;
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = undefined;
    stream.push(pendingDelta);
    pendingDelta = null;
    lastDeltaFlushAt = now;
  };
  const scheduleDeltaFlush = (): void => {
    flushPendingDelta();
    if (!pendingDelta || deltaTimer) return;
    deltaTimer = setTimeout(
      () => {
        deltaTimer = undefined;
        flushPendingDelta(true);
      },
      Math.max(0, deltaIntervalMs - (Date.now() - lastDeltaFlushAt)),
    );
  };
  const pushEvent = (event: QoderStreamEvent): void => {
    if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
      if (pendingDelta && pendingDelta.type === event.type && pendingDelta.contentIndex === event.contentIndex) {
        // Mutate in place rather than spreading a new object on every merged
        // delta: coalescing is the hottest path in a streamed response and the
        // object has no other references consumers rely on.
        pendingDelta.delta += event.delta;
        scheduleDeltaFlush();
        return;
      }
      // A different block/type must keep its ordering, so flush unconditionally.
      flushPendingDelta(true);
      pendingDelta = event;
      scheduleDeltaFlush();
      return;
    }
    // Any non-delta event is an ordering boundary (start/end/done/error).
    flushPendingDelta(true);
    stream.push(event);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const requestController = new AbortController();
  const requestTimer =
    options?.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => requestController.abort(new Error("Qoder request timeout")), options.timeoutMs)
      : undefined;
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
      const ident = await resolveQoderIdentity(accessToken, model.provider, providerMode, {
        signal: requestController.signal,
        fetch: options?.fetch,
        timeoutMs: options?.timeoutMs,
      });
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
      // 0.86.0+ passes a normalized TranscriptContext: the system prompt and
      // tool declarations are folded into the transcript's leading system
      // message instead of being top-level fields. Read them back with the
      // transcript helpers, and strip that system message from the list before
      // mapping history to Qoder's OpenAI-shaped messages. The resolved prompt
      // is then sent as one leading system message.
      const transcriptMessages = withoutInitialSystemMessage(context.messages);
      const normalizedMessages = transformMessagesForQoder(transcriptMessages);
      // Resolve the current prompt and tool set in a single transcript pass:
      // getCurrentSystemPrompt() would re-walk the messages (and re-resolve the
      // tools internally) on top of the getCurrentTools() call below.
      const currentSystem = getCurrentSystemMessage(context.messages);
      const systemText = currentSystem ? getSystemMessageText(currentSystem) : "";

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          lastUserText = contentToText(normalizedMessages[i].content);
          break;
        }
      }

      // Use a stable session id when pi provides one (per agent session) so
      // the Qoder server can maintain prompt cache affinity across consecutive
      // requests. Qoder forwards session_id as prompt_cache_key upstream,
      // which has a maximum length of 64 characters. Preserve the readable
      // form when it fits; hash the complete identity when it does not so the
      // bounded key remains stable for the same user/model/session.
      const sessionID = options?.sessionId
        ? (() => {
            const readable = `qoder-session-${userID}-${qoderModel}-${options.sessionId}`;
            return readable.length <= MAX_PROMPT_CACHE_KEY_LENGTH
              ? readable
              : `qoder-session-${stableHash("qoder-session", userID, qoderModel, options.sessionId)}`;
          })()
        : `${stableHash("qoder-session", userID, qoderModel)}-${crypto.randomUUID()}`;

      // Qoder's catalog exposes no per-model output cap, so we use the
      // documented upstream ceiling (MAX_OUTPUT_TOKENS = 131072, see models.ts)
      // and let pi cap it lower when the caller sets options.maxTokens (e.g.
      // compaction at 40K). This avoids truncating reasoning chains / long
      // generations that the 32K default would cut off.
      let maxTokens = MAX_OUTPUT_TOKENS;
      for (const limit of [model.maxTokens, options?.maxTokens]) {
        if (limit === undefined) continue;
        if (!Number.isInteger(limit) || limit <= 0) throw new Error("Qoder maxTokens must be a positive integer");
        maxTokens = Math.min(maxTokens, limit);
      }

      const currentTools = currentSystem?.toolsAdded ?? [];
      const toolsRaw = currentTools.length > 0 ? transformTools(currentTools) : undefined;
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
      if (options?.temperature !== undefined) parameters.temperature = options.temperature;
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

      // Qoder groups billing/records per agentic "run". qodercli keeps one
      // request_set_id + business.id per run (created at run start, threaded
      // through every tool round/retry/subagent); this plugin used to re-derive
      // them from a hash of the whole (growing) history, so every tool round
      // looked like a separate never-finished run on the credit ledger. Infer
      // the run boundary from the message tail and reuse the run identity.
      const { requestSetId, business } = getQoderRunIdentity({
        mode: providerMode,
        model: qoderModel,
        sessionId: sessionID,
        messages: normalizedMessages,
        lastUserText,
        product: "cli",
      });
      const requestID = crypto.randomUUID();

      const reqBody: Record<string, unknown> = {
        // request_id / chat_record_id are per-request (qodercli sets
        // chat_record_id = request_id); request_set_id is the run-scoped id.
        request_id: requestID,
        request_set_id: requestSetId,
        chat_record_id: requestID,
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
        // Stable per run: same id/name/begin_at across the run's requests;
        // stage advances init -> start -> processing like qodercli's lifecycle.
        business,
      };

      // Hooks see the logical JSON payload, not Qoder's encoded wire bytes.
      // Sign only after replacement/mutation so COSY hashes describe the actual body.
      const replacement = options?.onPayload
        ? await withAbort(Promise.resolve(options.onPayload(reqBody, model)), requestController.signal)
        : undefined;
      const payload = replacement === undefined ? reqBody : replacement;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Qoder onPayload must return a JSON object or undefined");
      }
      const bodyBytes = Buffer.from(JSON.stringify(payload));
      throwIfAborted();
      await yieldToEventLoop();
      // qoderEncodeBodyAsync writes the transformed body straight into a
      // preallocated Buffer, yielding to the event loop on large requests.
      const encodedBytes = await qoderEncodeBodyAsync(bodyBytes, requestController.signal);
      throwIfAborted();

      const chatURL = getQoderChatURL(providerMode, model.baseUrl);

      const headers = buildAuthHeaders(encodedBytes, chatURL, {
        userID,
        authToken: accessToken,
        name,
        email,
        machineID,
      });

      const outgoingConfig = (payload as { model_config?: { key?: string; source?: string } }).model_config;
      const modelSource = outgoingConfig?.source || modelConfig.source || "system";
      // Resolve the (optional) idle-timeout override once per request instead of
      // re-reading process.env on every streamed chunk.
      const configuredIdleTimeout = Number(
        options?.env?.QODER_STREAM_IDLE_TIMEOUT_MS ?? process.env.QODER_STREAM_IDLE_TIMEOUT_MS,
      );
      const idleTimeoutMs =
        Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout > 0
          ? configuredIdleTimeout
          : QODER_STREAM_IDLE_TIMEOUT_MS;
      const resetIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          requestController.abort(new Error("Qoder stream idle timeout"));
        }, idleTimeoutMs);
      };
      resetIdleTimer();

      const fetchPromise = (options?.fetch ?? fetch)(chatURL, {
        method: "POST",
        headers: mergeQoderHeaders(
          {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
            "Accept-Encoding": "identity",
            "X-Model-Key": outgoingConfig?.key || qoderModel,
            "X-Model-Source": modelSource,
            ...headers,
          },
          model.headers,
          options?.headers,
        ),
        // Buffer is a valid Uint8Array at runtime but not in DOM's BodyInit union.
        body: encodedBytes as unknown as BodyInit,
        signal: requestController.signal,
      }).then((received) => {
        if (requestController.signal.aborted) {
          void received.body?.cancel().catch(() => {});
          throwIfAborted();
        }
        return received;
      });
      response = await withAbort(fetchPromise, requestController.signal);
      resetIdleTimer();
      if (options?.onResponse) {
        await withAbort(
          Promise.resolve(
            options.onResponse(
              {
                status: response.status,
                headers: Object.fromEntries(response.headers.entries()),
              },
              model,
            ),
          ),
          requestController.signal,
        );
      }
      throwIfAborted();

      if (!response.ok) {
        const errText = await readResponseText(response, requestController.signal);
        throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
      }

      reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      let thinkingBlockIndex = -1;
      const toolCalls = new ToolCallAccumulator(output, pushEvent);

      // Qoder streams can carry <thinking> markup even without an explicit
      // reasoning request, so tag parsing is on unless the host disabled it.
      // Older pi builds passed `false`/`"off"` before reasoning became a typed
      // ThinkingLevel option; keep tolerating those legacy values.
      const thinkingEnabled = isThinkingRequested(options?.reasoning);
      const thinkingParser = new ThinkingTagParser(output, stream, pushEvent, { parseTags: thinkingEnabled });
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

      const appendApiThinking = (chunk: string): void => {
        // Qoder's backend sometimes routes a literal `<thinking>` opener into
        // reasoning_content (with the matching `</thinking>` closer landing in
        // the content stream). Strip tag artifacts so the thinking block stays
        // clean, matching the SDK's ContentBlock model.
        const cleaned = stripThinkingTags(chunk);
        if (!cleaned) return;
        if (thinkingBlockIndex === -1) {
          thinkingParser.flushAtBoundary();
          thinkingBlockIndex = output.content.length;
          output.content.push({ type: "thinking", thinking: "" });
          pushEvent({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
        }
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        block.thinking += cleaned;
        pushEvent({
          type: "thinking_delta",
          contentIndex: thinkingBlockIndex,
          delta: cleaned,
          partial: output,
        });
      };

      // DSML tool markup can be leaked through EITHER the reasoning_content or
      // the content channel. Feed both through the one parser so a wrapper that
      // splits across the two channels still reassembles and ids stay unique,
      // tagging every emitted text event with the channel it arrived on:
      // reasoning text lands in the API thinking block, content text in the
      // regular text sink. Tool events are channel-agnostic and always become
      // tool calls (never shown as tags).
      const processDsmlEvent = (event: DsmlParserEvent, fromReasoning: boolean): void => {
        if (event.type === "text") {
          if (fromReasoning) appendApiThinking(event.text);
          else thinkingParser.processChunk(event.text);
          return;
        }

        thinkingParser.flushAtBoundary();
        endApiThinking();
        if (event.type === "tool_start") {
          toolCalls.startDsmlCall(event.id, event.name);
          return;
        }

        toolCalls.appendDsmlArguments(event.id, event.arguments);
      };

      const processDsmlChunk = (content: string, fromReasoning: boolean): void => {
        for (const event of dsmlParser.processChunk(content)) processDsmlEvent(event, fromReasoning);
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
        const { done, value } = await withAbort(reader.read(), requestController.signal);
        throwIfAborted();
        if (!done) resetIdleTimer();

        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_LENGTH && !buffer.includes("\n")) {
          throw new Error(`Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without a complete line`);
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        // A final data line need not end with a newline. Decode it before EOF validation.
        if (done && buffer) {
          lines.push(buffer);
          buffer = "";
        }
        if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
          throw new Error(`Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters without a complete line`);
        }

        for (const rawLine of lines) {
          const line = rawLine.trim();

          // Yield every N lines to keep the event loop responsive. The flush
          // inside is throttled by DELTA_FLUSH_INTERVAL_MS, so a fast stream
          // coalesces deltas instead of re-rendering once per SSE line.
          if (++linesSinceYield >= SSE_LINES_PER_YIELD) {
            linesSinceYield = 0;
            flushPendingDelta();
            await yieldToEventLoop();
            throwIfAborted();
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
            if (inner.error || (inner.code && inner.message && !inner.choices)) {
              const error = inner.error ?? inner;
              throw new Error(`Qoder upstream error: ${typeof error === "string" ? error : JSON.stringify(error)}`);
            }
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
              output.usage.totalTokens = u.total_tokens ?? promptTokens + output.usage.output;
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
                // 1. Process reasoning/thinking content (API reasoning). DSML
                // tool calls are also sometimes leaked through this channel, so
                // route it through the DSML parser too: non-DSML reasoning text
                // becomes a thinking block, while any embedded tool call is
                // extracted and replayed as a real tool call instead of showing
                // up as literal tags inside the thinking.
                if (delta.reasoning_content) {
                  processDsmlChunk(delta.reasoning_content, true);
                }

                // 2. Process text content. DSML tool calls may be embedded in
                // delta.content when the gateway fails to expose tool_calls.
                if (delta.content) {
                  // End API thinking block if active before switching to text or
                  // a tool call embedded in the content stream.
                  endApiThinking();
                  processDsmlChunk(delta.content, false);
                }
                // 3. Process native structured tool calls.
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) toolCalls.processNativeDelta(tc);
                }
              }

              if (choice.finish_reason) {
                output.rawStopReason = String(choice.finish_reason);
                output.stopReason = mapFinishReason(output.rawStopReason);
              }
            }
          } catch (e) {
            // Skipping a broken data event could silently corrupt text or tool JSON.
            if (e instanceof SyntaxError) throw new Error("Malformed Qoder SSE data");
            throw e;
          }
        }
        if (done) break;
      }

      throwIfAborted();
      if (output.stopReason === "pending") {
        if (!sawDone) throw new Error("Qoder stream ended before a terminal event (unexpected EOF)");
        // Some gateway variants send only [DONE], without a finish_reason.
        output.stopReason = "stop";
      }
      if (output.stopReason === "length" && output.content.some((block) => block.type === "toolCall")) {
        throw new Error("Qoder tool call was truncated by the output token limit");
      }

      // The reader is cancelled in finally so normal completion, parsing errors,
      // idle timeouts, and external aborts all release the connection.

      // Flush any text or DSML markup split across the final content delta.
      for (const event of dsmlParser.finalize()) processDsmlEvent(event, false);

      thinkingParser.finalize();
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
      } else if (output.stopReason === "toolUse") {
        throw new Error("Qoder finished with tool_calls but returned no tool calls");
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "Qoder generation failed");
      }
      pushEvent({
        type: "done",
        reason: output.stopReason,
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
      if (deltaTimer) clearTimeout(deltaTimer);
      if (requestTimer) clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
      removeExternalAbortListener?.();
      if (reader) void reader.cancel().catch(() => {});
      else if (response) void response.body?.cancel().catch(() => {});
    }
  })();

  return stream;
}
