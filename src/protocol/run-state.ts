import crypto from "node:crypto";
import { QODER_GATEWAY_COSY_VERSION } from "../cosy.js";

/**
 * Run-scoped request identity, mirroring the official qodercli (>=1.1.x)
 * lifecycle instead of minting a fresh identity per HTTP request.
 *
 * qodercli creates one AgentLifecycle per user prompt ("run") and threads that
 * run's `requestSetId` + `business` (stable `id`/`name`/`begin_at`, with a
 * `stage` that advances init -> start -> processing) through *every* model
 * request of the run — including tool rounds, retries and subagent calls. The
 * server therefore groups the whole agentic execution under one request set,
 * and the Qoder credit ledger shows it as a single aggregated entry.
 *
 * pi drives one HTTP request per model round, and this plugin previously
 * previously re-derived `request_set_id` from a hash of the whole (growing)
 * message list, while minting a brand-new `business.id` with `stage:"start"`
 * on every request. Each round therefore looked like a separate, never-finished
 * run — which is why the ledger filled with many short, small credit rows.
 *
 * A run boundary is inferred from the message tail: when the conversation ends
 * with tool results that pair with the previous assistant message's tool_calls,
 * the request continues the current run; otherwise (a fresh user message, a
 * retry from a clean state, a new session) a new run starts.
 */

export type QoderRunMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string }>;
};

export interface QoderRunBusiness {
  product: string;
  version: string;
  type: string;
  id: string;
  name: string;
  begin_at: number;
  stage: "init" | "start" | "processing";
}

interface QoderRunState {
  key: string;
  requestSetId: string;
  business: QoderRunBusiness;
}

/** Maximum number of in-flight runs remembered per process (evict oldest). */
const MAX_RUN_STATES = 64;

const runStates = new Map<string, QoderRunState>();

/** Empty the run registry. Exposed for tests only. */
export function clearQoderRunRegistry(): void {
  runStates.clear();
}

/**
 * True when `messages` ends in an unfinished tool round: trailing `tool`
 * results whose ids were declared by the last assistant tool_calls message.
 * Used to decide whether a request continues the current agentic run.
 */
export function isToolRoundContinuation(messages: readonly QoderRunMessage[]): boolean {
  let i = messages.length - 1;
  const openToolCallIds = new Set<string>();
  while (i >= 0) {
    const message = messages[i];
    if (message.role !== "tool") break;
    if (message.tool_call_id) openToolCallIds.add(message.tool_call_id);
    i--;
  }
  if (openToolCallIds.size === 0) return false;

  while (i >= 0) {
    const message = messages[i];
    if (message.role === "assistant") {
      const declared = (message.tool_calls ?? [])
        .map((tc) => tc?.id)
        .filter((id): id is string => typeof id === "string");
      return declared.some((id) => openToolCallIds.has(id));
    }
    if (message.role === "user") return false;
    i--;
  }
  return false;
}

/** qodercli truncates the run display name to 10 chars for agent runs. */
function runDisplayName(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 10 ? trimmed.slice(0, 10) : trimmed;
}

function createBusiness(product: string, name: string): QoderRunBusiness {
  return {
    product,
    // business.version carries the client version (qodercli pins its own);
    // mirror the COSY client identity this plugin emulates.
    version: QODER_GATEWAY_COSY_VERSION,
    type: "agent",
    id: crypto.randomUUID(),
    name: runDisplayName(name),
    begin_at: Date.now(),
    stage: "init",
  };
}

function advanceStage(business: QoderRunBusiness): void {
  // init -> start (first request) -> processing (all later requests).
  if (business.stage === "init") business.stage = "start";
  else if (business.stage === "start") business.stage = "processing";
}

function evictOldestRunIfNeeded(): void {
  if (runStates.size < MAX_RUN_STATES) return;
  const oldestKey = runStates.keys().next().value;
  if (oldestKey !== undefined) runStates.delete(oldestKey);
}

export interface QoderRunRequest {
  mode: string;
  model: string;
  sessionId: string;
  /** Normalized (post-transform) messages sent in this request. */
  messages: readonly QoderRunMessage[];
  /** Text of the current user prompt (used for the business display name). */
  lastUserText: string;
  product: string;
}

export interface QoderRunIdentity {
  /** Stable for every model request that belongs to the same agentic run. */
  requestSetId: string;
  /** Run-scoped business object, stable id/name/begin_at with advancing stage. */
  business: QoderRunBusiness;
}

/**
 * Return the run identity for this request, creating (or reusing) the
 * run-scoped state keyed by mode/model/session.
 */
export function getQoderRunIdentity(input: QoderRunRequest): QoderRunIdentity {
  const key = `${input.mode}:${input.model}:${input.sessionId}`;
  const continuation = isToolRoundContinuation(input.messages);

  let state = continuation ? runStates.get(key) : undefined;
  if (!state) {
    state = {
      key,
      requestSetId: crypto.randomUUID(),
      business: createBusiness(input.product, input.lastUserText),
    };
    runStates.set(key, state);
    evictOldestRunIfNeeded();
  }
  advanceStage(state.business);

  return { requestSetId: state.requestSetId, business: { ...state.business } };
}
