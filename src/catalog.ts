import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { buildAuthHeaders } from "./cosy.js";
import { debugLog } from "./debug.js";
import { getHomeDir } from "./home.js";
import { parseQoderPriceFactor } from "./protocol/usage.js";
import { getQoderBaseUrl, getQoderModelListURL, getQoderRegionConfig, type QoderMode } from "./region.js";
import { fetchWithRetry } from "./retry.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Maximum output tokens sent per request. Aliyun Model Studio (the upstream
 * behind Qoder's CN catalog) documents Max Output Length = 131072 for every
 * model we expose (qwen3.8-max/flash, qwen3.7-max/plus/flash), in both normal
 * and thinking modes (thinking chain alone goes up to 262144). The Qoder
 * /model/list catalog does not return a per-model output cap, so this single
 * constant is the source of truth for both static models and request sending.
 * qodercli ships a conservative 32e3 default and caps its UI at 65536; we use
 * the documented upstream ceiling so reasoning chains and long generations
 * are not truncated.
 */
export const MAX_OUTPUT_TOKENS = 131072;

/**
 * Fallback context window when the catalog omits `context_config`.
 *
 * Qoder's `/model/list` often ships `max_input_tokens` as a stale 180K floor
 * even for models that accept 1M-token prompts (verified against global `lite`
 * through 1,000K tokens). When `context_config` is present we use its largest
 * `token_count` instead, so models that truly advertise 200K/256K stay there.
 */
export const DEFAULT_CONTEXT_WINDOW = 1000000;

/** Shape of a single entry returned by the Qoder /model/list endpoint. */
export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: {
    disabled?: unknown;
    enabled?: { efforts?: Record<string, { is_default?: boolean }>; is_default?: boolean };
  };
  source?: string;
  [key: string]: unknown;
}

export interface QoderModelDef {
  id: string;
  upstreamKey?: string;
  name: string;
  api: "qoder-api";
  provider: "qoder" | "qoder-cn";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  description?: string;
  /**
   * Relative Credit multiplier from the live catalog (`price_factor`). Qoder
   * bills in Credits, not USD, so this is exposed as metadata rather than folded
   * into the monetary `cost`. Absent when the catalog omits it.
   */
  priceFactor?: number;
}

function getQoderCachePath(mode: QoderMode): string {
  return join(getHomeDir(), ".pi", "agent", getQoderRegionConfig(mode).modelCacheFile);
}

interface ParsedModelCache {
  updatedAt?: number;
  /**
   * Account the catalog was fetched for. Model entitlements are per account,
   * so a cache built for a different user must not be reused within its TTL.
   */
  userID?: string;
  models?: QoderModelDef[];
  configs?: Record<string, QoderModelEntry>;
}

/** In-memory cache keyed by absolute cache path (HOME-safe across tests). */
const modelCacheMem = new Map<string, ParsedModelCache | null>();

/**
 * In-memory displayId -> config index keyed by absolute cache path, so
 * getCachedModelConfig resolves in O(1) instead of scanning every config entry
 * on each request. Derived from the memoized cache and invalidated on write
 * (writeParsedModelCache) or clear (clearQoderModelsMemCache).
 */
const configIndexMem = new Map<string, Map<string, QoderModelEntry>>();

/**
 * In-flight model-catalog fetches keyed by cache path **and account**. Multiple
 * callers within one process (auto-login, session_start, login, token refresh)
 * can fire updateQoderModelsCache at roughly the same time; this coalesces the
 * same-account ones into a single network request instead of re-fetching the
 * model list per caller, while keeping different accounts separate.
 */
const inflightModelUpdates = new Map<string, Promise<void>>();

/** Clear process-memory model caches (also used by tests that mutate cache files). */
export function clearQoderModelsMemCache(): void {
  modelCacheMem.clear();
  configIndexMem.clear();
}

function readParsedModelCache(mode: QoderMode): ParsedModelCache | null {
  const cachePath = getQoderCachePath(mode);
  if (modelCacheMem.has(cachePath)) {
    return modelCacheMem.get(cachePath) ?? null;
  }
  if (!existsSync(cachePath)) {
    modelCacheMem.set(cachePath, null);
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as ParsedModelCache;
    modelCacheMem.set(cachePath, data);
    return data;
  } catch {
    modelCacheMem.set(cachePath, null);
    return null;
  }
}

