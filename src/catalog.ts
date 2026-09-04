import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { buildAuthHeaders } from "./cosy.js";
import { parseQoderPriceFactor } from "./protocol/usage.js";
import { getQoderBaseUrl, getQoderModelListURL, getQoderRegionConfig, type QoderMode } from "./region.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Qoder's price_factor is a relative Credit multiplier, not a USD token rate.
 * Keep pi-ai's monetary cost at zero/unknown and expose the multiplier
 * separately on QoderModelDef.
 */

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
  price_factor?: number;
  original_price_factor?: number;
  // Accept camelCase from compatibility fixtures without making it canonical.
  priceFactor?: number;
  originalPriceFactor?: number;
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
  /** Relative Qoder Credit multiplier from the server model catalog. */
  priceFactor?: number;
  /** Original multiplier before a promotion, when supplied by Qoder. */
  originalPriceFactor?: number;
  contextWindow: number;
  maxTokens: number;
  description?: string;
}

interface QoderModelCacheData {
  updatedAt?: number;
  models?: QoderModelDef[];
  configs?: Record<string, QoderModelEntry>;
}

interface LoadedQoderModelCache {
  signature: string;
  data: QoderModelCacheData;
}

const modelCacheMemory = new Map<QoderMode, LoadedQoderModelCache>();

