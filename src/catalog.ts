import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { buildAuthHeaders } from "./cosy.js";
import { isGatewayCosyVersionRefreshDue, refreshGatewayCosyVersion } from "./cosy-version.js";
import { debugLog } from "./debug.js";
import { getQoderStatePath } from "./home.js";
import { fetchQoderJson } from "./http.js";
import { parseQoderPriceFactor } from "./protocol/usage.js";
import { resolveContextWindowOverride, resolveMaxOutputTokens, resolvePreferMaxContext } from "./qoder-settings.js";
import { getQoderBaseUrl, getQoderModelListURL, getQoderRegionConfig, type QoderMode } from "./region.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Fallback context window when the catalog omits `context_config`.
 *
 * Matches what Qoder itself treats as the baseline prompt size. `max_input_tokens`
 * (when advertised) is preferred over this value; the 1M figure that used to
 * live here was a guess that let pi grow a conversation to ~1M tokens (and
 * bill every round for it) even for models whose catalog entry only offers 200K.
 */
export const DEFAULT_CONTEXT_WINDOW = 200000;

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

/**
 * omp fork's `ThinkingConfig` shape. The fork reads `model.thinking` (not the
 * `thinkingLevelMap` that earendil pi-ai exposes), and when it is absent omp
 * fills a generic default ladder (`minimal`..`high`) instead of the model's
 * real efforts - so `DeepSeek-V4-Pro` would show `low`/`medium` it does not
 * support. Defining this inline because the plugin compiles against
 * @earendil-works/pi-ai, which has no such field.
 */
export interface QoderThinkingConfig {
  mode: "effort";
  efforts: readonly ThinkingLevel[];
  defaultLevel?: ThinkingLevel;
  requiresEffort?: boolean;
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
  thinking?: QoderThinkingConfig;
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
  return getQoderStatePath(getQoderRegionConfig(mode).modelCacheFile);
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

/**
 * Per-cache-file in-memory state.
 *
 * One instance per absolute cache path (so relocating $HOME in tests yields a
 * fresh store) that keeps the parsed cache, its derived displayId index, the
 * static-seed indexes and the in-flight catalog fetches together. Rewriting the
 * cache invalidates the derived index in one place, replacing the previous
 * four module-level maps whose consistency had to be maintained by hand.
 */
class QoderCatalogStore {
  private loaded = false;
  private data: ParsedModelCache | null = null;
  private configIndex: Map<string, QoderModelEntry> | undefined;
  private readonly staticByUpstreamKey = new Map<string, QoderModelDef>();
  private readonly staticById = new Map<string, QoderModelDef>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(readonly mode: QoderMode) {}

  /** Parsed cache file, memoized until the store is cleared. */
  read(): ParsedModelCache | null {
    if (this.loaded) return this.data;
    this.loaded = true;
    const cachePath = getQoderCachePath(this.mode);
    if (!existsSync(cachePath)) {
      this.data = null;
      return null;
    }
    try {
      this.data = JSON.parse(readFileSync(cachePath, "utf8")) as ParsedModelCache;
    } catch {
      this.data = null;
    }
    return this.data;
  }

  write(data: ParsedModelCache): void {
    const cachePath = getQoderCachePath(this.mode);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
    this.data = data;
    this.loaded = true;
    // The configs changed, so any previously built displayId index is stale.
    this.configIndex = undefined;
  }

  /**
   * Memoized pi model id -> catalog config index, so getCachedModelConfig
   * resolves in O(1) instead of scanning every config entry per request. Both
   * cache shapes are handled: the new cache keys by friendly id, legacy caches
   * key by raw upstream key with the display name inside the entry. Only
   * display-name-derived ids are indexed, so raw keys never resolve.
   */
  configs(): Map<string, QoderModelEntry> {
    if (this.configIndex) return this.configIndex;
    const index = new Map<string, QoderModelEntry>();
    const configs = this.read()?.configs;
    if (configs && typeof configs === "object") {
      for (const entry of Object.values(configs)) {
        if (!entry || typeof entry !== "object" || !entry.display_name) continue;
        const displayId = toQoderModelId(entry.display_name);
        if (displayId && displayId !== "QoderModel" && !index.has(displayId)) {
          // Keep the catalog entry exactly as published: the request builder
          // forwards `model_config` verbatim, so rewriting `is_default` here
          // would ask the gateway for a different context tier than the one
          // Qoder recommends (and bills for).
          index.set(displayId, entry as QoderModelEntry);
        }
      }
    }
    this.configIndex = index;
    return index;
  }

