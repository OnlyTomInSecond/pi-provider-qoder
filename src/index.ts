import type { Api, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  autoLoginQoderFromEnvironment,
  getCachedCredentials,
  loginQoderForMode,
  refreshQoderTokenForMode,
} from "./auth/oauth.js";
import { fetchQoderUsageForMode } from "./auth/usage.js";
import { getCachedModels, isCacheStale, priceFactorHint, updateQoderModelsCache } from "./catalog.js";
import { registerQoderCreditDisplay } from "./credit-display.js";
import { debugLog } from "./debug.js";
import { streamQoder } from "./protocol/stream.js";
import { getQoderBaseUrl, getQoderRegionConfig, QODER_MODES, type QoderMode } from "./region.js";

// Stock pi never reads a `fetchUsage` reference off the oauth config: it is
// absent from pi-coding-agent 0.75.5 through 1.4.0. The hook is only meaningful
// to hosts that opt in (OMP-style), so extending the type locally keeps it typed
// instead of smuggled through an `as unknown` cast.
type QoderOAuth = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

type QoderProviderModel = NonNullable<ProviderConfig["models"]>[number];

const QODER_API = "qoder-api" as Api;

async function registerQoderApi(): Promise<void> {
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    const register = (compat as Record<string, unknown>).registerApiProvider;
    // OMP-style hosts ship a compat module without the api registry.
    if (typeof register !== "function") return;
    (register as (config: unknown, source: string) => void)(
      { api: QODER_API, stream: streamQoder, streamSimple: streamQoder },
      "provider:qoder",
    );
  } catch (error) {
    // The module may be missing entirely if pi drops the temporary compat
    // entrypoint; registerProvider(streamSimple) below is enough on its own, so
    // loading must not fail. Log so the degradation is diagnosable.
    debugLog("pi-ai/compat registerApiProvider unavailable", error);
  }
}

function modelsForProvider(mode: QoderMode): QoderProviderModel[] {
  // getCachedModels already falls back to the static catalog and stamps
  // provider/baseUrl. pi's picker renders "<id> (<name>)" only when `name` has
  // words the id does not, so the name carries just the Credit-multiplier hint
  // (e.g. "Cantus (×3.2)") instead of a second copy of the model name. Plain
  // models keep name === id and therefore show no parenthetical at all.
  return getCachedModels(mode).map((model) => ({
    ...model,
    name: priceFactorHint(model.priceFactor) ?? model.id,
  }));
}

function createQoderOAuth(mode: QoderMode): QoderOAuth {
  const region = getQoderRegionConfig(mode);
  return {
    name: region.loginName,
    login: (callbacks) => loginQoderForMode(callbacks, mode),
    refreshToken: (credentials, signal) => refreshQoderTokenForMode(credentials, mode, signal),
    getApiKey: (cred: OAuthCredentials) => cred.access,
    // NOTE: no `modifyModels` hook on purpose. OMP (Bun) does a whole-catalog
    // structuredClone before invoking it, and its bundled catalog contains a
    // model with a non-cloneable property -> "The object can not be cloned."
    // removes qoder from `omp models`. Models are supplied at registration
    // via `modelsForProvider` and refreshed by the startup/session cache hooks.
    fetchUsage: (credentials) => fetchQoderUsageForMode(credentials, mode),
  };
}

function registerQoderProvider(pi: ExtensionAPI, mode: QoderMode): void {
  const providerID = getQoderRegionConfig(mode).providerID;
  pi.registerProvider(providerID, {
    baseUrl: getQoderBaseUrl(mode),
    api: QODER_API,
    models: modelsForProvider(mode),
    oauth: createQoderOAuth(mode),
    streamSimple: streamQoder,
  });
}

/**
 * Rebuild the model cache for `mode` when it is missing, stale (>1h old), or
 * was fetched for a different account. Identity comes from the auth file
 * (keyed by token) with region fallbacks, so a registry/startup token and an
 * auth-file record both work. Login/refresh are the other rebuild triggers;
 * this covers startup and the case where the cache was deleted while the token
 * is still valid.
 */
async function refreshQoderModelsCache(mode: QoderMode, accessToken?: string): Promise<void> {
  const region = getQoderRegionConfig(mode);
  const providerID = region.providerID;
  const token = accessToken ?? getCachedCredentials("", providerID)?.access;
  if (!token) return;
  const creds = getCachedCredentials(token, providerID);
  // Rebuild when the cache is missing, older than an hour, or was fetched for
  // a different account.
  if (!isCacheStale(mode, creds?.userID)) return;
  await updateQoderModelsCache(
    token,
    creds?.userID || "qoder-user",
    creds?.name || region.userNameFallback,
    creds?.email || region.userEmailFallback,
    mode,
  );
}

/**
 * Run `task` for both regions concurrently, isolating each region's failure so
 * one bad region cannot block the other.
 */
async function runPerMode(
  task: (mode: QoderMode) => Promise<void>,
  onError: (mode: QoderMode, error: unknown) => void,
): Promise<void> {
  await Promise.all(
    QODER_MODES.map(async (mode) => {
      try {
        await task(mode);
      } catch (error) {
        onError(mode, error);
      }
    }),
  );
}

export default async function (pi: ExtensionAPI) {
  await registerQoderApi();

  // Global and CN are independent (separate PAT env vars, cache files, base
  // URLs), so initialize them concurrently to cut startup time in half instead
  // of chaining their network round-trips sequentially. Each mode keeps its own
  // failure boundary so one bad region cannot block the other. They share
  // auth.json; the host credential store serializes updates under its lock.
  await runPerMode(
    async (mode) => {
      const providerID = getQoderRegionConfig(mode).providerID;
      await autoLoginQoderFromEnvironment(providerID, mode);
      await refreshQoderModelsCache(mode);
    },
    (mode, error) => {
      const providerID = getQoderRegionConfig(mode).providerID;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
    },
  );

  // Refresh once per session at startup if the cache is missing or stale,
  // rather than on every message in the stream hot path.
  pi.on("session_start", async (_event, ctx) => {
    // The two regions are independent (own token, cache file, base URL), so
    // refresh them concurrently instead of letting a slow catalog fetch for one
    // delay the other.
    await runPerMode(
      async (mode) => {
        const providerID = getQoderRegionConfig(mode).providerID;
        // getApiKeyForProvider resolves OAuth getApiKey() to the access token on
        // the ModelRegistry compatibility facade. It stays the most portable
        // choice: it exists in pi 0.75.5+ (older peer hosts included), whereas
        // the newer getProviderAuth() is absent there and offers no extra value.
        const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
        if (!accessToken) return;
        await refreshQoderModelsCache(mode, accessToken);
      },
      // Best-effort: fall back to the existing cache / static models.
      (mode, error) => debugLog(`session_start model catalog refresh failed for ${mode}`, error),
    );
  });

  for (const mode of QODER_MODES) registerQoderProvider(pi, mode);
  registerQoderCreditDisplay(pi);
}
