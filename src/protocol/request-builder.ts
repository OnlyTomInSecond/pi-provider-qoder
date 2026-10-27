import crypto from "node:crypto";
import {
  type Api,
  clampThinkingLevel,
  getCurrentSystemMessage,
  getSystemMessageText,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type TranscriptContext,
  withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import type { QoderIdentity } from "../auth/oauth.js";
import { MAX_OUTPUT_TOKENS, type QoderModelEntry } from "../catalog.js";
import type { QoderMode } from "../region.js";
import { getQoderRunIdentity } from "./run-state.js";
import { contentToText, transformMessagesForQoder, transformTools } from "./transform.js";

/** Private option used only between the initial stream and its one resume attempt. */
export const QODER_RESUME_ATTEMPT = "__qoderResumeAttempt";

/** Maximum length of Qoder's `session_id` (upstream `prompt_cache_key`). */
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

type InternalStreamOptions = SimpleStreamOptions & Record<string, unknown>;

/** True while running the internal continuation of a timed-out stream. */
export function isResumeAttempt(options?: SimpleStreamOptions): boolean {
  return (options as InternalStreamOptions | undefined)?.[QODER_RESUME_ATTEMPT] === 1;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Resolve the bounded prompt-cache key, preserving it across an internal resume.
 *
 * When the host supplies no `sessionId`, the fallback is derived from
 * `fallbackSeed` (the conversation's system prompt + first user turn) instead
 * of a fresh UUID: a per-request random id defeats both upstream prompt-cache
 * affinity and the run coalescing in run-state.ts.
 */
function resolveSessionID(
  userID: string,
  qoderModel: string,
  options?: SimpleStreamOptions,
  fallbackSeed = "",
): string {
  const supplied = options?.sessionId;
  if (isResumeAttempt(options) && supplied) return supplied;
  if (!supplied) {
    return `qoder-session-${stableHash("qoder-session", userID, qoderModel, fallbackSeed)}`;
  }

  const readable = `qoder-session-${userID}-${qoderModel}-${supplied}`;
  return readable.length <= MAX_PROMPT_CACHE_KEY_LENGTH
    ? readable
    : `qoder-session-${stableHash("qoder-session", userID, qoderModel, supplied)}`;
}

export interface QoderChatRequestInput {
  model: Model<Api>;
  context: TranscriptContext;
  options?: SimpleStreamOptions;
  providerMode: QoderMode;
  /** Catalog/static config for `model.id`; `key` must be present. */
  modelConfig: QoderModelEntry;
  identity: QoderIdentity;
}

export interface QoderChatRequest {
  /** Logical JSON payload seen by `onPayload` and COSY signing. */
  body: Record<string, unknown>;
  /** Upstream model key sent to the gateway (`model_config.key`). */
  upstreamModel: string;
  /** Session id forwarded as `prompt_cache_key`; stable across a resume. */
  sessionID: string;
}

/** Resolve the output cap from the upstream ceiling and any host/pi limits. */
function resolveMaxTokens(model: Model<Api>, options?: SimpleStreamOptions): number {
  // Qoder's catalog exposes no per-model output cap, so we use the documented
  // upstream ceiling (MAX_OUTPUT_TOKENS = 131072) and let pi cap it lower when
  // the caller sets options.maxTokens (e.g. compaction at 40K). This avoids
  // truncating reasoning chains / long generations that the 32K default would
  // cut off.
  let maxTokens = MAX_OUTPUT_TOKENS;
  for (const limit of [model.maxTokens, options?.maxTokens]) {
    if (limit === undefined) continue;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("Qoder maxTokens must be a positive integer");
    maxTokens = Math.min(maxTokens, limit);
  }
  return maxTokens;
}

/**
 * Map pi's thinking level (`options.reasoning`) to Qoder's request fields.
 *
 * Confirmed from @qoder-ai/qodercli: the chat body carries `reasoning_effort`
 * ("none"|"low"|"medium"|"high"|"xhigh"|"max") and `enable_thinking` (bool)
 * inside `parameters`, alongside `max_tokens`. This mirrors the pi-ai OpenAI
 * provider: clamp the requested level to what the model advertises via
 * `thinkingLevelMap`, then map to the upstream effort name.
 */
function buildParameters(
  model: Model<Api>,
  modelConfig: QoderModelEntry,
  options?: SimpleStreamOptions,
): { parameters: Record<string, unknown>; thinkingEnabled: boolean } {
  const parameters: Record<string, unknown> = { max_tokens: resolveMaxTokens(model, options) };
  if (options?.temperature !== undefined) parameters.temperature = options.temperature;

  const requestedLevel = options?.reasoning;

  // Normalize every host's "thinking off" signal into one flag. pi and OMP both
  // resolve level "off" to `reasoning: undefined`; OMP's fork also sets
  // `disableReasoning` / `forceReasoningOff`; `false` / `"off"` cover older
  // hosts. When off, skip clamping so the request never snaps back up to a
  // concrete level.
  const extOptions = options as
    | (SimpleStreamOptions & { disableReasoning?: boolean; forceReasoningOff?: boolean })
    | undefined;
  const explicitlyOff =
    extOptions?.disableReasoning === true ||
    extOptions?.forceReasoningOff === true ||
    (requestedLevel as unknown) === false ||
    (requestedLevel as unknown) === "off";
  const clamped = !explicitlyOff && requestedLevel ? clampThinkingLevel(model, requestedLevel) : undefined;
  const reasoningLevel = clamped === "off" ? undefined : clamped;

  if (!reasoningLevel) {
    // Explicitly disable thinking. `enable_thinking: false` alone is not enough:
    // qodercli also sends `reasoning_effort: "none"` (and flips
    // `model_config.is_reasoning`), otherwise the gateway still routes the
    // reasoning model as reasoning-enabled.
    //
    // Exception: when the catalog positively shows the model has no disabled
    // branch (effort-based thinking_config without `disabled`, or
    // thinkingLevelMap pinning `off` to null), some upstreams reject
    // `reasoning_effort: "none"` outright (Sonus: 400 "Unsupported value:
    // 'none'"). For those, omit the effort signal — the request stays valid and
    // `enable_thinking: false` is the strongest disable the upstream accepts.
    // With no catalog signal either way (static fallback / tests), keep sending
    // "none".
    parameters.enable_thinking = false;
    const tc = modelConfig.thinking_config;
    const lacksDisabledBranch = (tc?.enabled?.efforts && !tc.disabled) || model.thinkingLevelMap?.off === null;
    if (!lacksDisabledBranch) {
      parameters.reasoning_effort = "none";
    }
    return { parameters, thinkingEnabled: false };
  }

  parameters.enable_thinking = true;
  // Effort-based models advertise concrete effort names in the map
  // (low/medium/xhigh/max). Toggle-only models map every level to
  // "enabled"/"disabled" and accept no effort value — only the on/off switch
  // matters, so we send enable_thinking alone.
  const mapped = model.thinkingLevelMap?.[reasoningLevel];
  const effort = mapped && mapped !== "enabled" && mapped !== "disabled" ? mapped : reasoningLevel;
  // Only send reasoning_effort when the upstream model actually exposes effort
  // levels (thinking_config.enabled.efforts).
  if (modelConfig.thinking_config?.enabled?.efforts && typeof effort === "string") {
    parameters.reasoning_effort = effort;
  }
  return { parameters, thinkingEnabled: true };
}

/**
 * Build the logical Qoder chat payload for one model round.
 *
 * Pure with respect to I/O: identity and model config are resolved by the
 * caller, so the resulting body can be asserted directly in tests instead of
 * being decoded out of the wire-encoded request.
 */
export function buildQoderChatRequest(input: QoderChatRequestInput): QoderChatRequest {
  const { model, context, options, providerMode, modelConfig, identity } = input;
  const qoderModel = modelConfig.key;
  if (!qoderModel) throw new Error(`Unknown Qoder model id: ${model.id}`);

  // 0.99.x passes a normalized TranscriptContext: the system prompt and tool
  // declarations are folded into the transcript's leading system message
  // instead of being top-level fields. Read them back with the transcript
  // helpers, and strip that system message from the list before mapping history
  // to Qoder's OpenAI-shaped messages. The resolved prompt is then sent as one
  // leading system message.
  const transcriptMessages = withoutInitialSystemMessage(context.messages);
  const normalizedMessages = transformMessagesForQoder(transcriptMessages);
  // Resolve the current prompt and tool set in a single transcript pass:
  // getCurrentSystemPrompt() would re-walk the messages (and re-resolve the
  // tools internally) on top of the getCurrentTools() call below.
  //
  // The leading system message is the only proof that the host folded
  // `systemPrompt` and `tools` into the transcript. Some hosts that export the
  // >=0.86 transcript toolkit still pass a flat Context (omp 18.12.x does), so
  // when no folded system message exists fall back to the flat fields instead
  // of silently sending an empty prompt and `tools: []`.
  const currentSystem = getCurrentSystemMessage(context.messages);
  const flatContext = context as TranscriptContext & { systemPrompt?: unknown; tools?: Tool[] };
  const systemText = currentSystem
    ? getSystemMessageText(currentSystem)
    : contentToText(flatContext.systemPrompt ?? "");

  let lastUserText = "";
  for (let i = normalizedMessages.length - 1; i >= 0; i--) {
    if (normalizedMessages[i].role === "user") {
      lastUserText = contentToText(normalizedMessages[i].content);
      break;
    }
  }

  // Use a stable session id when pi provides one (per agent session) so the
  // Qoder server can maintain prompt cache affinity across consecutive
  // requests. Qoder forwards session_id as prompt_cache_key upstream. Without a
  // host session id, derive one from the conversation's opening turns so
  // consecutive tool rounds keep the same affinity and run identity.
  const fallbackSeed = `${systemText}\0${contentToText(normalizedMessages[0]?.content ?? "")}`;
  const sessionID = resolveSessionID(identity.userID, qoderModel, options, fallbackSeed);

  const currentTools = currentSystem?.toolsAdded ?? flatContext.tools ?? [];
  const toolsRaw = currentTools.length > 0 ? transformTools(currentTools) : undefined;
  const { parameters, thinkingEnabled } = buildParameters(model, modelConfig, options);

  // Qoder groups billing/records per agentic "run". qodercli keeps one
  // request_set_id + business.id per run (created at run start, threaded through
  // every tool round/retry/subagent); infer the run boundary from the message
  // tail and reuse the run identity.
  const { requestSetId, business } = getQoderRunIdentity({
    mode: providerMode,
    model: qoderModel,
    sessionId: sessionID,
    messages: normalizedMessages,
    lastUserText,
    resume: isResumeAttempt(options),
    product: "cli",
  });
  const requestID = crypto.randomUUID();

  const body: Record<string, unknown> = {
    // request_id / chat_record_id are per-request (qodercli sets
    // chat_record_id = request_id); request_set_id is the run-scoped id.
    request_id: requestID,
    request_set_id: requestSetId,
    chat_record_id: requestID,
    session_id: sessionID,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: isResumeAttempt(options),
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    // Qoder's server ignores the top-level `system` field (verified: the model
    // never sees it). Inject the system prompt as a leading role:system message
    // instead, which the server does honor.
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
          is_reasoning: thinkingEnabled && !!modelConfig.is_reasoning,
        },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: thinkingEnabled ? modelConfig : { ...modelConfig, is_reasoning: false },
    // Stable per run: same id/name/begin_at across the run's requests; stage
    // advances init -> start -> processing like qodercli's lifecycle.
    business,
  };

  return { body, upstreamModel: qoderModel, sessionID };
}
