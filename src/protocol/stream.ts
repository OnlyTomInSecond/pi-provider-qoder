import crypto from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { RequestAbortScope } from "../abort.js";
import { resolveQoderIdentity } from "../auth/oauth.js";
import { getCachedModelConfig } from "../catalog.js";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import type { QoderProvider } from "../credits.js";
import { readResponseText, withAbort } from "../http.js";
import { getQoderChatURL, getQoderModeForProvider, getQoderRegionConfig } from "../region.js";
import { MAX_STREAM_BUFFER_LENGTH, readNumericOption } from "../util.js";
import { yieldToEventLoop } from "../yield.js";
import { DELTA_FLUSH_INTERVAL_MS, DeltaCoalescer } from "./delta-coalescer.js";
import { type DsmlParserEvent, DsmlToolCallParser } from "./dsml.js";
import { qoderEncodeBodyAsync } from "./encoding.js";
import { parseModelBusyRejection, QoderModelBusyError, resolveModelBusyLimits, sleepWithAbort } from "./model-busy.js";
import { buildQoderChatRequest, isResumeAttempt, QODER_RESUME_ATTEMPT } from "./request-builder.js";
import { buildContinuationContext, hasGeneratedContent, isResumableTimeout, relayContinuation } from "./resume.js";
import { decodeQoderSseData } from "./sse.js";
import { isDegenerateDsmlTurn } from "./thinking.js";
import { isThinkingRequested, ThinkingSink } from "./thinking-sink.js";
import { ToolCallAccumulator } from "./tool-calls.js";
import { applyQoderUsage } from "./usage.js";

// Re-exported for callers/tests that inspect the model-busy envelope directly.
export { parseModelBusyRejection } from "./model-busy.js";

const SSE_LINES_PER_YIELD = 32;
type QoderStreamEvent = Parameters<AssistantMessageEventStream["push"]>[0];
const QODER_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Longest reasoning tail kept for the degenerate-turn check (trailing markup only). */
const RAW_REASONING_TAIL_LENGTH = 512;

interface MappedFinishReason {
  stopReason: "stop" | "length" | "toolUse" | "error";
  errorMessage?: string;
}

/**
 * Map Qoder's OpenAI-style `finish_reason` to a pi stop reason. Unknown values
 * degrade to `error` with a diagnostic (like pi's own OpenAI provider) instead
 * of throwing mid-stream, so already-streamed content is still finalized.
 */
