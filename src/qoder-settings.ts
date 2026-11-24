import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getQoderStatePath } from "./home.js";
import { DELTA_FLUSH_INTERVAL_MS } from "./protocol/delta-coalescer.js";
import { readNumericOption } from "./util.js";

/**
 * Persistent, user-facing plugin options.
 *
 * These are the knobs that change how many Qoder Credits a session burns. They
 * can be set three ways, in decreasing precedence:
 *
 *   1. environment variable (per invocation, e.g. `QODER_CONTEXT_WINDOW=… pi`)
 *   2. this settings file (written by the `/qoder-settings` TUI command)
 *   3. the plugin defaults (qodercli-compatible: catalog context tier, 32K
 *      output, no reasoning replay)
 *
 * The file lives at `~/.pi/agent/qoder/qoder-settings.json` (or under
 * `$PI_CODING_AGENT_DIR/qoder/`).
 */

/** Prior assistant reasoning replay policy. */
export type ReasoningReplay = "none" | "last" | "all";

export interface QoderSettings {
  /**
   * Context window in tokens reported to pi. `null`/absent means "use the
   * catalog's own default tier" (usually 200K), which is what decides when pi
   * auto-compacts.
   */
  contextWindow?: number | null;
  /** Legacy behavior: use the largest tier the catalog advertises. */
  useMaxContext?: boolean;
  /** Per-request `max_tokens`. */
  maxOutputTokens?: number;
  /** How much prior thinking is sent back with each request. */
  replayReasoning?: ReasoningReplay;
  /** Milliseconds without a streamed byte before the request is treated as stalled. */
  streamIdleTimeoutMs?: number;
  /** Minimum gap between streamed text/thinking deltas (0 = flush every event). */
  streamDeltaIntervalMs?: number;
  /** Verbose diagnostics for best-effort failures. */
  debug?: boolean;
}

/** Default stream idle timeout (also the `QODER_STREAM_IDLE_TIMEOUT_MS` fallback). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Upper bound for user-supplied timeouts, so a typo cannot hang a session. */
const MAX_STREAM_TIMEOUT_MS = 3_600_000;
const MAX_STREAM_DELTA_MS = 60_000;

/** Upstream maximum output length (Aliyun Model Studio documents 131072). */
export const MAX_OUTPUT_TOKENS_LIMIT = 131072;

const SETTINGS_FILE = "qoder-settings.json";
const REASONING_REPLAY_VALUES: readonly ReasoningReplay[] = ["none", "last", "all"];

function positiveInteger(value: unknown, max?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
  if (max !== undefined && value > max) return undefined;
  return value;
}

function nonNegativeInteger(value: unknown, max?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  if (max !== undefined && value > max) return undefined;
  return value;
}

/** Normalize a raw settings object, dropping anything invalid or unknown. */
export function normalizeQoderSettings(raw: unknown): QoderSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const settings: QoderSettings = {};

  if (value.contextWindow === null) settings.contextWindow = null;
  else {
    const window = positiveInteger(value.contextWindow);
    if (window !== undefined) settings.contextWindow = window;
  }
  if (typeof value.useMaxContext === "boolean") settings.useMaxContext = value.useMaxContext;
  const maxOutputTokens = positiveInteger(value.maxOutputTokens, MAX_OUTPUT_TOKENS_LIMIT);
  if (maxOutputTokens !== undefined) settings.maxOutputTokens = maxOutputTokens;
  if (typeof value.replayReasoning === "string") {
    const replay = value.replayReasoning.trim().toLowerCase();
    if ((REASONING_REPLAY_VALUES as readonly string[]).includes(replay)) {
      settings.replayReasoning = replay as ReasoningReplay;
    }
  }
  const streamIdleTimeoutMs = positiveInteger(value.streamIdleTimeoutMs, MAX_STREAM_TIMEOUT_MS);
  if (streamIdleTimeoutMs !== undefined) settings.streamIdleTimeoutMs = streamIdleTimeoutMs;
  const streamDeltaIntervalMs = nonNegativeInteger(value.streamDeltaIntervalMs, MAX_STREAM_DELTA_MS);
  if (streamDeltaIntervalMs !== undefined) settings.streamDeltaIntervalMs = streamDeltaIntervalMs;
  if (typeof value.debug === "boolean") settings.debug = value.debug;
  return settings;
}

let cachedFile: { key: string; settings: QoderSettings } | undefined;

/** Absolute path of the persisted settings file. */
export function getQoderSettingsPath(): string {
  return getQoderStatePath(SETTINGS_FILE);
}

/**
 * Read the persisted settings.
 *
 * `/qoder-settings` writes from this process and request building reads on a
 * hot path, so the parse is cached and invalidated by mtime/size. A missing or
 * corrupt file is treated as "no overrides" rather than an error: options must
 * never break a session.
 */
