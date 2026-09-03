import crypto from "node:crypto";
import { exchangeJobToken, fetchUserInfo } from "./auth/pat.js";
import { getCachedModelConfig, MAX_OUTPUT_TOKENS } from "./catalog.js";
import { buildAuthHeaders, getMachineId } from "./cosy.js";
import { type DsmlParserEvent, DsmlToolCallParser } from "./protocol/dsml.js";
import { qoderEncodeBodyAsync } from "./protocol/encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./protocol/thinking.js";
import { getQoderChatURL, getQoderRegionConfig, type QoderMode } from "./region.js";

/** Settings supplied by OpenCode's native provider package contract. */
export interface QoderOpenCodeSettings {
  apiKey?: string;
  region?: QoderMode;
  mode?: QoderMode;
  sessionId?: string;
  reasoningEffort?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  [key: string]: unknown;
}

// OpenCode passes provider settings and stream parts through a runtime-defined contract.
// Keep this boundary structural; the protocol internals remain strictly typed.
// biome-ignore lint/suspicious/noExplicitAny: OpenCode's native provider contract is runtime-defined
type AnyRecord = Record<string, any>;
type StreamPart = AnyRecord;

type QoderIdentity = {
  accessToken: string;
  userID: string;
  name: string;
  email: string;
  machineID: string;
};

type ToolState = {
  id: string;
  name: string;
  arguments: string;
  opened: boolean;
};

const credentialCache = new Map<string, Promise<QoderIdentity>>();
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const MAX_SSE_BUFFER_LENGTH = 8 * 1024 * 1024;

function modeFromSettings(settings: QoderOpenCodeSettings): QoderMode {
  return settings.region === "cn" || settings.mode === "cn" ? "cn" : "global";
}

function tokenFromSettings(settings: QoderOpenCodeSettings, mode: QoderMode): string {
  if (typeof settings.apiKey === "string" && settings.apiKey.trim()) return settings.apiKey.trim();
  for (const envName of getQoderRegionConfig(mode).patEnvNames) {
    const value = process.env[envName];
    if (value) return value;
  }
  return "";
}

async function resolveIdentity(settings: QoderOpenCodeSettings, mode: QoderMode): Promise<QoderIdentity> {
  const configuredToken = tokenFromSettings(settings, mode);
  if (!configuredToken) {
    throw new Error(
      mode === "cn"
        ? "Qoder CN credentials missing. Set QODERCN_API_KEY or configure provider settings.apiKey."
        : "Qoder credentials missing. Set QODER_API_KEY or configure provider settings.apiKey.",
    );
  }

  const cacheKey = `${mode}:${configuredToken}`;
  const cached = credentialCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    let accessToken = configuredToken;
    if (configuredToken.startsWith("pt-")) {
      const exchanged = await exchangeJobToken(configuredToken, mode);
      accessToken = exchanged.jobToken;
    }

    const region = getQoderRegionConfig(mode);
    const info = await fetchUserInfo(accessToken, mode);
    return {
      accessToken,
      userID: info.userID || "qoder-user",
      name: info.name || region.userNameFallback,
      email: info.email || region.userEmailFallback,
      machineID: getMachineId(),
    };
  })();

  credentialCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    credentialCache.delete(cacheKey);
    throw error;
  }
}

function hashValue(prefix: string, ...values: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const value of values) {
    hash.update("\0");
    hash.update(value);
  }
  return hash.digest("hex").slice(0, 24);
}

function hashField(hash: ReturnType<typeof crypto.createHash>, name: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(name);
  hash.update(":");
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
}

function stableRecordID(
  mode: QoderMode,
  model: string,
  systemText: string,
  messages: unknown,
  tools: unknown,
  parameters: unknown,
): string {
  const hash = crypto.createHash("sha256");
  hashField(hash, "schema", "qoder-record-opencode-v1");
  hashField(hash, "mode", mode);
  hashField(hash, "model", model);
  hashField(hash, "system", systemText);
  hashField(hash, "messages", JSON.stringify(messages));
  hashField(hash, "tools", JSON.stringify(tools ?? []));
  hashField(hash, "parameters", JSON.stringify(parameters));
  return hash.digest("hex").slice(0, 16);
}

function textFromOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromOutput).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const item = value as AnyRecord;
  if (typeof item.value === "string") return item.value;
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.value)) return item.value.map(textFromOutput).join("\n");
  return JSON.stringify(value);
}

function imageDataURL(part: AnyRecord): string | undefined {
  if (typeof part.data === "string") {
    return part.data.startsWith("data:")
      ? part.data
      : `data:${part.mediaType || "application/octet-stream"};base64,${part.data}`;
  }
  if (part.data instanceof Uint8Array) {
    return `data:${part.mediaType || "application/octet-stream"};base64,${Buffer.from(part.data).toString("base64")}`;
  }
  return undefined;
}

function userContent(content: unknown): string | Array<AnyRecord> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: Array<AnyRecord> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text });
    if (part.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/")) {
      const url = imageDataURL(part);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
    if (part.type === "image" && typeof part.image === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image } });
    }
  }
  return parts.length > 0 ? parts : "";
}

function assistantMessage(content: unknown): AnyRecord {
  let text = "";
  const toolCalls: AnyRecord[] = [];

  if (typeof content === "string") text = content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") text += part.text;
      if ((part.type === "reasoning" || part.type === "thinking") && typeof (part.text ?? part.thinking) === "string") {
        text += `<thinking>${part.text ?? part.thinking}</thinking>\n\n`;
      }
      if (part.type === "tool-call") {
        const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
        toolCalls.push({
          id: part.toolCallId,
          type: "function",
          function: { name: part.toolName, arguments: input },
        });
      }
    }
  }

  const message: AnyRecord = {
    role: "assistant",
    content: text || (toolCalls.length > 0 ? " " : null),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function promptToQoder(prompt: AnyRecord[]): { systemText: string; messages: AnyRecord[]; lastUserText: string } {
  const systemParts: string[] = [];
  const messages: AnyRecord[] = [];

  for (const item of prompt) {
    if (item.role === "system") {
      systemParts.push(textFromOutput(item.content));
      continue;
    }
    if (item.role === "user") {
      messages.push({ role: "user", content: userContent(item.content) });
      continue;
    }
    if (item.role === "assistant") {
      messages.push(assistantMessage(item.content));
      continue;
    }
    if (item.role === "tool") {
      const results = Array.isArray(item.content) ? item.content : [item.content];
      for (const result of results) {
        if (!result || typeof result !== "object") continue;
        if (result.type !== "tool-result") continue;
        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: textFromOutput(result.output),
        });
      }
    }
  }

  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserText = textFromOutput(messages[i].content);
      break;
    }
  }
  return { systemText: systemParts.join("\n"), messages, lastUserText };
}