  /**
   * Static fallback catalog for this mode, indexed by upstream key and by public
   * id. `getCachedModels` maps every cached entry back to a seed by upstream key
   * and `getCachedModelConfig` resolves a fallback by public id; both used to run
   * a linear `.find` per call.
   */
  get staticSeeds(): { byUpstreamKey: Map<string, QoderModelDef>; byId: Map<string, QoderModelDef> } {
    if (this.staticByUpstreamKey.size === 0) {
      for (const model of this.mode === "cn" ? staticCnModels : staticModels) {
        if (model.upstreamKey && !this.staticByUpstreamKey.has(model.upstreamKey)) {
          this.staticByUpstreamKey.set(model.upstreamKey, model);
        }
        if (!this.staticById.has(model.id)) this.staticById.set(model.id, model);
      }
    }
    return { byUpstreamKey: this.staticByUpstreamKey, byId: this.staticById };
  }

  /**
   * Coalesce a catalog fetch per account: multiple callers within one process
   * (auto-login, session_start, login, token refresh) join one network request,
   * while different accounts stay separate so the cache is stamped correctly.
   */
  runUpdate(userID: string, task: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(userID);
    if (existing) return existing;
    const promise = (async () => {
      try {
        await task();
      } finally {
        this.inflight.delete(userID);
      }
    })();
    this.inflight.set(userID, promise);
    return promise;
  }
}

/** Process-memory stores keyed by absolute cache path (HOME-safe across tests). */
const catalogStores = new Map<string, QoderCatalogStore>();

function getCatalogStore(mode: QoderMode): QoderCatalogStore {
  const cachePath = getQoderCachePath(mode);
  let store = catalogStores.get(cachePath);
  if (!store) {
    store = new QoderCatalogStore(mode);
    catalogStores.set(cachePath, store);
  }
  return store;
}

/** Clear process-memory model caches (also used by tests that mutate cache files). */
export function clearQoderModelsMemCache(): void {
  catalogStores.clear();
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

/** Fields that vary between the static fallback and the live catalog. */
interface ModelDefFields {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  upstreamKey?: string;
  supportsEffort: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  thinking?: QoderThinkingConfig;
  description?: string;
  priceFactor?: number;
}

/** Build a model def, stamping the constants every Qoder model shares. */
function makeModelDef(mode: QoderMode, fields: ModelDefFields): QoderModelDef {
  return {
    api: "qoder-api",
    provider: getQoderRegionConfig(mode).providerID,
    baseUrl: getQoderBaseUrl(mode),
    cost: ZERO_COST,
    maxTokens: resolveMaxOutputTokens(),
    ...fields,
    // Explicit QODER_CONTEXT_WINDOW wins for static fallback entries too; live
    // entries already resolved it in contextWindowFromCatalog().
    contextWindow: resolveContextWindowOverride() ?? fields.contextWindow,
  };
}

function buildStaticModels(mode: QoderMode, rows: readonly StaticModelRow[]): QoderModelDef[] {
  return rows.map((row) =>
    makeModelDef(mode, {
      id: toQoderModelId(row.name),
      upstreamKey: row.upstreamKey,
      name: row.name,
      reasoning: row.reasoning,
      supportsEffort: row.supportsEffort ?? false,
      input: row.vision ? ["text", "image"] : ["text"],
      contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      ...(row.description ? { description: row.description } : {}),
    }),
  );
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
 * Map Qoder's `thinking_config` to omp's `thinking` metadata so omp's effort
 * picker lists the actual supported levels (it reads `thinking.efforts`, not
 * `thinkingLevelMap`). Only effort-based models have a meaningful ladder;
 * toggle-only models (no `efforts`) return undefined so omp falls back to its
 * generic behavior.
 */
export function buildThinkingConfig(entry: QoderModelEntry): QoderThinkingConfig | undefined {
  const tc = entry.thinking_config;
  const efforts = tc?.enabled?.efforts;
  if (!efforts || typeof efforts !== "object") return undefined;

  const supported = new Set(Object.keys(efforts));
  const ordered = PI_THINKING_LEVELS.filter((level) => supported.has(level));
  if (ordered.length === 0) return undefined;

  const defaultLevel = PI_THINKING_LEVELS.find((level) => efforts[level]?.is_default);

  return {
    mode: "effort",
    efforts: ordered,
    ...(defaultLevel ? { defaultLevel } : {}),
    // Qoder's catalog marks a `disabled` branch when thinking can be turned
    // off. Without it reasoning is mandatory upstream, so omp clamps "off" to
    // the lowest supported effort instead of disabling.
    requiresEffort: !tc?.disabled,
  };
}

export function getCachedModels(mode: QoderMode): QoderModelDef[] {
  const store = getCatalogStore(mode);
  const data = store.read();
  if (data && Array.isArray(data.models)) {
    const staticByKey = store.staticSeeds.byUpstreamKey;
    const models = data.models.map((model: QoderModelDef) => {
      const config = (data.configs?.[model.id] ?? store.configs().get(model.id)) as QoderModelEntry | undefined;
      const display = config?.display_name;
      const staticModel = staticByKey.get(model.id);
      // Recompute the two "money" knobs from the current policy instead of
      // trusting the values baked into the cache file: a cache written by an
      // older release may carry the 1M window / 128K output cap, and those
      // must not keep inflating credits for the rest of the cache TTL.
      const adjusted: Partial<QoderModelDef> = { maxTokens: resolveMaxOutputTokens() };
      const forcedWindow = resolveContextWindowOverride();
      if (config) adjusted.contextWindow = contextWindowFromCatalog(config);
      else if (forcedWindow !== undefined) adjusted.contextWindow = forcedWindow;
      const next = { ...model, ...adjusted };
      if (display) return { ...next, id: toQoderModelId(display), name: display };
      if (staticModel) return { ...next, id: staticModel.id, name: staticModel.name };
      return next.name ? { ...next, id: toQoderModelId(next.name) } : next;
    });
    // Older releases injected `auto` without a corresponding service config.
    // Keep an explicitly enabled service model, but drop the legacy fallback.
    // Configs are keyed by display id (`Auto`) since 9d88e99; older caches
    // still key them by upstream raw key (`auto`), so check both spellings.
    if (data.configs && typeof data.configs === "object" && !data.configs.auto && !data.configs.Auto) {
      return models.filter((model: QoderModelDef) => model.id.toLowerCase() !== "auto");
    }
    return models;
  }
  return mode === "cn" ? staticCnModels : staticModels;
}

export function getCachedModelConfig(modelId: string, mode: QoderMode): QoderModelEntry | null {
  const store = getCatalogStore(mode);
  // O(1) lookup against the memoized displayId index (no per-request scan of the
  // whole config list, which could be hundreds of entries).
  const config = store.configs().get(modelId);
  if (config) return config;

  const staticModel = store.staticSeeds.byId.get(modelId);
  if (staticModel) {
    return {
      key: staticModel.upstreamKey || modelId,
      is_reasoning: staticModel.reasoning,
      source: "system",
    };
  }

  return null;
}

/** `context_config` tiers, ascending by advertised token count. */
function contextTiers(entry: QoderModelEntry): Array<{ tokens: number; isDefault: boolean }> {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return [];
  const tiers: Array<{ tokens: number; isDefault: boolean }> = [];
  for (const config of Object.values(contextConfig)) {
    if (!config || typeof config !== "object") continue;
    const tokens = config.token_count;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
    tiers.push({ tokens, isDefault: config.is_default === true });
  }
  return tiers.sort((a, b) => a.tokens - b.tokens);
}

/**
 * Resolve the context window pi should use for a catalog entry.
 *
 * Qoder advertises selectable context tiers (typically 200K/400K/1M) and
 * charges more the more context a request carries, so the catalog's *default*
 * tier wins (GLM-5.x: 200K). The previous "largest tier" behavior grew a
 * session until ~984K tokens before pi compacted, and every intermediate round
 * re-sent that prompt.
 *
 * Opt-outs (env or `/qoder-settings`):
 *   contextWindow=<tokens>  force a window (capped to the largest tier)
 *   useMaxContext / QODER_CONTEXT_MAX=1   legacy: largest advertised tier
 *
 * Without `context_config`, the advertised `max_input_tokens` is the best
 * known limit; DEFAULT_CONTEXT_WINDOW is the last resort.
 */
export function contextWindowFromCatalog(
  entry: QoderModelEntry,
  env?: Readonly<Record<string, string | undefined>>,
): number {
  const tiers = contextTiers(entry);
  const largest = tiers[tiers.length - 1]?.tokens;

  const forced = resolveContextWindowOverride(env);
  if (forced !== undefined) return largest !== undefined ? Math.min(forced, largest) : forced;
  if (resolvePreferMaxContext(env) && largest !== undefined) return largest;

  const defaultTier = tiers.find((tier) => tier.isDefault)?.tokens;
  if (defaultTier !== undefined) return defaultTier;
  // No tier marked as default: take the smallest (cheapest) one rather than
  // silently opting every request into the largest, most expensive context.
  if (tiers.length > 0) return tiers[0].tokens;

  const advertised = entry.max_input_tokens;
  if (typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0) return Math.round(advertised);
  return DEFAULT_CONTEXT_WINDOW;
}

export function isCacheStale(mode: QoderMode, userID?: string): boolean {
  const data = getCatalogStore(mode).read();
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
 * coalesced into a single network request (see QoderCatalogStore.runUpdate), so
 * a startup auto-login, a session_start hook and a token refresh firing
 * together only fetch once. The store is per cache file and the in-flight key
 * includes the account, so joining another account's request is impossible.
 * Network errors are swallowed (returns normally) so callers stay best-effort.
 */
export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: QoderMode,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  // Independently cancellable callers must not abort another caller's work.
  if (signal) return fetchAndCacheModelList(authToken, userID, name, email, mode, signal);
  return getCatalogStore(mode).runUpdate(userID, () => fetchAndCacheModelList(authToken, userID, name, email, mode));
}

async function fetchAndCacheModelList(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: QoderMode,
  signal?: AbortSignal,
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    // Refresh the dynamic COSY identity BEFORE signing this request: the
    // gateway gates the catalog on the client's COSY version, so a catalog
    // request signed with a stale identity returns the reduced list, which
    // is then cached for its full TTL and registered for the whole session.
    // The refresh is throttled to once a day and never throws; when it is
    // not due it returns immediately.
    // Only pay the (async) refresh when it is actually due; when throttled the
    // catalog request signs immediately with the cached identity.
    if (isGatewayCosyVersionRefreshDue()) {
      // The caller's signal bounds the refresh so an aborted catalog request is
      // not held until the refresh's own timeout.
      await refreshGatewayCosyVersion({ signal });
    }

    const headers = buildAuthHeaders(null, modelListURL, {
      userID,
      authToken,
      name,
      email,
    });

    const resData = await fetchQoderJson<{ chat?: QoderModelEntry[] }>(
      modelListURL,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...headers,
        },
      },
      { signal },
    );
    signal?.throwIfAborted();
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable || !entry.display_name) continue;