export function readQoderSettings(): QoderSettings {
  const path = getQoderSettingsPath();
  let key: string;
  try {
    const stat = statSync(path);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return {};
  }
  if (cachedFile?.key === key) return cachedFile.settings;

  let settings: QoderSettings = {};
  try {
    settings = normalizeQoderSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    settings = {};
  }
  cachedFile = { key, settings };
  return settings;
}

/** Persist the settings, creating the qoder state directory when needed. */
export function writeQoderSettings(settings: QoderSettings): QoderSettings {
  const normalized = normalizeQoderSettings(settings);
  const path = getQoderSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  cachedFile = undefined;
  return normalized;
}

/** Drop the memoized copy (tests, and after an external edit). */
export function clearQoderSettingsCache(): void {
  cachedFile = undefined;
}

export interface QoderSettingsEnv {
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Context window override from `QODER_CONTEXT_WINDOW` or the settings file.
 * `undefined` means "use the catalog's default tier".
 */
export function resolveContextWindowOverride(env?: Readonly<Record<string, string | undefined>>): number | undefined {
  const forced = readNumericOption("QODER_CONTEXT_WINDOW", env, 0, (value) => Number.isFinite(value) && value > 0);
  if (forced > 0) return Math.round(forced);
  const configured = readQoderSettings().contextWindow;
  return configured === null || configured === undefined ? undefined : configured;
}

/** `QODER_CONTEXT_MAX=1` or the settings file opts into the largest tier. */
export function resolvePreferMaxContext(env?: Readonly<Record<string, string | undefined>>): boolean {
  if (truthy(env?.QODER_CONTEXT_MAX ?? process.env.QODER_CONTEXT_MAX)) return true;
  return readQoderSettings().useMaxContext === true;
}

/** Per-request output cap: env > settings file > qodercli's 32K default. */
export function resolveMaxOutputTokens(env?: Readonly<Record<string, string | undefined>>): number {
  const fromEnv = readNumericOption(
    "QODER_MAX_OUTPUT_TOKENS",
    env,
    Number.NaN,
    (value) => Number.isFinite(value) && value > 0 && value <= MAX_OUTPUT_TOKENS_LIMIT,
  );
  if (Number.isFinite(fromEnv)) return fromEnv;
  return readQoderSettings().maxOutputTokens ?? 32768;
}

/** Reasoning replay: env > settings file > `none` (cost-saving default). */
export function resolveReasoningReplay(env?: Readonly<Record<string, string | undefined>>): ReasoningReplay {
  const raw = (env?.QODER_REPLAY_REASONING ?? process.env.QODER_REPLAY_REASONING)?.trim().toLowerCase();
  if (raw === "last") return "last";
  if (raw === "all" || raw === "1" || raw === "true" || raw === "yes") return "all";
  if (raw === "none" || raw === "off" || raw === "0" || raw === "false" || raw === "no") return "none";
  return readQoderSettings().replayReasoning ?? "none";
}

function truthy(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Stream idle timeout: env > settings file > 120 s. */
export function resolveStreamIdleTimeoutMs(env?: Readonly<Record<string, string | undefined>>): number {
  const fromEnv = readNumericOption(
    "QODER_STREAM_IDLE_TIMEOUT_MS",
    env,
    Number.NaN,
    (value) => Number.isFinite(value) && value > 0 && value <= MAX_STREAM_TIMEOUT_MS,
  );
  if (Number.isFinite(fromEnv)) return fromEnv;
  return readQoderSettings().streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/** Delta coalescing interval: env > settings file > 50 ms (0 = no coalescing). */
export function resolveStreamDeltaIntervalMs(env?: Readonly<Record<string, string | undefined>>): number {
  const fromEnv = readNumericOption(
    "QODER_STREAM_DELTA_INTERVAL_MS",
    env,
    Number.NaN,
    (value) => Number.isFinite(value) && value >= 0 && value <= MAX_STREAM_DELTA_MS,
  );
  if (Number.isFinite(fromEnv)) return fromEnv;
  return readQoderSettings().streamDeltaIntervalMs ?? DELTA_FLUSH_INTERVAL_MS;
}

/**
 * Verbose logging: `QODER_DEBUG` (any truthy value) or the settings file.
 *
 * The env var keeps its historical "set it to anything non-empty" behavior; the
 * TUI stores an explicit boolean.
 */
export function resolveDebugEnabled(env?: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env?.QODER_DEBUG ?? process.env.QODER_DEBUG;
  if (raw !== undefined && raw.trim() !== "" && raw.trim().toLowerCase() !== "0") return true;
  return readQoderSettings().debug === true;
}