function writeParsedModelCache(mode: QoderMode, data: ParsedModelCache): void {
  const cachePath = getQoderCachePath(mode);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  modelCacheMem.set(cachePath, data);
  // The configs changed, so any previously built displayId index is stale.
  configIndexMem.delete(cachePath);
}

/**
 * Derive the only public model id from Qoder's display name.
 * The upstream key remains available solely inside the matching config entry.
 */
export function toQoderModelId(displayName?: string): string {
  return (displayName || "QoderModel").replace(/\s+/g, "");
}

/**
 * Compact description of a fallback (static) catalog entry. The pi-visible id
 * is always derived from `name` (whitespace stripped), matching live entries.
 */
interface StaticModelRow {
  name: string;
  upstreamKey: string;
  reasoning: boolean;
  /** The catalog advertises discrete effort levels for this model. */
  supportsEffort?: boolean;
  /** Vision-capable model (`is_vl`); adds the "image" input modality. */
  vision?: boolean;
  /** Defaults to DEFAULT_CONTEXT_WINDOW when omitted. */
  contextWindow?: number;
  description?: string;
}

function buildStaticModels(mode: QoderMode, rows: readonly StaticModelRow[]): QoderModelDef[] {
  const region = getQoderRegionConfig(mode);
  const baseUrl = getQoderBaseUrl(mode);
  return rows.map((row) => ({
    id: toQoderModelId(row.name),
    upstreamKey: row.upstreamKey,
    name: row.name,
    api: "qoder-api",
    provider: region.providerID,
    baseUrl,
    reasoning: row.reasoning,
    supportsEffort: row.supportsEffort ?? false,
    input: row.vision ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(row.description ? { description: row.description } : {}),
  }));
}

export const staticModels: QoderModelDef[] = buildStaticModels("global", [
  { name: "Auto", upstreamKey: "auto", reasoning: true, vision: true },
  { name: "Ultimate", upstreamKey: "ultimate", reasoning: true, supportsEffort: true, vision: true },
  { name: "Performance", upstreamKey: "performance", reasoning: true, supportsEffort: true, vision: true },
  { name: "Efficient", upstreamKey: "efficient", reasoning: false, vision: true },
  { name: "Lite", upstreamKey: "lite", reasoning: false },
  { name: "Qwen3.7 Plus", upstreamKey: "qmodel", reasoning: false, vision: true },
  { name: "Cantus", upstreamKey: "cmodel", reasoning: true, supportsEffort: true, vision: true },
  { name: "Qwen3.8-Max", upstreamKey: "qmodel_preview", reasoning: true, supportsEffort: true, vision: true },
  { name: "Qwen3.7-Max", upstreamKey: "qmodel_latest", reasoning: false, vision: true },
  { name: "DeepSeek-V4-Pro", upstreamKey: "dmodel", reasoning: true, supportsEffort: true, vision: true },
  { name: "DeepSeek-V4-Flash", upstreamKey: "dfmodel", reasoning: true, supportsEffort: true, vision: true },
  { name: "GLM-5.2", upstreamKey: "gm51model", reasoning: true, supportsEffort: true, vision: true },
  // Catalog advertises 256K; not included in the 1M live test in issue #13.
  { name: "Kimi-K2.7-Code", upstreamKey: "kmodel", reasoning: false, vision: true, contextWindow: 256000 },
  { name: "Kimi-K3", upstreamKey: "kmodel_latest", reasoning: false, vision: true },
  { name: "MiniMax-M3", upstreamKey: "mmodel", reasoning: false, vision: true },
]);