      const display = entry.display_name;
      // The pi-visible id is the whitespace-stripped display name, so two
      // entries whose names differ only by whitespace would collide and leave
      // one upstream key unreachable (the picker would show a duplicate while
      // both requests resolve to whichever entry won the config map). Keep the
      // first entry and skip later collisions; the read-side index uses the
      // same first-wins rule.
      const modelId = toQoderModelId(display);
      if (configs[modelId]) {
        debugLog(`model catalog: duplicate pi id "${modelId}" (key ${key}); keeping the first entry`);
        continue;
      }
      // Use the catalog's own default tier (e.g. 200K when 200K/400K/1M are
      // offered) so pi compacts at the prompt size Qoder actually charges for.
      // QODER_CONTEXT_WINDOW / QODER_CONTEXT_MAX opt into something larger.
      const ctxLen = contextWindowFromCatalog(entry);
      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const thinkingLevelMap = buildThinkingLevelMap(entry);
      const priceFactor = parseQoderPriceFactor(entry.price_factor);
      const thinking = buildThinkingConfig(entry);
      // Both regions expose display_name (whitespace-stripped) as the sole
      // pi-visible id. The config stores the upstream key under that id for
      // request-time use.
      const modelInfo = { id: modelId, name: display };

      configs[modelInfo.id] = entry;

      newModels.push(
        makeModelDef(mode, {
          id: modelInfo.id,
          name: modelInfo.name,
          reasoning: isReasoning,
          supportsEffort,
          thinkingLevelMap,
          thinking,
          input: isVL ? ["text", "image"] : ["text"],
          contextWindow: ctxLen,
          ...(priceFactor !== undefined ? { priceFactor } : {}),
        }),
      );
    }

    if (newModels.length === 0) return;

    const cacheData = {
      updatedAt: Date.now(),
      userID,
      models: newModels,
      configs,
    };

    getCatalogStore(mode).write(cacheData);
  } catch (error) {
    signal?.throwIfAborted();
    debugLog("model catalog refresh failed", error);
  }
}
