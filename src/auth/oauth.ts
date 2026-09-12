import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { isCacheStale, updateQoderModelsCache } from "../catalog.js";
import { getMachineId } from "../cosy.js";
import { debugLog } from "../debug.js";
import { getHomeDir } from "../home.js";
import { getQoderRefreshURL, getQoderRegionConfig, type QoderMode } from "../region.js";
import { DEFAULT_TOKEN_TTL_MS, resolveTokenExpiry } from "./expiry.js";
import { interactiveLogin } from "./login.js";
import { credentialsFromPat, decodePatRefresh, fetchUserInfo, isPatRefresh } from "./pat.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

interface AuthStorageLike {
  create?: () => { set?: (providerID: string, credentials: unknown) => void };
}

/**
 * Lazily load the host's `AuthStorage`. A static import of
 * `@earendil-works/pi-coding-agent` pulls in the package's entire module graph
 * (measured ~300ms per process start), so it is deferred: only env-PAT
 * auto-login consults it. Hosts that do not export a usable `AuthStorage` fall
 * back to writing auth.json directly, which is what pi itself reads.
 */
let authStoragePromise: Promise<AuthStorageLike | undefined> | undefined;

function loadHostAuthStorage(): Promise<AuthStorageLike | undefined> {
  authStoragePromise ??= import("@earendil-works/pi-coding-agent")
    .then((mod) => (mod as unknown as { AuthStorage?: AuthStorageLike }).AuthStorage)
    .catch((error) => {
      debugLog("host AuthStorage unavailable; using auth.json directly", error);
      return undefined;
    });
  return authStoragePromise;
}

const identityCache = new Map<string, QoderCredentials>();

/** Cap the identity memo so long sessions with many token refreshes stay bounded. */
const MAX_IDENTITY_CACHE = 32;

/**
 * Memoize an identity, evicting the oldest entry past the cap. Re-inserting an
 * existing key refreshes its recency (LRU), and a token refresh produces a new
 * key each time, so the oldest (stale) entries fall off first.
 */
