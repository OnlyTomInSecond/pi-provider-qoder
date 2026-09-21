import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { isCacheStale, updateQoderModelsCache } from "../catalog.js";
import { getMachineId } from "../cosy.js";
import { debugLog } from "../debug.js";
import { fetchQoderJson, type QoderRequestOptions } from "../http.js";
import { getQoderRefreshURL, getQoderRegionConfig, type QoderMode } from "../region.js";
import { DEFAULT_TOKEN_TTL_MS, resolveTokenExpiry } from "./expiry.js";
import { interactiveLogin } from "./login.js";
import { credentialsFromPat, decodePatRefresh, fetchUserInfo, isPatRefresh } from "./pat.js";
import { readAuthFile, storeEnvironmentCredentials } from "./storage.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

export type QoderIdentity = Pick<QoderCredentials, "userID" | "email" | "name" | "machineID">;

const identityCache = new Map<string, QoderIdentity>();

/** Cap the identity memo so long sessions with many token refreshes stay bounded. */
const MAX_IDENTITY_CACHE = 32;

/**
 * Memoize an identity, evicting the oldest entry past the cap. Re-inserting an
 * existing key refreshes its recency (LRU), and a token refresh produces a new
 * key each time, so the oldest (stale) entries fall off first.
 */
function cacheIdentity(key: string, creds: QoderIdentity): void {
  identityCache.delete(key);
  const { userID, email, name, machineID } = creds;
  identityCache.set(key, { userID, email, name, machineID });
  if (identityCache.size <= MAX_IDENTITY_CACHE) return;
  const oldest = identityCache.keys().next().value;
  if (oldest !== undefined) identityCache.delete(oldest);
}

/** Insert an identity into the bounded memo. Exposed for tests only. */
export function cacheQoderIdentityForTest(key: string, creds: QoderCredentials): void {
  cacheIdentity(key, creds);
}

/** Current size of the identity memo. Exposed for tests only. */
export function getQoderIdentityCacheSizeForTest(): number {
  return identityCache.size;
}

/** Whether the identity memo contains `key`. Exposed for tests only. */
export function hasQoderIdentityForTest(key: string): boolean {
  return identityCache.has(key);
}

/** Maximum identities kept in the memo. Exposed for tests only. */
export const MAX_IDENTITY_CACHE_FOR_TEST = MAX_IDENTITY_CACHE;

/** Clear process-memory identities. Authentication storage is never memoized here. */
export function clearQoderAuthMemCache(): void {
  identityCache.clear();
}

/** Return the PAT exposed through the environment for a provider mode. */
export function getQoderPatForMode(mode: QoderMode): string {
  for (const envName of getQoderRegionConfig(mode).patEnvNames) {
    // Trim so a PAT pasted with surrounding whitespace/newlines (common in
    // shell exports and CI secrets) still exchanges, matching interactiveLogin.
    const value = process.env[envName]?.trim();
    if (value) return value;
  }
  return "";
}

/** Exchange an environment PAT before pi resolves its initial model. */
export async function autoLoginQoderFromEnvironment(providerID: string, mode: QoderMode): Promise<void> {
  const pat = getQoderPatForMode(mode);
  if (!pat) return;

  // An explicitly supplied PAT is authoritative. The auth file only stores
  // the exchanged job token, so it cannot tell us whether the environment
  // token changed. Re-exchange it on startup to avoid silently using an old
  // account's credentials.
  const credentials = await credentialsFromPat(pat, mode);

  await storeEnvironmentCredentials(providerID, credentials);
  const qCreds = credentials as QoderCredentials;
  if (qCreds.userID) cacheIdentity(`${providerID}:${qCreds.access}`, qCreds);

  // Refresh the model catalog before the provider is registered only when the
  // cached list is stale (>1h) or belongs to a different account, mirroring
  // refreshQoderModelsCache. The PAT exchange above is authoritative for
  // *identity* and always runs, but the model list changes rarely and a fresh,
  // same-account cache is reused instead of re-fetched on every boot.
  // (Blocking matters for `pi --list-models`, which can exit before background
  // work completes — so the stale fetch is awaited, not fired-and-forgotten.)
  if (isCacheStale(mode, qCreds.userID)) {
    await updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode);
  }
}

/**
 * Read the Qoder identity (userID/email/name/machineID) from pi's own auth
 * store. pi persists the full OAuthCredentials there on login/refresh and keeps
 * it up to date, so there is no need to maintain a separate credentials cache.
 *
 * When `accessToken` is given and the stored entry carries a different access
 * token, null is returned: the stored identity belongs to another account, and
 * reusing its userID would sign requests as the wrong user. Pass an empty/
 * undefined token to read whatever entry is stored ("any account").
 *
 * Note: the auth.json path/shape is a pi internal convention, not a public API.
 * This is best-effort and falls back to null so callers can use placeholders.
 */
export function getCachedCredentials(accessToken?: string, providerID = "qoder"): QoderCredentials | null {
  let auth: Record<string, unknown>;
  try {
    auth = readAuthFile();
  } catch (error) {
    debugLog("failed to read auth storage", error);
    return null;
  }
  const creds = (auth[providerID] || (providerID === "qoder" ? auth.qoder : null)) as QoderCredentials | null;
  if (!(creds?.userID || creds?.access)) return null;
  // A caller asking for a specific token must not receive another account's
  // identity; an empty token means "any entry" (used to discover the token).
  if (accessToken && creds.access && creds.access !== accessToken) return null;
  if (creds.access && creds.userID) {
    cacheIdentity(`${providerID}:${creds.access}`, creds);
  }
  return creds;
}