export const staticCnModels: QoderModelDef[] = buildStaticModels("cn", [
  // CN Auto has not been live-tested at 1M; keep the conservative 200K
  // fallback until the CN catalog advertises a larger option.
  {
    name: "Auto",
    upstreamKey: "auto",
    reasoning: true,
    vision: true,
    contextWindow: 200000,
    description: "Qoder CN smart routing; fallback context window of 200K.",
  },
  {
    name: "Qwen3.7-Max",
    upstreamKey: "qmodel_latest",
    reasoning: true,
    vision: true,
    description: "Qoder CN qmodel_latest; context options 200K/400K/1M.",
  },
  {
    name: "Qwen3.7-Plus",
    upstreamKey: "qmodel",
    reasoning: true,
    description: "Qoder CN qmodel; context options 200K/400K/1M.",
  },
  {
    name: "Qwen3.6-Flash",
    upstreamKey: "q36fmodel",
    reasoning: true,
    description: "Qoder CN q36fmodel; context options 200K/400K/1M.",
  },
  {
    name: "DeepSeek-V4-Pro",
    upstreamKey: "dmodel",
    reasoning: true,
    description: "Qoder CN dmodel; context options 200K/400K/1M.",
  },
  {
    name: "DeepSeek-V4-Flash",
    upstreamKey: "dfmodel",
    reasoning: false,
    description: "Qoder CN dfmodel; context options 200K/400K/1M.",
  },
  {
    // Live CN catalog currently displays 200K; do not copy global gm51model's 1M.
    name: "GLM-5.2",
    upstreamKey: "gm51model",
    reasoning: true,
    vision: true,
    contextWindow: 200000,
    description: "Qoder CN gm51model; live catalog currently displays GLM-5.2 with 200K context.",
  },
  {
    // Catalog advertises 256K; same as global kmodel.
    name: "Kimi-K2.7-Code",
    upstreamKey: "kmodel",
    reasoning: true,
    vision: true,
    contextWindow: 256000,
    description: "Qoder CN kmodel; context option 256K.",
  },
  {
    // Live CN catalog reports 200K; not confirmed at 1M.
    name: "MiniMax-M2.7",
    upstreamKey: "mmodel",
    reasoning: false,
    contextWindow: 200000,
    description: "Qoder CN mmodel; live catalog reports 200K context.",
  },
]);

/** pi thinking levels in display order (matches the pi-ai SDK this build targets). */
const PI_THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Map Qoder's `thinking_config` to pi's `thinkingLevelMap` so the TUI exposes
 * the levels the upstream model actually supports.
 *
 * Qoder has two shapes:
 *   - effort-based: `thinking_config.enabled.efforts = { low, medium, xhigh, ... }`
 *     Each effort key is already a pi level name, so supported levels map to
 *     themselves and the rest are pinned to null (hidden in the picker).
 *     `xhigh`/`max` are only shown when the map carries them, otherwise the
 *     picker tops out at `high`.
 *   - toggle-based: `thinking_config.enabled` without `efforts` (only on/off).
 *     Every pi level is exposed and maps to "enabled" so a user picking any
 *     level turns thinking on; the exact effort sent upstream is decided at
 *     request time.
 * Returns undefined for models that do not support thinking, so pi falls back
 * to `reasoning: false`-style behavior (only `off`).
 */
function buildThinkingLevelMap(entry: QoderModelEntry): ThinkingLevelMap | undefined {
  const tc = entry.thinking_config;
  if (!tc) return undefined;
  const efforts = tc.enabled?.efforts;
  if (efforts && typeof efforts === "object") {
    const supported = new Set(Object.keys(efforts));
    // `off` (disable thinking) is selectable when the catalog advertises a
    // `disabled` option; otherwise pin it to null to hide it.
    const map: ThinkingLevelMap = { off: tc.disabled ? "disabled" : null };
    for (const level of PI_THINKING_LEVELS) {
      map[level] = supported.has(level) ? level : null;
    }
    return map;
  }
  // toggle-only (enabled/disabled, no efforts) — expose every level as "on".
  // `off` is selectable when the catalog advertises `disabled`.
  if (tc.enabled) {
    const map: ThinkingLevelMap = { off: tc.disabled ? "disabled" : null };
    for (const level of PI_THINKING_LEVELS) {
      map[level] = "enabled";
    }
    return map;
  }
  return undefined;
}

/**
 * Lazily built indexes over the static fallback catalogs. `getCachedModels`
 * maps every cached entry back to a seed (by upstream key) and
 * `getCachedModelConfig` resolves a fallback by public id; both used to run a
 * linear `.find` per call. The seed arrays are module constants, so the maps
 * are built once per mode.
 */
