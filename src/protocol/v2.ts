// shape: none — dispatch object does not apply: straight-line build (derive
//   model → wrap options → delegate → forward events) with a single
//   first-event self-heal branch, not a discriminator table.
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { QoderModelEntry } from "../catalog.js";
import { debugLog } from "../debug.js";
import type { QoderMode } from "../region.js";
import { markLegacyOnly } from "./routing.js";
import { streamQoder } from "./stream.js";

interface V2Route {
  mode: QoderMode;
  modelConfig: QoderModelEntry;
  upstreamKey: string;
}

function envValue(options: SimpleStreamOptions | undefined, name: string): string | undefined {
  return options?.env?.[name] ?? process.env[name];
}

function v2BaseUrl(route: V2Route, options?: SimpleStreamOptions): string {
  // pi-ai's OpenAI client appends `/chat/completions` to this base.
  return (
    envValue(options, "QODER_MODEL_SERVER_HOST") ?? (route.mode === "cn" ? "" : "https://api2-v2.qoder.sh/model/v1")
  );
}

// PRD §8.2 outbound allowlist: dispatch only to *.qoder.sh, or to the explicit
// QODER_MODEL_SERVER_HOST value. Anything else errors before dispatch.
function isAllowedV2Host(baseUrl: string, options?: SimpleStreamOptions): boolean {
  const override = envValue(options, "QODER_MODEL_SERVER_HOST");
  if (override) return baseUrl === override;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "api2-v2.qoder.sh" || host.endsWith(".qoder.sh");
  } catch {
    return false;
  }
}

// Process-stable fallback for hosts that never pass options.sessionId — stable
// across turns of the process without any identity dependency (identity
// resolution is legacy-local by design).
const processFallbackSessionId = crypto.randomUUID();

function osType(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maxAdvertisedTier(contextConfig: QoderModelEntry["context_config"]): number | undefined {
  if (!contextConfig) return undefined;
  let max: number | undefined;
  for (const tier of Object.values(contextConfig)) {
    const count = tier?.token_count;
    if (typeof count === "number" && Number.isFinite(count) && (max === undefined || count > max)) max = count;
  }
  return max;
}

/**
 * The Qoder field injector. Runs inside pi-ai's onPayload (which replaces the
 * body with a non-undefined return), then CHAINS pi's own hook — replacing it
 * without calling it would silence before_provider_request for every other
 * extension.
 */
function injectQoderFields(
  body: Record<string, unknown>,
  route: V2Route,
  model: Model<Api>,
  options?: SimpleStreamOptions,
): void {
  // metadata.context — required envelope; session_id keys prompt caching.
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  body.metadata = {
    ...metadata,
    context: {
      request_id: crypto.randomUUID(),
      session_id: options?.sessionId ?? processFallbackSessionId,
      os_type: osType(),
      task_id: "common",
      client_type: "5",
    },
  };
  // Explicit-send set (owner direction 2026-09-25; probes are acceptance
  // checks, server default is never trusted silently).
  body.enable_thinking = resolveReasoningLevel(model, options) !== undefined;
  const tier = maxAdvertisedTier(route.modelConfig.context_config);
  if (tier !== undefined) body.context_length = tier;
  body.preserve_thinking = true;
  body.parallel_tool_calls = true;
  if (options?.cacheRetention === "none") body.skipCacheWrite = true;
}

function resolveReasoningLevel(model: Model<Api>, options?: SimpleStreamOptions): string | undefined {
  const requestedLevel = options?.reasoning;
  if (!requestedLevel) return undefined;
  // Same rule as the legacy path (stream.ts): clamp through pi-ai's model-aware
  // helper; "off" (or an unsupported model) disables, anything else enables.
  const clamped = clampThinkingLevel(model, requestedLevel);
  return clamped === "off" ? undefined : clamped;
}

function isInvalidModelErrorEvent(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "error") return false;
  const error = isRecord(event.error) ? event.error : undefined;
  const message = typeof error?.errorMessage === "string" ? error.errorMessage : "";
  // pi-ai formats provider errors as "<status>: <body>". The prefix must be
  // exactly 400 (eligibility), never 401 (auth): a bad token and a bad model
  // key look identical on v2, and retrying legacy on an auth fault would
  // double-spend quota.
  return /^400\D/.test(message) && message.includes("invalid_model_error");
}

function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
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
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: output });
  stream.end();
  return stream;
}

/**
 * v2 transport: delegate the turn to pi-ai's OpenAI Completions implementation
 * so pi contract correctness is inherited on every upgrade, with the Qoder
 * field injector in front and the stale-table self-heal behind.
 */
export function streamQoderV2(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  route: V2Route,
): AssistantMessageEventStream {
  const baseUrl = v2BaseUrl(route, options);
  if (!baseUrl || !isAllowedV2Host(baseUrl, options)) {
    return errorStream(model, `Qoder v2 host rejected by the outbound allowlist: ${baseUrl || "(empty)"}`);
  }
  if (!options?.apiKey) {
    return errorStream(model, "Qoder credentials not set (protocol=v2): no access token available for this request");
  }

  const v2Model: Model<Api> = {
    ...model,
    id: route.upstreamKey,
    baseUrl,
    api: "openai-completions" as Api,
    compat: {
      ...(model.compat as Record<string, unknown> | undefined),
      thinkingTokenBudgetField: "reasoning_budget_tokens",
      supportsLongCacheRetention: false,
    } as Model<Api>["compat"],
  };

  const callerOnPayload = options?.onPayload;
  const wrappedOnPayload = async (payload: unknown, selected: Model<Api>): Promise<unknown> => {
    const body = isRecord(payload) ? payload : {};
    injectQoderFields(body, route, v2Model, options);
    if (callerOnPayload) {
      const next = await callerOnPayload(body, selected);
      return next !== undefined ? next : body;
    }
    return body;
  };

  const inner = openAICompletionsApi().streamSimple(v2Model, context, { ...options, onPayload: wrappedOnPayload });

  const fallbackEnabled = envValue(options, "QODER_FALLBACK") === "1";
  if (!fallbackEnabled) return inner;

  // Self-heal (opt-in): on a pre-start 400 invalid_model_error, the routing
  // row is wrong — retry exactly once on legacy with the UNWRAPPED options and
  // cache the correction for the session.
  const out = createAssistantMessageEventStream();
  void (async () => {
    let firstEvent = true;
    for await (const event of inner) {
      if (firstEvent) {
        firstEvent = false;
        if (isInvalidModelErrorEvent(event)) {
          markLegacyOnly(route.upstreamKey);
          debugLog(`provider.fallback model_key=${route.upstreamKey} from=v2 to=legacy`);
          const legacyStream = streamQoder(model, context, options);
          for await (const legacyEvent of legacyStream) out.push(legacyEvent);
          out.end();
          return;
        }
      }
      out.push(event);
    }
    out.end();
  })().catch((error: unknown) => {
    debugLog(`provider.fallback wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      out.end();
    } catch {}
  });
  return out;
}