function getModelCacheSignature(cachePath: string): string | null {
  try {
    const stat = statSync(cachePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/**
 * Read and parse the model cache at most once per file version. The stat call
 * is intentionally much cheaper than reading and parsing the cache on every
 * request, while still noticing login/catalog updates made by another pi
 * process and direct file changes during tests.
 */
function loadModelCache(mode: QoderMode): QoderModelCacheData | null {
  const cachePath = getQoderCachePath(mode);
  const signature = getModelCacheSignature(cachePath);
  const cached = modelCacheMemory.get(mode);
  if (signature && cached?.signature === signature) return cached.data;
  if (!signature) {
    modelCacheMemory.delete(mode);
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8")) as QoderModelCacheData;
    if (!data || typeof data !== "object") return null;
    modelCacheMemory.set(mode, { signature, data });
    return data;
  } catch {
    modelCacheMemory.delete(mode);
    return null;
  }
}

function getQoderCachePath(mode: QoderMode): string {
  return join(homedir(), ".pi", "agent", getQoderRegionConfig(mode).modelCacheFile);
}

/**
 * Derive the only public model id from Qoder's display name.
 * The upstream key remains available solely inside the matching config entry.
 */
export function toQoderModelId(displayName?: string): string {
  return (displayName || "QoderModel").replace(/\s+/g, "");
}

export const staticModels: QoderModelDef[] = [
  {
    id: "Auto",
    upstreamKey: "auto",
    name: "Auto",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Ultimate",
    upstreamKey: "ultimate",
    name: "Ultimate",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Performance",
    upstreamKey: "performance",
    name: "Performance",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Efficient",
    upstreamKey: "efficient",
    name: "Efficient",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Lite",
    upstreamKey: "lite",
    name: "Lite",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Qwen3.7Plus",
    upstreamKey: "qmodel",
    name: "Qwen3.7 Plus",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Cantus",
    upstreamKey: "cmodel",
    name: "Cantus",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Qwen3.8-Max",
    upstreamKey: "qmodel_preview",
    name: "Qwen3.8-Max",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Qwen3.7-Max",
    upstreamKey: "qmodel_latest",
    name: "Qwen3.7-Max",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "DeepSeek-V4-Pro",
    upstreamKey: "dmodel",
    name: "DeepSeek-V4-Pro",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "DeepSeek-V4-Flash",
    upstreamKey: "dfmodel",
    name: "DeepSeek-V4-Flash",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "GLM-5.2",
    upstreamKey: "gm51model",
    name: "GLM-5.2",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Kimi-K2.7-Code",
    upstreamKey: "kmodel",
    name: "Kimi-K2.7-Code",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // Catalog advertises 256K; not included in the 1M live test in issue #13.
    contextWindow: 256000,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "Kimi-K3",
    upstreamKey: "kmodel_latest",
    name: "Kimi-K3",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
  {
    id: "MiniMax-M3",
    upstreamKey: "mmodel",
    name: "MiniMax-M3",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: getQoderBaseUrl("global"),
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
  },
];

export const staticCnModels: QoderModelDef[] = [
  {
    id: "Auto",
    upstreamKey: "auto",
    name: "Auto",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // CN Auto has not been live-tested at 1M; keep the conservative 200K
    // fallback until the CN catalog advertises a larger option.
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN smart routing; fallback context window of 200K.",
  },
  {
    id: "Qwen3.7-Max",
    upstreamKey: "qmodel_latest",
    name: "Qwen3.7-Max",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN qmodel_latest; context options 200K/400K/1M.",
  },
  {
    id: "Qwen3.7-Plus",
    upstreamKey: "qmodel",
    name: "Qwen3.7-Plus",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN qmodel; context options 200K/400K/1M.",
  },
  {
    id: "Qwen3.6-Flash",
    upstreamKey: "q36fmodel",
    name: "Qwen3.6-Flash",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN q36fmodel; context options 200K/400K/1M.",
  },
  {
    id: "DeepSeek-V4-Pro",
    upstreamKey: "dmodel",
    name: "DeepSeek-V4-Pro",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN dmodel; context options 200K/400K/1M.",
  },
  {
    id: "DeepSeek-V4-Flash",
    upstreamKey: "dfmodel",
    name: "DeepSeek-V4-Flash",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN dfmodel; context options 200K/400K/1M.",
  },
  {
    id: "GLM-5.2",
    upstreamKey: "gm51model",
    name: "GLM-5.2",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // Live CN catalog currently displays 200K; do not copy global gm51model's 1M.
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN gm51model; live catalog currently displays GLM-5.2 with 200K context.",
  },
  {
    id: "Kimi-K2.7-Code",
    upstreamKey: "kmodel",
    name: "Kimi-K2.7-Code",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    // Catalog advertises 256K; same as global kmodel.
    contextWindow: 256000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN kmodel; context option 256K.",
  },
  {
    id: "MiniMax-M2.7",
    upstreamKey: "mmodel",
    name: "MiniMax-M2.7",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    // Live CN catalog reports 200K; not confirmed at 1M.
    contextWindow: 200000,
    maxTokens: MAX_OUTPUT_TOKENS,
    description: "Qoder CN mmodel; live catalog reports 200K context.",
  },
];

/**
 * Offline fallback rates from Qoder's documented model selector. These are
 * relative multipliers, not fixed per-request Credits; an authenticated live
 * catalog always overrides them.
 */
const DOCUMENTED_PRICE_FACTORS: Record<string, number> = {
  auto: 1.0,
  ultimate: 1.6,
  performance: 1.1,
  efficient: 0.3,
  qmodel_preview: 0.5,
  qmodel_latest: 0.5,
  qmodel: 0.1,
  kmodel_latest: 0.8,
  kmodel: 0.3,
  gm51model: 0.6,
  dmodel: 0.8,
  dfmodel: 0.3,
  mmodel: 0.2,
};

for (const model of staticModels) {
  const priceFactor = model.upstreamKey ? DOCUMENTED_PRICE_FACTORS[model.upstreamKey] : undefined;
  if (priceFactor !== undefined) model.priceFactor = priceFactor;
}

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

export function getCachedModels(mode: QoderMode): QoderModelDef[] {
  const data = loadModelCache(mode);
  if (data && Array.isArray(data.models)) {
    const models = data.models.map((model: QoderModelDef) => {
      const config = data.configs?.[model.id];
      const display = config?.display_name;
      const staticModel = (mode === "cn" ? staticCnModels : staticModels).find((seed) => seed.upstreamKey === model.id);
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

export function getCachedModelConfig(modelId: string, mode: QoderMode): QoderModelEntry | null {
  const data = loadModelCache(mode);
  if (data) {
    const direct = data.configs?.[modelId];
    if (direct && toQoderModelId(direct.display_name) === modelId) {
      return withMaxContextAsDefault(direct);
    }

    // Read old cache shapes without preserving their raw-key aliases.
    const legacyEntry = Object.values(data.configs || {}).find(
      (entry) =>
        entry && typeof entry === "object" && toQoderModelId((entry as QoderModelEntry).display_name) === modelId,
    ) as QoderModelEntry | undefined;
    if (legacyEntry) {
      return withMaxContextAsDefault(legacyEntry);
    }
  }

  const staticModel = (mode === "cn" ? staticCnModels : staticModels).find((model) => model.id === modelId);
  if (staticModel) {
    return {
      key: staticModel.upstreamKey || modelId,
      is_reasoning: staticModel.reasoning,
      source: "system",
    };
  }

  return null;
}

/** Resolve contextWindow from a catalog entry. Exported for tests. */
export function contextWindowFromCatalog(entry: QoderModelEntry): number {
  const contextConfig = entry.context_config;
  if (contextConfig && typeof contextConfig === "object") {
    let advertised = 0;
    for (const configVal of Object.values(contextConfig)) {
      if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
        if (configVal.token_count > advertised) advertised = configVal.token_count;
      }
    }
    if (advertised > 0) return advertised;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Prefer the largest context option when Qoder exposes selectable contexts. */
function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return entry;

  const maxTokenCount = Math.max(
    ...Object.values(contextConfig).map((config) => (typeof config?.token_count === "number" ? config.token_count : 0)),
  );
  if (maxTokenCount <= 0) return entry;

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

export function isCacheStale(mode: QoderMode): boolean {
  const data = loadModelCache(mode);
  if (!data || typeof data.updatedAt !== "number") return true;
  // Stale if older than 1 hour
  return Date.now() - data.updatedAt > 3600_000;
}

export async function updateQoderModelsCache(
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

    const response = await fetch(modelListURL, {
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
        priceFactor: parseQoderPriceFactor(entry.price_factor ?? entry.priceFactor),
        originalPriceFactor: parseQoderPriceFactor(entry.original_price_factor ?? entry.originalPriceFactor),
        contextWindow: ctxLen,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    }

    if (newModels.length === 0) return;

    const cacheData = {
      updatedAt: Date.now(),
      models: newModels,
      configs,
    };

    const cachePath = getQoderCachePath(mode);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
    modelCacheMemory.delete(mode);
  } catch {}
}