const staticSeedByUpstreamKey = new Map<QoderMode, Map<string, QoderModelDef>>();
const staticSeedById = new Map<QoderMode, Map<string, QoderModelDef>>();

function getStaticSeedIndex(mode: QoderMode, by: "upstreamKey" | "id"): Map<string, QoderModelDef> {
  const store = by === "upstreamKey" ? staticSeedByUpstreamKey : staticSeedById;
  const existing = store.get(mode);
  if (existing) return existing;

  const index = new Map<string, QoderModelDef>();
  for (const model of mode === "cn" ? staticCnModels : staticModels) {
    const key = by === "upstreamKey" ? model.upstreamKey : model.id;
    if (key && !index.has(key)) index.set(key, model);
  }
  store.set(mode, index);
  return index;
}

export function getCachedModels(mode: QoderMode): QoderModelDef[] {
  const data = readParsedModelCache(mode);
  if (data && Array.isArray(data.models)) {
    const staticByKey = getStaticSeedIndex(mode, "upstreamKey");
    const models = data.models.map((model: QoderModelDef) => {
      const config = data.configs?.[model.id] as QoderModelEntry | undefined;
      const display = config?.display_name;
      const staticModel = staticByKey.get(model.id);
      if (display) return { ...model, id: toQoderModelId(display), name: display };
      if (staticModel) return { ...model, id: staticModel.id, name: staticModel.name };
      return model.name ? { ...model, id: toQoderModelId(model.name) } : model;
    });
    // Older releases injected `auto` without a corresponding service config.
    // Keep an explicitly enabled service model, but drop the legacy fallback.
    if (data.configs && typeof data.configs === "object" && !data.configs.auto) {
      return models.filter((model: QoderModelDef) => model.id.toLowerCase() !== "auto");
    }
    return models;
  }
  return mode === "cn" ? staticCnModels : staticModels;
}

/**
 * Build (once, then memoize) a map from pi model id (display-name-derived) to
 * its catalog config. Both cache shapes are handled uniformly: the new cache
 * already keys configs by the friendly id, while legacy caches key by the raw
 * upstream key and carry the display name inside each entry. Only
 * display-name-derived ids are indexed, so raw upstream keys (e.g. `lite`)
 * never resolve to a public model id — matching the previous behavior. The
 * index is derived from the memoized cache, so it keeps serving after the cache
 * file is removed, and is dropped whenever the cache is rewritten or cleared.
 */
function getConfigIndex(mode: QoderMode): Map<string, QoderModelEntry> {
  const cachePath = getQoderCachePath(mode);
  const existing = configIndexMem.get(cachePath);
  if (existing) return existing;

  const index = new Map<string, QoderModelEntry>();
  const configs = readParsedModelCache(mode)?.configs;
  if (configs && typeof configs === "object") {
    for (const entry of Object.values(configs)) {
      if (!entry || typeof entry !== "object" || !entry.display_name) continue;
      const displayId = toQoderModelId(entry.display_name);
      if (displayId && displayId !== "QoderModel" && !index.has(displayId)) {
        index.set(displayId, entry as QoderModelEntry);
      }
    }
  }
  configIndexMem.set(cachePath, index);
  return index;
}

export function getCachedModelConfig(modelId: string, mode: QoderMode): QoderModelEntry | null {
  // O(1) lookup against the memoized displayId index (no per-request scan of the
  // whole config list, which could be hundreds of entries).
  const config = getConfigIndex(mode).get(modelId);
  if (config) return withMaxContextAsDefault(config);

  const staticModel = getStaticSeedIndex(mode, "id").get(modelId);
  if (staticModel) {
    return {
      key: staticModel.upstreamKey || modelId,
      is_reasoning: staticModel.reasoning,
      source: "system",
    };
  }

  return null;
}

/** Largest `context_config` token_count an entry advertises, or 0 when none. */
function maxContextTokenCount(contextConfig: QoderModelEntry["context_config"]): number {
  if (!contextConfig || typeof contextConfig !== "object") return 0;
  let max = 0;
  for (const config of Object.values(contextConfig)) {
    if (config && typeof config === "object" && typeof config.token_count === "number" && config.token_count > max) {
      max = config.token_count;
    }
  }
  return max;
}