function cacheIdentity(key: string, creds: QoderCredentials): void {
  identityCache.delete(key);
  identityCache.set(key, creds);
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

function getAuthFilePath(): string {
  return join(getHomeDir(), ".pi", "agent", "auth.json");
}

/** Memoized parse of auth.json; invalidated on save. undefined = not loaded. */
let authFileMem: { path: string; data: Record<string, unknown> } | null | undefined;

/** Clear process-memory auth caches (used by tests that mutate auth.json). */
export function clearQoderAuthMemCache(): void {
  authFileMem = undefined;
  identityCache.clear();
}

function readAuthFileCached(): Record<string, unknown> | null {
  const authPath = getAuthFilePath();
  if (authFileMem !== undefined) {
    if (authFileMem === null) return null;
    if (authFileMem.path === authPath) return authFileMem.data;
  }
  if (!existsSync(authPath)) {
    authFileMem = null;
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    authFileMem = { path: authPath, data };
    return data;
  } catch (error) {
    debugLog(`failed to parse ${authPath}`, error);
    authFileMem = null;
    return null;
  }
}

/** Return the PAT exposed through the environment for a provider mode. */
export function getQoderPatForMode(mode: QoderMode): string {
  for (const envName of getQoderRegionConfig(mode).patEnvNames) {
    const value = process.env[envName];
    if (value) return value;
  }
  return "";
}

function saveCredentialsToAuthFile(providerID: string, credentials: OAuthCredentials): void {
  try {
    const authPath = getAuthFilePath();
    const dir = dirname(authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const existing = readAuthFileCached();
    const auth: Record<string, unknown> = existing ? { ...existing } : {};
    auth[providerID] = { type: "oauth", ...credentials };
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
    authFileMem = { path: authPath, data: auth };
    const q = credentials as QoderCredentials;
    if (q.access && q.userID) {
      cacheIdentity(`${providerID}:${q.access}`, q);
    }
  } catch (err) {
    console.error(`[pi-provider-qoder] Failed to write auth storage for ${providerID}:`, err);
  }
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

  const hostAuthStorage = await loadHostAuthStorage();
  if (typeof hostAuthStorage?.create === "function") {
    try {
      const authStorage = hostAuthStorage.create();
      if (typeof authStorage?.set !== "function") throw new Error("AuthStorage has no set()");
      authStorage.set(providerID, { type: "oauth", ...credentials });
    } catch (error) {
      debugLog("AuthStorage.set failed; writing auth.json directly", error);
      saveCredentialsToAuthFile(providerID, credentials);
    }
  } else {
    saveCredentialsToAuthFile(providerID, credentials);
  }

  const qCreds = credentials as QoderCredentials;

  // Refresh the model catalog before the provider is registered only when the
  // cached list is stale (>1h), mirroring refreshQoderModelsCache. The PAT
  // exchange above is authoritative for *identity* and always runs, but the
  // model list changes rarely and the cache is not account-keyed within its
  // TTL, so a fresh cache is reused instead of re-fetched on every boot.
  // (Blocking matters for `pi --list-models`, which can exit before background
  // work completes — so the stale fetch is awaited, not fired-and-forgotten.)
  if (isCacheStale(mode)) {
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
  const auth = readAuthFileCached();
  if (!auth) return null;
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
 * misses (in-memory cached), and persist it so later requests skip the fetch.
 */
export async function resolveQoderIdentity(
  accessToken: string,
  providerID: string,
  mode: QoderMode,
): Promise<QoderCredentials> {
  const region = getQoderRegionConfig(mode);
  const cacheKey = `${providerID}:${accessToken}`;
  const mem = identityCache.get(cacheKey);
  if (mem?.userID) return mem;

  const cached = getCachedCredentials(accessToken, providerID);
  if (cached?.userID) {
    cacheIdentity(cacheKey, cached);
    return cached;
  }

  const info = await fetchUserInfo(accessToken, mode);
  const machineID = getMachineId();
  const creds: QoderCredentials = {
    access: accessToken,
    userID: info.userID || "qoder-user",
    email: info.email || region.userEmailFallback,
    name: info.name || region.userNameFallback,
    machineID,
    refresh: "",
    expires: 0,
  };
  cacheIdentity(cacheKey, creds);
  saveCredentialsToAuthFile(providerID, creds);
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
      const creds = await credentialsFromPat(pat, mode);
      const qCreds = creds as QoderCredentials;
      // Persist the resolved identity locally so chat requests can resolve the real uid.
      // Cache models in background
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch((error) =>
        debugLog("model catalog refresh after PAT exchange failed", error),
      );
      // Persist the resolved identity locally. OMP (17.x) stores login
      // credentials in its own agent.db, not in ~/.pi/agent/auth.json, so
      // without this the chat COSY payload would fall back to uid "qoder-user"
      // and Qoder CN rejects it with "Login expired" (105).
      saveCredentialsToAuthFile(providerID, creds);
      return creds;
    } catch (error) {
      debugLog("environment PAT exchange failed; falling back to interactive login", error);
    }
  }

  // 2. Interactive login (CN only supports PAT prompt here; global supports device flow fallback)
  const creds = await interactiveLogin(callbacks, mode);

  // Cache models in background.
  try {
    const qCreds = creds as QoderCredentials;
    updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch((error) =>
      debugLog("model catalog refresh after login failed", error),
    );
  } catch (error) {
    debugLog("failed to start model catalog refresh after login", error);
  }

  // Persist the resolved identity locally (see note above).
  saveCredentialsToAuthFile(providerID, creds);
  return creds;
}

export async function refreshQoderTokenForMode(
  credentials: OAuthCredentials,
  mode: QoderMode,
): Promise<OAuthCredentials> {
  // PAT-based credentials: re-exchange the stored PAT for a fresh job token.
  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (pat) {
      try {
        const refreshed = await credentialsFromPat(pat, mode);
        const qCreds = refreshed as QoderCredentials;
        updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch((error) =>
          debugLog("model catalog refresh after PAT re-exchange failed", error),
        );
        return refreshed;
      } catch (error) {
        debugLog("PAT re-exchange failed; extending validity", error);
      }
    }
    return {
      ...credentials,
      expires: Date.now() + 60 * 60 * 1000, // extend 1 hour to retry later
    };
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();
  const prev = credentials as Partial<QoderCredentials>;
  const prevName = prev.name || "";
  const prevEmail = prev.email || "";

  const refreshURL = getQoderRefreshURL(mode);
  try {
    const response = await fetch(refreshURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": "pi-provider-qoder",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        token: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };

      const newAccess = data.token;
      const newRefresh = data.refresh_token || refreshToken;

      // Qoder reports `expires_in` in milliseconds (see expiry.ts); keep a
      // 30-day fallback for responses that omit both fields.
      const expireMs = resolveTokenExpiry(data, DEFAULT_TOKEN_TTL_MS);

      const refreshed = {
        ...credentials,
        refresh: `${newRefresh}|${userID}|${machineID}`,
        access: newAccess,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        email: prevEmail,
        name: prevName,
        machineID,
      };

      // pi persists the refreshed credentials in auth.json itself.
      // Cache models in background
      updateQoderModelsCache(newAccess, userID, prevName, prevEmail, mode).catch((error) =>
        debugLog("model catalog refresh after token refresh failed", error),
      );

      return refreshed;
    }
  } catch (error) {
    debugLog("token refresh request failed; extending validity", error);
  }

  // Fallback: Extend validity slightly to buy time, as Qoder tokens are long-lived
  const refreshedFallback = {
    ...credentials,
    expires: Date.now() + 60 * 60 * 1000, // extend for 1 hour
  };
  return refreshedFallback;
}