function toolsToQoder(tools: unknown): AnyRecord[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

function providerOptions(options: AnyRecord, settings: QoderOpenCodeSettings): AnyRecord {
  const all = options.providerOptions as AnyRecord | undefined;
  const scoped = all?.qoder ?? all?.["qoder-api"] ?? {};
  const body = settings.body && typeof settings.body === "object" ? settings.body : {};
  return { ...body, ...scoped };
}

function reasoningParameters(
  options: AnyRecord,
  settings: QoderOpenCodeSettings,
  config: AnyRecord,
  maxTokens: number,
): AnyRecord {
  const overrides = providerOptions(options, settings);
  const effort =
    overrides.reasoning_effort ?? overrides.reasoningEffort ?? options.reasoningEffort ?? settings.reasoningEffort;
  const explicitEnable = overrides.enable_thinking;
  const enabled =
    typeof explicitEnable === "boolean"
      ? explicitEnable
      : typeof effort === "string"
        ? !["off", "none", "disabled"].includes(effort)
        : !!config.is_reasoning || !!config.thinking_config;

  const parameters: AnyRecord = { ...overrides, max_tokens: maxTokens, enable_thinking: enabled };
  if (enabled && typeof effort === "string" && config.thinking_config?.enabled?.efforts) {
    parameters.reasoning_effort = effort;
  }
  return parameters;
}

function finishReason(value: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool-calls";
  if (value === "length") return "length";
  if (value === "content_filter") return "content-filtered";
  return "stop";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class QoderLanguageModel {
  readonly specificationVersion = "v2";
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly modelId: string;
  readonly provider: string;
  private readonly settings: QoderOpenCodeSettings;

  constructor(modelId: string, settings: QoderOpenCodeSettings = {}) {
    this.modelId = modelId;
    this.provider = "qoder";
    this.settings = settings;
  }

  async doStream(
    options: AnyRecord,
  ): Promise<{ stream: ReadableStream<StreamPart>; request?: AnyRecord; response?: AnyRecord }> {
    const controller = new AbortController();
    const externalSignal = options.abortSignal as AbortSignal | undefined;
    const abort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abort();
      else externalSignal.addEventListener("abort", abort, { once: true });
    }

    const stream = new ReadableStream<StreamPart>({
      start: (streamController) => {
        void this.runStream(options, streamController, controller)
          .catch((error) => {
            try {
              streamController.enqueue({ type: "error", error: asError(error) });
              streamController.close();
            } catch {}
          })
          .finally(() => {
            if (externalSignal) externalSignal.removeEventListener("abort", abort);
          });
      },
      cancel: (reason) => controller.abort(reason),
    });
    return { stream };
  }

  async doGenerate(options: AnyRecord): Promise<AnyRecord> {
    const result: AnyRecord[] = [];
    let finish: AnyRecord = { finishReason: "stop", usage: {} };
    const response = await this.doStream(options);
    const reader = response.stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const part = next.value;
        if (part.type === "text-delta") {
          const previous = result.find((item) => item.type === "text");
          if (previous) previous.text += part.delta;
          else result.push({ type: "text", text: part.delta });
        } else if (part.type === "reasoning-delta") {
          const previous = result.find((item) => item.type === "reasoning");
          if (previous) previous.text += part.delta;
          else result.push({ type: "reasoning", text: part.delta });
        } else if (part.type === "tool-call") {
          result.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        } else if (part.type === "finish") {
          finish = part;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return {
      content: result,
      finishReason: finish.finishReason,
      usage: finish.usage ?? {},
      request: { body: "" },
      response: finish.response,
      warnings: [],
    };
  }

  private async runStream(
    options: AnyRecord,
    output: ReadableStreamDefaultController<StreamPart>,
    requestController: AbortController,
  ): Promise<void> {
    const signal = requestController.signal;
    const mode = modeFromSettings(this.settings);
    const identity = await resolveIdentity(this.settings, mode);
    if (signal.aborted) throw asError(signal.reason || new Error("Qoder request aborted"));

    const config = getCachedModelConfig(this.modelId, mode) ?? {
      key: this.modelId,
      is_reasoning: false,
      source: "system",
    };
    const qoderModel = config.key || this.modelId;
    const maxTokens =
      typeof options.maxOutputTokens === "number" && options.maxOutputTokens > 0
        ? Math.min(options.maxOutputTokens, MAX_OUTPUT_TOKENS)
        : MAX_OUTPUT_TOKENS;
    const prompt = promptToQoder((options.prompt || []) as AnyRecord[]);
    const tools = toolsToQoder(options.tools);
    const parameters = reasoningParameters(options, this.settings, config, maxTokens);
    const recordID = stableRecordID(mode, qoderModel, prompt.systemText, prompt.messages, tools, parameters);
    const sessionSeed =
      typeof prompt.messages[0]?.content === "string"
        ? prompt.messages[0].content
        : JSON.stringify(prompt.messages[0]?.content || "");
    const sessionID =
      this.settings.sessionId || hashValue("qoder-opencode-session", identity.userID, qoderModel, sessionSeed);
    const reqBody: AnyRecord = {
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
      session_type: "opencode",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: "",
      messages: prompt.systemText
        ? [{ role: "system", content: prompt.systemText }, ...prompt.messages]
        : prompt.messages,
      tools,
      parameters,
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderModel, is_reasoning: !!config.is_reasoning },
          originalContent: prompt.lastUserText,
        },
        features: [],
        text: prompt.lastUserText,
      },
      model_config: config,
      business: {
        product: "opencode",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: crypto.randomUUID(),
        name: prompt.lastUserText.substring(0, 30),
        begin_at: Date.now(),
      },
    };

    const url = getQoderChatURL(mode);
    const body = Buffer.from(JSON.stringify(reqBody));
    const encoded = Buffer.from(await qoderEncodeBodyAsync(body), "utf8");
    const authHeaders = buildAuthHeaders(encoded, url, {
      userID: identity.userID,
      authToken: identity.accessToken,
      name: identity.name,
      email: identity.email,
      machineID: identity.machineID,
    });
    const modelSource = config.source || "system";
    const headers = {
      ...(this.settings.headers || {}),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
      "X-Model-Key": qoderModel,
      "X-Model-Source": modelSource,
      ...authHeaders,
    };

    const response = await fetch(url, { method: "POST", headers, body: encoded, signal });
    if (!response.ok) {
      const message = (await response.text().catch(() => "")).slice(0, 1000);
      throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. ${message}`);
    }
    if (!response.body) throw new Error("Qoder response has no body");

    const textId = `text-${crypto.randomUUID()}`;
    const reasoningIds: string[] = [];
    let textStarted = false;
    let apiReasoningId: string | undefined;
    let finishValue: unknown = "stop";
    let usage: AnyRecord = {};
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let toolCallCount = 0;
    const toolStates = new Map<number | string, ToolState>();
    const orderedTools: ToolState[] = [];
    const partial: AnyRecord = { content: [] };
    const enqueue = (part: StreamPart): void => {
      if (!signal.aborted) output.enqueue(part);
    };

    const closeApiReasoning = (): void => {
      if (!apiReasoningId) return;
      enqueue({ type: "reasoning-end", id: apiReasoningId });
      apiReasoningId = undefined;
    };

    const emitParserEvent = (event: AnyRecord): void => {
      if (event.type === "text_start") {
        if (!textStarted) {
          textStarted = true;
          enqueue({ type: "text-start", id: textId });
        }
      } else if (event.type === "text_delta") {
        if (!textStarted) {
          textStarted = true;
          enqueue({ type: "text-start", id: textId });
        }
        enqueue({ type: "text-delta", id: textId, delta: event.delta });
      } else if (event.type === "thinking_start") {
        const id = `reasoning-${crypto.randomUUID()}`;
        reasoningIds[event.contentIndex] = id;
        enqueue({ type: "reasoning-start", id });
      } else if (event.type === "thinking_delta") {
        const id = reasoningIds[event.contentIndex] || `reasoning-${crypto.randomUUID()}`;
        reasoningIds[event.contentIndex] = id;
        enqueue({ type: "reasoning-delta", id, delta: event.delta });
      } else if (event.type === "thinking_end") {
        const id = reasoningIds[event.contentIndex];
        if (id) enqueue({ type: "reasoning-end", id });
      }
    };

    const parser = new ThinkingTagParser(partial as never, undefined as never, emitParserEvent as never);
    const dsml = new DsmlToolCallParser();
    const closeTool = (state: ToolState): void => {
      if (!state.opened) return;
      const input = state.arguments || "{}";
      enqueue({ type: "tool-call", toolCallId: state.id, toolName: state.name, input });
      state.opened = false;
      toolCallCount++;
    };
    const openTool = (state: ToolState): void => {
      if (state.opened || (!state.id && !state.name)) return;
      state.opened = true;
      enqueue({ type: "tool-input-start", id: state.id, toolName: state.name });
      if (state.arguments) enqueue({ type: "tool-input-delta", id: state.id, delta: state.arguments });
    };
    const appendTool = (state: ToolState, value: string): void => {
      state.arguments += value;
      if (state.opened) enqueue({ type: "tool-input-delta", id: state.id, delta: value });
    };
    const processDsmlEvent = (event: DsmlParserEvent): void => {
      if (event.type === "text") {
        parser.processChunk(event.text);
      } else if (event.type === "tool_start") {
        parser.flushAtBoundary();
        closeApiReasoning();
        const state: ToolState = { id: event.id, name: event.name, arguments: "", opened: false };
        toolStates.set(event.id, state);
        orderedTools.push(state);
        openTool(state);
      } else {
        const state = toolStates.get(event.id);
        if (state) appendTool(state, event.arguments);
      }
    };

    const processContent = (value: string): void => {
      if (!value) return;
      closeApiReasoning();
      for (const event of dsml.processChunk(value)) processDsmlEvent(event);
    };

    const processDelta = (delta: AnyRecord): void => {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        parser.flushAtBoundary();
        closeApiReasoning();
        if (!apiReasoningId) {
          apiReasoningId = `reasoning-${crypto.randomUUID()}`;
          enqueue({ type: "reasoning-start", id: apiReasoningId });
        }
        const value = stripThinkingTags(delta.reasoning_content);
        if (value) enqueue({ type: "reasoning-delta", id: apiReasoningId, delta: value });
      }
      if (typeof delta.content === "string" && delta.content) processContent(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const item of delta.tool_calls) {
          const key = item.index ?? 0;
          let state = toolStates.get(key);
          if (!state) {
            state = { id: "", name: "", arguments: "", opened: false };
            toolStates.set(key, state);
            orderedTools.push(state);
          }
          if (item.id) state.id = item.id;
          if (item.function?.name) state.name = item.function.name;
          openTool(state);
          if (typeof item.function?.arguments === "string") appendTool(state, item.function.arguments);
        }
      }
    };

    enqueue({ type: "stream-start", warnings: [] });
    let buffer = "";
    let sawDone = false;
    const decoder = new TextDecoder();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        requestController.abort(new Error("Qoder stream idle timeout"));
      }, Number(process.env.QODER_STREAM_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS);
    };
    resetIdle();

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }
      try {
        const envelope = JSON.parse(data);
        if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
          throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
        }
        if (envelope.body === "[DONE]") {
          sawDone = true;
          return;
        }
        if (!envelope.body) return;
        const inner = typeof envelope.body === "string" ? JSON.parse(envelope.body) : envelope.body;
        if (inner.id) responseId = inner.id;
        if (inner.model) responseModel = inner.model;
        if (inner.usage) {
          usage = {
            inputTokens: inner.usage.prompt_tokens,
            outputTokens: inner.usage.completion_tokens,
            totalTokens: inner.usage.total_tokens,
            reasoningTokens: inner.usage.completion_tokens_details?.reasoning_tokens,
          };
        }
        const choice = inner.choices?.[0];
        if (choice?.delta) processDelta(choice.delta);
        if (choice?.finish_reason) finishValue = choice.finish_reason;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const activeReader = response.body.getReader();
      reader = activeReader;
      while (!sawDone) {
        const next = await activeReader.read();
        if (next.done) break;
        resetIdle();
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_LENGTH && !buffer.includes("\n")) {
          throw new Error(`Qoder SSE buffer exceeded ${MAX_SSE_BUFFER_LENGTH} characters`);
        }
        while (true) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          processLine(line);
          if (sawDone) break;
        }
      }
      buffer += decoder.decode();
      if (!sawDone && buffer) processLine(buffer);
      for (const event of dsml.finalize()) processDsmlEvent(event);
      parser.finalize();
      closeApiReasoning();
      for (const state of orderedTools) closeTool(state);
      if (idleTimer) clearTimeout(idleTimer);
      if (textStarted) enqueue({ type: "text-end", id: textId });
      enqueue({
        type: "finish",
        finishReason: finishReason(finishValue, toolCallCount > 0),
        usage,
        response: { id: responseId, modelId: responseModel || this.modelId },
      });
      output.close();
    } catch (error) {
      enqueue({ type: "error", error: asError(error) });
      try {
        output.close();
      } catch {}
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      await reader?.cancel().catch(() => {});
    }
  }
}

/** OpenCode V2 native provider contract. */
export function model(modelID: string, settings: QoderOpenCodeSettings = {}): QoderLanguageModel {
  return new QoderLanguageModel(modelID, settings);
}

/** Compatibility factory for OpenCode releases that load AI SDK-style packages. */
export function createQoder(settings: QoderOpenCodeSettings = {}): {
  languageModel: (modelID: string) => QoderLanguageModel;
} {
  return { languageModel: (modelID: string) => model(modelID, settings) };
}

export default { model };