/** Resolve contextWindow from a catalog entry. Exported for tests. */
export function contextWindowFromCatalog(entry: QoderModelEntry): number {
  return maxContextTokenCount(entry.context_config) || DEFAULT_CONTEXT_WINDOW;
}

/** Prefer the largest context option when Qoder exposes selectable contexts. */
function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  const maxTokenCount = maxContextTokenCount(contextConfig);
  if (maxTokenCount <= 0 || !contextConfig) return entry;

  return {
    ...entry,
    context_config: Object.fromEntries(
      Object.entries(contextConfig).map(([name, config]) => [
        name,
        { ...config, is_default: config.token_count === maxTokenCount },
      ]),
    ),
  };
}

export function isCacheStale(mode: QoderMode, userID?: string): boolean {
  const data = readParsedModelCache(mode);
  if (!data || typeof data.updatedAt !== "number") return true;
  // Stale if the cache belongs to another account: Qoder entitlements (and
  // therefore the advertised model list) are per account. A legacy cache with
  // no recorded userID counts as stale too, so it gets stamped once.
  if (userID && data.userID !== userID) return true;
  // Stale if older than 1 hour
  return Date.now() - data.updatedAt > 3600_000;
}

/**
 * Refresh the model catalog for `mode` from the live /model/list endpoint.
 * Concurrent calls for the same mode **and account** within one process are
 * coalesced into a single network request (see inflightModelUpdates), so a
 * startup auto-login, a session_start hook and a token refresh firing together
 * only fetch once. Account identity is part of the key: the result is cached
 * per account, so joining another account's in-flight request would stamp the
 * wrong userID onto this account's cache.
 * Network errors are swallowed (returns normally) so callers stay best-effort.
 */
export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: QoderMode,
): Promise<void> {
  const inflightKey = `${getQoderCachePath(mode)}:${userID}`;
  const inflight = inflightModelUpdates.get(inflightKey);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      await fetchAndCacheModelList(authToken, userID, name, email, mode);
    } finally {
      inflightModelUpdates.delete(inflightKey);
    }
  })();
  inflightModelUpdates.set(inflightKey, promise);
  return promise;
}

async function fetchAndCacheModelList(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: QoderMode,
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    const headers = buildAuthHeaders(null, modelListURL, {
      userID,
      authToken,
      name,
      email,
    });

    const response = await fetchWithRetry(modelListURL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
    });

    if (!response.ok) {
      return;
    }

    const resData = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable || !entry.display_name) continue;

      const display = entry.display_name;
      // Prefer the largest selectable context option the catalog advertises
      // (e.g. 1M when 200K/400K/1M are offered). If none is advertised, use
      // DEFAULT_CONTEXT_WINDOW rather than the stale 180K `max_input_tokens`
      // floor. Do not seed from DEFAULT_CONTEXT_WINDOW before scanning
      // context_config: that would inflate models that only advertise 200K.
      const ctxLen = contextWindowFromCatalog(entry);
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const thinkingLevelMap = buildThinkingLevelMap(entry);
      const priceFactor = parseQoderPriceFactor(entry.price_factor);
      // Both regions expose display_name (whitespace-stripped) as the sole
      // pi-visible id. The config stores the upstream key under that id for
      // request-time use.
      const modelInfo = { id: toQoderModelId(display), name: display };

      configs[modelInfo.id] = entry;

      newModels.push({
        id: modelInfo.id,
        name: modelInfo.name,
        api: "qoder-api",
        provider: getQoderRegionConfig(mode).providerID,
        baseUrl: getQoderBaseUrl(mode),
        reasoning: isReasoning,
        supportsEffort,
        thinkingLevelMap,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(priceFactor !== undefined ? { priceFactor } : {}),
      });
    }

    if (newModels.length === 0) return;

    const cacheData = {
      updatedAt: Date.now(),
      userID,
      models: newModels,
      configs,
    };

    writeParsedModelCache(mode, cacheData);
  } catch (error) {
    debugLog("model catalog refresh failed", error);
  }
}