function mapFinishReason(reason: string): MappedFinishReason {
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "tool_calls":
    case "function_call":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Qoder finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Qoder finish_reason: network_error" };
    default:
      return { stopReason: "error", errorMessage: `Qoder finish_reason: ${reason}` };
  }
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  const deltaIntervalMs = readNumericOption(
    "QODER_STREAM_DELTA_INTERVAL_MS",
    options?.env,
    DELTA_FLUSH_INTERVAL_MS,
    (value) => Number.isFinite(value) && value >= 0,
  );
  const coalescer = new DeltaCoalescer(deltaIntervalMs, (event) => stream.push(event));
  const pushEvent = (event: QoderStreamEvent): void => coalescer.push(event);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const abortScope = new RequestAbortScope({
    externalSignal: options?.signal,
    timeoutMs: options?.timeoutMs,
  });
  const throwIfAborted = (): void => abortScope.throwIfAborted();

  const resumeAfterTimeout = async (): Promise<boolean> => {
    if (
      isResumeAttempt(options) ||
      options?.signal?.aborted ||
      !effectiveSessionID ||
      !hasGeneratedContent(output) ||
      output.content.some((block) => block.type === "toolCall")
    ) {
      return false;
    }

    const continuationContext = buildContinuationContext(context, output);
    const continuationOptions = {
      ...options,
      sessionId: effectiveSessionID,
      [QODER_RESUME_ATTEMPT]: 1,
    } as SimpleStreamOptions;
    const continuation = streamQoder(model, continuationContext, continuationOptions);
    await relayContinuation(output, continuation, pushEvent);
    return true;
  };
  let effectiveSessionID: string | undefined;

  (async () => {
    try {
      throwIfAborted();
      const providerMode = getQoderModeForProvider(model.provider);
      const provider: QoderProvider = providerMode === "cn" ? "qoder-cn" : "qoder";

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
        signal: abortScope.signal,
        fetch: options?.fetch,
        timeoutMs: options?.timeoutMs,
      });
      throwIfAborted();

      // Both providers expose the upstream display_name (whitespace stripped)
      // as the pi id. Read the original key from cached/static config so the
      // gateway still receives identifiers such as `lite` or `qmodel`.
      const modelConfig = getCachedModelConfig(model.id, providerMode);
      if (!modelConfig?.key) {
        throw new Error(`Unknown Qoder model id: ${model.id}`);
      }

      await yieldToEventLoop();
      throwIfAborted();

      const identity = {
        userID: ident.userID || "qoder-user",
        name: ident.name || region.userNameFallback,
        email: ident.email || region.userEmailFallback,
        machineID: ident.machineID || getMachineId(),
      };
      const request = buildQoderChatRequest({
        model,
        context,
        options,
        providerMode,
        modelConfig,
        identity,
      });
      const reqBody = request.body;
      const qoderModel = request.upstreamModel;
      effectiveSessionID = request.sessionID;

      // Hooks see the logical JSON payload, not Qoder's encoded wire bytes.
      // Sign only after replacement/mutation so COSY hashes describe the actual body.
      const replacement = options?.onPayload
        ? await withAbort(Promise.resolve(options.onPayload(reqBody, model)), abortScope.signal)
        : undefined;
      const payload = replacement === undefined ? reqBody : replacement;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Qoder onPayload must return a JSON object or undefined");
      }
      throwIfAborted();

      const chatURL = getQoderChatURL(providerMode, model.baseUrl);

      // pi 1.4 reports its client identity in `options.identity` instead of
      // merging a User-Agent into `options.headers`. Qoder authenticates with
      // COSY headers and is not an attribution target, so host identity is not
      // applied here; model/request headers can still set a User-Agent.
      const outgoingConfig = (payload as { model_config?: { key?: string; source?: string } }).model_config;
      const modelSource = outgoingConfig?.source || modelConfig.source || "system";
      // Resolve the (optional) idle-timeout override once per request instead of
      // re-reading process.env on every streamed chunk.
      const idleTimeoutMs = readNumericOption(
        "QODER_STREAM_IDLE_TIMEOUT_MS",
        options?.env,
        QODER_STREAM_IDLE_TIMEOUT_MS,
        (value) => Number.isFinite(value) && value > 0,
      );

      const encodeAndSign = async (): Promise<{ body: Buffer; headers: Record<string, string> }> => {
        const bodyBytes = Buffer.from(JSON.stringify(payload));
        // qoderEncodeBodyAsync writes the transformed body straight into a
        // preallocated Buffer, yielding to the event loop on large requests
        // (small bodies encode synchronously, so host fake-timer tests do not
        // need to drain setImmediate).
        const encoded = await qoderEncodeBodyAsync(bodyBytes, abortScope.signal);
        throwIfAborted();
        const signed = buildAuthHeaders(encoded, chatURL, {
          userID: identity.userID,
          authToken: accessToken,
          name: identity.name,
          email: identity.email,
          machineID: identity.machineID,
        });
        return { body: encoded, headers: signed };
      };

      let encodedBytes: Buffer;
      let headers: Record<string, string>;
      ({ body: encodedBytes, headers } = await encodeAndSign());

      const { retries: modelBusyRetries, maxWaitMs: modelBusyMaxWaitMs } = resolveModelBusyLimits(options);

      // Any raw generation field ends recovery for this stream: a retry could
      // duplicate text, thinking, or tool arguments (including fragments still
      // buffered in the tag parser). Reset per attempt.
      let sawModelOutput = false;

      // Exactly one `start` per logical stream: recovery retries reuse it.
      pushEvent({ type: "start", partial: output });

      /**
       * One wire attempt. Model-busy rejections may be retried; every other
       * failure propagates. All mutable state (output metadata, sinks) is
       * re-created per attempt so a failed attempt cannot leak into the next.
       */
      const runAttempt = async (): Promise<void> => {
        throwIfAborted();
        // Reset every mutable output field BEFORE the request: a failed attempt
        // may otherwise leak metadata, usage (including Qoder credits) or a
        // finish_reason into the attempt that succeeds, or into the terminal
        // error when the next attempt fails at fetch/HTTP level.
        output.stopReason = "pending";
        output.errorMessage = undefined;
        output.responseId = undefined;
        output.responseModel = undefined;
        output.usage = zeroUsage();
        sawModelOutput = false;

        abortScope.startIdleWatch(idleTimeoutMs);

        const fetchPromise = (options?.fetch ?? fetch)(chatURL, {
          method: "POST",
          headers: providerHeadersToRecord(
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
          signal: abortScope.signal,
        }).then((received) => {
          if (abortScope.signal.aborted) {
            void received.body?.cancel().catch(() => {});
            throwIfAborted();
          }
          return received;
        });
        response = await withAbort(fetchPromise, abortScope.signal);
        abortScope.resetIdle();
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
            abortScope.signal,
          );
        }
        throwIfAborted();

        if (!response.ok) {
          const errText = await readResponseText(response, abortScope.signal);
          const busy = parseModelBusyRejection(errText);
          if (busy) {
            throw new QoderModelBusyError(`Upstream status ${response.status}: ${errText}`, busy.retryAfterMs, false);
          }
          throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
        }

        reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const notifyProviderStreamEvent = async (event: unknown): Promise<void> => {
          if (!options?.onProviderStreamEvent) return;
          await withAbort(Promise.resolve(options.onProviderStreamEvent(event, model)), abortScope.signal);
        };
        const decoder = new TextDecoder();
        let buffer = "";

        const toolCalls = new ToolCallAccumulator(output, pushEvent);

        // Qoder streams can carry <thinking> markup even without an explicit
        // reasoning request, so tag parsing is on unless the host disabled it.
        // Older pi builds passed `false`/`"off"` before reasoning became a typed
        // ThinkingLevel option; keep tolerating those legacy values.
        const thinking = new ThinkingSink(output, stream, pushEvent, {
          parseTags: isThinkingRequested(options?.reasoning),
        });
        const dsmlParser = new DsmlToolCallParser();

        // Tail of the reasoning channel before residue is stripped. Only the tail
        // matters (the degenerate-turn check looks for trailing markup), so this
        // stays bounded instead of growing with the reply.
        let rawReasoningTail = "";

        // DSML tool markup can be leaked through EITHER the reasoning_content or
        // the content channel. Feed both through the one parser so a wrapper that
        // splits across the two channels still reassembles and ids stay unique,
        // tagging every emitted text event with the channel it arrived on:
        // reasoning text lands in a thinking block, content text in the regular
        // text sink. Tool events are channel-agnostic and always become tool
        // calls (never shown as tags).
        const processDsmlEvent = (event: DsmlParserEvent, fromReasoning: boolean): void => {
          if (event.type === "text") {
            if (fromReasoning) thinking.pushReasoning(event.text);
            else thinking.pushContent(event.text);
            return;
          }

          thinking.boundary();
          if (event.type === "tool_start") {
            toolCalls.startDsmlCall(event.id, event.name);
            return;
          }

          toolCalls.appendDsmlArguments(event.id, event.arguments);
        };

        const processDsmlChunk = (content: string, fromReasoning: boolean): void => {
          for (const event of dsmlParser.processChunk(content)) processDsmlEvent(event, fromReasoning);
        };

        // `data: [DONE]` is the end of the response. Break the read loop too, not
        // just the line loop: Qoder's gateway keeps the HTTP body open after the
        // sentinel, so waiting for `done` from reader.read() hung until the
        // server or the OS eventually closed the socket. The full reply had
        // already been streamed by then, so the agent looked stuck with no error.
        let sawDone = false;
        let linesSinceYield = 0;

        while (!sawDone) {
          const { done, value } = await withAbort(reader.read(), abortScope.signal);
          throwIfAborted();
          if (!done) abortScope.resetIdle();

          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          if (buffer.length > MAX_STREAM_BUFFER_LENGTH && !buffer.includes("\n")) {
            throw new Error(`Qoder SSE buffer exceeded ${MAX_STREAM_BUFFER_LENGTH} characters without a complete line`);
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          // A final data line need not end with a newline. Decode it before EOF validation.
          if (done && buffer) {
            lines.push(buffer);
            buffer = "";
          }
          if (buffer.length > MAX_STREAM_BUFFER_LENGTH) {
            throw new Error(`Qoder SSE buffer exceeded ${MAX_STREAM_BUFFER_LENGTH} characters without a complete line`);
          }

          for (const rawLine of lines) {
            const line = rawLine.trim();

            // Yield every N lines to keep the event loop responsive. The flush
            // inside is throttled by DELTA_FLUSH_INTERVAL_MS, so a fast stream
            // coalesces deltas instead of re-rendering once per SSE line.
            if (++linesSinceYield >= SSE_LINES_PER_YIELD) {
              linesSinceYield = 0;
              coalescer.flush();
              await yieldToEventLoop();
              throwIfAborted();
            }

            if (!line.startsWith("data:")) continue;

            try {
              const decoded = decodeQoderSseData(line.substring(5).trim());
              if (decoded.type === "done") {
                sawDone = true;
                break;
              }
              if (decoded.type === "empty") continue;

              const inner = decoded.value;
              await notifyProviderStreamEvent(inner);
              if (inner.id) output.responseId = inner.id;
              if (inner.model) output.responseModel = inner.model;
              if (inner.usage) {
                // Qoder Credits ride along on the Usage object; the provider is
                // recorded so the session footer can split Global/CN totals.
                applyQoderUsage(output.usage, inner.usage, provider);
              }
              if (inner.choices && inner.choices.length > 0) {
                const choice = inner.choices[0];
                const delta = choice.delta;

                if (delta) {
                  // Any raw generation field ends recovery for this stream: a
                  // retry could duplicate text, thinking, or tool arguments
                  // (including fragments still buffered in the tag parser).
                  if (
                    delta.reasoning_content ||
                    delta.content ||
                    (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
                  ) {
                    sawModelOutput = true;
                  }

                  // 1. Process reasoning/thinking content (API reasoning). DSML
                  // tool calls are also sometimes leaked through this channel, so
                  // route it through the DSML parser too: non-DSML reasoning text
                  // becomes a thinking block, while any embedded tool call is
                  // extracted and replayed as a real tool call instead of showing
                  // up as literal tags inside the thinking.
                  if (delta.reasoning_content) {
                    rawReasoningTail = (rawReasoningTail + delta.reasoning_content).slice(-RAW_REASONING_TAIL_LENGTH);
                    processDsmlChunk(delta.reasoning_content, true);
                  }

                  // 2. Process text content. DSML tool calls may be embedded in
                  // delta.content when the gateway fails to expose tool_calls.
                  if (delta.content) {
                    processDsmlChunk(delta.content, false);
                  }
                  // 3. Process native structured tool calls.
                  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) toolCalls.processNativeDelta(tc);
                  }
                }

                if (choice.finish_reason) {
                  output.rawStopReason = String(choice.finish_reason);
                  const mapped = mapFinishReason(output.rawStopReason);
                  output.stopReason = mapped.stopReason;
                  if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
                }
              }
            } catch (e) {
              // A model-busy rejection is retryable; let it reach the attempt loop.
              if (e instanceof QoderModelBusyError) throw e;
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

        // The reader is cancelled in the outer finally so normal completion,
        // parsing errors, idle timeouts, and external aborts all release the
        // connection.

        // Flush any text or DSML markup split across the final content delta.
        for (const event of dsmlParser.finalize()) processDsmlEvent(event, false);

        thinking.finalize();

        const hasToolCalls = toolCalls.finalize();
        if (hasToolCalls) {
          output.stopReason = "toolUse";
        } else if (output.stopReason === "toolUse") {
          throw new Error("Qoder finished with tool_calls but returned no tool calls");
        }

        // A turn the gateway stripped the tool call out of has no text and no
        // tool call, so `stop` reads as a finished task: the agent loop ends the
        // turn and the work dies with no error to retry. Report it instead.
        if (isDegenerateDsmlTurn(output, rawReasoningTail)) {
          // "server error" is deliberate: pi-ai classifies an assistant error by
          // matching its message (RETRYABLE_PROVIDER_ERROR_PATTERN), and that
          // phrase is what makes the turn retryable instead of a dead end.
          throw new Error(
            "Qoder server error: degenerate model output (unparseable DSML tool-call markup, no tool call executed)",
          );
        }

        if (output.stopReason !== "stop" && output.stopReason !== "length" && output.stopReason !== "toolUse") {
          throw new Error(output.errorMessage || "Qoder generation failed");
        }
        // Release the connection before reporting completion: a recovery retry
        // must not leave the previous attempt's socket open.
        await releaseBody();
        pushEvent({
          type: "done",
          reason: output.stopReason,
          message: output,
        });
        stream.end();
      };

      for (let attempt = 0; ; attempt++) {
        try {
          await runAttempt();
          return;
        } catch (e) {
          if (!(e instanceof QoderModelBusyError)) throw e;
          if (e.sawModelOutput || sawModelOutput || output.content.length > 0) {
            // Keep this wording out of pi-ai's retryable pattern: retrying a
            // turn that already emitted content would duplicate it.
            throw new Error("Qoder model rejected the request after partial output (10605 RESOURCE_LIMIT)");
          }
          const requestedWaitMs = e.retryAfterMs ?? 0;
          if (attempt >= modelBusyRetries) {
            throw new QoderModelBusyError(
              `Qoder server error: model is busy (10605 RESOURCE_LIMIT, retryAfterSeconds=${Math.round(requestedWaitMs / 1000)}, attempts=${attempt + 1})`,
              requestedWaitMs,
            );
          }
          if (requestedWaitMs > modelBusyMaxWaitMs) {
            throw new QoderModelBusyError(
              `Qoder server error: model is busy (10605 RESOURCE_LIMIT, requested delay ${requestedWaitMs}ms exceeds local cap ${modelBusyMaxWaitMs}ms)`,
              requestedWaitMs,
            );
          }
          await releaseBody();
          await sleepWithAbort(requestedWaitMs, abortScope.signal);
          // Covers an abort that lands between the wait and the next attempt.
          throwIfAborted();
          // qodercli resets request_id and chat_record_id to ONE new value per
          // recovery attempt and keeps request_set_id, so the server can
          // correlate the retry with the same request set.
          const nextId = crypto.randomUUID();
          (payload as { request_id?: string }).request_id = nextId;
          (payload as { chat_record_id?: string }).chat_record_id = nextId;
          ({ body: encodedBytes, headers } = await encodeAndSign());
        }
      }

      async function releaseBody(): Promise<void> {
        const activeReader = reader;
        const activeResponse = response;
        reader = undefined;
        response = undefined;
        if (activeReader) {
          try {
            await activeReader.cancel().catch(() => {});
          } finally {
            activeReader.releaseLock();
          }
        } else if (activeResponse) {
          await activeResponse.body?.cancel().catch(() => {});
        }
      }
    } catch (e: unknown) {
      let failure = e;
      if (isResumableTimeout(e) && !options?.signal?.aborted) {
        try {
          if (await resumeAfterTimeout()) {
            if (output.stopReason === "pending" || output.stopReason === "error" || output.stopReason === "aborted") {
              throw new Error("Qoder continuation ended without a usable stop reason");
            }
            pushEvent({
              type: "done",
              reason: output.stopReason,
              message: output,
            });
            stream.end();
            return;
          }
        } catch (resumeError) {
          failure = resumeError;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = failure instanceof Error ? failure.message : String(failure);
      pushEvent({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    } finally {
      coalescer.dispose();
      abortScope.dispose();
      if (reader) void reader.cancel().catch(() => {});
      else if (response) void response.body?.cancel().catch(() => {});
    }
  })();

  return stream;
}
