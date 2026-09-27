// shape: none — module-scope cache state (trigger #3, one instance per
//   process) plus a straight-line command handler.
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchQoderUsageForMode, type QoderProviderUsage } from "../auth/usage.js";
import { getQoderRegionConfig, QODER_MODES, type QoderMode } from "../region.js";

const QUOTA_CACHE_TTL_MS = 60_000;
const QUOTA_FETCH_TIMEOUT_MS = 3_000;

interface QuotaCacheEntry {
  usage: QoderProviderUsage;
  fetchedAt: number;
}

const quotaCache = new Map<QoderMode, QuotaCacheEntry>();
const inflight = new Map<QoderMode, Promise<QoderProviderUsage>>();

/** Test-only resetter, alongside the fork's existing resetter pattern. */
export function clearQoderQuotaCache(): void {
  quotaCache.clear();
  inflight.clear();
}

function fetchUsage(credentials: OAuthCredentials, mode: QoderMode): Promise<QoderProviderUsage> {
  const pending = inflight.get(mode);
  if (pending) return pending;
  const request = fetchQoderUsageForMode(credentials, mode, { timeoutMs: QUOTA_FETCH_TIMEOUT_MS }).finally(() => {
    inflight.delete(mode);
  });
  inflight.set(mode, request);
  return request;
}

function renderUsage(usage: QoderProviderUsage, servedFromCache: boolean, cacheAgeMs: number): string[] {
  const lines: string[] = [];
  const buckets = usage.usageBuckets ?? [];
  for (const bucket of buckets) {
    const limit = bucket.limitDisplay ? ` / ${bucket.limitDisplay}` : "";
    const reset = bucket.resetAt ? ` — resets ${bucket.resetAt.slice(0, 10)}` : "";
    lines.push(`${bucket.label}: ${bucket.usedDisplay}${limit} ${bucket.unit ?? ""}${reset}`.trimEnd());
  }
  if (usage.summary) lines.push(usage.summary);
  if (usage.resetAt) lines.push(`Reset: ${usage.resetAt.slice(0, 10)}`);
  if (usage.manageUrl) lines.push(`Manage: ${usage.manageUrl}`);
  if (servedFromCache) lines.push(`(cached ${Math.round(cacheAgeMs / 1000)}s ago)`);
  return lines;
}

/**
 * F4: on-demand subscription quota. Manual command only — never touches the
 * turn path; a 60 s cache absorbs repeat invocations; concurrent invocations
 * share one in-flight fetch; failures print the reason with zero fabricated
 * numbers.
 */
export async function handleQuotaCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const lines: string[] = [];
  for (const mode of QODER_MODES) {
    const region = getQoderRegionConfig(mode);
    const token = await ctx.modelRegistry.getApiKeyForProvider(region.providerID).catch(() => undefined);
    if (!token) continue;
    const cached = quotaCache.get(mode);
    const cacheAge = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
    if (cached && cacheAge < QUOTA_CACHE_TTL_MS) {
      lines.push(`[${region.loginName}]`, ...renderUsage(cached.usage, true, cacheAge));
      continue;
    }
    try {
      const usage = await fetchUsage({ access: token, refresh: "", expires: 0 }, mode);
      quotaCache.set(mode, { usage, fetchedAt: Date.now() });
      lines.push(`[${region.loginName}]`, ...renderUsage(usage, false, 0));
    } catch (error) {
      lines.push(`[${region.loginName}] quota unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (lines.length === 0) {
    ctx.ui.notify("Qoder quota unavailable: no Qoder credentials are configured.", "warning");
    return;
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