/**
 * Resolve the Qoder identity (userID/email/name/machineID) for a chat request.
 * OMP (17.x) persists login credentials in its own agent.db, not in
 * ~/.pi/agent/auth.json, so the provider-side cache is frequently empty and the
 * COSY payload would fall back to uid "qoder-user" -> Qoder CN rejects it with
 * "Login expired" (105). Fetch the identity from the job token when the cache
 * misses. Memoize identity only; never write synthetic credentials to auth.json.
 */
export async function resolveQoderIdentity(
  accessToken: string,
  providerID: string,
  mode: QoderMode,
  options: QoderRequestOptions = {},
): Promise<QoderIdentity> {
  options.signal?.throwIfAborted();
  const region = getQoderRegionConfig(mode);
  const cacheKey = `${providerID}:${accessToken}`;
  const mem = identityCache.get(cacheKey);
  if (mem?.userID) {
    cacheIdentity(cacheKey, mem);
    return mem;
  }

  const cached = getCachedCredentials(accessToken, providerID);
  if (cached?.userID) {
    cacheIdentity(cacheKey, cached);
    return cached;
  }

  const info = await fetchUserInfo(accessToken, mode, options);
  const machineID = getMachineId();
  const creds: QoderIdentity = {
    userID: info.userID || "qoder-user",
    email: info.email || region.userEmailFallback,
    name: info.name || region.userNameFallback,
    machineID,
  };
  // Failed profile lookups must be retried, not permanently cached as a placeholder.
  if (info.userID) cacheIdentity(cacheKey, creds);
  return creds;
}

export async function loginQoderForMode(callbacks: OAuthLoginCallbacks, mode: QoderMode): Promise<OAuthCredentials> {
  const providerID = getQoderRegionConfig(mode).providerID;
  // 1. Try environment variables first (PAT). A PAT (pt-...) must be exchanged
  //    for a short-lived job token before it can be used — credentialsFromPat
  //    handles the exchange + identity resolution.
  const pat = getQoderPatForMode(mode);
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat, mode, { signal: callbacks.signal });
      const qCreds = creds as QoderCredentials;
      // Cache models in background without outliving a cancelled login.
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode, callbacks.signal).catch(
        (error) => debugLog("model catalog refresh after PAT exchange failed", error),
      );
      // The host persists credentials (auth.json in pi, agent.db in OMP).
      if (qCreds.userID) cacheIdentity(`${providerID}:${qCreds.access}`, qCreds);
      return creds;
    } catch (error) {
      callbacks.signal?.throwIfAborted();
      debugLog("environment PAT exchange failed; falling back to interactive login", error);
    }
  }

  // 2. Interactive login (CN only supports PAT prompt here; global supports device flow fallback)
  const creds = await interactiveLogin(callbacks, mode);

  // Cache models in background.
  try {
    const qCreds = creds as QoderCredentials;
    updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode, callbacks.signal).catch(
      (error) => debugLog("model catalog refresh after login failed", error),
    );
  } catch (error) {
    debugLog("failed to start model catalog refresh after login", error);
  }

  const identity = creds as QoderCredentials;
  if (identity.userID) cacheIdentity(`${providerID}:${creds.access}`, identity);
  return creds;
}

export async function refreshQoderTokenForMode(
  credentials: OAuthCredentials,
  mode: QoderMode,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  signal?.throwIfAborted();
  let refreshed: QoderCredentials;
  // Refresh failures must propagate. Extending local expiry cannot make an
  // expired/revoked upstream token valid and prevents the host from recovering.
  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (!pat) throw new Error(`Missing Qoder PAT; run /login ${getQoderRegionConfig(mode).providerID}`);
    refreshed = (await credentialsFromPat(pat, mode, { signal })) as QoderCredentials;
  } else {
    const [refreshToken, storedUserID, storedMachineID] = credentials.refresh.split("|");
    if (!refreshToken)
      throw new Error(`Missing Qoder refresh token; run /login ${getQoderRegionConfig(mode).providerID}`);
    const previous = credentials as Partial<QoderCredentials>;
    const userID = storedUserID || previous.userID || "";
    const machineID = storedMachineID || previous.machineID || getMachineId();
    const data = await fetchQoderJson<{
      token?: string;
      refresh_token?: string;
      expires_at?: string;
      expires_in?: number;
    }>(
      getQoderRefreshURL(mode),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.access}`,
          Accept: "application/json",
          "User-Agent": "pi-provider-qoder",
        },
        body: JSON.stringify({ refreshToken }),
      },
      { signal },
    );
    if (!data.token) throw new Error("Qoder refresh returned no access token");
    refreshed = {
      ...credentials,
      refresh: `${data.refresh_token || refreshToken}|${userID}|${machineID}`,
      access: data.token,
      expires: resolveTokenExpiry(data, DEFAULT_TOKEN_TTL_MS) - 5 * 60 * 1000,
      userID,
      email: previous.email || "",
      name: previous.name || "",
      machineID,
    };
  }
  signal?.throwIfAborted();
  if (refreshed.userID) cacheIdentity(`${getQoderRegionConfig(mode).providerID}:${refreshed.access}`, refreshed);
  // Host owns persistence. Catalog refresh is best-effort but cancellation-aware.
  updateQoderModelsCache(refreshed.access, refreshed.userID, refreshed.name, refreshed.email, mode, signal).catch(
    (error) => debugLog("model catalog refresh after token refresh failed", error),
  );
  return refreshed;
}
